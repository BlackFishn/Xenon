# YouTube player design preview

Run `node tools/preview-docs.cjs` from the repository root, then open
<http://127.0.0.1:8123/mockups/youtube-player.html>.
You can also open `youtube-player.html` directly in a browser; if clipboard
access is unavailable, paste into the link field with the keyboard.

This standalone mockup is for design review. It uses sample artwork and data,
simulates playback controls, and resets on reload. It does not contact YouTube,
play video or audio, or change the dashboard or saved settings.

## Revision 02

- Removed the separate playback controls below the video. The controls inside
  the video illustrate YouTube's own player; production must use the real embed
  controls, rather than recreate or overlay these illustrative controls.
- Fill widget hides the header, link field, queue, and video metadata. The
  player fills the remaining area below a slim restore strip. Restore layout or
  Escape brings the layout back without remounting the player or losing state.
- Fullscreen inside the mock video enters browser fullscreen. It is distinct
  from filling one widget. Controls fade when idle and remain accessible when
  paused or keyboard-focused.
- Artwork keeps its 16:9 aspect ratio with black space where needed.
- Queue, favorites, recent videos, loop, autoplay, and the empty-state preview
  remain available in the normal layout.

## Production connection

Use YouTube's embedded player with `controls=1`, `fs=1`, and fullscreen
permission on its iframe. Enable the IFrame API to load a pasted video ID and
advance the app's queue on player events. Keep the same iframe mounted while
changing the widget layout. The mockup's play, seek, volume, settings, and
fullscreen illustrations are replaced by the embed's native UI.

References: [Player parameters](https://developers.google.com/youtube/player_parameters)
and [IFrame API](https://developers.google.com/youtube/iframe_api_reference).

Screenshots: [Wide](youtube-player-wide.png),
[Video only](youtube-player-wide-focus.png), [Compact](youtube-player-compact.png),
[Edge](youtube-player-edge.png), [Portrait](youtube-player-portrait.png),
[Phone](youtube-player-phone.png), [Phone video only](youtube-player-phone-focus.png).

Validation: fullscreen entry/exit, fill and Escape restoration, retained player
element and queue/position, control auto-hide, queue/favorites/link interactions,
and overflow/aspect-ratio checks at 320, 390, 720, 1440, 1600, and 2560 pixels wide,
including the 2560 × 720 Edge layout. JavaScript syntax and git whitespace checks.
