# Anchor validation

## Version 1.2.1 theme

Verified the rendered popup and help page with black backgrounds, white controls, grayscale secondary text, checked controls, and the held-pause status. Manifest, assets, package versions, and JavaScript syntax pass validation. Playback code is unchanged from 1.2.0; the CI workflow runs the full suite for this update.

## Version 1.2.0 browser baseline

- **Windows / Chromium: 70 passing checks**, including three shortcut checks.
- **Windows / Brave: 70 passing checks**, including three shortcut checks.

The shipped manifest, syntax, assets, and package versions also passed validation. Tests use real HTML media with local WAV fixtures in isolated browser profiles.

## Playback and keyboard — 24 checks

- Hulu default content scripts and bridge initialize.
- Explicit Play starts media.
- Click Pause holds against repeated scripted restarts.
- Explicit Play releases the pause latch.
- Space overrides duplicate website keydown and keyup handlers.
- Synthetic page clicks cannot release a user pause.
- K pauses and resumes without repeat-toggle.
- Typing and editing do not engage extension keyboard handling.
- Seek controls preserve a pause latch.
- Replacement player is held paused.
- Reload retains the pause latch in session storage.
- Popup Resume releases the latch and plays the primary media.
- Normal programmatic pause and recovery are allowed by default.
- Strict pause option catches programmatic pause.
- Autoplay protection starts a fresh page held paused.
- Ending media blocks the next autoplay attempt.
- Pause state propagates to newly created permitted iframe.
- Disabling protection restores normal playback.
- Popup renders controls and settings without errors.
- Native controls cannot bypass the pause latch; popup Resume works.
- Native autoplay on a replacement player is re-paused.
- Open shadow-root player is held and can resume explicitly.
- Pause-when-hidden option latches until explicit resume.
- No uncaught player errors.

## Sites, frames, and icons — 26 checks

- No player means gray icon and inactive title.
- Jellyfin-style server activates automatically with black anchor.
- Unlabelled Jellyfin btnPause control locks scripted restarts.
- Hardware Play/Pause key resumes and latches again.
- Hardware media keys work while a search field has focus.
- Dedicated Play, Pause and Stop keys are handled.
- Repeating a held media key does not toggle again.
- Pause survives reload on a custom HTTP server.
- Changing ports activates the new server and clears the old pause.
- Disabling a site grays its icon and restores media playback.
- Re-enabling a site restores its active icon without a reload.
- Document-start protection on www.netflix.com generic player fixture.
- Document-start protection on www.disneyplus.com generic player fixture.
- Document-start protection on www.primevideo.com generic player fixture.
- Document-start protection on www.youtube.com generic player fixture.
- Document-start protection on tv.apple.com generic player fixture.
- Document-start protection on www.peacocktv.com generic player fixture.
- Document-start protection on www.paramountplus.com generic player fixture.
- Document-start protection on www.max.com generic player fixture.
- Document-start protection on www.twitch.tv generic player fixture.
- Cross-origin embedded player activates an otherwise empty page.
- Removing the only iframe grays the icon and drops stale frame state.
- Closed shadow-root autoplay inherits the pause latch.
- A broken media source grays its icon.
- Browser settings pages keep the icon gray.
- Closed tabs remove frames, pause state and current origin.

## Media Session — 10 checks

- Fallback Media Session handlers exist when the site supplies none.
- OS Play starts the default player and OS Pause holds it.
- OS Play releases an existing pause latch.
- Site-specific Play and Pause callbacks are preserved and run once.
- Removing a site handler leaves the generic hardware fallback.
- A broken or no-op site Play handler recovers through the fallback.
- A newer Pause cancels delayed Play recovery.
- OS Stop is a persistent pause without losing the viewing position.
- Disabling restores original site callbacks and playbackState.
- Removing the player unregisters Anchor fallback callbacks.

## Lifecycle hardening — 7 checks

- Malformed null and primitive commands do not throw.
- A later explicit pause cancels a stale native Play gesture.
- Reattached media keeps only one set of listener registrations.
- Closed shadow roots regain protection after host reattachment.
- Media Session state repairs a site overwrite while held paused.
- Media-key keyup uses the same identity as keydown.
- Pause protection works when Media Session is unavailable.

## Shortcut handling — 3 checks

- The optional quick-toggle command has no reserved default shortcut.
- The popup explains how to configure an unassigned shortcut.
- The popup directs users to reassign the old conflicting Brave shortcut.

## Platform validation

Local Chromium and installed Brave tests ran on Windows. GitHub Actions runs the same portable suite on Windows, macOS, and Linux; consult the repository Actions page for current results. ChromeOS has compatible APIs but has not been directly tested. Mobile Chrome/Brave, Firefox, and Safari are outside this package's supported scope.

## Limits of these results

Hulu, Netflix, Disney+, Prime Video, YouTube, Apple TV, Peacock, Paramount+, Max, Twitch, and Jellyfin-style URLs are intercepted to serve generic test players. These establish automatic injection and playback control on those origins, not production-service compatibility.

A limited live Hulu smoke test in Brave confirmed player detection, playback with the site's Play control, and Anchor's Keep paused control. Media-key tests use Chromium DevTools dispatch. Media Session tests register browser handlers and exercise their callbacks with a recording shim. No physical keyboard/headset matrix, OS media routing matrix, or complete live streaming-service/DRM/ad-transition matrix has been tested. Hidden-tab policy is checked with simulated visibility state.

No test suite establishes zero bugs or prevents a page from replacing media methods or overriding page-side commands. Anchor is a playback convenience tool, not a security boundary. Black icons indicate detected playable media, not a guarantee of full-service compatibility.
