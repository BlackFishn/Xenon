import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const require = createRequire(import.meta.url);
const { createLocalVideo, validateFile, streamArgs, metadata, shiftVtt } = require('../local-video.js');

const PROBE = { format: { duration: '100' }, streams: [
  { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
  { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'eng' } },
  { index: 2, codec_type: 'audio', codec_name: 'ac3', channels: 6, tags: { language: 'tha', title: 'Thai' }, disposition: { default: 1 } },
  { index: 3, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
  { index: 4, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'tha' } },
  { index: 5, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'jpn' } }
] };
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nOne\n\n00:00:04.000 --> 00:00:05.500\nTwo\n';

async function fixture(t, extra = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'xenon-local-video-test-'));
  const video = path.join(dir, 'movie.mkv');
  await writeFile(video, 'synthetic fixture');
  const calls = [];
  const children = [];
  const engine = createLocalVideo({
    tempRoot: dir,
    platform: 'win32', getFfmpegPath: () => 'ffmpeg', pickFiles: async () => [video],
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      if (args.includes('-version')) return { stdout: 'ffmpeg version' };
      if (args.includes('-show_streams')) return { stdout: JSON.stringify(PROBE) };
      return { stdout: VTT };
    },
    spawn: (file, args, options) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.kill = () => { child.killed = true; child.stdout.destroy(); child.emit('close', 1); };
      children.push({ child, file, args, options });
      return child;
    }, ...extra
  });
  t.after(async () => { await engine.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, video, calls, children, engine };
}

function response() {
  const res = new PassThrough();
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.resume();
  return res;
}

test('picker authorizes opaque IDs and exposes language metadata without paths', async t => {
  const { engine, video } = await fixture(t);
  const result = await engine.pickVideos();
  assert.equal(result.ok, true);
  const info = result.files[0];
  assert.match(info.id, /^[a-f0-9]{32}$/);
  assert.equal(info.defaultAudio, '2');
  assert.equal(info.defaultSubtitle, 'off');
  assert.equal(info.audioTracks[1].language, 'tha');
  assert.equal(info.subtitleTracks[1].styling, 'plain');
  assert.equal(info.subtitleTracks[2].supported, false);
  assert.equal(info.playbackMode, 'copy');
  assert.equal(JSON.stringify(result).includes(video), false);
  assert.deepEqual(await engine.status(), { ok: true, available: true, engine: 'ffmpeg', platform: 'win32', pickerSupported: true,
    importSupported: true, maxImportBytes: 16 * 1024 ** 3, maxImportTotalBytes: 32 * 1024 ** 3, maxSubtitleBytes: 8 * 1024 ** 2, activeStreams: 0 });
});

test('file authorization refuses relative paths, URLs, UNC, ADS, non-media and changed files', async t => {
  const { engine, video } = await fixture(t);
  for (const candidate of ['movie.mkv', 'https://host/movie.mkv', '\\\\host\\share\\movie.mkv', `${video}:payload.mkv`]) {
    await assert.rejects(validateFile(candidate));
  }
  const info = (await engine.pickVideos()).files[0];
  await writeFile(video, 'changed fixture content');
  await assert.rejects(engine.stream(new EventEmitter(), response(), { id: info.id, owner: 'widget-one', generation: 'session-one' }), { code: 'file_changed' });
  await assert.rejects(engine.stream(new EventEmitter(), response(), { id: video, owner: 'widget-one', generation: 'session-one' }), { code: 'unknown_file' });
});

test('symlink selections cannot authorize a different file', async t => {
  const { dir, video } = await fixture(t);
  const alias = path.join(dir, 'alias.mkv');
  try { await symlink(video, alias); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Windows user cannot create symlinks'); return; } throw error; }
  await assert.rejects(validateFile(alias), { code: 'invalid_file' });
});

test('ordinary H264/AAC playback copies picture and audio; other audio only encodes audio', () => {
  const record = { id: 'test', path: path.resolve('movie.mkv') };
  metadata(PROBE, record);
  const original = streamArgs(record, record.info.audioTracks[0], 12.5);
  assert.equal(original[original.indexOf('-c:v') + 1], 'copy');
  assert.equal(original[original.indexOf('-c:a') + 1], 'copy');
  assert.equal(original.includes('-vf'), false);
  assert.equal(original.includes('file,pipe'), true);
  assert.equal(original[original.indexOf('-readrate') + 1], '1');
  const alternate = streamArgs(record, record.info.audioTracks[1], 12.5);
  assert.equal(alternate[alternate.indexOf('-c:v') + 1], 'copy');
  assert.equal(alternate[alternate.indexOf('-c:a') + 1], 'aac');
  assert.equal(alternate.includes('0:2'), true);
  record.video.codec = 'hevc';
  record.video.copy = false;
  const fallback = streamArgs(record, record.info.audioTracks[0], 0);
  assert.equal(fallback[fallback.indexOf('-c:v') + 1], 'libx264');
  assert.match(fallback[fallback.indexOf('-vf') + 1], /1280.*720/);
  assert.equal(fallback[fallback.lastIndexOf('-threads') + 1], '2');
});

test('subtitle extraction coalesces/cache full text and shifts cues on seek without another process', async t => {
  const { engine, calls } = await fixture(t);
  const info = (await engine.pickVideos()).files[0];
  const [one, two] = await Promise.all([
    engine.subtitles({ id: info.id, track: '3', start: 2 }),
    engine.subtitles({ id: info.id, track: '3', start: 4 })
  ]);
  assert.match(one, /00:00:00.000 --> 00:00:01.000\nOne/);
  assert.equal(two.includes('One'), false);
  assert.match(two, /00:00:00.000 --> 00:00:01.500\nTwo/);
  assert.equal(calls.filter(c => c.args.includes('webvtt')).length, 1);
  await assert.rejects(engine.subtitles({ id: info.id, track: '5' }), { code: 'unsupported_subtitle' });
  assert.equal(shiftVtt(VTT, 0), VTT);
});

test('external subtitles require picker grant and are size bounded', async t => {
  const { engine, dir, video } = await fixture(t, { pickFiles: async kind => [kind === 'Videos' ? videoFile : subtitleFile] });
  const videoFile = video;
  const subtitleFile = path.join(dir, 'thai.ass');
  await writeFile(subtitleFile, '[Script Info]\n');
  const info = (await engine.pickVideos()).files[0];
  const result = await engine.pickSubtitle(info.id);
  const added = result.file.subtitleTracks.at(-1);
  assert.match(added.id, /^external-[a-f0-9]{32}$/);
  assert.equal(added.styling, 'plain');
  assert.equal(JSON.stringify(result).includes(subtitleFile), false);
  await writeFile(subtitleFile, Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(engine.pickSubtitle(info.id), { code: 'subtitle_too_large' });
});

test('each owner has one process; stale stop cannot kill replacement; disconnect and close clean up', async t => {
  const { engine, children } = await fixture(t);
  const info = (await engine.pickVideos()).files[0];
  const req = new EventEmitter();
  const first = response();
  await engine.stream(req, first, { id: info.id, owner: 'widget-one', generation: 'session-one', audio: '1' });
  children[0].child.stdout.write(Buffer.from('mp4'));
  assert.equal(first.status, 200);
  const replacement = response();
  await engine.stream(req, replacement, { id: info.id, owner: 'widget-one', generation: 'session-two', audio: '2' });
  assert.equal(children[0].child.killed, true);
  engine.stop({ owner: 'widget-one', generation: 'session-one' });
  assert.equal(children[1].child.killed, undefined);
  req.emit('aborted');
  assert.equal(children[1].child.killed, true);
  await engine.stream(new EventEmitter(), response(), { id: info.id, owner: 'widget-one', generation: 'session-new' });
  engine.close();
  assert.equal(children[2].child.killed, true);
});

test('concurrent playback cap, unknown tracks and invalid positions do not launch extra processes', async t => {
  const { engine, children } = await fixture(t);
  const info = (await engine.pickVideos()).files[0];
  for (const owner of ['widget-one', 'widget-two']) await engine.stream(new EventEmitter(), response(), { id: info.id, owner, generation: 'session-one' });
  await assert.rejects(engine.stream(new EventEmitter(), response(), { id: info.id, owner: 'widget-three', generation: 'session-one' }), { code: 'player_busy' });
  await assert.rejects(engine.stream(new EventEmitter(), response(), { id: info.id, owner: 'widget-three', generation: 'session-one', audio: '999' }), { code: 'invalid_audio' });
  await assert.rejects(engine.stream(new EventEmitter(), response(), { id: info.id, owner: 'widget-three', generation: 'session-one', start: -1 }), { code: 'invalid_position' });
  assert.equal(children.length, 2);
});

test('aborted pending start and an early generation stop never replace newer playback', async t => {
  const { engine, children } = await fixture(t);
  const info = (await engine.pickVideos()).files[0];
  const oldRequest = new EventEmitter();
  const obsolete = engine.stream(oldRequest, response(), { id: info.id, owner: 'widget-one', generation: 'session-old' });
  oldRequest.aborted = true;
  await engine.stream(new EventEmitter(), response(), { id: info.id, owner: 'widget-one', generation: 'session-new' });
  await obsolete;
  assert.equal(children.length, 1);
  assert.equal(children[0].child.killed, undefined);
  const pending = engine.stream(new EventEmitter(), response(), { id: info.id, owner: 'widget-two', generation: 'session-pending' });
  engine.stop({ owner: 'widget-two', generation: 'session-pending' });
  await pending;
  assert.equal(children.length, 1);
  await engine.stream(new EventEmitter(), response(), { id: info.id, owner: 'widget-two', generation: 'session-pending' });
  assert.equal(children.length, 1);
});

test('picker is single-flight while engine discovery is still pending', async t => {
  let release;
  let opened = 0;
  const ready = new Promise(resolve => { release = resolve; });
  const { engine } = await fixture(t, {
    execFile: async () => { await ready; return { stdout: 'version' }; },
    pickFiles: async () => { opened++; return []; }
  });
  const first = engine.pickVideos();
  await assert.rejects(engine.pickVideos(), { code: 'picker_busy' });
  release();
  assert.equal((await first).cancelled, true);
  assert.equal(opened, 1);
});

test('copied seek maps exact DTS, B-frame delay and encoder priming without estimating frame rate', async t => {
  let packets = 0;
  const { engine } = await fixture(t, { execFile: async (file, args) => {
    if (args.includes('-version')) return { stdout: 'version' };
    if (args.includes('-show_streams')) return { stdout: JSON.stringify({ ...PROBE, format: { duration: '100', start_time: '-0.021' } }) };
    assert.equal(args.includes('copy'), true);
    assert.equal(args[args.indexOf('-frames:v') + 1], '1');
    packets++;
    return { stdout: '#tb 0: 1/1000\n0, -83, 0, 41, 4453, 0xc22668fa\n' };
  } });
  const info = (await engine.pickVideos()).files[0];
  const [one, two] = await Promise.all([engine.prepare({ id: info.id, start: 1.3 }), engine.prepare({ id: info.id, start: 1.3 })]);
  assert.equal(one.actualStart, -0.062);
  assert.equal(one.seekOffset, 1.362);
  assert.deepEqual(one, two);
  assert.equal(packets, 1);
  await engine.prepare({ id: info.id, start: 1.3 });
  assert.equal(packets, 1);
});

test('independent picker grants allow one widget to release without revoking another', async t => {
  const { engine, children } = await fixture(t);
  const first = (await engine.pickVideos()).files[0];
  const second = (await engine.pickVideos()).files[0];
  assert.notEqual(first.id, second.id);
  await engine.stream(new EventEmitter(), response(), { id: first.id, owner: 'widget-one', generation: 'session-one', rate: '2' });
  assert.equal(children[0].args[children[0].args.indexOf('-readrate') + 1], '2');
  engine.releaseFiles([second.id]);
  assert.equal(children[0].child.killed, undefined);
  await assert.rejects(engine.prepare({ id: second.id }), { code: 'unknown_file' });
  engine.releaseFiles([first.id]);
  assert.equal(children[0].child.killed, true);
});

test('subtitle extraction work stays bounded while distinct requests are pending', async t => {
  let finish;
  let started;
  let count = 0;
  const wait = new Promise(resolve => { finish = resolve; });
  const both = new Promise(resolve => { started = resolve; });
  const { engine } = await fixture(t, { execFile: async (file, args) => {
    if (args.includes('-version')) return { stdout: 'version' };
    if (args.includes('-show_streams')) return { stdout: JSON.stringify({ ...PROBE, streams: [...PROBE.streams, { index: 6, codec_type: 'subtitle', codec_name: 'subrip' }] }) };
    count++;
    if (count === 2) started();
    await wait;
    return { stdout: VTT };
  } });
  const info = (await engine.pickVideos()).files[0];
  const one = engine.subtitles({ id: info.id, track: '3' });
  const two = engine.subtitles({ id: info.id, track: '4' });
  await both;
  await assert.rejects(engine.subtitles({ id: info.id, track: '6' }), { code: 'player_busy' });
  assert.equal(count, 2);
  finish();
  await Promise.all([one, two]);
});

function upload(body) {
  const req = new PassThrough();
  req.headers = {};
  if (body !== undefined) queueMicrotask(() => req.end(body));
  return req;
}

async function importedFiles(dir) {
  const directories = (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.startsWith('xenon-local-video-'));
  return (await Promise.all(directories.map(async entry => (await readdir(path.join(dir, entry.name))).map(name => path.join(dir, entry.name, name))))).flat();
}

test('browser imports stream to private temporary files and keep the original display name', async t => {
  const { engine, dir } = await fixture(t);
  const req = upload();
  const pending = engine.importFile(req, { name: 'ภาพยนตร์.mkv', size: 1024 * 1024 });
  for (let i = 0; i < 16; i++) req.write(Buffer.alloc(64 * 1024, i));
  req.end();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.files[0].name, 'ภาพยนตร์.mkv');
  assert.equal(result.files[0].audioTracks.length, 2);
  const imported = await importedFiles(dir);
  assert.equal(imported.length, 1);
  assert.match(path.basename(imported[0]), /^[a-f0-9]{32}\.mkv$/);
  assert.equal((await readFile(imported[0])).length, 1024 * 1024);
  assert.equal(JSON.stringify(result).includes(dir), false);
  engine.releaseFiles([result.files[0].id]);
  await engine.close();
  assert.deepEqual(await importedFiles(dir), []);
});

test('invalid names, extensions, sizes and low disk space reject before consuming uploads', async t => {
  const { engine } = await fixture(t, { statfs: async () => ({ bavail: 10, bsize: 1024 }) });
  for (const name of ['../movie.mkv', 'C:\\movie.mkv', 'movie.mkv:secret', 'movie.exe']) {
    await assert.rejects(engine.importFile(upload(), { name, size: 10 }));
  }
  for (const size of [0, -1, NaN, Infinity, 1.5, 16 * 1024 ** 3 + 1]) {
    await assert.rejects(engine.importFile(upload(), { name: 'movie.mkv', size }));
  }
  await assert.rejects(engine.importFile(upload(), { name: 'movie.mkv', size: 10 }), { code: 'no_space' });
});

test('truncated and oversized upload bodies remove committed and partial temp files', async t => {
  const { engine, dir } = await fixture(t);
  await assert.rejects(engine.importFile(upload(Buffer.from('abc')), { name: 'movie.mkv', size: 10 }), { code: 'import_aborted' });
  await assert.rejects(engine.importFile(upload(Buffer.from('too many bytes')), { name: 'movie.mkv', size: 3 }), { code: 'import_too_large' });
  assert.deepEqual(await importedFiles(dir), []);
});

test('imports remain capped at two; closing aborts writers and removes partial files', async t => {
  const { engine, dir } = await fixture(t);
  const one = engine.importFile(upload(), { name: 'one.mkv', size: 100 }).catch(error => error.code);
  const two = engine.importFile(upload(), { name: 'two.mkv', size: 100 }).catch(error => error.code);
  await assert.rejects(engine.importFile(upload(), { name: 'three.mkv', size: 100 }), { code: 'import_busy' });
  await new Promise(resolve => setTimeout(resolve, 20));
  await engine.close();
  assert.deepEqual(await Promise.all([one, two]), ['import_aborted', 'import_aborted']);
  assert.deepEqual(await importedFiles(dir), []);
});

test('idle upload timeout aborts the atomic stream and releases its import slot', async t => {
  const { engine, dir } = await fixture(t, { importIdleMs: 20 });
  const pending = engine.importFile(upload(), { name: 'movie.mkv', size: 100 });
  const keepAlive = setTimeout(() => {}, 100);
  try { await assert.rejects(pending, { code: 'import_aborted' }); }
  finally { clearTimeout(keepAlive); }
  assert.deepEqual(await importedFiles(dir), []);
});

test('client disconnect during probing cancels its child and removes the full import', async t => {
  let enteredProbe;
  const probing = new Promise(resolve => { enteredProbe = resolve; });
  let killed = false;
  const { engine, dir } = await fixture(t, { execFile: (file, args) => {
    if (args.includes('-version')) return Promise.resolve({ stdout: 'version' });
    let rejectProbe;
    const result = new Promise((resolve, reject) => { rejectProbe = reject; });
    result.child = { kill() { killed = true; rejectProbe(Object.assign(new Error('terminated'), { code: 'KILLED' })); } };
    enteredProbe();
    return result;
  } });
  const req = upload(Buffer.from('abc'));
  req.socket = new EventEmitter();
  const pending = engine.importFile(req, { name: 'movie.mkv', size: 3 });
  await probing;
  req.socket.emit('close');
  await assert.rejects(pending, { code: 'import_aborted' });
  assert.equal(killed, true);
  assert.deepEqual(await importedFiles(dir), []);
});

test('discarding an imported subtitle after a lost response preserves its video grant', async t => {
  const { engine, dir } = await fixture(t);
  const file = (await engine.pickVideos()).files[0];
  const initial = file.subtitleTracks.length;
  const result = await engine.importFile(upload(Buffer.from('subtitle')), { id: file.id, name: 'ไทย.srt', size: 8 });
  assert.equal(result.file.subtitleTracks.length, initial + 1);
  assert.match(result.importedTrackId, /^external-[a-f0-9]{32}$/);
  engine.discardImport(result);
  assert.equal(result.file.subtitleTracks.length, initial);
  const text = await engine.subtitles({ id: file.id, track: '3' });
  assert.match(text, /WEBVTT/);
  await engine.close();
  assert.deepEqual(await importedFiles(dir), []);
});
