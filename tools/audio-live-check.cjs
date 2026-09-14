'use strict';
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const probeExe = path.join(root, '.codex/audio-build/probe/xenon-audio-probe.exe');
const base = 'http://127.0.0.1:3030';
const controller = new AbortController();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let latest = null;
const watchers = new Set();
function expect(predicate, timeout = 8000) {
  if (predicate(latest)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = { predicate, resolve: () => { clearTimeout(timer); watchers.delete(watcher); resolve(); } };
    const timer = setTimeout(() => { watchers.delete(watcher); reject(new Error('Live audio event timeout')); }, timeout);
    watchers.add(watcher);
  });
}
const probeRow = data => data?.speakerApps?.find(app => app.proc === 'xenon-audio-probe');
async function post(route, body) {
  const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(route + ': ' + res.status);
  return res.json();
}
let probe;
(async () => {
  try {
    const stream = await fetch(base + '/sse', { signal: controller.signal });
    if (!stream.ok) throw new Error('SSE unavailable');
    const reader = (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of stream.body) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (!/^event: ?audio$/m.test(frame)) continue;
          latest = JSON.parse(frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n'));
          for (const watcher of [...watchers]) if (watcher.predicate(latest)) watcher.resolve();
        }
      }
    })();
    reader.catch(() => {});
    const initial = await (await fetch(base + '/audio')).json();
    assert.match(initial.speaker.id, /^\{0\./, 'native endpoint ID confirms new backend is active');
    console.log('Native backend confirmed. Waiting 125 seconds without audio requests...');
    await wait(125000);
    let start = performance.now();
    probe = spawn(probeExe, [], { windowsHide: true });
    await expect(data => !!probeRow(data));
    const openMs = performance.now() - start;
    start = performance.now();
    probe.stdin.end();
    await expect(data => data && !probeRow(data));
    const closeMs = performance.now() - start;
    console.log(JSON.stringify({ after125SecondsWithoutAudioRequests: { openMs, closeMs } }));
    // A second isolated session exercises the real HTTP -> Node -> COM path.
    probe = spawn(probeExe, [], { windowsHide: true });
    await expect(data => !!probeRow(data));
    const latencies = [];
    for (const level of [20, 40, 60, 80, 35, 55, 75, 25, 45, 65]) {
      start = performance.now();
      await post('/audio/app/volume', { proc: 'xenon-audio-probe', level });
      latencies.push(performance.now() - start);
      const actual = await (await fetch(base + '/audio')).json();
      assert.equal(probeRow(actual).volume, level);
    }
    await post('/audio/app/mute', { proc: 'xenon-audio-probe', muted: true });
    assert.equal(probeRow(await (await fetch(base + '/audio')).json()).muted, true);
    await post('/audio/app/mute', { proc: 'xenon-audio-probe', muted: false });
    assert.equal(probeRow(await (await fetch(base + '/audio')).json()).muted, false);
    probe.stdin.end();
    await expect(data => data && !probeRow(data));
    const final = await (await fetch(base + '/audio')).json();
    assert.equal(final.speaker.volume, initial.speaker.volume);
    assert.equal(final.speaker.muted, initial.speaker.muted);
    assert.equal(final.mic.volume, initial.mic.volume);
    assert.equal(final.mic.muted, initial.mic.muted);
    console.log(JSON.stringify({ httpWriteMs: latencies, muteVerified: true, masterAndMicrophoneUnchanged: true }));
  } finally { if (probe) probe.stdin.end(); controller.abort(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
