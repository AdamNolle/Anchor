importScripts('settings.js');
const S = PauseKeeperSettings;
let queue = Promise.resolve();
const serialized = (fn) => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };
const iconCache = new Map();
let compatibilityReady = null;

function migrateCompatibility() {
  if (!compatibilityReady) compatibilityReady = (async () => {
    const { compatibilityVersion = 0, sites = {} } = await chrome.storage.local.get(['compatibilityVersion', 'sites']);
    if (compatibilityVersion >= 1) return;
    // Older Hulu settings treated episode transitions as deliberate pauses.
    // Reset these once; subsequent choices in the popup remain user-controlled.
    for (const [origin, config] of Object.entries(sites)) {
      if (S.isHulu(origin)) sites[origin] = { ...config, strictPause: false, blockAutoplay: false };
      if (S.isLinkedIn(origin)) sites[origin] = { ...config, enabled: false };
    }
    // Discard holds inherited from the old compatibility settings on upgrade.
    const { tabLocks = {}, tabOrigins = {} } = await chrome.storage.session.get(['tabLocks', 'tabOrigins']);
    for (const [tabId, origin] of Object.entries(tabOrigins)) {
      if (S.isHulu(origin) || S.isLinkedIn(origin)) delete tabLocks[tabId];
    }
    await chrome.storage.session.set({ tabLocks });
    await chrome.storage.local.set({ sites, compatibilityVersion: 1 });
  })().catch(error => { compatibilityReady = null; throw error; });
  return compatibilityReady;
}

async function updateAction(tabId, frames) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  const config = await settingsFor(tab);
  const { tabLocks = {}, tabFrames = {} } = await chrome.storage.session.get(['tabLocks', 'tabFrames']);
  const candidates = frames || Object.values(tabFrames[tabId] || {});
  const available = config.enabled && candidates.some(f => f.enabled && f.available);
  const locked = config.enabled && !!tabLocks[tabId];
  const key = `${S.origin(tab.url)}:${config.enabled}:${available}:${locked}`;
  if (iconCache.get(tabId) === key) return;
  const suffix = available ? '' : '-gray';
  await chrome.action.setIcon({ tabId, path: { 16: `icons/16${suffix}.png`, 32: `icons/32${suffix}.png` } });
  await chrome.action.setTitle({ tabId, title: !S.origin(tab.url) ? 'Anchor — unavailable on this page' : !config.enabled ? 'Anchor — protection off' : !available ? 'Anchor — no playable media detected' : locked ? 'Anchor — held paused' : 'Anchor — player protected' });
  await chrome.action.setBadgeText({ tabId, text: locked ? 'Ⅱ' : '' });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#000000' });
  iconCache.set(tabId, key);
}

async function recordFrame(sender, state) {
  return serialized(async () => {
    const { tabFrames = {} } = await chrome.storage.session.get('tabFrames');
    tabFrames[sender.tab.id] ||= {};
    tabFrames[sender.tab.id][sender.frameId] = { documentId: sender.documentId, enabled: !!state.enabled, available: !!state.available };
    await chrome.storage.session.set({ tabFrames });
    await updateAction(sender.tab.id);
  });
}

async function settingsFor(tab) {
  await migrateCompatibility();
  const { sites = {} } = await chrome.storage.local.get('sites');
  return S.forOrigin(S.origin(tab.url), sites);
}

async function broadcast(tabId, message, excludeFrameId) {
  if (typeof excludeFrameId === 'number') {
    const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => true }).catch(() => []);
    await Promise.all(frames.filter(f => f.frameId !== excludeFrameId).map(f => chrome.tabs.sendMessage(tabId, message, { frameId: f.frameId }).catch(() => null)));
    return;
  }
  try { return await chrome.tabs.sendMessage(tabId, message); } catch { return null; }
}

async function setLock(tabId, locked, expectedOrigin, sourceFrameId) {
  return serialized(async () => {
    if (expectedOrigin && S.origin((await chrome.tabs.get(tabId)).url) !== expectedOrigin) return;
    const { tabLocks = {} } = await chrome.storage.session.get('tabLocks');
    if (locked) tabLocks[tabId] = true; else delete tabLocks[tabId];
    await chrome.storage.session.set({ tabLocks });
    // The source frame has already acted. Echoing its previous pause back can
    // interrupt a newer Play gesture while the service worker is catching up.
    await broadcast(tabId, { type: 'PK_COMMAND', command: locked ? 'lock-sync' : 'release' }, sourceFrameId);
    await updateAction(tabId);
  });
}

async function registerSites() {
  // Remove the per-host registrations left by v1.0. Universal manifest scripts
  // now cover HTTP(S) pages and cross-origin embedded players at document start.
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const owned = existing.filter(s => s.id.startsWith('pk-'));
  if (owned.length) await chrome.scripting.unregisterContentScripts({ ids: owned.map(s => s.id) });
}

async function injectNow(tabId) {
  // MAIN first: the bridge handshakes after the engine listener exists.
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['main.js'], world: 'MAIN' });
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['bridge.js'] });
}

async function status(tabId) {
  const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'ISOLATED', func: () => globalThis.__pauseKeeperStatus || null }).catch(() => []);
  const frames = results.filter(r => r.result).map(r => ({ frameId: r.frameId, ...r.result }));
  const { tabLocks = {} } = await chrome.storage.session.get('tabLocks');
  await updateAction(tabId, frames);
  return { locked: !!tabLocks[tabId], available: frames.some(f => f.enabled && f.available), blocked: frames.reduce((n, f) => n + (f.blocked || 0), 0), media: frames.reduce((n, f) => n + (f.media || 0), 0), frames };
}

async function resume(tabId) {
  const state = await status(tabId);
  const best = state.frames.filter(f => f.enabled && f.media > 0).sort((a, b) => b.score - a.score)[0];
  await setLock(tabId, false);
  if (best) await chrome.tabs.sendMessage(tabId, { type: 'PK_COMMAND', command: 'play' }, { frameId: best.frameId });
  return status(tabId);
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const extensionPage = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
  (async () => {
    // Upgrade settings and old holds before any message reads session state.
    await migrateCompatibility();
    if (message.type === 'PK_SETTINGS' && sender.tab) {
      return serialized(async () => {
        const tab = await chrome.tabs.get(sender.tab.id);
        const { tabLocks = {}, tabOrigins = {} } = await chrome.storage.session.get(['tabLocks', 'tabOrigins']);
        const origin = S.origin(tab.url);
        if (tabOrigins[tab.id] && tabOrigins[tab.id] !== origin) delete tabLocks[tab.id];
        tabOrigins[tab.id] = origin;
        await chrome.storage.session.set({ tabLocks, tabOrigins });
        return { config: await settingsFor(tab), locked: !!tabLocks[tab.id] };
      });
    }
    if (message.type === 'PK_INTENT' && sender.tab) {
      if ((await settingsFor(sender.tab)).enabled) await setLock(sender.tab.id, !!message.locked, S.origin(sender.tab.url), sender.frameId);
      return { ok: true };
    }
    if (message.type === 'PK_STATE' && sender.tab && !extensionPage) {
      await recordFrame(sender, message.state || {});
      return { ok: true };
    }
    if (message.type === 'PK_GONE' && sender.tab && !extensionPage) {
      await serialized(async () => {
        const { tabFrames = {} } = await chrome.storage.session.get('tabFrames');
        if (tabFrames[sender.tab.id]?.[sender.frameId]?.documentId === sender.documentId) delete tabFrames[sender.tab.id][sender.frameId];
        await chrome.storage.session.set({ tabFrames });
        await updateAction(sender.tab.id);
      });
      return { ok: true };
    }
    if (message.type === 'PK_RECHECK' && sender.tab && !extensionPage) {
      const current = await status(sender.tab.id);
      await serialized(async () => {
        const { tabFrames = {} } = await chrome.storage.session.get('tabFrames');
        tabFrames[sender.tab.id] = Object.fromEntries(current.frames.map(f => [f.frameId, { enabled: f.enabled, available: f.available }]));
        await chrome.storage.session.set({ tabFrames });
      });
      return { ok: true };
    }
    if (extensionPage && message.type === 'PK_STATUS') return status(message.tabId);
    if (extensionPage && message.type === 'PK_SAVE') {
      const tab = await chrome.tabs.get(message.tabId);
      const origin = S.origin(tab.url);
      if (!origin || origin !== message.origin) throw new Error('The tab changed. Open the popup again.');
      const clean = Object.fromEntries(Object.keys(S.defaults).map(k => [k, !!message.config[k]]));
      await serialized(async () => {
        const { sites = {} } = await chrome.storage.local.get('sites');
        sites[origin] = clean;
        await chrome.storage.local.set({ sites });
        await registerSites();
      });
      if (!clean.enabled) await setLock(tab.id, false);
      // Settings changes work immediately on an already open streaming page.
      if (clean.enabled) await injectNow(tab.id);
      await broadcast(tab.id, { type: 'PK_REFRESH' });
      await status(tab.id);
      return { ok: true };
    }
    if (extensionPage && message.type === 'PK_CONTROL') {
      const tab = await chrome.tabs.get(message.tabId);
      if (!(await settingsFor(tab)).enabled) throw new Error('Enable protection on this site first.');
      if (message.command === 'lock') { await setLock(tab.id, true); return status(tab.id); }
      if (message.command === 'play') return resume(tab.id);
    }
    return { ok: false };
  })().then(reply, e => reply({ error: e.message }));
  return true;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  try {
  if (command !== 'toggle-pause-lock' || !tab?.id || !(await settingsFor(tab)).enabled) return;
  const { tabLocks = {} } = await chrome.storage.session.get('tabLocks');
  if (tabLocks[tab.id]) await resume(tab.id); else await setLock(tab.id, true);
  } catch { /* The tab can close or become inaccessible during an action. */ }
});
chrome.tabs.onRemoved.addListener(tabId => serialized(async () => {
  const { tabLocks = {}, tabOrigins = {}, tabFrames = {} } = await chrome.storage.session.get(['tabLocks', 'tabOrigins', 'tabFrames']);
  delete tabLocks[tabId]; delete tabOrigins[tabId]; delete tabFrames[tabId]; iconCache.delete(tabId);
  await chrome.storage.session.set({ tabLocks, tabOrigins, tabFrames });
}).catch(() => {}));
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url || change.status === 'loading') {
    // Moving to a different site clears a latch from the previous site's player.
    serialized(async () => {
      const { tabOrigins = {}, tabLocks = {}, tabFrames = {} } = await chrome.storage.session.get(['tabOrigins', 'tabLocks', 'tabFrames']);
      const origin = S.origin(tab.url);
      if (tabOrigins[tabId] && tabOrigins[tabId] !== origin) { delete tabLocks[tabId]; await chrome.action.setBadgeText({ tabId, text: '' }); }
      tabOrigins[tabId] = origin;
      if (change.status === 'loading') delete tabFrames[tabId];
      await chrome.storage.session.set({ tabOrigins, tabLocks, tabFrames });
      await updateAction(tabId);
    }).catch(() => {});
  }
});
chrome.permissions.onRemoved.addListener(() => serialized(registerSites).catch(() => {}));
async function initialize() {
  await migrateCompatibility();
  await registerSites();
  iconCache.clear();
  for (const tab of await chrome.tabs.query({})) await updateAction(tab.id);
}
chrome.runtime.onInstalled.addListener(() => serialized(initialize).catch(console.error));
chrome.runtime.onStartup.addListener(() => serialized(initialize).catch(console.error));
