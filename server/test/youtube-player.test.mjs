import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/youtube-widget.js', import.meta.url), 'utf8');
const A = 'M7lc1UVf-VE', B = 'aqz-KE-bpKQ', C = 'jNQXAC9IVRw';

function setup({ stored = '{}', denied = false, native = false } = {}) {
  const messages = [], events = {}, documentEvents = {}, writes = [];
  let now = 10000;
  const classList = () => {
    const names = new Set();
    return {
      add(...values) { values.forEach(value => names.add(value)); },
      remove(...values) { values.forEach(value => names.delete(value)); },
      contains(value) { return names.has(value); },
      toggle(value, on = !names.has(value)) { if (on) names.add(value); else names.delete(value); return on; },
    };
  };
  const attributes = new Map();
  const stage = {
    firstChild: null, isConnected: true, open: false, classList: classList(), insertions: 0, removals: 0,
    showModal() { this.open = true; },
    close() { this.open = false; },
    focus() { document.activeElement = this; },
    closest: () => null,
    getBoundingClientRect: () => ({ left: 300, right: 1300, top: 0, bottom: 563, width: 1000, height: 563 }),
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute: name => attributes.get(name) ?? null,
    removeAttribute(name) { attributes.delete(name); },
    insertBefore(frame) { this.insertions += 1; this.firstChild = frame; frame.parentNode = this; },
    removeChild(frame) { this.removals += 1; assert.equal(this.firstChild, frame); this.firstChild = null; frame.parentNode = null; },
  };
  const document = {
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener(type, fn) { documentEvents[type] = fn; }, body: { classList: classList() },
    createElement: () => ({ style: {}, addEventListener() {}, contentWindow: { postMessage(message, origin) { messages.push({ ...JSON.parse(message), origin }); } } }),
  };
  const window = { __XENON_NATIVE__: native, addEventListener(type, fn) { events[type] = fn; } };
  const context = vm.createContext({
    window, document, makeEl() { throw new Error('Unexpected DOM render'); },
    apiJson: async () => ({ connected: false }), location: { origin: 'http://127.0.0.1:3030' },
    URL, URLSearchParams, console, Date: { now: () => now },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    localStorage: { getItem() { if (denied) throw new Error('denied'); return stored; }, setItem(key, value) { if (denied) throw new Error('denied'); writes.push({ key, value }); } },
  });
  const instrumented = source.replace('window.YouTubeWidget = { renderWidgets, playFromSdk };',
    'window.YouTubeWidget = { parseVideoLink, normalizeVideo, player, saved, playList, playAt, playNext, applyState, toggleFavorite, stopPlayer, loadTab, setFocus, focusBackdropClick };');
  vm.runInContext(instrumented, context);
  return { ...window.YouTubeWidget, stage, messages, events, documentEvents, document, writes, advanceClock() { now += 2000; } };
}

test('YouTube links accept supported forms and preserve timestamp while rejecting other hosts', () => {
  const { parseVideoLink: parse } = setup();
  for (const link of [A, `https://www.youtube.com/watch?v=${A}&list=ignored`, `youtu.be/${A}`, `https://m.youtube.com/shorts/${A}`, `https://youtube.com/live/${A}`, `https://youtube.com/embed/${A}`]) assert.equal(parse(link)?.id, A, link);
  assert.equal(parse(`https://youtu.be/${A}?t=1h2m3s`).start, 3723);
  assert.equal(parse(`https://youtube.com/watch?v=${A}#t=90`).start, 90);
  assert.equal(parse(`https://youtu.be/${A}?start=55`).start, 55);
  for (const link of [`https://youtube.com.evil.test/watch?v=${A}`, `https://evil.test/?v=${A}`, `https://user@youtube.com/watch?v=${A}`, `https://youtu.be:8443/${A}`, `https://youtu.be/${A}/extra`, 'javascript:alert(1)', 'https://youtube.com/playlist?list=test', 'file:///video', `https://youtu.be/${A.slice(1)}`, 'x'.repeat(2049), null, {}]) assert.equal(parse(link), null, String(link));
});

test('saved lists are validated, deduplicated and bounded without trusting saved images', () => {
  const r = setup({ stored: JSON.stringify({ favorites: [{ id: A, image: 'javascript:alert(1)', title: 'x'.repeat(1000), seconds: -1 }, { id: A }, { id: 'bad' }], recent: Array.from({ length: 80 }, (_, i) => ({ id: String(i).padStart(11, '0') })), autoplay: false, loop: 'yes' }) });
  assert.equal(r.saved.favorites.length, 1);
  assert.equal(r.saved.favorites[0].title.length, 300);
  assert.equal(r.saved.favorites[0].seconds, 0);
  assert.equal(r.saved.favorites[0].image, `https://i.ytimg.com/vi/${A}/hqdefault.jpg`);
  assert.equal(r.saved.recent.length, 30);
  assert.equal(r.saved.autoplay, false);
  assert.equal(r.saved.loop, false);
  for (const stored of ['broken JSON', 'null', '[]']) assert.equal(setup({ stored }).saved.favorites.length, 0);
});

test('direct playback needs no account and retains the iframe while advancing the queue', () => {
  const r = setup();
  r.playList([{ id: A, start: 15 }, { id: B }], 0, r.stage);
  const frame = r.player.frame;
  const url = new URL(frame.src);
  assert.equal(url.origin, 'https://www.youtube-nocookie.com');
  assert.equal(url.searchParams.get('controls'), '1');
  assert.equal(url.searchParams.get('fs'), '1');
  assert.equal(url.searchParams.get('start'), '15');
  assert.equal(url.searchParams.get('origin'), 'http://127.0.0.1:3030');
  assert.equal(frame.allowFullscreen, true);
  r.applyState(1); r.applyState(0);
  assert.equal(r.player.qi, 1);
  assert.equal(r.player.frame, frame);
  assert.equal(r.messages.filter(m => m.func === 'loadVideoById').at(-1).args[0], B);
  r.applyState(0);
  assert.equal(r.player.qi, 1, 'duplicate ended reports must not skip another video');
  assert.equal(r.saved.recent.length, 2);
});

test('autoplay off stops at the current video, repeat restarts it, manual Next still advances', () => {
  const r = setup({ stored: '{"autoplay":false}' });
  r.playList([{ id: A }, { id: B }], 0, r.stage);
  r.applyState(1); r.applyState(0);
  assert.equal(r.player.qi, 0);
  r.saved.loop = true; r.advanceClock(); r.applyState(1); r.applyState(0);
  assert.equal(r.player.qi, 0);
  assert.deepEqual(r.messages.filter(m => m.event === 'command').slice(-2).map(m => m.func), ['seekTo', 'playVideo']);
  r.playNext();
  assert.equal(r.player.qi, 1);
});

test('message handling rejects foreign frames and wrong origins, then updates matching video metadata', () => {
  const r = setup();
  r.playList([{ id: A }], 0, r.stage);
  const frame = r.player.frame;
  const data = JSON.stringify({ event: 'infoDelivery', info: { videoData: { video_id: A, title: 'Actual title', author: 'Channel' }, duration: 123, playerState: 1 } });
  r.events.message({ origin: 'https://evil.test', source: frame.contentWindow, data });
  r.events.message({ origin: 'https://www.youtube-nocookie.com', source: {}, data });
  assert.equal(r.player.queue[0].title, '');
  r.events.message({ origin: 'https://www.youtube-nocookie.com', source: frame.contentWindow, data });
  assert.equal(r.player.queue[0].title, 'Actual title');
  assert.equal(r.saved.recent[0].channel, 'Channel');
  r.toggleFavorite();
  assert.equal(r.saved.favorites[0].id, A);
  r.toggleFavorite();
  assert.equal(r.saved.favorites.length, 0);
});

test('unavailable storage does not stop playback; stopping destroys the frame', () => {
  const r = setup({ denied: true });
  r.playList([{ id: A }, { id: C }], 0, r.stage);
  r.toggleFavorite();
  assert.equal(r.saved.favorites.length, 1);
  r.stopPlayer();
  assert.equal(r.player.frame, null);
  assert.equal(r.stage.firstChild, null);
  assert.equal(r.player.queue.length, 0);
});

test('native kiosk retains its fullscreen guard and large queues are bounded', () => {
  const r = setup({ native: true });
  r.playList(Array.from({ length: 150 }, () => ({ id: A })), 0, r.stage);
  assert.equal(r.player.queue.length, 100);
  assert.equal(new URL(r.player.frame.src).searchParams.get('fs'), '0');
  assert.equal(r.player.frame.allowFullscreen, undefined);
  assert.ok(!r.player.frame.allow.includes('fullscreen'));
});


test('Focus preserves the playing iframe and prior Fill layout in browsers and native kiosks', () => {
  for (const native of [false, true]) for (const expanded of [false, true]) {
    const r = setup({ native });
    assert.equal(r.setFocus(true), false, 'there is nothing to focus before playback');
    r.playList([{ id: A }], 0, r.stage);
    r.applyState(1);
    r.player.time = 42;
    r.player.expanded = expanded;
    const frame = r.player.frame, src = frame.src, sent = r.messages.length;
    let restored = 0;
    const trigger = { isConnected: true, focus() { restored += 1; } };

    assert.equal(r.setFocus(true, trigger), true);
    assert.equal(r.stage.open, true);
    assert.equal(r.stage.classList.contains('is-focused'), true);
    assert.equal(r.document.body.classList.contains('yt-focused'), true);
    assert.equal(r.document.activeElement, r.stage, 'the stage receives keyboard focus without an exit overlay');
    assert.equal(r.player.expanded, expanded, 'Focus must not overwrite the Fill setting');

    r.setFocus(false);
    assert.equal(r.stage.open, false);
    assert.equal(r.stage.classList.contains('is-focused'), false);
    assert.equal(r.document.body.classList.contains('yt-focused'), false);
    assert.equal(r.player.expanded, expanded);
    assert.equal(restored, 1, 'keyboard focus returns to the invoking control');
    assert.equal(r.player.frame, frame);
    assert.equal(frame.src, src);
    assert.equal(frame.parentNode, r.stage);
    assert.equal(r.stage.insertions, 1, 'the iframe is inserted only when playback starts');
    assert.equal(r.stage.removals, 0, 'Focus must never detach the live iframe');
    assert.equal(r.player.time, 42);
    assert.equal(r.player.state, 1);
    assert.equal(r.messages.length, sent, 'resizing sends no playback commands');
  }
});

test('Focus backdrop exits on either side and consumes the click while player clicks stay focused', () => {
  const r = setup();
  r.playList([{ id: A }], 0, r.stage);
  const click = (clientX, clientY = 100, currentTarget = r.stage) => ({
    clientX, clientY, currentTarget, target: currentTarget,
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  });
  r.setFocus(true);
  for (const x of [300, 800, 1300]) {
    const event = click(x);
    r.focusBackdropClick(event);
    assert.equal(r.stage.open, true, 'clicks within the player must not exit Focus');
    assert.equal(event.prevented, false);
  }
  for (const x of [299, 1301]) {
    r.setFocus(true);
    const event = click(x);
    r.focusBackdropClick(event);
    assert.equal(r.stage.open, false, 'clicking either blurred side exits Focus');
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true, 'the dismissal click must not reach dashboard handlers');
  }
  r.setFocus(true);
  r.focusBackdropClick(click(0, 100, {}));
  assert.equal(r.stage.open, true, 'unrelated event targets cannot dismiss the player');
});

test('Escape restores Focus without clearing Fill, and stopping playback cleans up the modal', () => {
  const r = setup();
  r.playList([{ id: A }], 0, r.stage);
  r.player.expanded = true;
  r.setFocus(true);
  const escape = { key: 'Escape', preventDefault() {}, stopPropagation() {} };
  r.documentEvents.keydown({ ...escape, key: 'Enter' });
  assert.equal(r.stage.open, true);
  r.document.fullscreenElement = {};
  r.documentEvents.keydown(escape);
  assert.equal(r.stage.open, true, 'the embed gets the first Escape while it owns browser fullscreen');
  r.document.fullscreenElement = null;
  r.documentEvents.keydown(escape);
  assert.equal(r.stage.open, false);
  assert.equal(r.player.expanded, true, 'one Escape exits Focus and preserves the original Fill view');
  r.setFocus(true);
  r.stopPlayer();
  assert.equal(r.stage.open, false);
  assert.equal(r.document.body.classList.contains('yt-focused'), false);
  assert.equal(r.player.frame, null);
  assert.equal(r.player.expanded, false);
});

test('unsupported or failed modal entry leaves playback and its prior layout intact', () => {
  const r = setup();
  r.playList([{ id: A }], 0, r.stage);
  r.player.expanded = true;
  const frame = r.player.frame;
  for (const showModal of [undefined, () => { throw new Error('dialog unavailable'); }]) {
    r.stage.showModal = showModal;
    assert.equal(r.setFocus(true), false);
    assert.equal(r.stage.open, false);
    assert.equal(r.stage.classList.contains('is-focused'), false);
    assert.equal(r.document.body.classList.contains('yt-focused'), false);
    assert.equal(r.player.expanded, true);
    assert.equal(r.player.frame, frame);
    assert.equal(r.stage.removals, 0);
  }
});
