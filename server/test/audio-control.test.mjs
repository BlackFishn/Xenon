import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const { createAudioControl } = createRequire(import.meta.url)('../audio-control');
const rows = [Array.from({ length: 22 }, (_, i) => i === 0 ? 'RØDE' : '')];
function fakeHost(reply) {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
  proc.send = data => proc.stdout.write(JSON.stringify(data) + '\n');
  proc.stdin = new Writable({
    write(chunk, encoding, done) { reply(JSON.parse(chunk.toString()), proc); done(); },
    final(done) { done(); queueMicrotask(() => proc.emit('exit', 0)); },
  });
  proc.kill = () => proc.emit('exit', 0);
  return proc;
}

test('audio host keeps one process, accepts split UTF-8 events, and reads post-write values', async () => {
  let launches = 0, current = rows, host;
  const control = createAudioControl({ supported: true, spawn: () => {
    launches++;
    host = fakeHost((message, proc) => {
      if (message.action === 'command') current = [rows[0].map((x, i) => i === 10 ? '37' : x)];
      proc.send({ id: message.id, ok: true, ...(message.action === 'snapshot' ? { rows: current } : {}) });
    });
    queueMicrotask(() => {
      const bytes = Buffer.from(JSON.stringify({ event: 'audio', rows }) + '\n');
      for (const byte of bytes) host.stdout.write(Buffer.from([byte]));
    });
    return host;
  } });
  try {
    assert.deepEqual(await control.rows(), rows);
    await control.command(['/SetVolume', 'test.exe', '37']);
    assert.equal((await control.rows())[0][10], '37');
    assert.equal(launches, 1);
  } finally { control.stop(); }
});

test('an old helper falls back once, without repeatedly launching a failed process', async () => {
  let launches = 0;
  const control = createAudioControl({ supported: true, spawn: () => {
    launches++;
    const proc = fakeHost(() => {});
    queueMicrotask(() => proc.emit('exit', 2));
    return proc;
  } });
  assert.equal(await control.rows(), null);
  assert.equal(await control.command(['/Mute', 'test.exe']), false);
  assert.equal(await control.rows(), null);
  assert.equal(launches, 1);
});

test('a rejected native write surfaces failure rather than returning fallback permission', async () => {
  const control = createAudioControl({ supported: true, spawn: () => {
    const proc = fakeHost(message => proc.send({ id: message.id, ok: false, error: 'Gone' }));
    queueMicrotask(() => proc.send({ event: 'audio', rows }));
    return proc;
  } });
  try { await assert.rejects(control.command(['/Switch', 'gone.exe']), /Gone/); }
  finally { control.stop(); }
});

test('oversized or malformed snapshots cannot become audio state', async () => {
  const control = createAudioControl({ supported: true, spawn: () => {
    const proc = fakeHost(() => {});
    queueMicrotask(() => proc.send({ event: 'audio', rows: [['invalid']] }));
    return proc;
  } });
  assert.equal(await control.rows(), null);
  assert.equal(control.running(), false);
});

test('slider sends immediately, coalesces slow writes, and delivers the final value', async () => {
  const context = vm.createContext({ setTimeout, clearTimeout, Date, setOffline: () => {} });
  vm.runInContext(readFileSync(new URL('../js/volume.js', import.meta.url), 'utf8'), context);
  const sent = [];
  let finish;
  const send = value => { sent.push(value); return new Promise(resolve => { finish = resolve; }); };
  context.queueAudioWrite('test', 10, send);
  assert.deepEqual(sent, [10]);
  for (let i = 11; i <= 90; i++) context.queueAudioWrite('test', i, send);
  assert.deepEqual(sent, [10]);
  finish();
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.deepEqual(sent, [10, 90]);
  finish();
  await new Promise(resolve => setTimeout(resolve, 65));
  context.queueAudioWrite('test', 25, send);
  assert.deepEqual(sent, [10, 90, 25]);
  finish();
});
