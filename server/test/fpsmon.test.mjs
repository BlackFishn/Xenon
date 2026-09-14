import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const file = fileURLToPath(new URL('../fpsmon.js', import.meta.url));
const require = createRequire(file);
const source = readFileSync(file, 'utf8');
const gameDetect = require('./gamedetect');
const GAME = 'wardogsclient-win64-shipping';
const HEADER = 'Application,ProcessID,SwapChainAddress,PresentMode,Dropped,TimeInSeconds,msBetweenPresents,msBetweenDisplayChange\n';

function monitor(header = HEADER) {
  const state = { now: 10000, time: 0, foreground: GAME, gamePid: 42, gameProc: GAME, modern: false };
  const spawns = [], timers = [];
  const ctx = {
    module: { exports: {} }, __dirname: dirname(file),
    Date: { now: () => state.now }, process: { platform: 'win32' },
    setTimeout: fn => { timers.push(fn); return {}; }, clearTimeout: () => {},
    require: name => name === './gamedetect' ? {
      isIgnoredProc: gameDetect.isIgnoredProc,
      getForegroundProcess: () => state.foreground,
      getGameDiag: () => state,
    } : name === 'child_process' ? {
      spawn: (exe, args, options) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = () => { child.killed = true; child.emit('close', 0); };
        spawns.push({ exe, args, options, child });
        return child;
      },
    } : name === 'fs' ? {
      existsSync: p => p.endsWith('PresentMon-2.5.1-x64.exe') ? state.modern : p.endsWith('PresentMon.exe'),
    } : require(name),
  };
  vm.runInNewContext(source, ctx, { filename: file });
  ctx.onData(header);
  function feed({ name = GAME + '.exe', pid = 42, swap = '0x1', present = 10, display = 10, dropped = 0 } = {}) {
    state.time += present / 1000;
    state.now += present;
    ctx.onData([name, pid, swap, 'Hardware: Independent Flip', dropped, state.time, present, display].join(',') + '\n');
  }
  return { state, feed, spawns, timers, input: ctx.onData, api: ctx.module.exports };
}

test('dropped WAR DOGS present bursts do not inflate displayed FPS', () => {
  const m = monitor();
  for (let i = 0; i < 100; i++) {
    m.feed({ present: 9.75, display: 0, dropped: 1 });
    m.feed({ present: 0.25, display: 10 });
  }
  assert.equal(m.api.getCurrentFps(), 100);
  assert.equal(m.api.getGamingProcess().metric, 'displayed');
  assert.equal(m.api.getGamingProcess().pid, 42);
});

test('frame rate includes long intervals instead of inverting the median', () => {
  const m = monitor();
  for (let i = 0; i < 30; i++) {
    for (const interval of [2.5, 2.5, 25]) m.feed({ present: interval, display: interval });
  }
  assert.equal(m.api.getCurrentFps(), 100); // median inversion was 400
});

test('VS Code and unrelated busy processes cannot replace the tracked game', () => {
  const m = monitor();
  for (let i = 0; i < 100; i++) m.feed({ name: 'code.exe', pid: 7, present: 2.5, display: 2.5 });
  for (let i = 0; i < 100; i++) m.feed({ name: 'unrelated.exe', pid: 8, present: 2.5, display: 2.5 });
  for (let i = 0; i < 20; i++) m.feed();
  m.state.foreground = 'chrome'; // touching the dashboard must keep the game
  assert.equal(m.api.getCurrentFps(), 100);
  assert.equal(m.api.getGamingProcess().name, GAME + '.exe');
  m.state.gamePid = 0;
  m.state.gameProc = '';
  assert.equal(m.api.getCurrentFps(), null);
});

test('only the identified PID supplies a tracked game reading', () => {
  const m = monitor();
  for (let i = 0; i < 30; i++) m.feed({ pid: 99, present: 2.5, display: 2.5 });
  assert.equal(m.api.getCurrentFps(), null);
  for (let i = 0; i < 10; i++) m.feed();
  assert.equal(m.api.getCurrentFps(), 100);
});

test('independent swap chains never blend their frame intervals', () => {
  const m = monitor();
  for (let i = 0; i < 20; i++) m.feed({ swap: '0xmain', present: 10, display: 10 });
  for (let i = 0; i < 10; i++) m.feed({ swap: '0xoverlay', present: 2, display: 2 });
  assert.equal(m.api.getCurrentFps(), 100);
});

test('a new foreground game can supply the windowed detection hint', () => {
  const m = monitor();
  m.state.foreground = 'anothergame';
  m.feed({ name: 'anothergame.exe', pid: 80, display: 20, present: 20 });
  assert.equal(m.api.getGamingProcess().name, 'anothergame.exe');
  assert.equal(m.api.getCurrentFps(), 50);
});

test('expired intervals are removed after pauses and FPS clears when frames stop', () => {
  const m = monitor();
  for (let i = 0; i < 60; i++) m.feed({ present: 5, display: 5 });
  m.state.now += 3000;
  m.state.time += 3;
  assert.equal(m.api.getCurrentFps(), null);
  m.feed({ present: 20, display: 20 });
  assert.equal(m.api.getCurrentFps(), 50);
});

test('missing display timing stays unavailable instead of using tiny present gaps', () => {
  const m = monitor();
  m.feed({ present: 0.25, display: 0 });
  m.feed({ present: 0.25, display: 0, dropped: 1 });
  assert.equal(m.api.getCurrentFps(), null);
});

test('legacy CSV without display columns still averages all present intervals', () => {
  const m = monitor('Application,ProcessID,PresentMode,msBetweenPresents\n');
  for (let i = 0; i < 20; i++) {
    for (const interval of [2.5, 2.5, 25]) {
      m.input(GAME + '.exe,42,Hardware: Independent Flip,' + interval + '\n');
    }
  }
  assert.equal(m.api.getCurrentFps(), 100);
  assert.equal(m.api.getGamingProcess().metric, 'presented');
});

const MODERN_HEADER = 'Application,ProcessID,SwapChainAddress,PresentMode,FrameType,CPUStartTime,FrameTime,DisplayedTime\n';

test('2.x counts every displayed frame including generated frames, not only engine frames', () => {
  const m = monitor(MODERN_HEADER);
  for (let i = 0; i < 110; i++) {
    // Engine produces 110 frames/s, then FG supplies another 110 display frames.
    // FrameTime and FrameType must not halve the displayed-frame count.
    for (const type of ['Application', 'Intel XeSS-FG']) {
      m.input([GAME + '.exe', 42, '0x1', 'Hardware: Independent Flip', type,
        i * 1000 / 110, 1000 / 110, 1000 / 220].join(',') + '\n');
    }
  }
  assert.equal(m.api.getCurrentFps(), 220);
  assert.equal(m.api.getGamingProcess().metric, 'displayed');
});

test('NVIDIA-style frames without generated-frame labels still use their full display cadence', () => {
  const m = monitor(MODERN_HEADER);
  for (let i = 0; i < 220; i++) {
    m.input([GAME + '.exe', 42, '0x1', 'Hardware: Independent Flip', 'Application',
      i * 1000 / 220, 1000 / 110, 1000 / 220].join(',') + '\n');
  }
  assert.equal(m.api.getCurrentFps(), 220);
});

test('2.x unavailable display frames are excluded without falling back to CPU frame time', () => {
  const m = monitor(MODERN_HEADER);
  m.input(GAME + '.exe,42,0x1,Hardware: Independent Flip,Application,100,1,NA\n');
  assert.equal(m.api.getCurrentFps(), null);
  m.input(GAME + '.exe,42,0x1,Hardware: Independent Flip,Application,110,1,5\n');
  assert.equal(m.api.getCurrentFps(), 200);
});

test('2.x CPUStartTime is milliseconds, so old intervals expire after two seconds', () => {
  const m = monitor(MODERN_HEADER);
  for (let i = 0; i < 10; i++) {
    m.input(GAME + '.exe,42,0x1,Hardware: Independent Flip,Application,' + i * 10 + ',10,10\n');
  }
  m.input(GAME + '.exe,42,0x1,Hardware: Independent Flip,Application,1500,20,20\n');
  assert.equal(m.api.getCurrentFps(), 92);
  m.input(GAME + '.exe,42,0x1,Hardware: Independent Flip,Application,4000,20,20\n');
  assert.equal(m.api.getCurrentFps(), 50);
});

test('upgrading the reader uses modern metrics and retains its isolated ETW session', () => {
  const m = monitor();
  assert.equal(m.spawns.length, 0); // no tracing before a dashboard connects
  assert.equal(m.api.isCurrentVersionAvailable(), false);
  m.api.resumeFpsMonitor();
  assert.ok(m.spawns[0].args.includes('-no_top'));
  assert.ok(m.spawns[0].args.includes('XenonFps'));
  m.state.modern = true;
  assert.equal(m.api.isCurrentVersionAvailable(), true);
  m.api.reload();
  assert.equal(m.spawns[0].child.killed, true);
  m.timers.pop()();
  assert.ok(m.spawns[1].exe.endsWith('PresentMon-2.5.1-x64.exe'));
  for (const arg of ['--v2_metrics', '--track_frame_type', '--no_console_stats', 'XenonFps']) {
    assert.ok(m.spawns[1].args.includes(arg), arg);
  }
  assert.equal(m.spawns[1].options.windowsHide, true);
});
