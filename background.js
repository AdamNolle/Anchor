importScripts('settings.js');
const S = PauseKeeperSettings;
let queue = Promise.resolve();
const serialized = (fn) => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };
const iconCache = new Map();
const SCRIPT_IDS = ['anchor-main', 'anchor-bridge'];
let compatibilityReady = null;

function migrateCompatibility() {
  if (!compatibilityReady) compatibilityReady = (async () => {
    const { compatibilityVersion = 0, sites = {}, ignoredSites } = await chrome.storage.local.get(['compatibilityVersion', 'sites', 'ignoredSites']);
    if (compatibilityVersion >= 2) return;
    if (compatibilityVersion < 1) {
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
    }
    // Version 2: per-site "Protect this site" switches become the ignored-sites
    // list, and social feeds are ignored by default unless one was explicitly
    // turned on (LinkedIn's version 1 opt-in, for example).
    const ignored = new Set(Array.isArray(ignoredSites) ? S.cleanIgnored(ignoredSites) : []);
    const optedIn = [];
    for (const [origin, config] of Object.entries(sites)) {
      if (config?.enabled === false && !S.isLinkedIn(origin)) { const host = S.normalizeHost(origin); if (host) ignored.add(host); }
      if (config?.enabled === true && (S.isLinkedIn(origin) || S.isIgnored(origin, S.defaultIgnored))) optedIn.push(origin);
      sites[origin] = S.prefs(config);
    }
    if (!Array.isArray(ignoredSites)) {
      for (const host of S.defaultIgnored) if (!optedIn.some(origin => S.isIgnored(origin, [host]))) ignored.add(host);
    }
    await chrome.storage.local.set({ sites, ignoredSites: S.cleanIgnored([...ignored]), compatibilityVersion: 2 });
  })().catch(error => { compatibilityReady = null; throw error; });
  return compatibilityReady;
}

async function getIgnored() {
  await migrateCompatibility();
  const { ignoredSites } = await chrome.storage.local.get('ignoredSites');
  return Array.isArray(ignoredSites) ? ignoredSites : S.defaultIgnored;
}

async function updateAction(tabId, frames) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  const config = await settingsFor(tab);
  const ignored = !!S.origin(tab.url) && !config.enabled;
  const { tabLocks = {}, tabFrames = {} } = await chrome.storage.session.get(['tabLocks', 'tabFrames']);
  const candidates = frames || Object.values(tabFrames[tabId] || {});
  const available = config.enabled && candidates.some(f => f.enabled && f.available);
  const locked = config.enabled && !!tabLocks[tabId];
  const key = `${S.origin(tab.url)}:${config.enabled}:${available}:${locked}`;
  if (iconCache.get(tabId) === key) return;
  const suffix = available ? '' : '-gray';
  try {
    await chrome.action.setIcon({ tabId, path: { 16: `icons/16${suffix}.png`, 32: `icons/32${suffix}.png` } });
    await chrome.action.setTitle({ tabId, title: !S.origin(tab.url) ? 'Anchor — unavailable on this page' : ignored ? 'Anchor — protection off (ignored site)' : !available ? 'Anchor — no playable media detected' : locked ? 'Anchor — held paused' : 'Anchor — player protected' });
    await chrome.action.setBadgeText({ tabId, text: locked ? 'Ⅱ' : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#000000' });
    iconCache.set(tabId, key);
  } catch { /* The tab closed while its icon was being updated. */ }
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
  const ignored = await getIgnored();
  const { sites = {} } = await chrome.storage.local.get('sites');
  return S.forOrigin(S.origin(tab.url), sites, ignored);
}

async function broadcast(tabId, message, excludeFrameId) {
  if (typeof excludeFrameId === 'number') {
    const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => true }).catch(() => []);
    await Promise.all(frames.filter(f => f.frameId !== excludeFrameId).map(f => chrome.tabs.sendMessage(tabId, message, { frameId: f.frameId }).catch(() => null)));
    return;
  }
  try { return await chrome.tabs.sendMessage(tabId, message); } catch { return null; }
}

/* A tab hold is either whole-tab (true: popup Keep paused, quick toggle, pause when
 * hidden) or one player's ({ scope: 'media', frame }: a pause on a single video). Only
 * whole-tab holds are pushed to every frame; a one-player hold returns after a reload
 * to the frame where it was made, so other videos on the page keep playing. */
async function setLock(tabId, locked, expectedOrigin, sourceFrameId, scope = 'all', frameUrl, slot = null) {
  return serialized(async () => {
    if (expectedOrigin && S.origin((await chrome.tabs.get(tabId)).url) !== expectedOrigin) return;
    const { tabLocks = {} } = await chrome.storage.session.get('tabLocks');
    const previous = tabLocks[tabId];
    const whole = !locked || scope === 'all' || !frameUrl;
    if (locked) tabLocks[tabId] = whole ? true : { scope: 'media', frame: S.pageKey(frameUrl), slot }; else delete tabLocks[tabId];
    await chrome.storage.session.set({ tabLocks });
    // The source frame has already acted. Echoing its previous pause back can
    // interrupt a newer Play gesture while the service worker is catching up.
    if (locked ? whole : previous === true) await broadcast(tabId, { type: 'PK_COMMAND', command: locked ? 'lock-sync' : 'release' }, sourceFrameId);
    await updateAction(tabId);
  });
}

/* Content scripts are registered dynamically so ignored sites can be excluded
 * entirely: Anchor does not run on them at all. Embedded players from other
 * origins inside an ignored page still load but receive protection-off settings. */
async function registerSites() {
  const ignored = await getIgnored();
  const base = { matches: ['http://*/*', 'https://*/*'], runAt: 'document_start', allFrames: true, persistAcrossSessions: true };
  // MAIN first: the bridge handshakes after the engine listener exists.
  const scripts = [{ id: SCRIPT_IDS[0], js: ['main.js'], world: 'MAIN', ...base }, { id: SCRIPT_IDS[1], js: ['bridge.js'], world: 'ISOLATED', ...base }];
  const excludeMatches = S.excludePatterns(ignored);
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const same = (a = [], b = []) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
  const current = SCRIPT_IDS.map(id => existing.find(s => s.id === id));
  if (current.every(s => s && s.matchOriginAsFallback && same(s.excludeMatches, excludeMatches))) return;
  // Update in place when possible so navigation never misses the scripts.
  if (current.every(Boolean)) {
    try { await chrome.scripting.updateContentScripts(scripts.map(s => ({ ...s, matchOriginAsFallback: true, excludeMatches }))); return; }
    catch { /* Fall through to a fresh registration. */ }
  }
  // Also remove the per-host registrations left by early development builds.
  const stale = existing.filter(s => s.id.startsWith('pk-') || SCRIPT_IDS.includes(s.id)).map(s => s.id);
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  // Degrade gracefully if a browser rejects an option or a pattern, instead of
  // leaving every site without protection.
  const attempts = [
    scripts.map(s => ({ ...s, matchOriginAsFallback: true, excludeMatches })),
    scripts.map(s => ({ ...s, matchOriginAsFallback: true })),
    scripts
  ];
  let lastError;
  for (const attempt of attempts) {
    try { await chrome.scripting.registerContentScripts(attempt); return; }
    catch (error) { lastError = error; await chrome.scripting.unregisterContentScripts({ ids: SCRIPT_IDS }).catch(() => {}); }
  }
  throw lastError;
}

async function ensureRegistered() {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS }).catch(() => []);
  if (existing.length !== SCRIPT_IDS.length) await registerSites();
}

async function injectNow(tabId) {
  // MAIN first: the bridge handshakes after the engine listener exists.
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['main.js'], world: 'MAIN' });
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['bridge.js'] });
}

async function status(tabId) {
  const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'ISOLATED', func: () => globalThis.__pauseKeeperStatus || null }).catch(() => []);
  const frames = results.filter(r => r.result).map(r => ({ frameId: r.frameId, documentId: r.documentId, ...r.result }));
  const { tabLocks = {} } = await chrome.storage.session.get('tabLocks');
  await updateAction(tabId, frames);
  return { locked: !!tabLocks[tabId], available: frames.some(f => f.enabled && f.available), blocked: frames.reduce((n, f) => n + (f.blocked || 0), 0), media: frames.reduce((n, f) => n + (f.media || 0), 0), frames };
}

async function resume(tabId) {
  const state = await status(tabId);
  const best = state.frames.filter(f => f.enabled && f.media > 0).sort((a, b) => b.score - a.score)[0];
  await setLock(tabId, false);
  if (best) await chrome.tabs.sendMessage(tabId, { type: 'PK_COMMAND', command: 'play' }, { frameId: best.frameId }).catch(() => null);
  return status(tabId);
}

/* Ignored-site changes apply to open tabs immediately: newly ignored pages switch
 * protection off and drop their hold; pages that are no longer ignored get Anchor. */
async function setIgnored(list) {
  const next = S.cleanIgnored(list);
  const previous = await getIgnored();
  await serialized(async () => {
    await chrome.storage.local.set({ ignoredSites: next });
    await registerSites();
  });
  for (const tab of await chrome.tabs.query({})) {
    if (!S.origin(tab.url)) continue;
    const was = S.isIgnored(tab.url, previous), is = S.isIgnored(tab.url, next);
    if (was === is) continue;
    try {
      if (is) await setLock(tab.id, false);
      else await injectNow(tab.id);
      await broadcast(tab.id, { type: 'PK_REFRESH' });
      iconCache.delete(tab.id);
      await updateAction(tab.id);
    } catch { /* Tabs can close or refuse injection (for example the Web Store). */ }
  }
  return next;
}

/* Clears a hold when the tab moves to a different site or a different title. */
async function trackPage(tabId, url) {
  const { tabPages = {}, tabLocks = {} } = await chrome.storage.session.get(['tabPages', 'tabLocks']);
  const page = S.pageKey(url);
  const changed = !!tabPages[tabId] && tabPages[tabId] !== page;
  if (changed && tabLocks[tabId]) delete tabLocks[tabId];
  tabPages[tabId] = page;
  await chrome.storage.session.set({ tabPages, tabLocks });
  const hold = tabLocks[tabId];
  return { changed, locked: hold === true ? true : hold?.scope === 'media' ? { scope: 'media', frame: hold.frame, slot: hold.slot || null } : false };
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const extensionPage = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
  if (!message || typeof message !== 'object') return false;
  (async () => {
    // Upgrade settings and old holds before any message reads session state.
    await migrateCompatibility();
    if (message.type === 'PK_SETTINGS' && sender.tab) {
      return serialized(async () => {
        const tab = await chrome.tabs.get(sender.tab.id);
        const { locked } = await trackPage(tab.id, tab.url);
        return { config: await settingsFor(tab), locked };
      });
    }
    if (message.type === 'PK_INTENT' && sender.tab) {
      if ((await settingsFor(sender.tab)).enabled) await setLock(sender.tab.id, !!message.locked, S.origin(sender.tab.url), sender.frameId, message.scope === 'media' ? 'media' : 'all', typeof message.frame === 'string' && S.origin(message.frame) === S.origin(sender.url) ? message.frame : sender.url, message.slot && typeof message.slot === 'object' ? message.slot : null);
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
        tabFrames[sender.tab.id] = Object.fromEntries(current.frames.map(f => [f.frameId, { documentId: f.documentId, enabled: f.enabled, available: f.available }]));
        await chrome.storage.session.set({ tabFrames });
      });
      return { ok: true };
    }
    if (!extensionPage) return { ok: false };
    if (message.type === 'PK_STATUS') return status(message.tabId);
    if (message.type === 'PK_SAVE') {
      const tab = await chrome.tabs.get(message.tabId);
      const origin = S.origin(tab.url);
      if (!origin || origin !== message.origin) throw new Error('The tab changed. Open the popup again.');
      const clean = Object.fromEntries(Object.keys(S.defaults).map(k => [k, !!message.config?.[k]]));
      await serialized(async () => {
        const { sites = {} } = await chrome.storage.local.get('sites');
        sites[origin] = clean;
        await chrome.storage.local.set({ sites });
      });
      await broadcast(tab.id, { type: 'PK_REFRESH' });
      await status(tab.id);
      return { ok: true };
    }
    if (message.type === 'PK_GET_IGNORED') return { ignoredSites: await getIgnored() };
    if (message.type === 'PK_SET_IGNORED') return { ignoredSites: await setIgnored(message.ignoredSites) };
    if (message.type === 'PK_IGNORE_SITE') {
      // Popup switch for the current tab. Turning protection back on removes every
      // entry that covers this site, including a parent domain.
      const tab = await chrome.tabs.get(message.tabId);
      if (!S.origin(tab.url) || S.origin(tab.url) !== message.origin) throw new Error('The tab changed. Open the popup again.');
      const list = await getIgnored();
      const host = new URL(tab.url).hostname;
      const next = message.ignore ? [...list, S.normalizeHost(host)] : list.filter(entry => !S.isIgnored(host, [entry]));
      const ignoredSites = await setIgnored(next);
      await status(tab.id);
      return { ignoredSites };
    }
    if (message.type === 'PK_RESET_SITE') {
      await serialized(async () => {
        const { sites = {} } = await chrome.storage.local.get('sites');
        delete sites[message.origin];
        await chrome.storage.local.set({ sites });
      });
      return { ok: true };
    }
    if (message.type === 'PK_CONTROL') {
      const tab = await chrome.tabs.get(message.tabId);
      if (!(await settingsFor(tab)).enabled) throw new Error('Protection is off for this site. Turn on “Protect this site” first.');
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
  const { tabLocks = {}, tabPages = {}, tabFrames = {} } = await chrome.storage.session.get(['tabLocks', 'tabPages', 'tabFrames']);
  delete tabLocks[tabId]; delete tabPages[tabId]; delete tabFrames[tabId]; iconCache.delete(tabId);
  await chrome.storage.session.set({ tabLocks, tabPages, tabFrames });
}).catch(() => {}));
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url || change.status === 'loading') {
    serialized(async () => {
      // A different site or a different title clears the previous player's hold.
      // In-app navigation keeps the document, so its frames are told directly.
      const { changed } = await trackPage(tabId, tab.url);
      if (changed) {
        await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
        await broadcast(tabId, { type: 'PK_COMMAND', command: 'release' });
      }
      await updateAction(tabId);
    }).catch(() => {});
  }
  // Rebuild frame state from the live document once loading finishes, so frames
  // of a previous document never keep the icon active.
  if (change.status === 'complete') status(tabId).then(current => serialized(async () => {
    const { tabFrames = {} } = await chrome.storage.session.get('tabFrames');
    tabFrames[tabId] = Object.fromEntries(current.frames.map(f => [f.frameId, { documentId: f.documentId, enabled: f.enabled, available: f.available }]));
    await chrome.storage.session.set({ tabFrames });
    await updateAction(tabId);
  })).catch(() => {});
});
chrome.storage.onChanged.addListener((changes, area) => {
  // Keeps registrations right if the list changes outside setIgnored (for example sync or tests).
  if (area === 'local' && changes.ignoredSites) serialized(registerSites).catch(console.error);
});
chrome.permissions.onRemoved.addListener(() => serialized(registerSites).catch(() => {}));
async function initialize({ injectOpenTabs = false } = {}) {
  await migrateCompatibility();
  await registerSites();
  iconCache.clear();
  const ignored = await getIgnored();
  for (const tab of await chrome.tabs.query({})) {
    // After install or update, bring Anchor to already-open pages so they work
    // without a reload (players created afterward are fully protected).
    if (injectOpenTabs && S.origin(tab.url) && !S.isIgnored(tab.url, ignored)) await injectNow(tab.id).catch(() => {});
    await updateAction(tab.id);
  }
}
chrome.runtime.onInstalled.addListener(() => serialized(() => initialize({ injectOpenTabs: true })).catch(console.error));
chrome.runtime.onStartup.addListener(() => serialized(initialize).catch(console.error));
// Service workers restart often; make sure content scripts stay registered.
serialized(ensureRegistered).catch(console.error);
