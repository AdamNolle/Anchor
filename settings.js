/* Shared only by extension pages and the service worker. */
globalThis.PauseKeeperSettings = {
  // Per-site playback preferences. Whether a site is protected at all is decided
  // by the ignored-sites list, not stored per origin.
  defaults: { fixKeyboard: true, blockAutoplay: false, strictPause: false, pauseWhenHidden: false },
  // Social feeds autoplay and pause videos as you scroll and use Space/K for
  // their own shortcuts, so they are ignored by default. Users can remove any entry.
  defaultIgnored: ['bsky.app', 'facebook.com', 'instagram.com', 'linkedin.com', 'pinterest.com', 'reddit.com', 'snapchat.com', 'threads.com', 'threads.net', 'tiktok.com', 'tumblr.com', 'twitter.com', 'x.com'],
  maxIgnored: 500,
  isHulu(origin) {
    try { const u = new URL(origin); return u.protocol === 'https:' && (u.hostname === 'hulu.com' || u.hostname.endsWith('.hulu.com')); }
    catch { return false; }
  },
  isLinkedIn(origin) {
    try { const host = new URL(origin).hostname; return host === 'linkedin.com' || host.endsWith('.linkedin.com'); }
    catch { return false; }
  },
  origin(url) { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; } },
  /* Accepts a hostname, a URL, or a "*.example.com" wildcard and returns the
   * canonical ignored-site entry ("example.com"), or null when invalid. */
  normalizeHost(input) {
    let text = String(input ?? '').trim().toLowerCase();
    if (!text || /\s/.test(text)) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = 'http://' + text.replace(/^\*\./, '');
    let host;
    try { const u = new URL(text); if (!/^https?:$/.test(u.protocol)) return null; host = u.hostname; }
    catch { return null; }
    host = host.replace(/\.$/, '').replace(/^www\./, '');
    if (!host || host.length > 253) return null;
    if (host.startsWith('[')) return /^\[[0-9a-f:.]+\]$/.test(host) ? host : null;
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host) || host.split('.').some(l => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return null;
    return host;
  },
  cleanIgnored(list) {
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
      const host = this.normalizeHost(item);
      if (host && !out.includes(host)) out.push(host);
    }
    return out.sort().slice(0, this.maxIgnored);
  },
  isIp(host) { return host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host); },
  /* The ignored entry that covers this URL/origin/hostname: the entry itself or a parent domain. */
  ignoredBy(urlOrHost, list = []) {
    let host;
    try { host = new URL(urlOrHost).hostname; } catch { host = String(urlOrHost || ''); }
    host = host.toLowerCase().replace(/\.$/, '');
    if (!host) return null;
    return list.find(entry => host === entry || (!this.isIp(entry) && host.endsWith('.' + entry))) || null;
  },
  isIgnored(urlOrHost, list = []) { return !!this.ignoredBy(urlOrHost, list); },
  /* Content-script exclusion patterns. "*.example.com" also matches example.com. */
  excludePatterns(list = []) {
    return this.cleanIgnored(list).map(host => this.isIp(host) || !host.includes('.') ? `*://${host}/*` : `*://*.${host}/*`);
  },
  prefs(stored) {
    const out = { ...this.defaults };
    for (const key of Object.keys(this.defaults)) if (typeof stored?.[key] === 'boolean') out[key] = stored[key];
    return out;
  },
  forOrigin(origin, sites = {}, ignored = this.defaultIgnored) {
    const valid = !!this.origin(origin);
    return { ...this.prefs(valid ? sites[origin] : null), enabled: valid && !this.isIgnored(origin, ignored) };
  },
  /* Identifies the title being watched. A pause hold belongs to one page: reloads
   * keep it, but opening a different video (including in-app navigation) clears it.
   * Hashes, trailing slashes and timestamp/tracking parameters are ignored.
   * Keep in sync with pageKey() in main.js. */
  pageKey(url) {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return null;
      const volatile = /^(t|time|start|ts|timestamp|position|resume|autoplay|ref|ref_|refsrc|trackid|tctx|si|feature|pp|ab_channel|fbclid|gclid|utm_.*)$/i;
      const params = [...u.searchParams].filter(([k]) => !volatile.test(k)).map(([k, v]) => `${k}=${v}`).sort().join('&');
      return u.origin + (u.pathname.replace(/\/ref=[^/]*/g, '').replace(/\/+$/, '') || '/') + (params ? '?' + params : '');
    } catch { return null; }
  }
};
