import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';

const source = readFileSync(new URL('../js/media-spotify.js', import.meta.url), 'utf8');

async function setup(options = {}) {
  const { document, mkEl } = makeDom(), requests = [], intervals = new Map(), timers = new Map();
  let now = 100000, timerId = 0;
  const makeEl = (tag, cls, text) => {
    const node = mkEl(tag); node.className = cls || ''; if (text != null) node.textContent = text;
    node.offsetParent = {}; return node;
  };
  document.createElement = tag => makeEl(tag);
  const pane = makeEl('div'); pane.id = 'media-pane-play';
  pane.append(makeEl('div', 'media-content')); document.body.append(pane);
  const player = { ok: true, playing: true, track: { uri: 'spotify:track:ONE', name: 'Song' }, progressMs: 10000, durationMs: 180000 };
  const mediaData = { active: true, app: 'Spotify', title: 'Song', artist: 'Artist', position: 10, duration: 180, playbackStatus: 'Playing' };
  const window = {};
  vm.runInNewContext(source, { document, window, mediaData, hasActiveMedia: () => true, onVisiblePage: () => true,
    makeEl, Date: { now: () => now },
    setInterval(fn, ms) { intervals.set(ms, fn); return ms; }, clearInterval(ms) { intervals.delete(ms); },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    apiJson: async (url, init) => {
      requests.push({ url, action: init?.body ? JSON.parse(init.body) : null });
      const custom = options.api?.(url, init); if (custom !== undefined) return custom;
      if (url.endsWith('/status')) return { connected: true };
      if (url.includes('/player')) return structuredClone(player);
      if (url.endsWith('/devices')) return { ok: true, devices: [{ name: 'Phone', type: 'smartphone' }] };
      if (url.endsWith('/playlists')) return { ok: true, playlists: [{ name: 'My mix', uri: 'spotify:playlist:MIX' }] };
      if (url === '/actions/run') return { ok: true };
    },
  });
  window.MediaSpotify.sync(); await settle(30);
  return { document, pane, requests, mediaData, timers, media: window.MediaSpotify,
    query: selector => pane.querySelector(selector),
    async poll(ms = 15000) { now += ms; intervals.get(15000)(); await settle(30); },
    async tick(ms = 1000) { now += ms; intervals.get(1000)(); await settle(30); },
  };
}

test('media strip polls player every fifteen seconds and devices every thirty seconds', async () => {
  const h = await setup();
  h.query('.msp-pill-dv').click(); await settle(30);
  for (let i = 0; i < 4; i++) await h.poll();
  assert.equal(h.requests.filter(r => r.url.includes('/player')).length, 5);
  assert.equal(h.requests.filter(r => r.url.endsWith('/devices')).length, 3);
});

test('media cooldown from status blocks seed, tabs, manual controls, transport pokes and song-change refreshes', async () => {
  let waiting = true;
  const h = await setup({ api: url => waiting && url.endsWith('/status')
    ? { connected: true, error: 'rate_limited', retryAt: 3700000 } : undefined });
  assert.equal(h.requests.length, 1);
  assert.equal(h.query('.msp').hidden, false);
  assert.equal(h.query('.msp-cooldown').hidden, false);
  assert.match(h.query('.msp-cooldown').textContent, /1:00:00/);
  assert.equal(h.query('.msp-shuffle').disabled, true);
  h.query('.msp-pill-dv').click(); h.query('.msp-shuffle').click();
  h.media.poke(); h.mediaData.title = 'New song'; h.media.sync();
  await h.poll(60000); await h.tick();
  assert.equal(h.requests.length, 1);
  assert.equal([...h.timers.values()].filter(t => t.ms === 600).length, 0);
  assert.doesNotMatch(h.query('.msp-sheet-list').textContent, /No devices found/);
  assert.match(h.query('.msp-sheet-list').textContent, /Waiting for Spotify/);
  waiting = false; await h.poll(3600000); await h.tick();
  assert.equal(h.query('.msp-cooldown').hidden, true);
  assert.equal(h.query('.msp-shuffle').disabled, false);
  assert.ok(h.requests.some(r => r.url.includes('/player')));
});

test('media cached devices survive a refusal and stay visible but disabled', async () => {
  let refuse = false;
  const h = await setup({ api: url => refuse && url.endsWith('/devices')
    ? { ok: false, error: 'rate_limited', retryAt: 3730000 } : undefined });
  h.query('.msp-pill-dv').click(); await settle(30);
  refuse = true; await h.poll(30000);
  assert.match(h.query('.msp-sheet-list').textContent, /Phone/);
  assert.equal(h.query('.msp-item').disabled, true);
  assert.equal(h.query('.msp-sheet .msp-cooldown').hidden, false);
  const count = h.requests.length;
  await h.poll(30000); h.query('.msp-item').click(); await settle(30);
  assert.equal(h.requests.length, count);
});

test('media transient list failure preserves data instead of claiming it is empty', async () => {
  let fail = false;
  const h = await setup({ api: url => fail && url.endsWith('/devices') ? { ok: false, error: 'network' } : undefined });
  h.query('.msp-pill-dv').click(); await settle(30);
  fail = true; await h.poll(30000);
  assert.match(h.query('.msp-sheet-list').textContent, /Phone/);
});

test('rapid media transport pokes coalesce to one fresh resync timer', async () => {
  const h = await setup();
  h.media.poke(); h.media.poke(); h.media.poke();
  assert.equal([...h.timers.values()].filter(t => t.ms === 600).length, 1);
  assert.equal([...h.timers.values()].filter(t => t.ms === 1800).length, 0);
});
