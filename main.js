/* Runs in the player page so cached media methods are intercepted at document_start.
 * No network requests, player API dependencies, ads/DRM changes, or remote code. */
(() => {
  'use strict';
  if (window.__pauseKeeperEngine) return;
  window.__pauseKeeperEngine = true;
  const proto = HTMLMediaElement.prototype;
  const nativePlay = proto.play;
  const nativePause = proto.pause;
  const GESTURE_MS = 800, RESUME_MS = 1200;
  let config = { enabled: false, blockAutoplay: false, strictPause: false, fixKeyboard: true, pauseWhenHidden: false };
  let configured = false, locked = false, blocked = 0, hasPlayed = false, error = '';
  /* What a hold covers. holdAll: every player in this frame (popup Keep paused,
   * pause when hidden, a fresh page with autoplay blocking). Otherwise `holds` lists
   * player slots: the paused media, anything that replaces it, and anything layered
   * over it. Other videos on the page (feeds, news articles) keep working. */
  let holdAll = false, holds = [], pendingHold = false, pendingBox = null;
  let allowed = []; // Slots the user started while "Stop autoplay" is on.
  let recentGesture = null, pendingResume = null, activeMedia = null, lastBlockedAt = 0;
  const media = new Set(), roots = new Set(), observers = [];
  const listenedMedia = new WeakSet(), shadowRoots = new WeakMap(), engaged = new WeakSet();
  const keyUps = new Set();
  let session = null, nativeSetAction = null, lastSessionState = '', priorPlaybackState = null;
  const siteHandlers = new Map(), installedActions = new Set();
  let mediaActionVersion = 0, suppressSessionUntil = 0, reportTimer = 0, lastStatus = '';
  const now = () => performance.now();
  const isMedia = el => el instanceof HTMLMediaElement;
  const live = () => [...media].filter(el => el.isConnected);
  const hasSource = el => !!(el.currentSrc || el.getAttribute('src') || el.srcObject || el.querySelector('source[src]'));
  function score(el) {
    if (!el.isConnected) return 0;
    const rect = el.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    return (visible ? Math.min(rect.width * rect.height, 4000000) : 0) + (!el.paused ? 8000000 : 0) + (el === activeMedia ? 4000000 : 0) + (el.tagName === 'VIDEO' ? 1000 : 1);
  }
  function primary() { return live().filter(el => hasSource(el) && !el.error).sort((a,b) => score(b) - score(a))[0] || null; }

  /* Player slots, in page coordinates so scrolling does not change them. */
  function box(el) {
    if (!el?.isConnected) return null;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 ? { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height } : null;
  }
  function validBox(b) { return b && [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 1 && b.h > 1 ? { x: b.x, y: b.y, w: b.w, h: b.h } : null; }
  function slotOf(el) { return el ? { el, box: box(el) } : null; }
  function refreshSlot(slot) { const b = box(slot?.el); if (b) slot.box = b; }
  function sameSlot(slot, el) {
    if (!slot || !el) return false;
    if (slot.el === el) return true;
    const gone = !slot.el.isConnected;
    const a = (!gone && box(slot.el)) || slot.box, b = box(el);
    // Invisible media (audio, hidden players) replaces a player that is gone or invisible.
    if (!b) return gone || !box(slot.el);
    return !!a && overlaps(a, b);
  }
  function overlaps(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 && w * h >= 0.5 * Math.min(a.w * a.h, b.w * b.h);
  }
  function setLocked() { locked = holdAll || pendingHold || holds.length > 0; }
  function isHeld(el) {
    if (!locked || !el?.isConnected) return false;
    if (holdAll || holds.some(slot => sameSlot(slot, el))) return true;
    // After a reload, the hold returns to the player in the same place, or to the
    // only player on the page.
    if (pendingHold) {
      const b = box(el);
      const onlyPlayer = document.readyState !== 'loading' && live().filter(hasSource).length === 1;
      if (pendingBox ? (b && overlaps(pendingBox, b)) || onlyPlayer : true) {
        pendingHold = false; pendingBox = null; holds.push(slotOf(el)); return true;
      }
    }
    return false;
  }
  function autoplayAllowed(el) { return !config.blockAutoplay || allowed.some(slot => sameSlot(slot, el)); }
  function allow(el) {
    if (!el || allowed.some(slot => slot.el === el)) return;
    allowed = [...allowed.filter(slot => slot.el.isConnected), slotOf(el)].slice(-20);
  }
  function disallow(el) { allowed = allowed.filter(slot => !sameSlot(slot, el)); }

  function report(reason = 'status') {
    if (reportTimer) { clearTimeout(reportTimer); reportTimer = 0; }
    const player = primary();
    syncMediaSession(player);
    const slot = !holdAll && holds.length ? holds[holds.length - 1].box : pendingBox;
    const detail = JSON.stringify({ enabled: config.enabled, available: !!player, playing: !!player && !player.paused, locked, scope: holdAll ? 'all' : 'media', slot, blocked, media: live().filter(hasSource).length, score: player ? score(player) : 0, error, reason });
    // Routine status ticks only matter when something changed.
    if (reason === 'status' && detail === lastStatus) return;
    lastStatus = reason === 'status' ? detail : '';
    document.dispatchEvent(new CustomEvent('pause-keeper:status', { detail }));
  }
  // DOM churn on large streaming apps is constant; coalesce layout-reading status reports.
  function scheduleReport() { if (!reportTimer) reportTimer = setTimeout(() => { reportTimer = 0; report(); }, 120); }
  function enforce() {
    for (const el of live()) if (!el.paused && isHeld(el)) { try { nativePause.call(el); } catch {} }
  }
  /* target: a media element for a one-player hold, 'all' for the whole frame,
   * or 'pending' to hold the first player that starts (a reloaded page). */
  function lock(reason, target = 'all', enforceNow = true, slotBox = null) {
    if (!config.enabled) return;
    // An earlier native Play gesture must not undo a later explicit pause.
    recentGesture = null; pendingResume = null;
    if (target === 'all' || !target) { holdAll = true; holds = []; pendingHold = false; }
    else if (!holdAll) {
      if (target === 'pending') { pendingHold = true; pendingBox = slotBox; }
      else if (!holds.some(slot => slot.el === target)) holds = [...holds.filter(slot => slot.el.isConnected), slotOf(target)].slice(-10);
    }
    setLocked();
    if (enforceNow) enforce();
    report(reason);
  }
  function clearHolds() { locked = false; holdAll = false; holds = []; pendingHold = false; pendingBox = null; pendingResume = null; }
  function release(reason) { clearHolds(); error = ''; report(reason); }
  function userPlay(el, reason = 'user-play') {
    hasPlayed = true;
    if (el) { activeMedia = el; engaged.add(el); allow(el); }
    if (!locked) return;
    if (!el || holdAll || pendingHold) { release(reason); return; }
    // Playing one video releases its own slot; an unrelated video on the page
    // does not undo the pause on another.
    const remaining = holds.filter(slot => !sameSlot(slot, el));
    if (remaining.length === holds.length) return;
    holds = remaining; setLocked(); error = '';
    report(reason);
  }
  function blockedAttempt(el) {
    if (!el.paused) nativePause.call(el);
    // Avoid counting 'play' and 'playing' as separate retries or flooding the bridge.
    if (now() - lastBlockedAt > 150 || blocked === 0) { blocked++; lastBlockedAt = now(); report('blocked'); }
  }
  /* Whether Anchor stops this media from starting now. */
  function shouldBlock(el) {
    if (!config.enabled || !el.isConnected) return false;
    if (isHeld(el)) { if (!requestedPlay(el)) return true; userPlay(el); return false; }
    if (!autoplayAllowed(el)) { if (!requestedPlay(el)) return true; userPlay(el); }
    return false;
  }
  function intentionalPlay(el, reason = 'user-play') {
    el ||= primary();
    if (locked) release(reason);
    userPlay(el, reason);
    if (el) nativePlay.call(el).catch(e => {
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
    if (!el.paused && shouldBlock(el)) blockedAttempt(el);
  }
  function freshGesture(el) {
    return recentGesture && now() - recentGesture.time < GESTURE_MS && (!recentGesture.media || recentGesture.media === el);
  }
  /* A play request the user asked for: a native-control/media click, a website
   * shortcut, or a click on the player surface that the site answers with play(). */
  function requestedPlay(el) {
    if (freshGesture(el) && recentGesture.action === 'play' && (recentGesture.native || recentGesture.soft)) return true;
    return !!pendingResume && now() - pendingResume.time < RESUME_MS && sameSlot(pendingResume.slot, el);
  }
  function onMedia(event) {
    const el = event.currentTarget;
    if (!config.enabled) return;
    if (event.type === 'play' || event.type === 'playing') {
      if (shouldBlock(el)) blockedAttempt(el);
      else if (el === primary()) activeMedia = el;
    } else if (event.type === 'pause' && !el.ended && !isHeld(el)) {
      if (freshGesture(el) && recentGesture.action !== 'play' && !el.seeking && el.readyState >= 2) { engaged.add(el); lock('user-pause', el); }
      else if (config.strictPause && el === primary() && el.readyState >= 2 && !el.seeking && !el.error) lock('strict-pause', el);
    } else if (event.type === 'ended' && config.blockAutoplay && (el === activeMedia || el === primary())) {
      // The next episode, in this element or a replacement, waits for the user.
      disallow(el);
      lock('auto-block', el);
    }
    if (event.type === 'play' || event.type === 'pause' || event.type === 'ended') report(); else scheduleReport();
  }
  proto.play = function (...args) {
    remember(this);
    if (locked) checkNavigation();
    if (shouldBlock(this)) {
      blockedAttempt(this);
      // The same error the browser reports when pause() interrupts play(). Players
      // treat it as benign, whereas NotAllowedError makes many of them fall back to
      // muted autoplay or a "click to play" screen that survives a later resume.
      return Promise.reject(new DOMException('The play() request was interrupted because Anchor is holding this player paused.', 'AbortError'));
    }
    return nativePlay.apply(this, args);
  };
  proto.pause = function (...args) {
    remember(this);
    if (config.enabled && !isHeld(this) && !this.ended && !this.seeking && this.readyState >= 2) {
      if (freshGesture(this) && recentGesture.action !== 'play') { engaged.add(this); lock('user-pause', this, false); }
      else if (config.strictPause && this === primary()) lock('strict-pause', this, false);
    }
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
      scheduleReport();
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
  function editable(el) {
    return el instanceof Element && (el.matches('input,textarea,select,[role="textbox"],[role="searchbox"],[role="slider"],[role="combobox"],[role="menuitem"],[role="spinbutton"],[contenteditable]:not([contenteditable="false"]),[aria-multiline="true"],[data-lexical-editor],[data-slate-editor]') || el.isContentEditable);
  }
  function typing(event) {
    if (path(event).some(editable)) return true;
    if (event.type !== 'keydown' && event.type !== 'keyup') return false;
    if (document.designMode.toLowerCase() === 'on') return true;
    // Some editors retarget keyboard events to a wrapper or document body.
    for (let focused = document.activeElement; focused; focused = focused.shadowRoot?.activeElement) {
      if (editable(focused)) return true;
    }
    return false;
  }

  /* Classifying website controls. Text comes from labels, test ids and (for real
   * buttons) class names, split into lowercase words: "btnPause" -> " btn pause ". */
  const INTERACTIVE = 'button,a[href],[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="switch"],[role="checkbox"],[role="option"],summary,input,select,textarea';
  const SEEKER = '[role="slider"],[role="progressbar"],[role="scrollbar"],[aria-valuenow],input,select,textarea';
  const ATTRS = ['aria-label', 'title', 'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-action', 'data-uia', 'data-automationid', 'data-automation-id', 'data-e2e'];
  const TOGGLE = / (play ?pause|pause ?play|toggle ?(play|pause|playback)|play(back)? ?toggle|play ?control|icon ?playback)/;
  const PAUSE = / (btn ?|icon ?)?pause/;
  const PLAY = / (btn ?|icon ?)?play( |button|btn|icon|arrow|circle|fill|filled|outline)/;
  // Starting different content is a request to play, never a request to stay paused.
  const START = / (resume|unpause|replay|restart|start over|from (the )?beginning|watch(?! ?list)|continue watching|next|previous|episode)/;
  // Words that make a control something other than plain play/pause.
  const OTHER = / (skip|intro|recap|credits|next|previous|prev|episode|season|volume|mute|unmute|captions?|subtitles?|cc|audio|language|quality|settings?|full ?screen|pip|picture|cast|airplay|share|like|dislike|save|watch ?list|my list|info|details|close|exit|back|forward|rewind|seek|speed|rate|autoplay|trailer|preview|menu|more|replay|restart|report)( |$)/;
  const NOT_PLAY = / (autoplay|skip|rewind|forward|seek|volume|mute|settings?|speed|rate|quality|menu|playlist|watch ?list)( |$)/;
  const SEEK_WORDS = / (progress|scrub|scrubber|timeline|seek ?bar|slider|volume|rail|time ?bar)( |$)/;
  const SURFACE_BLOCK =/ (progress|scrub|scrubber|timeline|seek|seekbar|slider|volume|rail|settings?|menu|captions?|subtitles?|skip|ad|ads|advert|sponsor)( |$)/;
  function words(text) { return ' ' + String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' '; }
  function labelText(el, interactive, depth) {
    const parts = ATTRS.map(a => el.getAttribute(a));
    if (interactive) parts.push(el.textContent?.slice(0, 70), el.querySelector('svg use')?.getAttribute('href'));
    if (interactive || depth < 2) parts.push(el.getAttribute('class'));
    return words(parts.filter(Boolean).join(' '));
  }
  function classify(text) {
    const pause = PAUSE.test(text), play = PLAY.test(text);
    if (!OTHER.test(text)) {
      if (TOGGLE.test(text) || (pause && play)) return 'toggle';
      if (pause) return 'pause';
    }
    if (!NOT_PLAY.test(text) && !pause && (play || START.test(text))) return 'play';
    return null;
  }
  const inside = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  /* The player a click belongs to: the media under the pointer, else the media in
   * the nearest wrapper around the control. Pages with many videos (feeds, news)
   * act on the clicked one, not whichever is largest. */
  function mediaFor(event) {
    const candidates = live().filter(el => hasSource(el) && !el.error);
    if (!candidates.length) return null;
    const x = event.clientX, y = event.clientY, hasPoint = Number.isFinite(x) && (x || y);
    if (hasPoint) {
      const under = candidates.filter(el => inside(el.getBoundingClientRect(), x, y)).sort((a, b) => score(b) - score(a))[0];
      if (under) return under;
    }
    if (candidates.length === 1) return candidates[0];
    let depth = 0;
    for (const el of path(event)) {
      if (!(el instanceof Element) || ++depth > 12) break;
      const within = candidates.filter(m => el.contains(m));
      if (!within.length) continue;
      if (within.length === 1 || !hasPoint) return within.sort((a, b) => score(b) - score(a))[0];
      const distance = m => { const r = m.getBoundingClientRect(); return Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom)); };
      return within.sort((a, b) => distance(a) - distance(b))[0];
    }
    return primary();
  }
  function controlAction(event) {
    let depth = 0;
    for (const el of path(event)) {
      if (!(el instanceof Element)) continue;
      if (isMedia(el)) return { action: el.paused || isHeld(el) ? 'play' : 'pause', media: el, native: true };
      // Only the clicked element and its close wrappers can describe the control;
      // the first real button or link decides, so "Skip intro" inside a labelled
      // player container is never mistaken for that container's Pause.
      if (depth++ > 5) return null;
      if (el.matches(SEEKER)) return null;
      const interactive = el.matches(INTERACTIVE);
      const text = labelText(el, interactive, depth - 1);
      // Timelines, scrubbers and volume rails are never Play/Pause.
      if (SEEK_WORDS.test(text)) return null;
      const kind = classify(text);
      if (kind) {
        const player = mediaFor(event);
        if (!player) return null;
        // A label found on a wrapper around an unlabelled click target is only a
        // hint: record it and let the site's own pause()/play() confirm it.
        const soft = !interactive && depth > 1;
        return { action: kind === 'toggle' ? (isHeld(player) || player.paused ? 'play' : 'pause') : kind, media: player, soft };
      }
      if (interactive) return null;
    }
    return null;
  }
  // A click on a player itself (often an unlabelled or localized Play overlay).
  // Seek bars, volume, menus and ad links are excluded.
  function playerSurface(event) {
    if (!Number.isFinite(event.clientX)) return null;
    const player = live().filter(el => hasSource(el) && inside(el.getBoundingClientRect(), event.clientX, event.clientY)).sort((a, b) => score(b) - score(a))[0];
    if (!player) return null;
    let depth = 0;
    for (const el of path(event)) {
      if (!(el instanceof Element) || isMedia(el)) continue;
      if (depth++ > 5) break;
      if (el.matches(SEEKER) || el.matches('[role="menu"],[role="dialog"],[role="listbox"],a[href]') || SURFACE_BLOCK.test(labelText(el, true, 0))) return null;
    }
    return player;
  }
  window.addEventListener('pointerdown', event => {
    if (!event.isTrusted || !config.enabled || typing(event)) return;
    const control = controlAction(event);
    if (control) recentGesture = { ...control, time: now() };
  }, true);
  window.addEventListener('click', event => {
    if (!event.isTrusted || !config.enabled || typing(event)) return;
    const control = controlAction(event);
    if (!control) {
      const surface = (locked || config.blockAutoplay) && playerSurface(event);
      if (surface) pendingResume = { slot: slotOf(surface), time: now() };
      return;
    }
    const prior = recentGesture && now() - recentGesture.time < GESTURE_MS && recentGesture.media === control.media ? recentGesture : null;
    // A click on a media element may toggle it, show controls, or seek. Let an
    // actual pause() / play() establish intent instead of guessing from the click.
    if (control.native || control.soft) {
      recentGesture = { ...(prior || control), native: control.native, soft: control.soft, media: control.media, time: now() };
      return;
    }
    const action = prior ? prior.action : control.action;
    recentGesture = { ...control, action, time: now() };
    if (action === 'play') userPlay(control.media);
    else {
      const target = control.media;
      engaged.add(target);
      lock('user-pause', target, false);
      // Let the site's own handler pause first so its player state stays in sync;
      // enforce afterward for controls whose handler does not pause.
      setTimeout(() => { if (locked) enforce(); }, 0);
    }
  }, true);

  /* Page-level shortcuts (Space, K, arrows) only apply to a player the user is
   * watching: one they have used that is on screen (or audio), or a large unmuted
   * video. A small or muted ad, preview, or feed video never takes over Space. */
  function keyboardPlayer() {
    const player = primary();
    if (!player) return null;
    const r = player.getBoundingClientRect(), vw = innerWidth || 1, vh = innerHeight || 1;
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)), h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    if (engaged.has(player) && (player.tagName === 'AUDIO' || r.width === 0 || w * h > 0)) return player;
    if (player.tagName !== 'VIDEO' || player.muted) return null;
    return w * h >= vw * vh * 0.2 || (w >= vw * 0.5 && h >= vh * 0.25) ? player : null;
  }
  const mediaKeys = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop'];
  const inputKey = event => mediaKeys.includes(event.key) ? event.key : event.code || event.key;
  const focusedControl = event => path(event).some(el => el instanceof Element && el.matches('button,a,[role="button"],[role="link"],[role="tab"],[role="option"],summary'));
  window.addEventListener('keydown', event => {
    if (!event.isTrusted || !config.enabled) return;
    const key = inputKey(event);
    // Hardware media keys should keep working while typing or focusing buttons.
    if (mediaKeys.includes(key)) {
      const player = primary();
      if (!player) return;
      event.preventDefault(); event.stopImmediatePropagation(); keyUps.add(key);
      suppressSessionUntil = now() + 250;
      if (!event.repeat) runMediaAction(key === 'MediaPlayPause' ? (isHeld(player) || player.paused ? 'play' : 'pause') : key === 'MediaPlay' ? 'play' : key === 'MediaStop' ? 'stop' : 'pause');
      return;
    }
    if (!['Space', 'KeyK'].includes(key) || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || typing(event)) return;
    const player = keyboardPlayer();
    if (!player) return;
    const action = isHeld(player) || player.paused ? 'play' : 'pause';
    // A focused button or link keeps its own keyboard activation. The site may
    // still treat the key as its play/pause shortcut (YouTube's K after clicking
    // its Play button), so record the intent and let the site's pause()/play() decide.
    if (focusedControl(event)) { if (!event.repeat) recentGesture = { media: player, action, soft: true, time: now() }; return; }
    if (config.fixKeyboard) {
      event.preventDefault(); event.stopImmediatePropagation(); keyUps.add(key);
      if (event.repeat) return;
      recentGesture = { media: player, action, time: now() };
      if (action === 'play') intentionalPlay(player); else { engaged.add(player); lock('user-pause', player); }
    } else if (!event.repeat) {
      // Website shortcuts: record the intent and let the website act. Its own
      // play() releases the hold and its pause() establishes one.
      recentGesture = { media: player, action, soft: true, time: now() };
    }
  }, true);
  // Arrow seeking only fills in for players that do not handle arrows themselves;
  // some DRM players fail when their position is changed underneath them.
  window.addEventListener('keydown', event => {
    if (!event.isTrusted || !config.enabled || !config.fixKeyboard || event.defaultPrevented) return;
    const key = inputKey(event);
    if (!['ArrowLeft', 'ArrowRight'].includes(key) || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || typing(event) || focusedControl(event)) return;
    const player = keyboardPlayer();
    if (!player || !Number.isFinite(player.duration) || player.duration <= 0) return;
    const ranges = player.seekable;
    if (!ranges.length) return;
    event.preventDefault();
    const delta = key === 'ArrowLeft' ? -10 : 10;
    player.currentTime = Math.max(ranges.start(0), Math.min(ranges.end(ranges.length - 1), player.currentTime + delta));
  });
  window.addEventListener('keyup', event => {
    if (event.isTrusted && keyUps.delete(inputKey(event))) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (config.enabled && config.pauseWhenHidden && document.hidden && live().some(el => !el.paused)) lock('hidden');
  });

  /* In-app navigation to a different title. A hold belongs to the page where the
   * user paused; the next video should play (unless autoplay blocking is on).
   * Keep pageKey() in sync with PauseKeeperSettings.pageKey(). */
  const topFrame = (() => { try { return window.top === window; } catch { return false; } })();
  function pageKey(url) {
    try {
      const u = new URL(url);
      const volatile = /^(t|time|start|ts|timestamp|position|resume|autoplay|ref|ref_|refsrc|trackid|tctx|si|feature|pp|ab_channel|fbclid|gclid|utm_.*)$/i;
      const params = [...u.searchParams].filter(([k]) => !volatile.test(k)).map(([k, v]) => `${k}=${v}`).sort().join('&');
      return u.origin + (u.pathname.replace(/\/ref=[^/]*/g, '').replace(/\/+$/, '') || '/') + (params ? '?' + params : '');
    } catch { return null; }
  }
  let currentPage = pageKey(location.href);
  function checkNavigation() {
    if (!topFrame) return;
    const next = pageKey(location.href);
    if (next === currentPage) return;
    currentPage = next;
    recentGesture = null; pendingResume = null;
    if (!config.enabled) return;
    if (config.blockAutoplay) { hasPlayed = false; allowed = []; lock('auto-block'); }
    else if (locked) release('navigated');
  }
  if (topFrame) {
    // Synchronous, so an app that calls pushState() and then play() is not blocked.
    if (window.navigation?.addEventListener) window.navigation.addEventListener('currententrychange', checkNavigation);
    window.addEventListener('popstate', checkNavigation);
  }

  function runMediaAction(action, details = { action }) {
    const player = primary();
    const handler = siteHandlers.get(action);
    if (!config.enabled) { if (handler) return handler(details); return; }
    const version = ++mediaActionVersion;
    recentGesture = { media: player, action: action === 'play' ? 'play' : 'pause', time: now() };
    if (action === 'play') {
      // The OS play action targets this tab's session as a whole.
      if (locked) release('user-play');
      userPlay(player);
      if (!handler) { intentionalPlay(player); return; }
    } else if (player) { engaged.add(player); lock('user-pause', player); }
    try {
      const result = handler?.(details);
      if (result?.catch) result.catch(() => {});
    } catch { /* A broken website handler must not break the media key fallback. */ }
    if (action !== 'play') { if (locked) enforce(); return; }
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
    const state = isHeld(player) || player.paused ? 'paused' : 'playing';
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
      if (!config.enabled) { clearHolds(); error = ''; recentGesture = null; report(); return; }
      if (first && data.locked === true) lock('synced');
      // A one-player hold returns to the frame where it was made, for the first
      // player that starts after the reload.
      else if (first && data.locked?.scope === 'media' && data.locked.frame === pageKey(location.href)) lock('synced', 'pending', true, validBox(data.locked.slot));
      else if (first && config.blockAutoplay && !hasPlayed) lock('auto-block');
      report();
    } else if (config.enabled) {
      if (data.command === 'lock-sync') lock('synced');
      if (data.command === 'lock') lock('manual-pause');
      if (data.command === 'release') release('synced');
      if (data.command === 'play') intentionalPlay(primary(), 'manual-play');
    }
  });
  // Covers native autoplay, old cached play(), source replacement, late shadow
  // roots, and navigation in browsers without the Navigation API. It does nothing
  // to playback while protection is off or no hold exists.
  setInterval(() => {
    for (const el of media) if (!el.isConnected) media.delete(el);
    for (let i = observers.length - 1; i >= 0; i--) {
      if (observers[i].root.host && !observers[i].root.host.isConnected) { observers[i].observer.disconnect(); roots.delete(observers[i].root); observers.splice(i, 1); }
    }
    checkNavigation();
    for (const slot of holds) refreshSlot(slot);
    for (const slot of allowed) refreshSlot(slot);
    // Shadow roots are captured by attachShadow and DOM mutations above. Avoid
    // walking every element on every timer tick on large streaming pages.
    if (config.enabled) for (const el of live()) if (!el.paused && shouldBlock(el)) blockedAttempt(el);
    report();
  }, 1000);
})();
