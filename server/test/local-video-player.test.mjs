import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/local-video-player.js', import.meta.url), 'utf8');
const file = {
  id: 'a'.repeat(32), name: 'Languages.mkv', duration: 120, width: 1920, height: 1080, defaultAudio: '1',
  audioTracks: [{ id: '1', language: 'eng', codec: 'aac' }, { id: '2', language: 'tha', codec: 'aac' }],
  subtitleTracks: [{ id: '3', language: 'eng', codec: 'subrip', supported: true, delivery: 'vtt' }, { id: '4', language: 'jpn', codec: 'hdmv_pgs_subtitle', supported: false }],
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup({ available = true, picked = [file], pendingPick, prepare, denyPlayback = false } = {}) {
  const calls = [], uploads = [], revoked = [], timers = new Map(); let counter = 0;
  const document = { activeElement: null };
  class Node {
    constructor(tag, cls = '', text = '') {
      this.tagName = tag; this.className = cls; this.textContent = text; this.children = []; this.parentNode = null;
      this.dataset = {}; this.attributes = {}; this.events = {}; this.hidden = false; this.value = ''; this.paused = true;
      this.currentTime = 0; this.volume = 1; this.style = { setProperty(key, value) { this[key] = value; } }; this.open = false; this.isConnected = true;
      this.track = tag === 'track' ? { mode: 'disabled', activeCues: [], events: {},
        addEventListener(name, fn) { this.events[name] = fn; }, removeEventListener(name) { delete this.events[name]; },
        emit(name) { this.events[name]?.(); } } : undefined;
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
    emit(name, details = {}) {
      let stopped = false;
      const event = { target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() { stopped = true; }, ...details };
      for (const fn of this.events[name] || []) { fn(event); if (stopped) break; }
    }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    closest(tag) { return this.tagName === tag ? this : this.parentNode?.closest(tag); }
    click() { this.clicks = (this.clicks || 0) + 1; this.emit('click'); }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
    getBoundingClientRect() { return this.rect || { left: 10, top: 10, right: 810, bottom: 460, width: 800, height: 450 }; }
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
  document.createTextNode = text => new Node('#text', '', text);
  const makeEl = (tag, cls, text) => new Node(tag, cls, text);
  const window = {};
  class XMLHttpRequest {
    constructor() { this.upload = {}; this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) {
      this.body = body; uploads.push(this);
      const id = new URL(this.url, 'http://localhost').searchParams.get('id');
      const result = pendingPick ? pendingPick() : id ? { ok: true, file: { ...file, subtitleTracks: [...file.subtitleTracks, { id: 'external-' + 'b'.repeat(32), language: 'tha', supported: true, delivery: 'vtt' }] } } : { ok: true, files: picked };
      Promise.resolve(result).then(data => { if (this.aborted) return; this.status = data.ok ? 200 : 400; this.responseText = JSON.stringify(data); this.onload(); });
    }
    abort() { this.aborted = true; this.onabort?.(); }
  }
  const context = vm.createContext({
    window, document, makeEl, XMLHttpRequest, URLSearchParams, URL: { createObjectURL: () => 'blob:poster-' + ++counter, revokeObjectURL: value => revoked.push(value) }, crypto: { randomUUID: () => String(++counter).padStart(32, '0') },
    setTimeout(fn, delay) { const id = ++counter; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
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
  return { player, calls, uploads, revoked, timers, expireIdle() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } }, mount, wrap, document, importFiles: () => player.addFiles([{ name: file.name, size: 1024 }]), video: wrap.querySelector('video'), stage: wrap.querySelector('dialog'), find: cls => wrap.querySelector('.' + cls), get starts() { return starts; } };
}

test('Open files and subtitle input click synchronously before any backend request', async () => {
  const r = setup(); r.player.openFiles();
  assert.equal(r.find('lv-video-input').clicks, 1); assert.equal(r.calls.length, 0);
  assert.equal(r.find('lv-video-input').parentNode, r.stage, 'the input stays inside the Focus dialog');
  await r.importFiles(); const calls = r.calls.length;
  r.find('lv-sub-load').click(); assert.equal(r.find('lv-subtitle-input').clicks, 1); assert.equal(r.calls.length, calls);
});

test('multiple files stream serially as File bodies with progress, without reading contents into JavaScript', async () => {
  const resolve = [];
  const r = setup({ pendingPick: () => new Promise(done => resolve.push(done)) });
  const first = { name: 'One.mkv', size: 1024, arrayBuffer() { throw new Error('Do not buffer video contents'); } };
  const second = { name: 'Two.mp4', size: 2048, arrayBuffer() { throw new Error('Do not buffer video contents'); } };
  const preparing = r.player.addFiles([first, second]); await tick();
  assert.equal(r.uploads.length, 1); assert.equal(r.uploads[0].body, first);
  assert.equal(r.uploads[0].headers['Content-Type'], 'application/octet-stream');
  assert.equal(new URL(r.uploads[0].url, 'http://localhost').searchParams.get('size'), '1024');
  r.uploads[0].upload.onprogress({ loaded: 512, lengthComputable: true });
  assert.equal(r.find('lv-import-percent').textContent, '50%'); assert.equal(r.find('lv-import').hidden, false);
  resolve[0]({ ok: true, files: [file] }); await tick();
  assert.equal(r.uploads.length, 2); assert.equal(r.uploads[1].body, second);
  resolve[1]({ ok: true, files: [{ ...file, id: 'c'.repeat(32), name: second.name }] }); await preparing;
  assert.equal(r.find('lv-queue-count').textContent, '2'); assert.equal(r.find('lv-import').hidden, true);
});

test('Cancel aborts a pending import and discards remaining files', async () => {
  const r = setup({ pendingPick: () => new Promise(() => {}) });
  const preparing = r.player.addFiles([{ name: 'One.mkv', size: 1024 }, { name: 'Two.mkv', size: 1024 }]); await tick();
  r.find('lv-import-cancel').click(); await preparing;
  assert.equal(r.uploads.length, 1); assert.equal(r.uploads[0].aborted, true);
  assert.equal(r.find('lv-import').hidden, true); assert.match(r.find('lv-selection-note').textContent, /cancelled/);
  assert.equal(r.video.src, undefined);
});

test('hidden-page cancellation prevents late file preparation from starting playback', async () => {
  let resolve;
  const r = setup({ pendingPick: () => new Promise(done => { resolve = done; }) });
  const preparing = r.importFiles(); await tick(); r.player.cancelImports();
  resolve({ ok: true, files: [file] }); await preparing; await tick();
  assert.equal(r.uploads[0].aborted, true); assert.equal(r.video.src, undefined); assert.equal(r.starts, 0);
});

test('oversize or unsupported files never start an import, and server quota errors are explained', async () => {
  const r = setup(); await r.player.addFiles([{ name: 'Huge.mkv', size: 16 * 1024 ** 3 + 1 }]);
  assert.equal(r.uploads.length, 0); assert.match(r.find('lv-notice').textContent, /16 GB/);
  await r.player.addFiles([{ name: 'not-a-video.txt', size: 20 }]);
  assert.equal(r.uploads.length, 0); assert.match(r.find('lv-notice').textContent, /MKV/);
  const quota = setup({ pendingPick: async () => ({ ok: false, error: 'import_quota' }) }); await quota.importFiles();
  assert.match(quota.find('lv-notice').textContent, /temporary space/);
});

test('imported files play through opaque IDs with correct audio and scoped cancellation', async () => {
  const r = setup(); await r.importFiles();
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
  const r = setup(); await r.importFiles(); const src = r.video.src;
  r.find('lv-subtitles').value = '3'; r.find('lv-subtitles').emit('change');
  assert.equal(r.video.src, src); assert.equal(r.video.querySelector('track').track.mode, 'hidden');
  assert.match(r.video.querySelector('track').src, /track=3&start=0$/);
  assert.equal(r.find('lv-subtitles').options.find(option => option.value === '4').disabled, true);
  r.find('lv-subtitles').value = 'off'; r.find('lv-subtitles').emit('change');
  assert.equal(r.video.querySelector('track'), null);
  await r.player.addFiles([{ name: 'Thai.srt', size: 42 }], true);
  assert.equal(r.video.src, src); assert.match(r.video.querySelector('track').src, /track=external-/);
  assert.equal(r.calls.filter(call => call.path.endsWith('/stop')).length, 0);
});

test('pause frees the decoder; paused seek and track selection do not start a stream', async () => {
  const r = setup(); await r.importFiles(); r.video.currentTime = 32; r.video.emit('canplay');
  r.find('lv-play').click(); assert.equal(r.video.src, '');
  const stops = r.calls.filter(call => call.path.endsWith('/stop')).length;
  r.find('lv-seek').value = '54'; r.find('lv-seek').emit('input'); r.find('lv-seek').emit('change');
  r.find('lv-audio').value = '2'; r.find('lv-audio').emit('change');
  assert.equal(r.video.src, ''); assert.equal(r.calls.filter(call => call.path.endsWith('/stop')).length, stops);
  r.find('lv-play').click(); await tick(); const url = new URL(r.video.src, 'http://localhost');
  assert.equal(url.searchParams.get('start'), '54'); assert.equal(url.searchParams.get('audio'), '2');
});

test('speed changes restart with matching server read rate; failures stop the decoder', async () => {
  const r = setup(); await r.importFiles(); r.video.currentTime = 9; r.video.emit('canplay');
  r.find('lv-rate').value = '2'; r.find('lv-rate').emit('change');
  await tick();
  const url = new URL(r.video.src, 'http://localhost');
  assert.equal(url.searchParams.get('rate'), '2'); assert.equal(url.searchParams.get('start'), '9');
  r.video.emit('error'); assert.equal(r.video.src, '');
  assert.match(r.find('lv-notice').textContent, /could not be played/);
  assert.equal(r.calls.filter(call => call.path.endsWith('/stop')).length, 2);
});

test('blocked autoplay and an external media pause release the decoder', async () => {
  const blocked = setup({ denyPlayback: true }); await blocked.importFiles(); await tick();
  assert.equal(blocked.video.src, ''); assert.equal(blocked.calls.filter(call => call.path.endsWith('/stop')).length, 1);
  const r = setup(); await r.importFiles(); r.video.emit('canplay'); r.video.pause();
  assert.equal(r.video.src, ''); assert.equal(r.calls.filter(call => call.path.endsWith('/stop')).length, 1);
});

test('seek uses the actual keyframe start for the clock and subtitle timing', async () => {
  const r = setup(); await r.importFiles(); r.video.emit('canplay');
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
  const opening = r.importFiles(); await tick(); r.player.setActive(false);
  resolve({ ok: true, start: 0, actualStart: -.06, seekOffset: .06 }); await opening;
  assert.equal(r.video.src, ''); assert.equal(r.starts, 0);
});

test('paused frame is bounded, discarded after resume, and its object URL is revoked', async () => {
  const r = setup(); await r.importFiles(); r.video.emit('canplay');
  let callback; const canvas = { getContext: () => ({ drawImage() {} }), toBlob(fn) { callback = fn; } };
  r.document.createElement = () => canvas; r.video.videoWidth = 1920; r.video.videoHeight = 1080;
  r.find('lv-play').click(); assert.equal(canvas.width, 1280); assert.equal(canvas.height, 720);
  r.find('lv-play').click(); await tick(); callback({}); assert.equal(r.video.poster, undefined, 'late snapshot must not cover resumed playback');
  r.video.emit('canplay'); r.find('lv-play').click(); callback({}); const poster = r.video.poster;
  assert.match(poster, /^blob:poster-/); r.find('lv-play').click(); await tick();
  assert.ok(r.revoked.includes(poster)); assert.equal(r.video.poster, undefined);
});

test('Focus preserves the player, source, position and Fill; pause does not close Focus', async () => {
  const r = setup(); await r.importFiles(); r.video.currentTime = 28; r.video.emit('canplay');
  r.player.fill(true); const src = r.video.src, parent = r.video.parentNode;
  assert.equal(r.player.setFocus(true), true); assert.equal(r.stage.open, true);
  assert.equal(r.video.src, src); assert.equal(r.video.parentNode, parent); assert.equal(r.video.currentTime, 28);
  r.player.pause(); assert.equal(r.stage.open, true);
  r.stage.emit('cancel'); assert.equal(r.stage.open, false); assert.equal(r.player.isFilled(), true);
  assert.equal(r.document.body.classList.contains('lv-focused'), false);
});

test('caption cues render safe text and supported markup without fetching or restarting video', async () => {
  const r = setup(); await r.importFiles(); r.video.emit('canplay');
  r.find('lv-subtitles').value = '3'; r.find('lv-subtitles').emit('change');
  const track = r.video.querySelector('track').track, src = r.video.src, calls = r.calls.length;
  const text = value => ({ nodeType: 3, textContent: value });
  const tag = (name, ...childNodes) => ({ nodeType: 1, nodeName: name.toUpperCase(), childNodes, attributes: { onclick: 'bad()', src: 'bad' } });
  track.activeCues = [{ getCueAsHTML: () => ({ childNodes: [tag('b', text('ภาษาไทย\nEnglish')), tag('i', text('italic')), tag('ruby', text('字'), tag('rt', text('reading'))), tag('script', text('safe text'))] }) }];
  track.emit('cuechange');
  const caption = r.find('lv-caption');
  assert.equal(track.mode, 'hidden'); assert.equal(caption.hidden, false);
  assert.equal(caption.querySelector('b').children[0].textContent, 'ภาษาไทย\nEnglish');
  assert.equal(caption.querySelector('rt').children[0].textContent, 'reading');
  assert.equal(caption.querySelector('script'), null); assert.deepEqual(caption.querySelector('b').attributes, {});
  assert.equal(r.video.src, src); assert.equal(r.calls.length, calls);
  track.activeCues = [{ text: 'Next cue' }]; track.emit('cuechange');
  assert.equal(caption.children.length, 1); assert.equal(caption.children[0].textContent, 'Next cue');
  r.find('lv-subtitles').value = 'off'; r.find('lv-subtitles').emit('change');
  assert.equal(caption.hidden, true); assert.equal(track.events.cuechange, undefined);
  track.emit('cuechange'); assert.equal(caption.children.length, 0);
});

test('subtitle editing bounds mouse and touch drag to the picture and preserves playback', async () => {
  const r = setup(); await r.importFiles(); r.video.emit('canplay');
  const screen = r.find('lv-screen'), caption = r.find('lv-caption');
  screen.rect = { left: 10, top: 10, width: 800, height: 600 };
  caption.getBoundingClientRect = () => ({ left: 10 + parseFloat(caption.style.left || '50') * 8 - 100, top: 85 + parseFloat(caption.style.top || '92') * 4.5 - 40, width: 200, height: 40 });
  const src = r.video.src, calls = r.calls.length;
  r.find('lv-sub-adjust').click();
  assert.equal(r.stage.classList.contains('is-caption-editing'), true);
  assert.equal(caption.children[0].textContent, 'Subtitle preview');
  assert.equal(r.find('lv-caption-area').style.top, '75px'); assert.equal(r.find('lv-caption-area').style.height, '450px');
  for (const pointerType of ['mouse', 'touch']) {
    caption.emit('pointerdown', { pointerId: 1, pointerType, clientX: 410, clientY: 499, button: 0 });
    caption.emit('pointermove', { pointerId: 1, clientX: -1000, clientY: -1000 });
    assert.equal(Number(caption.dataset.x), .125); assert.ok(Math.abs(Number(caption.dataset.y) - 40 / 450) < .00001);
    caption.emit('pointermove', { pointerId: 1, clientX: 3000, clientY: 3000 });
    assert.equal(Number(caption.dataset.x), .875); assert.equal(Number(caption.dataset.y), 1);
    caption.emit('pointerup', { pointerId: 1 }); r.find('lv-caption-reset').click();
  }
  caption.emit('keydown', { key: 'ArrowUp' }); caption.emit('keydown', { key: 'ArrowLeft', shiftKey: true });
  assert.equal(caption.dataset.x, '0.45'); assert.ok(Math.abs(Number(caption.dataset.y) - .91) < .00001);
  for (let i = 0; i < 60; i += 1) caption.emit('keydown', { key: 'ArrowLeft' });
  assert.equal(Number(caption.dataset.x), .125);
  caption.emit('keydown', { key: 'ArrowRight' }); assert.ok(Math.abs(Number(caption.dataset.x) - .135) < .00001, 'one reversed key moves immediately at the left edge');
  for (let i = 0; i < 100; i += 1) caption.emit('keydown', { key: 'ArrowUp' });
  assert.ok(Math.abs(Number(caption.dataset.y) - 40 / 450) < .00001);
  caption.emit('keydown', { key: 'ArrowDown' }); assert.ok(Math.abs(Number(caption.dataset.y) - (40 / 450 + .01)) < .00001, 'one reversed key moves immediately at the top edge');
  const size = r.find('lv-caption-size'); size.value = '80'; size.emit('input'); const small = parseFloat(caption.style.fontSize);
  size.value = '200'; size.emit('input'); assert.equal(parseFloat(caption.style.fontSize) / small, 2.5);
  assert.equal(r.video.src, src); assert.equal(r.calls.length, calls); assert.equal(r.video.paused, false);
  const settings = { ...caption.dataset }; r.player.setFocus(true); r.player.setFocus(false); r.player.fill(true);
  assert.deepEqual(caption.dataset, settings);
  r.find('lv-caption-reset').click(); assert.deepEqual(caption.dataset, { x: '0.5', y: '0.92', size: '100' });
  r.find('lv-caption-done').click(); assert.equal(r.stage.classList.contains('is-caption-editing'), false); assert.equal(caption.hidden, true);
});

test('pointer Done restores Focus idle hiding while keyboard Done preserves control focus', async () => {
  const r = setup(); await r.importFiles(); r.video.emit('canplay'); r.player.setFocus(true);
  r.find('lv-sub-adjust').click(); r.find('lv-caption-done').emit('click', { detail: 1 });
  assert.equal(r.document.activeElement, r.stage); assert.equal(r.stage.classList.contains('has-hidden-controls'), false);
  r.expireIdle(); assert.equal(r.stage.classList.contains('has-hidden-controls'), true);
  r.find('lv-sub-adjust').click(); r.find('lv-caption-done').emit('click', { detail: 0 });
  assert.equal(r.document.activeElement, r.find('lv-tracks-toggle'));
  r.expireIdle(); assert.equal(r.stage.classList.contains('has-hidden-controls'), false);
});

test('paused subtitle preview remains editable and Escape finishes editing before leaving Focus', async () => {
  const r = setup(); await r.importFiles(); r.video.emit('canplay'); r.player.pause(); r.player.setFocus(true);
  r.find('lv-sub-adjust').click(); const calls = r.calls.length;
  assert.equal(r.find('lv-caption').hidden, false); assert.equal(r.find('lv-caption-editor').hidden, false);
  r.find('lv-caption-size').value = '150'; r.find('lv-caption-size').emit('input');
  assert.equal(r.video.src, ''); assert.equal(r.calls.length, calls);
  r.stage.emit('keydown', { key: 'Escape' });
  assert.equal(r.stage.open, true); assert.equal(r.find('lv-caption-editor').hidden, true);
  r.stage.emit('cancel'); assert.equal(r.stage.open, false);
  r.find('lv-sub-adjust').click(); r.player.setActive(false);
  assert.equal(r.stage.classList.contains('is-caption-editing'), false); assert.equal(r.find('lv-caption').hidden, true);
});

test('synthetic child clicks do not dismiss Focus or cancel its file input activation', async () => {
  const r = setup(); await r.importFiles(); r.player.setFocus(true);
  r.stage.emit('click', { target: r.find('lv-subtitle-input'), clientX: 0, clientY: 0 });
  assert.equal(r.stage.open, true); assert.equal(r.player.isFocused(), true);
  r.stage.emit('click', { target: r.stage, clientX: 0, clientY: 0 });
  assert.equal(r.stage.open, false, 'an actual backdrop click still closes Focus');
});

test('Focus starts with a full video and hidden controls; clicking reveals without toggling playback', async () => {
  const r = setup(); await r.importFiles(); r.video.emit('canplay');
  assert.equal(r.stage.style['--lv-aspect'], String(1920 / 1080));
  r.video.videoWidth = 960; r.video.videoHeight = 400; r.video.emit('loadedmetadata');
  assert.equal(r.stage.style['--lv-aspect'], '2.4', 'use the decoded dimensions when available');
  r.player.setFocus(true); const src = r.video.src;
  assert.equal(r.stage.classList.contains('has-hidden-controls'), true); assert.equal(r.timers.size, 0);
  r.stage.emit('pointermove', { target: r.video });
  assert.equal(r.stage.classList.contains('has-hidden-controls'), true, 'hover does not reveal hidden controls');
  r.stage.emit('click', { target: r.video, detail: 1 });
  assert.equal(r.stage.classList.contains('has-hidden-controls'), false); assert.equal(r.video.paused, false);
  assert.equal(r.video.src, src); assert.equal(r.timers.size, 1);
  const timer = [...r.timers.keys()][0]; r.video.emit('timeupdate'); r.video.emit('timeupdate');
  assert.equal([...r.timers.keys()][0], timer, 'playback events do not postpone hiding');
  r.expireIdle(); assert.equal(r.stage.classList.contains('has-hidden-controls'), true);
  r.stage.emit('keydown', { key: 'Tab' }); assert.equal(r.stage.classList.contains('has-hidden-controls'), false);
  r.player.setFocus(false); assert.equal(r.timers.size, 0); assert.equal(r.stage.classList.contains('has-hidden-controls'), false);
});

test('Focus controls stay usable for menus, keyboard focus and imports; paused Focus also starts clean', async () => {
  const r = setup(); await r.importFiles(); r.video.emit('canplay'); r.player.pause();
  r.player.setFocus(true); assert.equal(r.stage.classList.contains('has-hidden-controls'), true);
  r.stage.emit('click', { target: r.video, detail: 1 });
  assert.equal(r.video.paused, true); assert.equal(r.stage.classList.contains('has-hidden-controls'), false);
  r.find('lv-tracks-toggle').click(); r.expireIdle();
  assert.equal(r.find('lv-track-panel').hidden, false); assert.equal(r.stage.classList.contains('has-hidden-controls'), false);
  assert.equal(r.timers.size, 0);
  r.find('lv-track-close').click(); r.expireIdle();
  assert.equal(r.stage.classList.contains('has-hidden-controls'), false, 'keyboard focus on a control keeps it visible');
  r.stage.focus(); r.stage.emit('focusout'); await tick(); r.expireIdle();
  assert.equal(r.stage.classList.contains('has-hidden-controls'), true);
  r.stage.emit('pointerdown', { pointerType: 'touch', target: r.video });
  assert.equal(r.stage.classList.contains('has-hidden-controls'), false);
  r.stage.emit('click', { target: r.video, detail: 1 }); assert.equal(r.video.paused, true);
  r.player.destroy(); assert.equal(r.timers.size, 0);

  let finish;
  const pending = setup({ pendingPick: () => new Promise(resolve => { finish = resolve; }) });
  const initial = pending.importFiles(); await tick(); finish({ ok: true, files: [file] }); await initial;
  pending.video.emit('canplay'); pending.player.setFocus(true);
  const adding = pending.player.addFiles([{ name: 'Second.mkv', size: 1024 }]); await tick();
  assert.equal(pending.find('lv-import').hidden, false); assert.equal(pending.stage.classList.contains('has-hidden-controls'), false);
  pending.expireIdle(); assert.equal(pending.stage.classList.contains('has-hidden-controls'), false);
  pending.player.cancelImports(); await adding; pending.player.destroy();
});

test('switching away and destroying stop playback and abort pending imports', async () => {
  const r = setup(); await r.importFiles(); r.player.setFocus(true);
  r.player.setActive(false); assert.equal(r.video.src, ''); assert.equal(r.stage.open, false);
  const count = r.calls.filter(call => call.path.endsWith('/stop')).length;
  r.player.destroy(); assert.equal(r.calls.filter(call => call.path.endsWith('/stop')).length, count);
  let resolve;
  const pending = setup({ pendingPick: () => new Promise(done => { resolve = done; }) });
  const request = pending.importFiles(); await new Promise(done => setImmediate(done));
  pending.player.destroy(); resolve({ ok: true, files: [file] }); await request;
  assert.equal(pending.video.src, undefined); assert.equal(pending.starts, 0);
});

test('switching to YouTube while an import is pending never starts hidden playback', async () => {
  let resolve;
  const r = setup({ pendingPick: () => new Promise(done => { resolve = done; }) });
  const request = r.importFiles(); await new Promise(done => setImmediate(done));
  r.player.setActive(false); resolve({ ok: true, files: [file] }); await request;
  assert.equal(r.video.src, undefined); assert.equal(r.starts, 0);
  assert.equal(r.uploads[0].aborted, true);
});

test('clearing the queue releases file grants and resets playback for the next file selection', async () => {
  const r = setup(); await r.importFiles();
  r.find('lv-clear-queue').click();
  assert.equal(r.video.src, ''); assert.equal(r.find('lv-empty').hidden, false);
  assert.deepEqual(r.calls.find(call => call.path.endsWith('/release')).body, { ids: [file.id] });
  await r.importFiles(); assert.ok(r.video.src.includes(file.id));
});

test('missing engine and an empty import result explain or preserve state without a stream', async () => {
  const unavailable = setup({ available: false }); await unavailable.importFiles();
  assert.match(unavailable.find('lv-notice').textContent, /FFmpeg/);
  assert.equal(unavailable.uploads.length, 0);
  const cancelled = setup({ picked: [] }); await cancelled.importFiles();
  assert.equal(cancelled.video.src, undefined); assert.equal(cancelled.find('lv-empty').hidden, false);
});
