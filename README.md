# Anchor

![Anchor](icons/128.png)

Keep streaming players paused until you choose to resume. Anchor is a Manifest V3 extension for desktop Brave and Chrome. It automatically detects standard HTML video and audio players, including cross-origin frames and shadow-root players, across HTTP and HTTPS websites.

## Features

- Hold a deliberate pause against unwanted restart attempts.
- Play/pause, play, pause, and stop media-key support, including while typing.
- Media Session fallback handlers while preserving site callbacks.
- Black background with a white anchor for a detected player; gray icon for unavailable players or disabled protection.
- Space/K controls and ten-second arrow-key seeking.
- Per-site settings for autoplay blocking, strict pause detection, and pausing when leaving a tab.
- Local settings and session state; no telemetry, remote code, or network service.

## Install

1. Download the repository ZIP or clone this repository to a permanent folder.
2. Open `brave://extensions` or `chrome://extensions`, and enable Developer mode.
3. Select **Load unpacked** and choose the folder containing `manifest.json`.
4. Pin Anchor and reload already-open streaming pages.

To update, replace the extension files, click **Reload** on its extension card, and reload your streaming pages. No build step or npm installation is needed to use the extension.

## Supported platforms

| Platform | Scope |
| --- | --- |
| Windows | Desktop Chrome/Brave; browser integration tests run locally and in CI. |
| macOS | Desktop Chrome/Brave; Chromium integration tests in CI. |
| Linux | Desktop Chrome/Brave; Chromium integration tests in CI. |
| ChromeOS | Chrome extension APIs are compatible; no ChromeOS test environment is currently available. |
| Android / iOS / iPadOS | Chrome and Brave generally do not support loading this desktop extension. |
| Firefox / Safari | Not supported by this Chromium extension package. |

Requires Chromium 119+ and an operating system supported by your browser. OS media routing decides which tab or application receives physical keyboard/headset actions; browser callbacks and key dispatch tests cannot establish compatibility with every hardware device.

## Controls

Use your player's Play/Pause control, Space/K, media keys, or Anchor's **Keep paused** and **Resume** buttons. Pausing preserves the viewing position. Ordinary keyboard shortcuts leave text fields, sliders, links, and buttons alone.

An optional quick-toggle shortcut can be assigned at `brave://extensions/shortcuts` or `chrome://extensions/shortcuts`. The popup displays the actual assignment. Clear or reassign the old Alt+Shift+P shortcut because it conflicts with Brave.

**Lock every pause** catches unfamiliar controls but can interrupt buffering or player transitions. **Stop autoplay & next episodes** can also stop ad-to-content transitions. Both are off by default. If popup Resume hits browser autoplay restrictions after a reload, click the site's own Play button once.

## Tests and development

```sh
npm ci
npx playwright install --with-deps chromium
npm run check
npm test
```

Node.js 22+ is required for development. `ANCHOR_BROWSER` can point to an installed Brave executable to run the same suite against Brave. Tests use isolated temporary profiles and local/intercepted media fixtures. GitHub Actions runs the suite on Windows, macOS, and Linux. See [TESTING.md](TESTING.md) for validation scope and [CHANGELOG.md](CHANGELOG.md) for fixes.

## Limits

Anchor cannot guarantee every streaming service, player transition, or hardware device. It controls standard HTML media; native applications and non-HTML players are outside its scope. DRM and ads are not modified. Sites can replace browser methods or intentionally override page-side controls, so this is a playback convenience tool, not an enforcement or security boundary. Background timer throttling can delay recovery from cached native playback methods.

## License

MIT.
