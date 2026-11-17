# Chrome Web Store listing

Copy for the store submission form. Images are in this folder.

## Name

Anchor

## Summary (132 characters max)

Keeps web video and audio paused until you resume, with media-key support, automatic player detection, and ignored sites.

(This comes from `manifest.json`, so the dashboard fills it in for you.)

## Description

You pause a show to grab a drink. The player decides you didn't mean it: an ad ends, the stream reconnects, a script calls play(), and it starts again without you. Anchor stops that.

Paused should mean paused. Anchor holds your pause until you press play, then gets out of the way for everything else.

What it does
• Holds your pause. Scripted restarts, reconnects and ad transitions can't resume a video you paused.
• Autoplay still works. Next episodes, new titles and in-app navigation play normally. The hold belongs to the video you paused, not the whole site.
• Polite on busy pages. Pausing one news clip leaves the others alone, and muted autoplay clips never take over your Space bar.
• Ignored sites. Turn Anchor off for any site in one click. Social feeds are ignored out of the box.
• Media keys everywhere. Play/Pause, Play, Pause and Stop work even while you're typing in a text field.
• Works with any HTML player. Embedded iframes, shadow-DOM players and self-hosted servers like Jellyfin and Plex are detected automatically.

Optional per-site preferences
• Reliable keyboard controls: Space/K play and pause, arrow keys seek 10 seconds on players without their own shortcuts
• Stop autoplay & next episodes: every video waits until you start it
• Lock every pause: also holds pauses Anchor can't attribute to you
• Pause when leaving this tab

The toolbar icon turns white when Anchor is protecting a player and gray on ignored sites or pages without one. While a video is held, the icon shows a pause badge. You can assign a keyboard shortcut for Keep paused / Resume in your browser's extension shortcuts.

Private by design: no network requests, analytics, accounts or remote code. Settings stay on your device. Anchor doesn't skip ads, bypass DRM, or change what a site streams.

## Category

Make Chrome Yours → Functionality & UI (or Lifestyle → Entertainment)

## Language

English

## Graphics

| File | Use |
| --- | --- |
| `../icons/128.png` | Store icon (128×128) |
| `screenshot-1.png` | Screenshot (1280×800) |
| `screenshot-2.png` | Screenshot (1280×800) |
| `screenshot-3.png` | Screenshot (1280×800) |
| `promo-small.png` | Small promo tile (440×280) |
| `promo-marquee.png` | Marquee promo tile (1400×560) |

## Additional fields

- **Homepage URL:** https://github.com/AdamNolle/Anchor
- **Support URL:** https://github.com/AdamNolle/Anchor/issues

## Privacy tab

**Single purpose**

Keeps web video and audio the user has paused from restarting until the user resumes it.

**Permission justification**

| Permission | Why |
| --- | --- |
| `storage` | Saves the user's settings and ignored-sites list on their device, and keeps the current pause holds in session storage so they survive the service worker restarting. |
| `scripting` | Registers Anchor's content scripts dynamically so ignored sites can be excluded entirely, and adds Anchor to tabs that are already open when it is installed or updated. |
| Host access to `http://*/*` and `https://*/*` | Anchor has to detect and control HTML video and audio players on whatever site the user watches, including players embedded from other sites in iframes. Streaming sites, news sites and self-hosted servers (Jellyfin, Plex) live on arbitrary domains, so a fixed list of hosts would not work. Page access is used only on the device to find media elements and block scripted play() calls; nothing is read from or sent off the page. |

**Remote code:** No, I am not using remote code. All JavaScript ships in the package.

**Data usage:** The extension does not collect or transmit any user data. Tick none of the data categories. Certify all three statements:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://github.com/AdamNolle/Anchor/blob/main/PRIVACY.md

## Package

Run `npm run package` and upload `dist/anchor-1.0.0.zip`.

## Review note

Broad host permissions usually send an item to in-depth review, so the first review can take longer than usual. The justification above explains why every site is needed.
