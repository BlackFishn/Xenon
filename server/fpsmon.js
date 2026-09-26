'use strict';

// ─────────────────────────────────────────────────────────────────────────
// In-game FPS via PresentMon (Intel, open source).
//
// PresentMon captures present events through ETW, so it reports the *real*
// frame rate of any application — including exclusive-fullscreen games that
// bypass the desktop compositor (where the DWM fallback in network.ps1 reads
// nothing). It needs administrator rights (ETW tracing).
//
// We stream PresentMon's CSV to stdout, parse it by *header name* (so it keeps
// working across CLI versions), keep a short rolling window of frame times per
// swap chain, and expose the foreground/tracked game's displayed FPS. If it is
// absent (or fails to start, e.g. no admin), getCurrentFps() returns null and
// the server falls back to the existing methods.
//
// The installer uses the current standalone CLI (no service/MSI required):
//   server/presentmon/PresentMon-2.5.1-x64.exe   (recommended)
// Older installations remain readable at:
//   server/presentmon/PresentMon.exe
//   server/PresentMon.exe
// or anywhere on PATH as "PresentMon.exe".
// ─────────────────────────────────────────────────────────────────────────

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const gameDetect = require('./gamedetect');

const SAMPLE_WINDOW_MS = 2000;   // a process must have presented this recently
const MAX_SAMPLES = 2400;        // bound memory even with >1000 presents/second
const RESTART_DELAY_MS = 5000;   // wait before relaunching after an exit
const FAIL_BACKOFF_MS = 60000;   // back off hard after repeated instant failures
const GAMING_GRACE_MS = 10000;   // stay "gaming" briefly after frames stop (anti-flicker)
const IGNORE_PROCS = new Set([
  'dwm.exe', 'explorer.exe', 'presentmon.exe', 'searchhost.exe', 'shellexperiencehost.exe',
  // Terminals render flip-model frames (DWM can promote them to Independent Flip)
  // but are never games — the WindowsTerminal false positive the user reported.
  'windowsterminal.exe', 'conhost.exe', 'openconsole.exe', 'cmd.exe', 'powershell.exe',
  'pwsh.exe', 'wt.exe', 'alacritty.exe', 'wezterm-gui.exe', 'mintty.exe', 'putty.exe',
  'tabby.exe', 'hyper.exe',
  // Always-on GPU chat/media apps.
  'discord.exe', 'slack.exe', 'spotify.exe',
]);
// Processes that present frames continuously but are never games, so PresentMon
// must not treat them as one:
//  - Browser / WebView engines: the dashboard itself runs inside one of these
//    and on the Xeneon Edge it is full-screen, so it would otherwise look like a
//    game and pin game-mode permanently on (cloud-gaming-in-browser is the rare,
//    accepted cost of this exclusion).
//  - iCUE / Corsair: always running on this hardware and renders the Xeneon Edge
//    and RGB previews at the display refresh rate — the actual false positive
//    observed on the device (icue.exe ~74 fps).
//  - Wallpaper Engine and similar animated-wallpaper apps: perpetual presenters.
const IGNORE_PROC_RE = /msedge|chrome|firefox|brave|opera|vivaldi|webview|iexplore|icue|corsair|wallpaper/;

function isIgnoredProc(name) {
  if (!name) return false;
  return IGNORE_PROCS.has(name) || IGNORE_PROC_RE.test(name)
    || gameDetect.isIgnoredProc(name.replace(/\.exe$/, ''));
}

// A PresentMode counts as a game only when it uses the flip model typical of
// full-screen / borderless games ("Hardware: …" exclusive, or any "Independent
// Flip"). Plain "Composed: …" presents come from windowed desktop apps and
// browsers and are ignored.
function isGamingPresentMode(modeRaw) {
  const mode = normHeader(modeRaw);
  return mode.startsWith('hardware') || mode.includes('independentflip');
}

// Keep the versioned binary beside 1.x so an interrupted upgrade cannot replace
// a working collector. Its filename also selects the matching CLI arguments.
const MODERN_PRESENTMON = path.join(__dirname, 'presentmon', 'PresentMon-2.5.1-x64.exe');
const PRESENTMON_CANDIDATES = [
  MODERN_PRESENTMON,
  path.join(__dirname, 'presentmon', 'PresentMon.exe'),
  path.join(__dirname, 'PresentMon.exe'),
];

// Dedicated ETW session name. PresentMon's default name ("PresentMon") is
// shared territory: other frame tools use the same collector, and our
// -stop_existing_session would steal the session from whoever owns it (the
// NVIDIA App's FPS overlay reads frames through the same mechanism). With our
// own name, -stop_existing_session only ever clears a stale session left by a
// previous unclean Xenon exit — never another tool's.
const ETW_SESSION_NAME = 'XenonFps';

let _proc = null;
let _runningExe = null;
let _cols = null;
let _consecutiveFastFails = 0;
let _stopped = false;            // terminal: server shutting down, never restart
// Paused starts TRUE: PresentMon runs an admin ETW tracing session, so it stays
// idle until a dashboard actually connects (resumeFpsMonitor) and is torn back
// down when the last one leaves (pauseFpsMonitor) — no system-wide cost while
// nobody is watching FPS / game-mode. Distinct from _stopped: pause is reversible.
let _paused = true;
let _buffer = '';
let _restartTimer = null;        // pending relaunch timer, so reload() can pre-empt it
let _lastGamingAt = 0;           // last time a real app was presenting (for grace window)
const _bySwapChain = new Map();  // pid + swap chain -> recent frame intervals

function presentMonPath() {
  for (const candidate of PRESENTMON_CANDIDATES) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return 'PresentMon.exe'; // last resort: rely on PATH (spawn errors → fallback)
}

function isCurrentVersionAvailable() {
  try { return fs.existsSync(MODERN_PRESENTMON); } catch { return false; }
}

// True when any supported local reader is present (vs. relying on PATH).
function isAvailable() {
  return PRESENTMON_CANDIDATES.some(c => { try { return fs.existsSync(c); } catch { return false; } });
}

// A killed PresentMon cannot clean up after itself: proc.kill() is
// TerminateProcess on Windows, and the ETW session it registered survives the
// process — until reboot — unless stopped explicitly. logman ships with
// Windows. Without the admin rights PresentMon needs, no session was ever
// created and the stop fails; every outcome is deliberately ignored.
function stopEtwSession() {
  if (process.platform !== 'win32') return;
  try {
    spawn('logman.exe', ['stop', ETW_SESSION_NAME, '-ets'], { windowsHide: true, stdio: 'ignore' })
      .on('error', () => { /* ignore */ })
      .unref(); // must never delay server shutdown
  } catch { /* ignore */ }
}

function normHeader(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Build a column-index map from the CSV header, tolerant of version differences.
function parseHeader(fields) {
  const norm = fields.map(normHeader);
  const find = pred => norm.findIndex(pred);
  const frameTime = find(n => n.includes('betweenpresents') || n === 'frametime');
  // Prefer 2.x display durations: these include the collector's frame-generation
  // and flip-metering handling. Never infer a generated-frame multiplier.
  const displayDuration = find(n => n === 'displayedtime');
  const displayTime = displayDuration >= 0 ? displayDuration : find(n => n === 'msbetweendisplaychange');
  const fps = find(n => n === 'fps' || n.endsWith('fps') || n.includes('displayedfps'));
  const app = find(n => n === 'application' || n.includes('processname'));
  const pid = find(n => n.includes('processid'));
  const presentMode = find(n => n.includes('presentmode'));
  const dropped = find(n => n === 'dropped');
  const swapChain = find(n => n === 'swapchainaddress');
  const time = find(n => n === 'cpustarttime' || n === 'cpustarttimeinms' || n === 'timeinseconds');
  const timeScale = time >= 0 && norm[time] === 'timeinseconds' ? 1000 : 1;
  if (displayTime < 0 && frameTime < 0 && fps < 0) return null;
  return { frameTime, displayTime, fps, app, pid, presentMode, dropped, swapChain, time, timeScale };
}

function pruneSamples(samples, at) {
  while (samples.length && (at - samples[0].at > SAMPLE_WINDOW_MS
      || samples.length > MAX_SAMPLES)) samples.shift();
}

function rowValues(cols, fields) {
  if (!cols) return null;
  const pidRaw = cols.pid >= 0 ? fields[cols.pid] : '';
  const pid = String(pidRaw || '').trim() || (cols.app >= 0 ? fields[cols.app] : '?');
  const name = (cols.app >= 0 ? String(fields[cols.app] || '') : '').trim().toLowerCase();
  if (isIgnoredProc(name)) return null;

  // When PresentMon reports the present mode, keep only flip-model (game) presents
  // so windowed desktop apps and the dashboard's own browser don't count.
  if (cols.presentMode >= 0 && !isGamingPresentMode(fields[cols.presentMode])) return null;

  let present = null, usesFps = false;
  if (cols.frameTime >= 0) {
    const ft = parseFloat(fields[cols.frameTime]);
    if (Number.isFinite(ft) && ft > 0 && ft <= 1000) present = ft;
  } else if (cols.fps >= 0) {
    const f = parseFloat(fields[cols.fps]);
    if (Number.isFinite(f) && f > 0 && f <= 1000) { present = f; usesFps = true; }
  }

  // A frame that was never displayed carries no display interval — blank, zero
  // or negative depending on the version. Those rows are dropped frames, and
  // counting one as an interval of zero would read as an infinite frame rate.
  let display = null;
  if (cols.displayTime >= 0 && (cols.dropped < 0 || fields[cols.dropped] === '0')) {
    const dt = parseFloat(fields[cols.displayTime]);
    if (Number.isFinite(dt) && dt > 0 && dt <= 1000) display = dt;
  }
  if (present == null && display == null) return null;
  return { pid, name, present, display, usesFps };
}

function handleRow(fields) {
  const r = rowValues(_cols, fields);
  if (!r) return;
  const now = Date.now();
  const at = _cols.time >= 0 ? Number(fields[_cols.time]) * _cols.timeScale : now;
  if (!Number.isFinite(at)) return;
  const swapChain = _cols.swapChain >= 0 ? fields[_cols.swapChain] : '';
  const key = `${r.pid}:${swapChain}`;
  let entry = _bySwapChain.get(key);
  if (!entry) {
    entry = { pid: r.pid, name: r.name, samples: [], display: [], usesFps: r.usesFps,
      metric: _cols.displayTime >= 0 ? 'displayed' : 'presented', lastSeen: 0 };
    _bySwapChain.set(key, entry);
  }
  entry.name = r.name || entry.name;
  entry.usesFps = r.usesFps;
  if (r.present != null) entry.samples.push({ value: r.present, at });
  if (r.display != null) entry.display.push({ value: r.display, at });
  entry.lastSampleAt = at;
  pruneSamples(entry.samples, at);
  pruneSamples(entry.display, at);
  entry.lastSeen = now;
}

function onData(chunk) {
  _buffer += chunk;
  let nl;
  while ((nl = _buffer.indexOf('\n')) >= 0) {
    const line = _buffer.slice(0, nl).replace(/\r$/, '').trim();
    _buffer = _buffer.slice(nl + 1);
    if (!line) continue;
    const fields = line.split(',');
    if (!_cols) {
      // The header is the first line containing recognisable column names.
      if (/application|processid|presents/i.test(line)) _cols = parseHeader(fields);
      continue;
    }
    _consecutiveFastFails = 0; // we're getting real data → healthy
    try { handleRow(fields); } catch { /* ignore a malformed row */ }
  }
}

function start() {
  if (_stopped || _paused || process.platform !== 'win32') return;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  const exe = presentMonPath();
  _cols = null;
  _buffer = '';
  _bySwapChain.clear(); // fresh session → old process/swap-chain identities are meaningless
  const startedAt = Date.now();
  const args = exe === MODERN_PRESENTMON
    ? ['--output_stdout', '--stop_existing_session', '--no_console_stats', '--session_name', ETW_SESSION_NAME,
      '--v2_metrics', '--track_frame_type', '--no_track_gpu', '--no_track_input']
    : ['-output_stdout', '-stop_existing_session', '-no_top', '-session_name', ETW_SESSION_NAME];
  try {
    _runningExe = exe;
    _proc = spawn(exe, args, { windowsHide: true });
  } catch {
    _proc = null;
    scheduleRestart(startedAt);
    return;
  }
  _proc.stdout.on('data', d => onData(d.toString('utf8')));
  _proc.stderr.on('data', () => { /* PresentMon logs warnings here; ignore */ });
  _proc.on('error', () => { _proc = null; scheduleRestart(startedAt); });
  _proc.on('close', () => { _proc = null; scheduleRestart(startedAt); });
}

function scheduleRestart(startedAt) {
  if (_stopped || _paused) return;
  // If PresentMon dies almost immediately it usually means it's missing or we
  // lack admin rights — back off so we don't spin relaunching it.
  if (Date.now() - startedAt < 2500) _consecutiveFastFails++; else _consecutiveFastFails = 0;
  const delay = _consecutiveFastFails >= 3 ? FAIL_BACKOFF_MS : RESTART_DELAY_MS;
  if (_restartTimer) clearTimeout(_restartTimer);
  _restartTimer = setTimeout(start, delay);
}

// How long a silent process keeps its slot before being dropped. Long enough
// to survive loading screens, short enough that the map never accumulates every
// PID seen over a 24/7 uptime.
const STALE_ENTRY_MS = 60000;

let _foregroundPid = null;
function setForegroundPid(fn) { _foregroundPid = typeof fn === 'function' ? fn : null; }

function weight(entry) {
  return entry.metric === 'displayed' ? entry.display.length
    : Math.max(entry.samples.length, entry.display.length);
}

// The optional game context preserves the fork's tracked-game fallback when
// touching the dashboard. Unknown busy desktop apps must not replace that game.
function pickEntry(entries, now, wantedPid, context = null) {
  let best = null, front = null;
  const wanted = String(wantedPid || '');
  for (const [key, entry] of entries) {
    if (now - entry.lastSeen > SAMPLE_WINDOW_MS || !weight(entry)) continue;
    const pid = String(entry.pid || key);
    const name = entry.name.replace(/\.exe$/, '');
    let focused = wanted && pid === wanted;
    if (context) {
      focused = wanted ? focused : name === context.foreground
        && (name !== context.gameProc || !context.gamePid || pid === String(context.gamePid));
      const tracked = pid === String(context.gamePid) && name === context.gameProc;
      if (!focused && !tracked) continue;
    }
    if (focused && (!front || weight(entry) > weight(front))) front = entry;
    if (!best || weight(entry) > weight(best)) best = entry;
  }
  return front || best;
}

function meanOf(samples) {
  if (!samples.length) return null;
  const mean = samples.reduce((sum, sample) => sum + (typeof sample === 'number' ? sample : sample.value), 0) / samples.length;
  return Number.isFinite(mean) && mean > 0 ? mean : null;
}

function entryFps(entry) {
  if (!entry) return { fps: null, presentFps: null, displayFps: null };
  // Frames / elapsed seconds, including stalls; median inversion inflates bursts.
  const p = meanOf(entry.samples);
  const d = meanOf(entry.display);
  const presentFps = p == null ? null : Math.round(entry.usesFps ? p : 1000 / p);
  const displayFps = d == null ? null : Math.round(1000 / d);
  // A display-capable collector with no displayed frames is not a high-FPS game.
  const fps = entry.metric === 'displayed' ? displayFps : displayFps ?? presentFps;
  return { fps, presentFps, displayFps };
}

function _bestEntry() {
  const now = Date.now();
  for (const [key, entry] of _bySwapChain) {
    if (now - entry.lastSeen > STALE_ENTRY_MS) { _bySwapChain.delete(key); continue; }
    const at = entry.lastSampleAt + now - entry.lastSeen;
    pruneSamples(entry.samples, at);
    pruneSamples(entry.display, at);
  }
  let wanted = '';
  try { wanted = _foregroundPid ? String(_foregroundPid() || '') : ''; } catch { /* use name/tracked identity */ }
  return pickEntry(_bySwapChain, now, wanted, {
    ...gameDetect.getGameDiag(), foreground: gameDetect.getForegroundProcess(),
  });
}

function getCurrentFps() { return entryFps(_bestEntry()).fps; }
function getFpsDetail() { return entryFps(_bestEntry()); }

// Diagnostic: name + fps of the process currently driving game detection, or
// null. Used to identify false positives (e.g. the dashboard's own host).
function getGamingProcess() {
  const best = _bestEntry();
  if (!best) return null;
  const { fps } = entryFps(best);
  return fps == null ? null : { name: best.name || '?', pid: Number(best.pid) || null, fps, metric: best.metric };
}

// True while a real foreground app is presenting frames (a game or other
// GPU-intensive app). A short grace window keeps it stable between samples so
// the dashboard's game-mode doesn't flicker on momentary FPS dropouts.
function isGaming() {
  if (getCurrentFps() != null) { _lastGamingAt = Date.now(); return true; }
  return _lastGamingAt > 0 && (Date.now() - _lastGamingAt) < GAMING_GRACE_MS;
}

function startFpsMonitor() {
  if (_stopped || _paused || _proc) return;
  start();
}

// Re-attempt right away (e.g. just after PresentMon was installed), pre-empting
// any pending back-off timer instead of waiting it out.
function reload() {
  if (_stopped || _paused) return;
  _consecutiveFastFails = 0;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  if (_proc && _runningExe !== presentMonPath()) {
    // The close handler relaunches with the newly installed version and clears
    // only our own ETW session. Other overlays keep their sessions.
    try { _proc.kill(); } catch { /* normal retry remains available */ }
  } else if (!_proc) start();
}

// Pause/resume tie PresentMon's admin ETW session to whether a dashboard is
// actually connected (see server.js SSE lifecycle). Unlike stopFpsMonitor these
// are reversible: pause tears the process down but leaves the module runnable.
function pauseFpsMonitor() {
  if (_paused) return;
  _paused = true;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  if (_proc) { try { _proc.kill(); } catch { /* ignore */ } _proc = null; stopEtwSession(); }
  _bySwapChain.clear(); // a future session's PIDs are unrelated to this one
}

function resumeFpsMonitor() {
  if (_stopped) return;
  _paused = false;
  _consecutiveFastFails = 0;
  if (!_proc) start();
}

function stopFpsMonitor() {
  _stopped = true;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  if (_proc) { try { _proc.kill(); } catch { /* ignore */ } _proc = null; stopEtwSession(); }
  _bySwapChain.clear();
}

module.exports = { startFpsMonitor, stopFpsMonitor, pauseFpsMonitor, resumeFpsMonitor, getCurrentFps, getFpsDetail, getGamingProcess, setForegroundPid, isGaming, isAvailable, isCurrentVersionAvailable, reload, parseHeader, rowValues, pickEntry, entryFps };
