# Spotify widget

The Spotify tile keeps playback controls, Up Next, playlists, and Spotify Connect
devices together. Connect the account in **Settings → Spotify** using the existing
setup flow. Playback commands continue through the existing allowlisted action
dispatcher; this redesign does not change authentication or stored settings.

## Layout and controls

The player follows the dashboard's semantic palette, panel transparency, typography,
and control styling. The Spotify logo keeps its brand color; progress and active
states use the selected dashboard accent. Flat library tabs and compact neutral
controls match the neighbouring media widgets. Playing fills its card with a
blurred copy of the current album cover while keeping the foreground artwork
sharp. A scrim derived from the theme background preserves text and control
contrast; the header and library retain their neutral surfaces. Missing artwork
and idle playback clear the backdrop instead of retaining the previous cover.

Tall wide tiles use the reviewed layout: square artwork up to 348 px, a lower
title/control group with titles of up to two lines, seek above playback buttons,
and a neutral volume row without a separator. The cover fits the space remaining
above the controls, shrinking for shorter cards, wrapped titles and touch targets
so the sliders stay reachable. Compact tiles keep their responsive layout and the
same control order.

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

## Album layout validation (2026-09-26)

- The enlarged-cover revision matches the approved mock at 830×670: artwork is
  approximately 348 px square, the title/control group sits lower, and the volume
  divider is absent. Browser checks also verified two-line titles, the tall-layout
  breakpoint, shorter cards, large desktops and coarse-pointer targets: every
  cover stayed square and all controls remained visible and clickable.
- Spotify UI and provider tests: 43 passed, including cover changes across widget
  copies, missing artwork, idle playback, and the volume regressions below.
- The implementation was rendered with all 90 local dashboard stylesheets and the
  active theme tokens, using isolated fixture data. Mouse, keyboard, emulated touch,
  overlay hit targets, reduced motion, and light-theme colors passed.
- Edge, portrait, compact and desktop content had no horizontal overflow; tall
  wide playback follows title → seek → transport → volume with a two-line title.
- JavaScript syntax, Git whitespace and static demo build checks passed. This is
  a browser UI change; the native executable and backend do not require rebuilding.

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

### Main v4.11.9 integration

Up Next retains numbered, theme-aware rows and now plays a selected track inside its playlist or album context. Rows without a playable URI remain plain rows. The large square cover, lower control group, album backdrop and divider-free volume row remain unchanged.

## Queue controls

Open **Up Next → + Add songs**, enter a song/artist name or paste an
https://open.spotify.com/track/... link or spotify:track:... URI, then press
**Search**. Choose a result to **Add to queue**. Search runs only on submission,
returns up to ten tracks, and the chosen track is added without starting it or
interrupting the current song. **Back to queue** returns to Spotify's live list.

This uses Spotify's existing queue. There is no local queue, drag reordering or
position-specific insertion. Spotify's public Player API exposes queue reads and
additions, not queue reordering. Playback writes need Spotify Premium and an
active controllable device. Provider and connection errors stay visible.

Queue picks share a pending state across widget copies. The list stays mounted
while the action runs; only a successful action triggers track-change resync.
Failed requests retain the list and show a reason instead of silently clearing it.

If newly served controls report an unknown action, check the running backend's
/status and /actions/catalog: static JavaScript can update on disk while the
Node process still holds an older action catalog. Restart the **correct source
backend**, preserving its settings store, then reload the dashboard. This feature
changes browser/backend JavaScript only; no native or Helper rebuild is required.

See Spotify's [queue API](https://developer.spotify.com/documentation/web-api/reference/add-to-queue)
and [playback API](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback).

### Queue controls validation (2026-09-26)

- Widget behavior: 19 tests passed, including shared pending actions, failure
  feedback, explicit search, stale queue responses and long rate-limit cooldowns.
- Provider/queue/SDK checks: 105 passed, including URI/link validation, actionable
  errors, restricted context retry and unchanged SDK grants.
- Isolated browser: 28 checks passed with mocked Spotify responses; mouse,
  keyboard and touch; wide, short Edge, portrait, compact and desktop layouts;
  search focus/caret/text retained across polling. No live playback was changed.
- Final full suite with one test file at a time: 4,221 tests, 4,207 passed,
  14 skipped, zero failed. The concurrent run had one Discord voice timing
  failure; that unchanged test passed separately on production and this branch.
- Changed JavaScript syntax, whitespace checks and dashboard demo build passed.

The daily production backend was separately restarted from its existing source
launcher, activating the already-merged v4.11.10 spotifyPlayUri action. Its live
catalog now contains that action. Existing settings values and store identity
were preserved; only new schema defaults and revision metadata were added.
The new search/add controls are retained on develop until promotion.

## Spotify request limits and recovery

Spotify's API can temporarily reject requests with HTTP 429 while music continues
playing in its desktop client. Windows media metadata can still update the
dashboard during this period. Seeing a live title/cover therefore does not prove
that queue, device or volume API controls are available.

The dashboard shares cached reads between consumers and slows regular polling.
The progress animation remains local, so fewer API reads do not make its clock
less smooth. Queue and device lists refresh less often than playback and refresh
after relevant user actions.

When Spotify sends Retry-After, all provider calls wait for its full deadline.
The provider persists only cooldown metadata in a companion file beside its
token store; credentials and settings are not copied into that file. A normal
backend restart retains the wait. This does not change Spotify's quota or shorten
a restriction already imposed by Spotify.

The widget and media strip display the restriction, retain their last known
lists, and pause API-only controls until the wait ends. Local Windows media
transport remains available when the active media session is Spotify.

Recovery is automatic after the reported wait; the account can remain connected.
Spotify may return a new deadline if a restriction is still active.
See [Spotify's rate-limit guidance](https://developer.spotify.com/documentation/web-api/concepts/rate-limits).

## Debugging recurring restrictions

The source backend writes private Spotify diagnostics to
server/data/spotify-debug.jsonl. Records distinguish actual outbound requests
from cache/coalescing decisions and requests stopped by the existing cooldown.
Each provider instance has an identifier and process ID, so separate runs do not
look like one uninterrupted counter.

The log captures safe endpoint categories, HTTP status, duration, Retry-After and
the Spotify 429 reason when available. It omits authorization headers, tokens,
client IDs, query strings, request bodies, track IDs and music metadata.
The current log is capped at approximately 2 MiB with one previous file (.1).
Logging failures never change playback results or relax the cooldown.

A deadline restored from an older installation has an unknown reason: previous
versions saved only the deadline. Enabling diagnostics does not make a probe
request or clear that wait. If a normal request receives another 429 after the
wait ends, its reason will be recorded; the earlier response cannot be recovered.
