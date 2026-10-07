/* Shared only by extension pages and the service worker. */
globalThis.PauseKeeperSettings = {
  defaults: { enabled: true, blockAutoplay: false, strictPause: false, fixKeyboard: true, pauseWhenHidden: false },
  isHulu(origin) {
    try { const u = new URL(origin); return u.protocol === 'https:' && (u.hostname === 'hulu.com' || u.hostname.endsWith('.hulu.com')); }
    catch { return false; }
  },
  forOrigin(origin, sites = {}) {
    return { ...this.defaults, enabled: !!this.origin(origin), ...sites[origin] };
  },
  origin(url) { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; } },
  pattern(origin) { return `${new URL(origin).protocol}//${new URL(origin).hostname}/*`; }
};
