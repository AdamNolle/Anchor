# Changelog

## 1.2.1

- Apply a black-and-white theme to the popup, help page, buttons, controls, statuses, errors, and keyboard focus.

## 1.2.0

- Add portable development dependencies and Windows/macOS/Linux browser CI.
- Keep closed shadow-root players discoverable after their host is reattached.
- Register media listeners once when a player is removed and reattached.
- Clear stale native Play gestures when a later pause is requested.
- Restore actual Media Session playback state when a site changes it unexpectedly.
- Normalize media-key identifiers for both keydown and keyup.
- Ignore malformed page commands and handle tabs closing during extension actions.
- Include the site origin in the toolbar state cache to refresh navigation titles.

## 1.1.1

- Remove the default quick-toggle shortcut that conflicts with Brave.
- Display the actual assigned shortcut in the popup.

## 1.1.0

- Add automatic HTTP/HTTPS player coverage, embedded players, shadow roots, and media-key support.
- Add black active icons and gray inactive icons.
