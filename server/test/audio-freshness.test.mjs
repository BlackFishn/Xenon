import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/volume.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const gate = server.slice(server.indexOf('const AUDIO_WATCH_WINDOW_MS'), server.indexOf("let _lastAudioJson"));

test('a visible idle mixer renews fallback demand beyond two minutes, then stops when hidden', async () => {
  let now = 1, reads = 0, interval, period;
  const listeners = new Map();
  const pane = { getClientRects: () => pane.visible ? [{}] : [], visible: true, currentPage: true };
  const context = vm.createContext({
    Date: { now: () => now }, _serverHubSettings: {},
    document: { hidden: false, querySelectorAll: () => [pane], addEventListener: (name, fn) => listeners.set(name, fn) },
    window: { addEventListener: (name, fn) => listeners.set(name, fn) },
    onVisiblePage: el => el.currentPage,
    setInterval: (fn, ms) => { interval = fn; period = ms; },
  });
  vm.runInContext(source + '\n' + gate, context);
  context.fetchAudio = () => { reads++; context._noteAudioWatched(); };
  context.startVisibleAudioRefresh();
  assert.ok(period > 0 && period < 120000);
  for (; now <= 300001; now += period) {
    interval();
    assert.equal(context.audioPollWanted(), true, 'open mixer must keep receiving app changes');
  }
  assert.ok(reads > 1);
  const activeReads = reads;
  pane.visible = false;
  for (let i = 0; i < Math.ceil(130000 / period); i++) { now += period; interval(); }
  assert.equal(reads, activeReads, 'a hidden mixer must not collect audio');
  assert.equal(context.audioPollWanted(), false, 'unused fallback polling must expire');
  pane.visible = true;
  pane.currentPage = false;
  interval();
  assert.equal(reads, activeReads, 'mounted off-screen pager pages must stay idle');
  pane.currentPage = true;
  listeners.get('xenon:page-change')();
  assert.equal(reads, activeReads + 1, 'returning to the mixer refreshes immediately');
  context.document.hidden = true;
  interval();
  listeners.get('visibilitychange')();
  assert.equal(reads, activeReads + 1);
  context.document.hidden = false;
  listeners.get('visibilitychange')();
  assert.equal(reads, activeReads + 2, 'restoring the app refreshes immediately');
});
