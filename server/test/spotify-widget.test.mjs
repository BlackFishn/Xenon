import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';

const source = readFileSync(new URL('../js/spotify-widget.js', import.meta.url), 'utf8');

async function setup(options = {}) {
  const { document, mkEl } = makeDom();
  const intervals = new Map(), requests = [];
  let now = 100000;
  function makeEl(tag, cls = '', text) {
    const node = mkEl(tag);
    node.className = cls;
    if (text !== undefined) node.textContent = text;
    Object.defineProperty(node, 'firstChild', { get: () => node.children[0] || null });
    node.getClientRects = () => node.hidden ? [] : [{}];
    node.focus = () => { document.activeElement = node; };
    node.dataset = new Proxy(node.dataset, { set(target, key, value) {
      target[key] = value;
      node.setAttribute('data-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), value);
      return true;
    } });
    return node;
  }
  document.createElement = tag => makeEl(tag);
  const page = makeEl('div', 'pager-page');
  document.body.append(page);
  const mounts = Array.from({ length: 2 }, () => {
    const tile = makeEl('section', 'spotify-panel');
    tile.dataset.dashboardWidget = 'spotify';
    const mount = makeEl('div', 'spotify-widget-mount');
    tile.append(mount); page.append(tile);
    return mount;
  });
  const player = { ok: true, playing: true, track: { uri: 'spotify:track:1', name: 'Song', artist: 'Artist' },
    progressMs: 10000, durationMs: 200000, shuffle: false, repeat: 'off', liked: true,
    device: 'Desktop', supportsVolume: true, volume: 64 };
  const window = {};
  vm.runInNewContext(source, {
    window, document, makeEl, onVisiblePage: () => true, Date: { now: () => now },
    setInterval(fn, ms) { intervals.set(ms, fn); return ms; },
    clearInterval(ms) { intervals.delete(ms); }, setTimeout() {}, clearTimeout() {},
    apiJson: async (url, init) => {
      requests.push({ url, action: init?.body ? JSON.parse(init.body) : null });
      if (options.api) { const reply = options.api(url, init); if (reply !== undefined) return reply; }
      if (url.endsWith('/status')) return { connected: true, login: 'Listener' };
      if (url.includes('/player')) return structuredClone(player);
      if (url.endsWith('/queue')) return { ok: true, queue: [{ uri: 'spotify:track:2', name: 'Next song', artist: 'Artist' }] };
      if (url.endsWith('/playlists')) return { ok: true, playlists: [{ uri: 'spotify:playlist:1', name: 'Mix', tracks: 12 }] };
      if (url.endsWith('/devices')) return { ok: true, devices: [{ name: 'Phone', type: 'smartphone', active: false }] };
      if (url === '/actions/run') {
        const action = JSON.parse(init.body);
        if (action.type === 'spotifyPlay') player.playing = action.mode === 'play';
        return { ok: true };
      }
      return null;
    },
  });
  window.SpotifyWidget.renderWidgets();
  await settle(30);
  return { mounts, requests, document, player, widget: window.SpotifyWidget,
    tick(ms = 250) { now += ms; intervals.get(250)(); },
    poll(ms = 6000) { now += ms; intervals.get(6000)(); },
    query: (selector, index = 0) => mounts[index].querySelector(selector),
    fire(node, type, event = {}) { (node._handlers[type] || []).forEach(fn => fn({ preventDefault() {}, ...event })); },
  };
}

test('tabs switch before a slow response, coalesce repeated clicks, and retain unchanged rows', async () => {
  let resolve;
  const h = await setup({ api: url => url.endsWith('/playlists') ? new Promise(r => { resolve = r; }) : undefined });
  const tab = h.query('.sp-tab[data-stab="playlists"]');
  const queueRow = h.query('.sp-track');
  tab.click();
  assert.equal(tab.getAttribute('aria-selected'), 'true');
  assert.equal(h.query('.sp-panel--playlists').hidden, false);
  assert.match(h.query('.sp-panel--playlists').textContent, /Loading/);
  tab.click();
  assert.equal(h.requests.filter(r => r.url.endsWith('/playlists')).length, 1);
  assert.equal(h.query('.sp-track'), queueRow);
  resolve({ ok: true, playlists: [{ name: 'Focus', uri: 'spotify:playlist:1' }] });
  await settle();
  assert.match(h.query('.sp-panel--playlists').textContent, /Focus/);
});

test('duplicate widgets have unique accessible tabs and keyboard navigation stays on the chosen copy', async () => {
  const h = await setup();
  const first = h.query('.sp-tab'), second = h.query('.sp-tab', 1);
  assert.notEqual(first.id, second.id);
  h.fire(second, 'keydown', { key: 'End' });
  const devices = h.query('.sp-tab[data-stab="devices"]', 1);
  assert.equal(h.document.activeElement, devices);
  assert.equal(devices.tabIndex, 0);
  assert.equal(second.tabIndex, -1);
  assert.equal(h.query('.sp-panel--devices', 1).id, devices.getAttribute('aria-controls'));
  h.query('.sp-dev-chip').click();
  assert.equal(h.document.activeElement, h.query('.sp-tab[data-stab="devices"]'));
});

test('playback responds across copies, sends an explicit intent and restores state after failure', async () => {
  let resolve;
  const h = await setup({ api: url => url === '/actions/run' ? new Promise(r => { resolve = r; }) : undefined });
  h.query('.sp-play').click();
  assert.equal(h.query('.sp-play', 1).getAttribute('aria-label'), 'Play');
  assert.equal(h.query('.sp-now', 1).classList.contains('is-playing'), false);
  assert.deepEqual(h.requests.find(r => r.action).action, { type: 'spotifyPlay', mode: 'pause' });
  assert.equal(h.query('.sp-play', 1).disabled, true);
  h.query('.sp-play', 1).click();
  assert.equal(h.requests.filter(r => r.action?.type === 'spotifyPlay').length, 1);
  resolve(null);
  await settle(30);
  assert.equal(h.query('.sp-play').getAttribute('aria-label'), 'Pause');
  assert.equal(h.query('.sp-play', 1).disabled, false);
  assert.equal(h.query('.sp-play', 1).getAttribute('aria-label'), 'Pause');
});

test('progress follows elapsed time without extra API reads and recovers from cancelled drags', async () => {
  const h = await setup();
  const seek = h.query('.sp-seek-range');
  const reads = h.requests.length;
  h.tick(500);
  assert.equal(seek.value, '53'); // 10.5 / 200 seconds, rounded to the native range step.
  h.tick(750);
  assert.equal(seek.value, '56');
  assert.equal(h.requests.length, reads);
  seek.value = '500'; h.fire(seek, 'input');
  assert.match(seek.getAttribute('aria-valuetext'), /1:40/);
  h.tick(250);
  assert.equal(seek.value, '500');
  h.fire(seek, 'pointercancel');
  assert.equal(seek.value, '56');
  h.document.hidden = true;
  h.tick(1000);
  assert.equal(seek.value, '56');
  h.document.hidden = false;
  h.tick(250);
  assert.equal(seek.value, '58');
});

test('volume preview and playlist/device controls use the existing allowlisted actions', async () => {
  const h = await setup();
  const vol = h.query('.sp-vol-range');
  vol.value = '37'; h.fire(vol, 'input');
  assert.equal(h.query('.sp-vol-value').textContent, '37%');
  h.fire(vol, 'change');
  await settle(30);
  h.query('.sp-tab[data-stab="playlists"]').click();
  await settle();
  h.query('.sp-pl').click();
  h.query('.sp-dev-chip').click();
  await settle();
  h.query('.sp-dev').click();
  assert.deepEqual(h.requests.filter(r => r.action).map(r => r.action), [
    { type: 'spotifyVolume', mode: 'set', value: '37' },
    { type: 'spotifyPlaylist', playlist: 'spotify:playlist:1' },
    { type: 'spotifyDevice', device: 'Phone' },
  ]);
});

test('volume stays at the released value while Spotify returns an older snapshot', async () => {
  const h = await setup();
  const vol = h.query('.sp-vol-range');
  vol.value = '37'; h.fire(vol, 'input'); h.fire(vol, 'change');
  await settle(30);
  assert.equal(vol.value, '37');
  assert.equal(h.query('.sp-vol-value').textContent, '37%');
  assert.equal(h.query('.sp-vol-range', 1).value, '37');
});

test('adjusting volume does not freeze the track progress ticker', async () => {
  const h = await setup();
  const vol = h.query('.sp-vol-range');
  vol.value = '37'; h.fire(vol, 'input');
  h.tick(1000);
  assert.equal(h.query('.sp-seek-range').value, '55');
  h.fire(vol, 'pointercancel');
  assert.equal(vol.value, '64');
});

test('rapid volume changes serialize writes and keep only the newest queued value', async () => {
  const completions = [];
  const h = await setup({ api: (url, init) => {
    if (url === '/actions/run' && JSON.parse(init.body).type === 'spotifyVolume') {
      return new Promise(resolve => completions.push(resolve));
    }
  } });
  const vol = h.query('.sp-vol-range');
  for (const value of ['10', '25', '64']) {
    vol.value = value; h.fire(vol, 'input'); h.fire(vol, 'change');
  }
  assert.equal(completions.length, 1);
  h.player.volume = 10; // Spotify still reports the first write.
  completions[0]({ ok: true });
  await settle(30);
  assert.equal(completions.length, 2);
  assert.deepEqual(h.requests.filter(r => r.action?.type === 'spotifyVolume').map(r => r.action.value), ['10', '64']);
  completions[1]({ ok: true });
  await settle(30);
  assert.equal(vol.value, '64'); // Returning to the old value is not a confirmation.
});

test('volume rolls back on rejection and resumes external updates after confirmation', async () => {
  let fail = true;
  const h = await setup({ api: url => url === '/actions/run' && fail ? { ok: false, error: 'volume_failed' } : undefined });
  const vol = h.query('.sp-vol-range');
  vol.value = '37'; h.fire(vol, 'input'); h.fire(vol, 'change');
  await settle(30);
  assert.equal(vol.value, '64');
  fail = false;
  vol.value = '37'; h.fire(vol, 'input'); h.fire(vol, 'change');
  await settle(30);
  assert.equal(vol.value, '37');
  h.player.volume = 37;
  h.poll(); await settle(30);
  h.player.volume = 71;
  h.poll(); await settle(30);
  assert.equal(vol.value, '71');
});

test('unconfirmed volume is bounded and does not carry over to another device', async () => {
  const h = await setup();
  const vol = h.query('.sp-vol-range');
  vol.value = '37'; h.fire(vol, 'input'); h.fire(vol, 'change');
  await settle(30);
  h.tick(9000);
  h.widget.renderWidgets();
  assert.equal(vol.value, '64');
  vol.value = '37'; h.fire(vol, 'input'); h.fire(vol, 'change');
  await settle(30);
  h.player.device = 'Phone'; h.player.volume = 82;
  h.poll(3000); await settle(30);
  assert.equal(vol.value, '82');
});

test('a delayed older player read cannot undo the post-volume confirmation', async () => {
  let hold = false, resolveOld;
  const h = await setup({ api: url => url.includes('/player') && hold
    ? new Promise(resolve => { resolveOld = resolve; }) : undefined });
  const old = structuredClone(h.player);
  hold = true;
  h.poll(); await settle(30);
  assert.equal(typeof resolveOld, 'function');
  hold = false;
  h.player.volume = 37;
  const vol = h.query('.sp-vol-range');
  vol.value = '37'; h.fire(vol, 'input'); h.fire(vol, 'change');
  await settle(30);
  resolveOld(old);
  await settle(30);
  assert.equal(vol.value, '37');
  assert.equal(h.query('.sp-vol-range', 1).value, '37');
});
