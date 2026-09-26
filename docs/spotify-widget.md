# Spotify widget

The Spotify tile keeps playback controls, Up Next, playlists, and Spotify Connect
devices together. Connect the account in **Settings → Spotify** using the existing
setup flow. Playback commands continue through the existing allowlisted action
dispatcher; this redesign does not change authentication or stored settings.

## Layout and controls

The player follows the dashboard's semantic palette, panel transparency, typography,
and control styling. The Spotify logo keeps its brand color; progress and active
states use the selected dashboard accent. Flat library tabs and compact neutral
controls match the neighbouring media widgets. Album art stays within its cover
instead of recoloring the player surface.

- Wide tiles place the library beside the player. Portrait tiles show larger
  artwork above playback controls. Compact tiles keep every tab reachable by
  scrolling instead of hiding the library.
- The device chip opens **Devices**. Select another listed device to transfer
  playback. Select a playlist to start it.
- Play/pause reacts immediately in every widget copy. While a command is pending,
  other copies cannot send a conflicting play/pause command. Failed commands
  restore the previous state.
- Seek and volume have larger input targets. Seek previews the selected time;
  volume displays its percentage with a persistent handle. Short tiles omit the volume row.
- Queue rows are numbered. The existing approximate-order notice remains when
  Spotify cannot provide a reliable queue.
- Arrow Left/Right and Home/End navigate the tabs. Controls expose accessible names
  and toggle states, and animation follows the reduced-motion preference.

## Refresh behavior

Tabs display their loading state immediately and repeated tab clicks share the
pending request. Existing cached rows remain mounted when their data is unchanged.

The local progress ticker uses elapsed time at 250 ms intervals; Spotify polling
remains at its existing six-second cadence while visible. Rate-limit backoff,
hidden-page polling guards, and the local Windows media fallback remain in place.
A control action requests fresh player state instead of immediately displaying
the previous cached snapshot.

Volume previews are shared across copies without pausing the track clock. On
release, the selected value stays visible until a new player response confirms it
(or an eight-second confirmation window expires). A failed write restores the
last confirmed value. Rapid releases/keyboard steps send one write at a time and
retain only the newest queued value; older player reads cannot undo newer state.
Changing playback devices clears the previous device's pending volume.

## Volume regression validation (2026-09-26)

- Reproduced the original 37% → 64% snapback after a stale response and the frozen
  seek ticker during volume input; both now pass.
- Spotify UI and provider tests: 42 passed, including rapid writes, rejection,
  confirmation/expiry, device switching, duplicate widgets, and out-of-order reads.
- Isolated Chrome checks passed for mouse drag/release, keyboard steps, and
  emulated touch against stale fixture data; the seek clock continued during
  volume dragging. Edge, portrait, compact and desktop content had no horizontal
  overflow. No live Spotify playback command was sent.
- Syntax, whitespace and demo build checks passed. Full suite: 3,477 tests,
  3,458 passed, 9 failed, 10 skipped; the same nine baseline failures described below.
- Layout/album-blur exploration remains a standalone mockup; this fix only changes
  volume synchronization and persistent handle visibility.

## Validation (2026-09-26)

- JavaScript syntax and Git whitespace checks passed.
- Spotify UI and provider tests: 36 passed.
- Static demo build passed; no native shell rebuild is needed for these UI files.
- Browser checks used sample data and the complete dashboard stylesheet stack:
  2560×720 Edge, 390×844 portrait, 1200×800 and 1920×1080 desktop viewports,
  with widget sizes from 300×350 to 1000×800.
- Checked overflow, mouse and emulated touch playback, keyboard tab navigation,
  delayed loading, duplicate widgets, light-theme control contrast, and reduced
  motion. These checks do not claim a live Spotify account or physical touchscreen test.
- The feature full suite ran 3,471 tests: 3,451 passed, 10 failed, 10 skipped.
  Nine failures reproduce on the unchanged baseline: four community-catalog
  layout cases, stopwatch extraction, update handoff extraction, and three
  half-update extraction cases. The additional Discord voice timing case passes
  when rerun in isolation on both baseline and feature code.
