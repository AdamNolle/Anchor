/* Runs in the player page so cached media methods are intercepted at document_start.
 * No network requests, player API dependencies, ads/DRM changes, or remote code. */
(() => {
  'use strict';
  if (window.__pauseKeeperEngine) return;
  window.__pauseKeeperEngine = true;
  const proto = HTMLMediaElement.prototype;
  const nativePlay = proto.play;
  const nativePause = proto.pause;
  let config = { enabled: false, blockAutoplay: false, strictPause: false, fixKeyboard: true, pauseWhenHidden: false };
  let configured = false, locked = false, blocked = 0, hasPlayed = false, error = '';
  let recentGesture = null, activeMedia = null, lastBlockedAt = 0;
  const media = new Set(), roots = new Set(), observers = [];
  const listenedMedia = new WeakSet(), shadowRoots = new WeakMap();
  const keyUps = new Set();
  let session = null, nativeSetAction = null, lastSessionState = '', priorPlaybackState = null;
  const siteHandlers = new Map(), installedActions = new Set();
  let mediaActionVersion = 0, suppressSessionUntil = 0;
  const now = () => performance.now();
  const isMedia = el => el instanceof HTMLMediaElement;
  const live = () => [...media].filter(el => el.isConnected);
  const hasSource = el => !!(el.currentSrc || el.getAttribute('src') || el.srcObject || el.querySelector('source[src]'));
  function score(el) {
    const rect = el.getBoundingClientRect();
    if (!el.isConnected) return 0;
    const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    return (visible ? Math.min(rect.width * rect.height, 4000000) : 0) + (!el.paused ? 8000000 : 0) + (el === activeMedia ? 4000000 : 0) + (el.tagName === 'VIDEO' ? 1000 : 1);
  }
  function primary() { return live().filter(el => hasSource(el) && !el.error).sort((a,b) => score(b) - score(a))[0] || null; }
  function report(reason = 'status') {
    const player = primary();
    syncMediaSession(player);
    document.dispatchEvent(new CustomEvent('pause-keeper:status', { detail: JSON.stringify({ enabled: config.enabled, available: !!player, playing: !!player && !player.paused, locked, blocked, media: live().filter(hasSource).length, score: player ? score(player) : 0, error, reason }) }));
  }
  function pauseAll() {
    for (const el of live()) if (!el.paused) { try { nativePause.call(el); } catch {} }
  }
  function lock(reason, enforce = true) {
    if (!config.enabled) return;
    // An earlier native Play gesture must not undo a later explicit pause.
    recentGesture = null;
    locked = true;
    if (enforce) pauseAll();
    report(reason);
  }
  function release(reason) { locked = false; error = ''; report(reason); }
  function blockedAttempt(el) {
    if (!el.paused) nativePause.call(el);
    // Avoid counting 'play' and 'playing' as separate retries or flooding the bridge.
    if (now() - lastBlockedAt > 150 || blocked === 0) { blocked++; lastBlockedAt = now(); report('blocked'); }
  }
  function intentionalPlay(el, reason = 'user-play') {
    hasPlayed = true;
    activeMedia = el || primary();
    release(reason);
    if (activeMedia) nativePlay.call(activeMedia).catch(e => {
      if (e.name === 'AbortError' || locked) return;
      error = `${e.name}: ${e.message}`; report('play-error');
    });
  }
  function remember(el) {
    if (!isMedia(el) || media.has(el)) return;
    media.add(el);
    if (!listenedMedia.has(el)) {
      listenedMedia.add(el);
      for (const name of ['play', 'playing', 'pause', 'ended', 'loadedmetadata', 'loadeddata', 'emptied', 'error']) el.addEventListener(name, onMedia);
    }
    if (config.enabled && locked && !el.paused) blockedAttempt(el);
  }
  function freshGesture(el) {
    return recentGesture && now() - recentGesture.time < 800 && (!recentGesture.media || recentGesture.media === el);
  }
  function onMedia(event) {
    const el = event.currentTarget;
    if (!config.enabled) return;
    if (event.type === 'play' || event.type === 'playing') {
      if (locked && freshGesture(el) && recentGesture.native && recentGesture.action === 'play') { hasPlayed = true; activeMedia = el; release('user-play'); }
      else if (locked) blockedAttempt(el);
      else if (el === primary()) activeMedia = el;
    } else if (event.type === 'pause' && !el.ended && !locked) {
      if (freshGesture(el) && recentGesture.action !== 'play' && !el.seeking && el.readyState >= 2) lock('user-pause');
      else if (config.strictPause && el === primary() && el.readyState >= 2 && !el.seeking && !el.error) lock('strict-pause');
    } else if (event.type === 'ended' && config.blockAutoplay && (el === activeMedia || el === primary())) {
      lock('auto-block');
    }
    report();
  }
  proto.play = function (...args) {
    remember(this);
    if (config.enabled && locked && freshGesture(this) && recentGesture.native && recentGesture.action === 'play') { hasPlayed = true; activeMedia = this; release('user-play'); }
    if (config.enabled && locked) {
      blockedAttempt(this);
      // Reject honestly, like Chrome's own autoplay policy. Do not report false success.
      return Promise.reject(new DOMException('Anchor is holding this player paused. Press Play to resume.', 'NotAllowedError'));
    }
    return nativePlay.apply(this, args);
  };
  proto.pause = function (...args) {
    remember(this);
    if (config.enabled && !locked && !this.ended && !this.seeking && this.readyState >= 2 && (freshGesture(this) && recentGesture.action !== 'play')) lock('user-pause', false);
    if (config.enabled && config.strictPause && !locked && !this.ended && this === primary() && !this.seeking && this.readyState >= 2) lock('strict-pause', false);
    return nativePause.apply(this, args);
  };

  function discover(node) {
    if (isMedia(node)) remember(node);
    const nodeRoot = node.shadowRoot || shadowRoots.get(node);
    if (nodeRoot) observeRoot(nodeRoot);
    if (node.querySelectorAll) {
      for (const el of node.querySelectorAll('video,audio')) remember(el);
      for (const el of node.querySelectorAll('*')) {
        const root = el.shadowRoot || shadowRoots.get(el);
        if (root) observeRoot(root);
      }
    }
  }
  function observeRoot(root) {
    if (roots.has(root)) return;
    roots.add(root);
    discover(root);
    const observer = new MutationObserver(records => {
      for (const r of records) {
        if (r.type === 'attributes' && isMedia(r.target)) remember(r.target);
        for (const node of r.addedNodes) if (node.nodeType === 1) discover(node);
      }
      report();
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    observers.push({ root, observer });
  }
  observeRoot(document);
  // Register roots as they are created so even a closed shadow-root player is
  // protected. Return the original root unchanged to preserve component behavior.
  const nativeAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (...args) {
    const root = nativeAttachShadow.apply(this, args);
    shadowRoots.set(this, root);
    observeRoot(root);
    return root;
  };

  function path(event) { return event.composedPath ? event.composedPath() : [event.target]; }
  function typing(event) {
    return path(event).some(el => el instanceof Element && (el.matches('input,textarea,select,[role="textbox"],[role="slider"],[role="combobox"],[role="menuitem"]') || el.isContentEditable));
  }
  function controlAction(event) {
    for (const el of path(event)) {
      if (!(el instanceof Element)) continue;
      if (isMedia(el)) return { action: el.paused ? 'play' : 'pause', media: el, native: true };
      if (!el.matches('button,[role="button"],a,[aria-label],[data-testid],[data-action],[data-uia]')) continue;
      const button = el.matches('button,[role="button"]');
      const text = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid'), el.getAttribute('data-action'), el.getAttribute('data-uia'), button ? el.textContent?.slice(0, 70) : '', button ? el.getAttribute('class') : '', button ? el.querySelector('svg use')?.getAttribute('href') : ''].filter(Boolean).join(' ').toLowerCase();
      const player = primary();
      if (!player) return null;
      // Playback controls only. A next-item, playlist, or trailer button is not Resume.
      if (/next|playlist|trailer|preview|replay|playback speed|autoplay/.test(text)) return null;
      if (/play.?pause|toggle.?play|toggle.?pause|play.?control|icon.?playback/.test(text)) return { action: locked || player.paused ? 'play' : 'pause', media: player };
      if (/(^|[\s_\-])pause([\s_\-]|$)|pausebutton|pause-button|btnpause/.test(text)) return { action: 'pause', media: player };
      if (/(^|[\s_\-])play([\s_\-]|$)|playbutton|play-button|btnplay/.test(text)) return { action: 'play', media: player };
    }
    return null;
  }
  window.addEventListener('pointerdown', event => {
    if (!event.isTrusted || !config.enabled || typing(event)) return;
    const control = controlAction(event);
    if (control) recentGesture = { ...control, time: now() };
  }, true);
  window.addEventListener('click', event => {
    if (!event.isTrusted || !config.enabled || typing(event)) return;
    const control = controlAction(event);
    if (!control) return;
    // Native video controls include timeline, volume and fullscreen. Let an actual
    // pause() / pause event establish intent instead of guessing from a video click.
    if (control.native && control.media.controls) {
      const prior = recentGesture && now() - recentGesture.time < 800 && recentGesture.media === control.media ? recentGesture : control;
      recentGesture = { ...prior, native: true, media: control.media, time: now() };
      return;
    }
    const action = recentGesture && now() - recentGesture.time < 800 && recentGesture.media === control.media ? recentGesture.action : control.action;
    recentGesture = { ...control, action, time: now() };
    if (action === 'play') {
      hasPlayed = true; activeMedia = control.media; release('user-play');
    } else {
      lock('user-pause', false);
      queueMicrotask(() => { if (locked) pauseAll(); });
    }
  }, true);

  const mediaKeys = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop'];
  const inputKey = event => mediaKeys.includes(event.key) ? event.key : event.code || event.key;
  window.addEventListener('keydown', event => {
    if (!event.isTrusted || !config.enabled) return;
    const player = primary();
    if (!player) return;
    const key = inputKey(event);
    const mediaKey = mediaKeys.includes(key);
    // Hardware media keys should keep working while typing or focusing buttons.
    if (mediaKey) {
      event.preventDefault(); event.stopImmediatePropagation(); keyUps.add(key);
      suppressSessionUntil = now() + 250;
      if (!event.repeat) runMediaAction(key === 'MediaPlayPause' ? (locked || player.paused ? 'play' : 'pause') : key === 'MediaPlay' ? 'play' : key === 'MediaStop' ? 'stop' : 'pause');
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || typing(event)) return;
    const toggle = ['Space', 'KeyK'].includes(key);
    // Preserve keyboard activation of focused buttons and links.
    const focusedControl = path(event).some(el => el instanceof Element && el.matches('button,a,[role="button"]'));
    if (focusedControl) return;
    if (toggle && config.fixKeyboard) {
      event.preventDefault(); event.stopImmediatePropagation(); keyUps.add(key);
      if (event.repeat) return;
      recentGesture = { media: player, action: locked || player.paused ? 'play' : 'pause', time: now() };
      if (recentGesture.action === 'play') intentionalPlay(player); else lock('user-pause');
    } else if (config.fixKeyboard && ['ArrowLeft', 'ArrowRight'].includes(key)) {
      event.preventDefault(); event.stopImmediatePropagation(); keyUps.add(key);
      if (Number.isFinite(player.duration) && player.duration > 0) {
        const delta = key === 'ArrowLeft' ? -10 : 10;
        const ranges = player.seekable;
        const start = ranges.length ? ranges.start(0) : 0;
        const end = ranges.length ? ranges.end(ranges.length - 1) : player.duration;
        player.currentTime = Math.max(start, Math.min(end, player.currentTime + delta));
      }
    } else if (toggle && !event.repeat) {
      // Native website shortcuts: record the intent and let the website act.
      recentGesture = { media: player, action: locked || player.paused ? 'play' : 'pause', time: now() };
      if (recentGesture.action === 'play') { hasPlayed = true; release('user-play'); }
      else { lock('user-pause', false); queueMicrotask(() => { if (locked) pauseAll(); }); }
    }
  }, true);
  window.addEventListener('keyup', event => {
    if (event.isTrusted && keyUps.delete(inputKey(event))) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (config.enabled && config.pauseWhenHidden && document.hidden && live().some(el => !el.paused)) lock('hidden');
  });

  function runMediaAction(action, details = { action }) {
    const player = primary();
    const handler = siteHandlers.get(action);
    if (!config.enabled) { if (handler) return handler(details); return; }
    const version = ++mediaActionVersion;
    recentGesture = { media: player, action: action === 'play' ? 'play' : 'pause', time: now() };
    if (action === 'play') {
      hasPlayed = true; activeMedia = player; release('user-play');
      if (!handler) { intentionalPlay(player); return; }
    } else lock('user-pause');
    try {
      const result = handler?.(details);
      if (result?.catch) result.catch(() => {});
    } catch { /* A broken website handler must not break the media key fallback. */ }
    if (action !== 'play') { if (locked) pauseAll(); return; }
    // Retain player-specific Media Session behavior; recover if its Play callback
    // forgot to start the media. A newer pause always cancels this fallback.
    setTimeout(() => {
      if (version === mediaActionVersion && config.enabled && !locked && primary()?.paused) intentionalPlay(primary());
    }, 350);
  }
  function syncMediaSession(player) {
    if (!session || !nativeSetAction) return;
    if (!config.enabled || !player) {
      for (const action of installedActions) {
        try { nativeSetAction.call(session, action, siteHandlers.get(action) || null); } catch {}
      }
      installedActions.clear(); lastSessionState = '';
      if (priorPlaybackState !== null) { try { session.playbackState = priorPlaybackState; } catch {} priorPlaybackState = null; }
      return;
    }
    if (priorPlaybackState === null) priorPlaybackState = session.playbackState;
    for (const action of ['play', 'pause', 'stop']) if (!installedActions.has(action)) {
      try {
        nativeSetAction.call(session, action, details => { if (now() >= suppressSessionUntil) runMediaAction(action, details); });
        installedActions.add(action);
      } catch {}
    }
    const state = locked || player.paused ? 'paused' : 'playing';
    if (state !== lastSessionState || session.playbackState !== state) { try { session.playbackState = state; lastSessionState = state; } catch {} }
  }
  if (navigator.mediaSession) {
    session = navigator.mediaSession;
    nativeSetAction = session.setActionHandler;
    session.setActionHandler = function (action, handler) {
      if (!['play','pause','stop'].includes(action) || (handler !== null && typeof handler !== 'function')) return nativeSetAction.call(this, action, handler);
      siteHandlers.set(action, handler);
      installedActions.delete(action);
      if (config.enabled && primary()) syncMediaSession(primary());
      else return nativeSetAction.call(this, action, handler);
    };
  }

  document.addEventListener('pause-keeper:command', event => {
    let data;
    try { data = JSON.parse(event.detail); } catch { return; }
    if (!data || typeof data !== 'object') return;
    if (data.command === 'configure') {
      const first = !configured;
      config = { ...config, ...data.config };
      configured = true;
      if (!config.enabled) { locked = false; error = ''; report(); return; }
      if (data.locked && first) lock('synced');
      else if (first && config.blockAutoplay && !hasPlayed) lock('auto-block');
      report();
    } else if (config.enabled) {
      if (data.command === 'lock-sync') lock('synced');
      if (data.command === 'lock') lock('manual-pause');
      if (data.command === 'release') release('synced');
      if (data.command === 'play') intentionalPlay(primary(), 'manual-play');
    }
  });
  // Covers native autoplay, old cached play(), source replacement, and late shadow
  // roots. It does nothing to playback while protection is off or no lock exists.
  setInterval(() => {
    for (const el of media) if (!el.isConnected) media.delete(el);
    for (let i = observers.length - 1; i >= 0; i--) {
      if (observers[i].root.host && !observers[i].root.host.isConnected) { observers[i].observer.disconnect(); roots.delete(observers[i].root); observers.splice(i, 1); }
    }
    // Shadow roots are captured by attachShadow and DOM mutations above. Avoid
    // walking every element on every timer tick on large streaming pages.
    if (config.enabled && locked) for (const el of live()) if (!el.paused) blockedAttempt(el);
    report();
  }, 1000);
})();
