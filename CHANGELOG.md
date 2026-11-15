# Changelog

## 1.0.0 — first stable release

The first published release. Development builds were numbered 1.1.0–1.2.2 before this; settings saved by them are migrated automatically.

### Ignored sites

- Add an ignored-sites list. The popup's **Protect this site** switch ignores or restores the current site, and the new options page adds, validates and removes any site (hostnames, URLs or IPs, covering subdomains). It also lists and resets sites with custom preferences.
- Ignored sites are excluded from content-script injection entirely. Content scripts are now registered dynamically, falling back gracefully if a browser rejects an option or pattern.
- Ignore social feeds by default: X/Twitter, Facebook, Instagram, Threads, TikTok, Reddit, LinkedIn, Pinterest, Snapchat, Tumblr and Bluesky. Upgrading from a development build migrates its per-site switches into the list and keeps explicit social opt-ins.
- Apply ignore changes to open tabs immediately, and protect already-open tabs after install or update.

### Autoplay and next episodes

- A pause hold now belongs to the page where you paused. Opening a different title, by full navigation or in-app routing (Hulu, Netflix, YouTube and similar), releases it so the next video autoplays. Reloads, hash changes and timestamp/tracking parameters keep it.
- Holds apply to the player you paused, its replacements and overlays, not the whole tab. Other videos on news pages, feeds and articles keep autoplaying. Popup **Keep paused** still holds the whole tab.
- **Next episode**, **Play episode**, **Replay**, **Resume** and **Watch** controls now release a hold instead of being ignored.
- Clicking an unlabelled or localized Play overlay on a paused player resumes it. Seek bars, volume and menus still keep the hold.
- Controls act on the video they belong to on pages with several players.
- Blocked `play()` calls reject with `AbortError` instead of `NotAllowedError`, so players no longer fall back to muted autoplay or a stuck "click to play" screen.
- **Stop autoplay & next episodes** now holds each video until you start it, instead of releasing every video on the page once one plays.

### Fewer false pauses

- Clicks no longer inherit Play/Pause meaning from distant labelled containers. "Skip intro" inside a `play-pause` wrapper is not a pause, and labels on wrappers are only hints confirmed by the site's own `pause()`/`play()`.
- A click on a playing video without native controls no longer forces a pause; the site's own response decides.
- Recognized pause buttons let the site pause first, so its player state stays in sync.
- Detached sound effects (`new Audio()`) are never blocked.

### Keyboard

- Space/K apply only to a player you are watching (a large unmuted video or one you have used), so muted autoplay clips and ads no longer stop pages from scrolling.
- Arrow-key seeking only fills in when the site has no arrow shortcut of its own, avoiding errors in DRM players that fail when their position is changed underneath them.
- A site's own K/Space shortcut pressed while its Play button still has focus (YouTube after clicking Play) now establishes and releases holds correctly.

### Reliability

- Coalesce status reports during heavy DOM churn and skip unchanged status ticks.
- Rebuild frame state when a page finishes loading, keep document IDs for rechecked frames, and survive tabs closing during icon updates.
- Validate page references, pageKey parity and dynamic script registration in `npm run check`.
- Add `npm run package`, which builds a reproducible `dist/anchor-<version>.zip` containing only extension files, and `scripts/screenshots.cjs` for README images.
- Add 21 release regression checks covering ignored sites, social and news autoplay, navigation-scoped holds, next episodes, per-player holds and keyboard behavior.

## Development builds

Unpublished builds that preceded 1.0.0.

### Development build 1.2.2

- Disable protection on LinkedIn by default so feed videos do not capture typing shortcuts.
- Preserve keyboard input in rich text editors, editor wrappers, shadow-root editors, and document editing mode.
- Reset saved Hulu autoplay blocking and strict pause options once on upgrade so next episodes and source transitions can play normally. Clear old Hulu and LinkedIn pause holds during that reset.
- Keep deliberate-pause protection and respect settings chosen after the compatibility reset.
- Add LinkedIn typing and Hulu episode-transition regression coverage.

### Development build 1.2.1

- Apply a black-and-white theme to the popup, help page, buttons, controls, statuses, errors, and keyboard focus.

### Development build 1.2.0

- Add portable development dependencies and Windows/macOS/Linux browser CI.
- Keep closed shadow-root players discoverable after their host is reattached.
- Register media listeners once when a player is removed and reattached.
- Clear stale native Play gestures when a later pause is requested.
- Restore actual Media Session playback state when a site changes it unexpectedly.
- Normalize media-key identifiers for both keydown and keyup.
- Ignore malformed page commands and handle tabs closing during extension actions.
- Include the site origin in the toolbar state cache to refresh navigation titles.

### Development build 1.1.1

- Remove the default quick-toggle shortcut that conflicts with Brave.
- Display the actual assigned shortcut in the popup.

### Development build 1.1.0

- Add automatic HTTP/HTTPS player coverage, embedded players, shadow roots, and media-key support.
- Add black active icons and gray inactive icons.
