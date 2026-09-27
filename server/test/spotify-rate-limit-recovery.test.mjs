import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSpotifyProvider } = require('../stream-spotify.js');

function setup(t, respond, expired = false) {
  const dir = mkdtempSync(join(tmpdir(), 'spotify-cooldown-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tokensFile = join(dir, 'tokens.json');
  const time = { value: Date.now() };
  writeFileSync(tokensFile, JSON.stringify({ spotify: {
    accessToken: 'test-access', refreshToken: 'test-refresh', login: 'Test',
    expiresAt: expired ? 1 : time.value + 86400000,
  } }));
  const calls = [];
  function make() {
    return createSpotifyProvider({
      clientId: 'test-client', tokensFile, now: () => time.value,
      fetch: async (url, init = {}) => {
        calls.push({ path: new URL(url).pathname, method: init.method || 'GET' });
        const r = await respond(new URL(url), init, calls.length);
        const status = r.status || 200;
        return { ok: status < 400, status, headers: { get: () => r.retryAfter ?? null }, json: async () => r.data };
      },
    });
  }
  return { p: make(), make, time, calls, tokensFile };
}
const item = { id: 'one', uri: 'spotify:track:one', name: 'Song', duration_ms: 200000, artists: [], album: { images: [] } };
function playback(url) {
  if (url.pathname.endsWith('/queue')) return { data: { currently_playing: item, queue: [item] } };
  if (url.pathname.endsWith('/devices')) return { data: { devices: [{ id: 'pc', name: 'PC', is_active: true }] } };
  if (url.pathname.endsWith('/contains')) return { data: [false] };
  if (url.pathname.endsWith('/playlists')) return { data: { items: [] } };
  return { data: { is_playing: true, item, context: { type: 'playlist', uri: 'spotify:playlist:list' }, device: { volume_percent: 40 } } };
}
function isLimited(result, until, remaining) {
  assert.equal(result.error, 'rate_limited');
  assert.equal(result.retryAt, until);
  assert.equal(result.retryAfterMs, remaining);
}
function gate() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('full Retry-After survives restart and all surfaces keep the same deadline', async t => {
  const x = setup(t, () => ({ status: 429, retryAfter: '7200' }));
  const until = x.time.value + 7200000;
  isLimited(await x.p.getQueue(), until, 7200000);
  assert.deepEqual(JSON.parse(readFileSync(x.tokensFile + '.spotify-cooldown.json', 'utf8')), { retryAt: until });
  const restarted = x.make();
  x.time.value += 1000;
  const auth = restarted.buildAuthUrl('http://127.0.0.1:3031/stream/spotify/callback');
  const results = await Promise.all([
    restarted.getPlayer({ fresh: true }), restarted.getQueue(), restarted.getDevices(),
    restarted.getPlaylists(), restarted.query('player'), restarted.search('song'),
    restarted.setVolume('set', 20), restarted.saveCurrent(), restarted.toggleLike('toggle'),
    restarted.transferDevice('PC'), restarted.playUri('spotify:track:one', 'spotify:playlist:list'),
    restarted.exchangeCode('code', auth.state),
  ]);
  for (const result of results) isLimited(result, until, 7199000);
  const status = await restarted.status();
  assert.equal(status.connected, true);
  assert.equal(status.login, 'Test');
  isLimited(status, until, 7199000);
  assert.equal(x.calls.length, 1, 'restart and subsequent reads/actions must not bypass the existing wait');
});

test('pauseUntil only extends and persists no credentials', async t => {
  const x = setup(t, () => { throw new Error('no network expected'); });
  const tokensBefore = readFileSync(x.tokensFile, 'utf8');
  const until = x.time.value + 300000;
  assert.equal((await x.p.pauseUntil(until)).ok, true);
  assert.equal((await x.p.pauseUntil(until - 200000)).retryAt, until);
  const fresh = x.make();
  assert.equal((await fresh.pauseUntil(until + 100000)).retryAt, until + 100000);
  assert.equal(readFileSync(x.tokensFile, 'utf8'), tokensBefore);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(x.tokensFile + '.spotify-cooldown.json', 'utf8'))), ['retryAt']);
  assert.deepEqual(await fresh.pauseUntil(NaN), { ok: false, error: 'bad_deadline' });
  assert.equal(x.calls.length, 0);
});

test('absent or malformed Retry-After uses a conservative minute; HTTP dates retain their full duration', async t => {
  for (const header of [undefined, 'garbage', '-1']) {
    const x = setup(t, () => ({ status: 429, retryAfter: header }));
    isLimited(await x.p.getDevices(), x.time.value + 60000, 60000);
  }
  const x = setup(t, () => ({ status: 429, retryAfter: new Date(until).toUTCString() }));
  const until = Math.floor((x.time.value + 10800000) / 1000) * 1000;
  isLimited(await x.p.getDevices(), until, until - x.time.value);
});

test('expired-token reads coalesce refresh and preserve refresh-endpoint 429', async t => {
  const started = gate(), release = gate();
  const x = setup(t, async url => {
    assert.equal(url.pathname, '/api/token');
    started.resolve();
    await release.promise;
    return { status: 429, retryAfter: '9000' };
  }, true);
  const reads = [x.p.getPlayer(), x.p.getQueue(), x.p.getDevices(), x.p.getPlaylists()];
  await started.promise;
  release.resolve();
  for (const r of await Promise.all(reads)) isLimited(r, x.time.value + 9000000, 9000000);
  assert.equal(x.calls.length, 1);
  assert.equal(JSON.parse(readFileSync(x.tokensFile, 'utf8')).spotify.refreshToken, 'test-refresh');
});

test('one refresh serves concurrent reads and the breaker is rechecked after that await', async t => {
  const started = gate(), release = gate();
  const x = setup(t, async url => {
    if (url.pathname === '/api/token') {
      started.resolve();
      await release.promise;
      return { data: { access_token: 'refreshed', expires_in: 3600 } };
    }
    throw new Error('API read must be blocked after refresh');
  }, true);
  const a = x.p.getDevices(), b = x.p.getPlaylists();
  await started.promise;
  const until = x.time.value + 120000;
  await x.p.pauseUntil(until);
  release.resolve();
  for (const r of await Promise.all([a, b])) isLimited(r, until, 120000);
  assert.equal(x.calls.length, 1, 'the completed token refresh must not release queued API calls through a newer cooldown');
});

test('successful token refresh is shared by concurrent distinct API reads', async t => {
  const started = gate(), release = gate();
  const x = setup(t, async url => {
    if (url.pathname === '/api/token') {
      started.resolve(); await release.promise;
      return { data: { access_token: 'refreshed', expires_in: 3600 } };
    }
    return playback(url);
  }, true);
  const requests = [x.p.getDevices(), x.p.getPlaylists(), x.p.getQueue()];
  await started.promise; release.resolve();
  assert.ok((await Promise.all(requests)).every(r => r.ok));
  assert.equal(x.calls.filter(c => c.path === '/api/token').length, 1);
});

test('built-in and SDK queue/device readers share in-flight work and fifteen-second cache', async t => {
  const x = setup(t, playback);
  const results = await Promise.all([x.p.getQueue(), x.p.query('queue'), x.p.getDevices(), x.p.query('devices')]);
  assert.ok(results.every(r => r.ok));
  for (const suffix of ['/queue', '/devices']) assert.equal(x.calls.filter(c => c.path.endsWith(suffix)).length, 1);
  x.time.value += 14000;
  await Promise.all([x.p.getQueue(), x.p.query('queue'), x.p.getDevices(), x.p.query('devices')]);
  for (const suffix of ['/queue', '/devices']) assert.equal(x.calls.filter(c => c.path.endsWith(suffix)).length, 1);
  x.time.value += 2000;
  await Promise.all([x.p.getQueue(), x.p.getDevices()]);
  for (const suffix of ['/queue', '/devices']) assert.equal(x.calls.filter(c => c.path.endsWith(suffix)).length, 2);
});

test('mutations invalidate shared caches and fresh player bypasses both player cache layers', async t => {
  const x = setup(t, (url, init) => init.method === 'PUT' ? { status: 204 } : playback(url));
  await Promise.all([x.p.getQueue(), x.p.getDevices()]);
  await x.p.getPlayer();
  assert.equal(x.calls.filter(c => c.path === '/v1/me/player').length, 1);
  await x.p.getPlayer({ fresh: true });
  assert.equal(x.calls.filter(c => c.path === '/v1/me/player').length, 2);
  await x.p.setVolume('set', 30);
  await Promise.all([x.p.query('queue'), x.p.query('devices')]);
  for (const suffix of ['/queue', '/devices']) assert.equal(x.calls.filter(c => c.path.endsWith(suffix)).length, 2);
});

test('failed queue/player reads are not cached or described as an empty queue', async t => {
  const x = setup(t, () => ({ status: 500, data: {} }));
  assert.deepEqual(await x.p.getQueue(), { ok: false, error: 'queue_failed' });
  assert.deepEqual(await x.p.getQueue(), { ok: false, error: 'queue_failed' });
  await x.p.getPlayer(); await x.p.getPlayer();
  assert.equal(x.calls.length, 4);
  const empty = setup(t, () => ({ status: 204 }));
  assert.deepEqual(await empty.p.getQueue(), { ok: false, error: 'no_playback' });
});

test('secondary player/liked-state rate limits reach the caller instead of a misleading success', async t => {
  const queue = setup(t, url => url.pathname.endsWith('/queue') ? playback(url) : { status: 429, retryAfter: '240' });
  isLimited(await queue.p.getQueue(), queue.time.value + 240000, 240000);
  const liked = setup(t, url => url.pathname.endsWith('/contains') ? { status: 429, retryAfter: '240' } : playback(url));
  isLimited(await liked.p.getPlayer(), liked.time.value + 240000, 240000);
});

test('a cooldown expiry retries without retaining a cached 429', async t => {
  const x = setup(t, (url, _init, n) => n === 1 ? { status: 429, retryAfter: '2' } : playback(url));
  assert.equal((await x.p.getPlayer()).error, 'rate_limited');
  x.time.value += 1999;
  assert.equal((await x.p.getPlayer()).error, 'rate_limited');
  assert.equal(x.calls.length, 1);
  x.time.value++;
  assert.equal((await x.p.getPlayer()).ok, true);
  assert.equal(x.calls.filter(c => c.path === '/v1/me/player').length, 2);
});

test('reads made during a slow command cannot leave pre-command device data cached', async t => {
  const started = gate(), release = gate();
  let volume = 10;
  const x = setup(t, async (url, init) => {
    if (init.method === 'PUT') {
      started.resolve(); await release.promise; volume = 70;
      return { status: 204 };
    }
    if (url.pathname.endsWith('/devices')) return { data: { devices: [{ id: 'pc', name: 'PC', volume_percent: volume }] } };
    return playback(url);
  });
  const command = x.p.setVolume('set', 70);
  await started.promise;
  assert.equal((await x.p.getDevices()).devices[0].volume, 10);
  release.resolve();
  assert.equal((await command).ok, true);
  assert.equal((await x.p.getDevices()).devices[0].volume, 70);
  assert.equal(x.calls.filter(c => c.path.endsWith('/devices')).length, 2);
});
