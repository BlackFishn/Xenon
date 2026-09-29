import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/local-video-player.js', import.meta.url), 'utf8');
const file = {
  id: 'a'.repeat(32), name: 'Languages.mkv', duration: 120, defaultAudio: '1',
  audioTracks: [{ id: '1', language: 'eng', codec: 'aac' }, { id: '2', language: 'tha', codec: 'aac' }],
  subtitleTracks: [{ id: '3', language: 'eng', codec: 'subrip', supported: true, delivery: 'vtt' }, { id: '4', language: 'jpn', codec: 'hdmv_pgs_subtitle', supported: false }],
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup({ available = true, picked = [file], pendingPick, prepare, denyPlayback = false } = {}) {
  const calls = [], revoked = []; let counter = 0;
  const document = { activeElement: null };
  class Node {
    constructor(tag, cls = '', text = '') {
      this.tagName = tag; this.className = cls; this.textContent = text; this.children = []; this.parentNode = null;
      this.dataset = {}; this.attributes = {}; this.events = {}; this.hidden = false; this.value = ''; this.paused = true;
      this.currentTime = 0; this.volume = 1; this.style = { setProperty() {} }; this.open = false; this.isConnected = true;
      this.track = tag === 'track' ? { mode: 'disabled' } : undefined;
      this.classList = {
        contains: name => this.className.split(' ').includes(name),
        add: name => { if (!this.classList.contains(name)) this.className += ' ' + name; },
        remove: name => { this.className = this.className.split(' ').filter(value => value !== name).join(' '); },
        toggle: (name, on) => { if (on ?? !this.classList.contains(name)) this.classList.add(name); else this.classList.remove(name); },
      };
    }
    append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
    replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.append(...children); }
    remove() { this.isConnected = false; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    removeAttribute(key) { delete this.attributes[key]; if (key === 'src') this.src = ''; if (key === 'poster') delete this.poster; }
    getAttribute(key) { return this.attributes[key] ?? null; }
    addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
    emit(name, details = {}) { for (const fn of this.events[name] || []) fn({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...details }); }
    click() { this.emit('click'); }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
    getBoundingClientRect() { return { left: 10, top: 10, right: 810, bottom: 460 }; }
    get options() { return this.children; }
    querySelectorAll(selector) {
      const match = node => selector.startsWith('.') ? node.classList.contains(selector.slice(1)) : selector.startsWith('[data-') ? node.dataset[selector.slice(6, -1).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] !== undefined : node.tagName === selector;
      return this.children.flatMap(child => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    play() { if (denyPlayback) return Promise.reject(new Error('NotAllowedError')); this.paused = false; this.emit('play'); return Promise.resolve(); }
    pause() { this.paused = true; this.emit('pause'); }
    load() { this.currentTime = 0; }
  }
  document.body = new Node('body');
  const makeEl = (tag, cls, text) => new Node(tag, cls, text);
  const window = {};
  const context = vm.createContext({
    window, document, makeEl, URLSearchParams, URL: { createObjectURL: () => 'blob:poster-' + ++counter, revokeObjectURL: value => revoked.push(value) }, crypto: { randomUUID: () => String(++counter).padStart(32, '0') },
    apiJson: async (path, options) => {
      const body = options?.body ? JSON.parse(options.body) : null; calls.push({ path, body });
      if (path.endsWith('/status')) return { ok: available, available, error: available ? undefined : 'ffmpeg_missing' };
      if (path.endsWith('/pick')) return pendingPick ? pendingPick() : { ok: true, files: picked };
      if (path.startsWith('/media/local/prepare?')) { const start = Number(new URL(path, 'http://localhost').searchParams.get('start')); return prepare ? prepare(start) : { ok: true, start, actualStart: Math.floor(start), seekOffset: start % 1 }; }
      if (path.endsWith('/subtitle')) return { ok: true, file: { ...file, subtitleTracks: [...file.subtitleTracks, { id: 'external-' + 'b'.repeat(32), language: 'tha', supported: true, delivery: 'vtt' }] } };
      return { ok: true };
    },
  });
  vm.runInContext(source, context);
  const mount = new Node('div'), wrap = new Node('div'); mount.append(wrap);
  for (const cls of ['yt-focus', 'yt-fill', 'yt-filled-actions', 'yt-restore', 'media-open-files']) mount.append(new Node('button', cls));
  let starts = 0;
  const player = window.LocalVideoPlayer.create({ mount, wrap, onPlay() { starts += 1; } });
  player.setActive(true);
  return { player, calls, revoked, mount, wrap, document, video: wrap.querySelector('video'), stage: wrap.querySelector('dialog'), find: cls => wrap.querySelector('.' + cls), get starts() { return starts; } };
}

test('picker-issued files play through opaque IDs with correct audio and scoped cancellation', async () => {
  const r = setup(); await r.player.openFiles();
  const first = new URL(r.video.src, 'http://localhost');
  assert.equal(first.pathname, '/media/local/stream');
  assert.equal(first.searchParams.get('id'), file.id);
  assert.equal(first.searchParams.get('audio'), '1');
  assert.equal(first.searchParams.has('path'), false);
  assert.equal(r.starts, 1);
  r.video.currentTime = 12; r.video.emit('canplay');
  r.find('lv-audio').value = '2'; r.find('lv-audio').emit('change');
  await tick();
  const second = new URL(r.video.src, 'http://localhost');
  assert.equal(second.searchParams.get('audio'), '2');
  assert.equal(second.searchParams.get('start'), '12');
  assert.equal(second.searchParams.get('owner'), first.searchParams.get('owner'));
  assert.notEqual(second.searchParams.get('generation'), first.searchParams.get('generation'));
  assert.deepEqual(r.calls.find(call => call.path.endsWith('/stop')).body, { owner: first.searchParams.get('owner'), generation: first.searchParams.get('generation') });
});

test('subtitle switch and external subtitle use WebVTT without restarting playback', async () => {
  const r = setup(); await r.player.openFiles(); const src = r.video.src;
  r.find('lv-subtitles').value = '3'; r.find('lv-subtitles').emit('change');
  assert.equal(r.video.src, src); assert.equal(r.video.querySelector('track').track.mode, 'showing');
  assert.match(r.video.querySelector('track').src, /track=3&start=0$/);
  assert.equal(r.find('lv-subtitles').options.find(option => option.value === '4').disabled, true);
  r.find('lv-subtitles').value = 'off'; r.find('lv-subtitles').emit('change');
  assert.equal(r.video.querySelector('track'), null);
  r.find('lv-sub-load').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.video.src, src); assert.match(r.video.querySelector('track').src, /track=external-/);
  assert.equal(r.calls.filter(call => call.path.endsWith('/stop')).length, 0);
});

test('pause frees the decoder; paused seek and track selection do not start a stream', async () => {
  const r = setup(); await r.player.openFiles(); r.video.currentTime = 32; r.video.emit('canplay');
  r.find('lv-play').click(); assert.equal(r.video.src, '');
  const stops = r.calls.filter(call => call.path.endsWith('/stop')).length;
  r.find('lv-seek').value = '54'; r.find('lv-seek').emit('input'); r.find('lv-seek').emit('change');
  r.find('lv-audio').value = '2'; r.find('lv-audio').emit('change');
  assert.equal(r.video.src, ''); assert.equal(r.calls.filter(call => call.path.endsWith('/stop')).length, stops);
  r.find('lv-play').click(); await tick(); const url = new URL(r.video.src, 'http://localhost');
  assert.equal(url.searchParams.get('start'), '54'); assert.equal(url.searchParams.get('audio'), '2');
});

test('speed changes restart with matching server read rate; failures stop the decoder', async () => {
  const r = setup(); await r.player.openFiles(); r.video.currentTime = 9; r.video.emit('canplay');
  r.find('lv-rate').value = '2'; r.find('lv-rate').emit('change');
  await tick();
  const url = new URL(r.video.src, 'http://localhost');
  assert.equal(url.searchParams.get('rate'), '2'); assert.equal(url.searchParams.get('start'), '9');
  r.video.emit('error'); assert.equal(r.video.src, '');
  assert.match(r.find('lv-notice').textContent, /could not be played/);
  assert.equal(r.calls.filter(call => call.path.endsWith('/stop')).length, 2);
});

test('blocked autoplay and an external media pause release the decoder', async () => {
  const blocked = setup({ denyPlayback: true }); await blocked.player.openFiles(); await tick();
  assert.equal(blocked.video.src, ''); assert.equal(blocked.calls.filter(call => call.path.endsWith('/stop')).length, 1);
  const r = setup(); await r.player.openFiles(); r.video.emit('canplay'); r.video.pause();
  assert.equal(r.video.src, ''); assert.equal(r.calls.filter(call => call.path.endsWith('/stop')).length, 1);
});

test('seek uses the actual keyframe start for the clock and subtitle timing', async () => {
  const r = setup(); await r.player.openFiles(); r.video.emit('canplay');
  r.find('lv-seek').value = '1.3'; r.find('lv-seek').emit('change'); await tick();
  assert.equal(new URL(r.video.src, 'http://localhost').searchParams.get('start'), '1.3');
  r.video.emit('loadedmetadata'); assert.ok(Math.abs(r.video.currentTime - .3) < .000001);
  r.find('lv-subtitles').value = '3'; r.find('lv-subtitles').emit('change');
  assert.match(r.video.querySelector('track').src, /start=1$/);
  r.video.emit('timeupdate'); assert.ok(Math.abs(Number(r.find('lv-seek').value) - 1.3) < .000001);
});

test('late preparation cannot restart a hidden player', async () => {
  let resolve;
  const r = setup({ prepare: () => new Promise(done => { resolve = done; }) });
  const opening = r.player.openFiles(); await tick(); r.player.setActive(false);
  resolve({ ok: true, start: 0, actualStart: -.06, seekOffset: .06 }); await opening;
  assert.equal(r.video.src, ''); assert.equal(r.starts, 0);
});

test('paused frame is bounded, discarded after resume, and its object URL is revoked', async () => {
  const r = setup(); await r.player.openFiles(); r.video.emit('canplay');
  let callback; const canvas = { getContext: () => ({ drawImage() {} }), toBlob(fn) { callback = fn; } };
  r.document.createElement = () => canvas; r.video.videoWidth = 1920; r.video.videoHeight = 1080;
  r.find('lv-play').click(); assert.equal(canvas.width, 1280); assert.equal(canvas.height, 720);
  r.find('lv-play').click(); await tick(); callback({}); assert.equal(r.video.poster, undefined, 'late snapshot must not cover resumed playback');
  r.video.emit('canplay'); r.find('lv-play').click(); callback({}); const poster = r.video.poster;
  assert.match(poster, /^blob:poster-/); r.find('lv-play').click(); await tick();
  assert.ok(r.revoked.includes(poster)); assert.equal(r.video.poster, undefined);
});

test('Focus preserves the player, source, position and Fill; pause does not close Focus', async () => {
  const r = setup(); await r.player.openFiles(); r.video.currentTime = 28; r.video.emit('canplay');
  r.player.fill(true); const src = r.video.src, parent = r.video.parentNode;
  assert.equal(r.player.setFocus(true), true); assert.equal(r.stage.open, true);
  assert.equal(r.video.src, src); assert.equal(r.video.parentNode, parent); assert.equal(r.video.currentTime, 28);
  r.player.pause(); assert.equal(r.stage.open, true);
  r.stage.emit('cancel'); assert.equal(r.stage.open, false); assert.equal(r.player.isFilled(), true);
  assert.equal(r.document.body.classList.contains('lv-focused'), false);
});

test('switching away and destroying stop playback and ignore a late picker result', async () => {
  const r = setup(); await r.player.openFiles(); r.player.setFocus(true);
  r.player.setActive(false); assert.equal(r.video.src, ''); assert.equal(r.stage.open, false);
  const count = r.calls.filter(call => call.path.endsWith('/stop')).length;
  r.player.destroy(); assert.equal(r.calls.filter(call => call.path.endsWith('/stop')).length, count);
  let resolve;
  const pending = setup({ pendingPick: () => new Promise(done => { resolve = done; }) });
  const request = pending.player.openFiles(); await new Promise(done => setImmediate(done));
  pending.player.destroy(); resolve({ ok: true, files: [file] }); await request;
  assert.equal(pending.video.src, undefined); assert.equal(pending.starts, 0);
});

test('switching to YouTube while a picker is pending never starts hidden playback', async () => {
  let resolve;
  const r = setup({ pendingPick: () => new Promise(done => { resolve = done; }) });
  const request = r.player.openFiles(); await new Promise(done => setImmediate(done));
  r.player.setActive(false); resolve({ ok: true, files: [file] }); await request;
  assert.equal(r.video.src, undefined); assert.equal(r.starts, 0);
  assert.deepEqual(r.calls.find(call => call.path.endsWith('/release')).body, { ids: [file.id] });
});

test('clearing the queue releases file grants and resets playback for the next picker', async () => {
  const r = setup(); await r.player.openFiles();
  r.find('lv-clear-queue').click();
  assert.equal(r.video.src, ''); assert.equal(r.find('lv-empty').hidden, false);
  assert.deepEqual(r.calls.find(call => call.path.endsWith('/release')).body, { ids: [file.id] });
  await r.player.openFiles(); assert.ok(r.video.src.includes(file.id));
});

test('missing engine and cancelled picker explain or preserve state without a stream', async () => {
  const unavailable = setup({ available: false }); await unavailable.player.openFiles();
  assert.match(unavailable.find('lv-notice').textContent, /FFmpeg/);
  assert.equal(unavailable.calls.filter(call => call.path.endsWith('/pick')).length, 0);
  const cancelled = setup({ picked: [] }); await cancelled.player.openFiles();
  assert.equal(cancelled.video.src, undefined); assert.equal(cancelled.find('lv-empty').hidden, false);
});
