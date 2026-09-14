# Windows audio: event-driven controls and measurements

Measured on the development Windows machine on 2026-09-11, using the Release,
trimmed, self-contained Xenon helper 0.12.4 and the source backend on port 3030.
These are single-machine samples, not latency guarantees.

## Behavior

- One persistent Core Audio host sleeps between Windows callbacks. Device,
  session, volume and mute changes trigger snapshots and deduplicated SSE audio
  events. Native operation does not run the legacy eight-second audio collector.
- Slider writes start immediately, with one request in flight per control and
  coalescing to the newest value, at most 25 writes/second. Older confirmations
  cannot pull the thumb back during a write. The final value is delivered.
- The legacy SoundVolumeView path remains available when the helper is too old
  or fails. An already dispatched native write is never replayed automatically:
  replaying a timed-out mute toggle could undo it. Failure resumes legacy reads.
- COM callback interfaces and implementations are explicitly preserved during
  .NET trimming. Testing the published executable caught a fail-fast crash on
  session creation that an untrimmed build did not expose; the deployed build
  includes the preservation fix.

## Visible mixer freshness (2026-09-14)

The legacy collector used to stop two minutes after the last audio interaction,
even if its mixer remained visible and SSE stayed connected. This left closed
apps on screen and hid newly active apps until another audio request. Visible
Volume/Microphone controls now read every 30 seconds to renew that watch; the
legacy SSE collector continues its eight-second cadence. Returning to the page
or restoring the window refreshes immediately. Hidden tabs and pager pages do
not renew the watch. Native callbacks still provide the immediate event path.
The mixer lists apps with active audio sessions, grouped by executable; it is
not a list of every running process.

Verified with the installed SoundVolumeView fallback after 130 seconds without
control input: four automatic reads renewed the watch, a new silent test app
appeared in 8.42 seconds and disappeared 7.65 seconds after closing. The browser
reported no JavaScript errors. All 37 focused audio tests passed, including a
five-minute simulated visible-mixer watch, hidden-page expiry, and immediate
refresh on return. No master or microphone controls were changed.

## Measurements

| Measurement | Legacy | Native |
| --- | ---: | ---: |
| Audio transport CPU during 32 seconds with no audio changes | 234.75 ms | 0 ms recorded |
| Audio transport CPU for 10 volume + unmute pairs | 1,203.25 ms | 15.625 ms |
| Direct command pair wall time, median of 10 | 176.46 ms | 1.86 ms |

The transport CPU comparison includes Node CPU plus the relevant audio child
process CPU, excluding benchmark-driver CPU. Legacy idle is four active
eight-second polls, not the old collector after its idle cutoff. The native
sample emitted no events. Windows CPU accounting is coarse: **0 ms recorded
does not mean literally zero CPU usage**. The command-pair CPU reduction in this
sample was approximately 98.7%.

The direct-command latency comparison was a separate PowerShell run. Legacy
ran SetVolume followed by Unmute, launching SoundVolumeView twice per pair;
native sent the same operations to the persistent helper. It excludes browser
input handling and the old 120 ms trailing slider debounce.

The real running server was also tested over HTTP and SSE:

- After 125 seconds without audio requests from the test client, creating a
  silent test app appeared on SSE in **570.37 ms**, including process startup.
- Closing that app appeared on SSE in **27.24 ms**.
- Ten HTTP app-volume writes had a **1.90 ms median**, **1.58 ms minimum** and
  **17.89 ms maximum** response time. Each was followed by a separate native
  readback asserting the actual requested value. Readback time is not included
  in HTTP response timing.
- App mute and unmute were verified by actual readback. Master output and
  microphone volume/mute remained unchanged throughout the test.

There is a tradeoff: the persistent native host used approximately **32.6 MiB
working set**, with **250 ms CPU / 406 ms wall time** for a measured cold start.
Startup is a one-time cost per host, not per slider input. These measurements
cover the audio path, not total dashboard/WebView CPU, rendering latency,
audible output latency, or every possible audio driver.

## Reproduce

Use a .NET 10 SDK and Node 18.15+. The probe emits silent output and changes only
its own session volume/mute; it does not open a microphone. Close other probe
instances first. Avoid changing audio devices during the run.

```powershell
dotnet publish helper -c Release -o .codex/audio-build/candidate-v2
dotnet publish tools/audio-probe -c Release -r win-x64 --self-contained true -o .codex/audio-build/probe

# Standalone helper/SoundVolumeView comparison, including native readback.
powershell -NoProfile -ExecutionPolicy Bypass -File tools/measure-audio.ps1 -Candidate "$PWD/.codex/audio-build/candidate-v2/xenon-helper.exe" -Probe "$PWD/.codex/audio-build/probe/xenon-audio-probe.exe" -SoundVolumeView "$PWD/server/soundvolumeview-x64/SoundVolumeView.exe" -IdleSeconds 16

# Isolated Node + audio child CPU, 32 seconds per backend.
node tools/audio-transport-bench.cjs

# Requires the running server to use the new helper; takes over 125 seconds.
node tools/audio-live-check.cjs
```

The installed helper was updated to the tested 0.12.4 executable and the source
backend restarted. Reload the dashboard to load updated frontend JavaScript.

## Verification scope

All 40 focused audio tests passed, covering process reuse, split UTF-8 input, explicit post-write
reads, unsupported-helper fallback, rejected writes, malformed snapshots,
timeout recovery without toggle replay, slider coalescing and thumb stability.
Release helper publishing and live session/volume/mute checks passed. JavaScript
syntax checks and `git diff --check` passed.

The full test run before the final timeout regression test had 3,279 passing,
10 skipped and six existing failures in PowerShell parsing policy, stopwatch,
and updater tests. This work did not make the full suite green. No browser
visual/performance measurement was performed.
