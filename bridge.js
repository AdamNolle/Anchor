(() => {
  if (globalThis.__pauseKeeperBridge) return;
  globalThis.__pauseKeeperBridge = true;
  const localIntents = new Set(['user-pause', 'manual-pause', 'user-play', 'manual-play', 'auto-block', 'hidden', 'strict-pause']);
  let stateKey = '', recheckPending = false;
  function send(data) { document.dispatchEvent(new CustomEvent('pause-keeper:command', { detail: JSON.stringify(data) })); }
  async function refresh() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'PK_SETTINGS' });
      if (response?.config) send({ command: 'configure', ...response });
    } catch { send({ command: 'configure', config: { enabled: false } }); }
  }
  document.addEventListener('pause-keeper:status', event => {
    try {
      const state = JSON.parse(event.detail);
      globalThis.__pauseKeeperStatus = { enabled: !!state.enabled, available: !!state.available, playing: !!state.playing, locked: !!state.locked, blocked: Number(state.blocked) || 0, media: Number(state.media) || 0, score: Number(state.score) || 0, error: String(state.error || '').slice(0,180) };
      const nextKey = `${state.enabled}:${state.available}:${state.media}`;
      if (nextKey !== stateKey) {
        stateKey = nextKey;
        chrome.runtime.sendMessage({ type: 'PK_STATE', state: globalThis.__pauseKeeperStatus }).catch(() => {});
      }
      if (localIntents.has(state.reason) && state.enabled) chrome.runtime.sendMessage({ type: 'PK_INTENT', locked: !!state.locked }).catch(() => {});
    } catch { /* Ignore malformed page messages. */ }
  });
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message.type === 'PK_REFRESH') { refresh().then(() => reply({ ok: true })); return true; }
    if (message.type === 'PK_COMMAND') { send(message); reply({ ok: true }); }
  });
  chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'local') refresh(); });
  window.addEventListener('pagehide', () => { chrome.runtime.sendMessage({ type: 'PK_GONE' }).catch(() => {}); });
  window.addEventListener('pageshow', () => { stateKey = ''; refresh(); });
  new MutationObserver(records => {
    const removedFrame = records.some(r => [...r.removedNodes].some(n => n.nodeType === 1 && (n.tagName === 'IFRAME' || n.querySelector?.('iframe'))));
    if (removedFrame && !recheckPending) {
      recheckPending = true;
      setTimeout(() => { recheckPending = false; chrome.runtime.sendMessage({ type: 'PK_RECHECK' }).catch(() => {}); }, 100);
    }
  }).observe(document, { childList: true, subtree: true });
  refresh();
})();
