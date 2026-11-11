import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSpotifyProvider } = require('../stream-spotify.js');
const { createSpotifyDebugLog, endpointTemplate, MAX_BYTES } = require('../spotify-debug-log.js');

function fixture(t, responder, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'spotify-debug-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tokensFile = join(dir, 'tokens.json');
  const logFile = join(dir, 'debug.jsonl');
  const time = { now: Date.now() };
  writeFileSync(tokensFile, JSON.stringify({ spotify: {
    accessToken: 'SECRET_ACCESS_TOKEN', refreshToken: 'SECRET_REFRESH_TOKEN',
    login: options.login ?? 'PRIVATE_LOGIN', expiresAt: options.expired ? 1 : time.now + 86400000,
  } }));
  const calls = [];
  const p = createSpotifyProvider({
    clientId: 'SECRET_CLIENT_ID', tokensFile, now: () => time.now,
    ...(options.disabled ? {} : { debugLogFile: logFile }),
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET' });
      const r = await responder(new URL(url), init);
      if (r instanceof Response) return r;
      return {
        ok: (r.status || 200) < 400, status: r.status || 200,
        headers: { get: () => r.retryAfter ?? null },
        ...(r.body ? { body: r.body } : {}),
        json: r.json || (async () => r.data),
      };
    },
  });
  return { p, time, dir, tokensFile, logFile, calls, lines: () => readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse) };
}
function gate() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('debug logging is opt-in and does not create a file by default', async t => {
  const x = fixture(t, () => ({ data: { devices: [] } }), { disabled: true });
  await x.p.getDevices();
  assert.equal(x.p.getDiagnostics().totals.upstreamStarted, 1);
  assert.equal(existsSync(x.logFile), false);
  assert.deepEqual(readdirSync(x.dir), ['tokens.json']);
});

test('all endpoint templates remove IDs and query contents; unknown paths are closed', () => {
  for (const [input, expected] of [
    ['https://api.spotify.com/v1/search?q=SECRET&limit=10', '/search'],
    ['https://api.spotify.com/v1/me/player/queue?uri=spotify:track:SECRET', '/me/player/queue'],
    ['https://api.spotify.com/v1/albums/SECRET/tracks?offset=SECRET', '/albums/:id/tracks'],
    ['https://api.spotify.com/v1/artists/SECRET/albums', '/artists/:id/albums'],
    ['https://api.spotify.com/v1/playlists/SECRET/tracks', '/playlists/:id/tracks'],
    ['https://api.spotify.com/v1/tracks/SECRET', '/tracks/:id'],
    ['https://api.spotify.com/v1/unknown/SECRET', '/other'],
    ['https://unrelated.test/SECRET', '/other'],
  ]) assert.equal(endpointTemplate(input), expected);
});

test('API diagnostics never include credentials, music data, IDs, query strings or raw errors', async t => {
  const x = fixture(t, (_url, init) => init.method === 'PUT'
    ? { status: 204 }
    : { data: { tracks: { items: [{ name: 'SECRET_SONG_NAME', uri: 'spotify:track:SECRET_TRACK_ID', artists: [{ name: 'SECRET_ARTIST' }] }] } } });
  await x.p.search('SECRET_SEARCH_TEXT', 'track', 1);
  await x.p.query('albumTracks', { id: 'SECRETALBUMID' });
  await x.p.query('artistAlbums', { id: 'SECRETARTISTID' });
  await x.p.query('playlistTracks', { id: 'SECRETPLAYLISTID' });
  await x.p.playUri('spotify:track:SECRETTRACKID');
  const raw = readFileSync(x.logFile, 'utf8');
  assert.doesNotMatch(raw, /SECRET_|SECRETALBUMID|SECRETARTISTID|SECRETPLAYLISTID|SECRETTRACKID|PRIVATE_LOGIN|Bearer|Authorization|\?/);
  const starts = x.lines().filter(r => r.event === 'request_start');
  const ends = x.lines().filter(r => r.event === 'request_end');
  // 5.0's playUri reads a lone track's album first, so it plays in that album.
  assert.equal(starts.length, 6);
  assert.equal(ends.length, 6);
  assert.ok(ends.every(r => r.status === 200 || r.status === 204));
  assert.ok(starts.every(r => /^[a-f0-9]{16}$/.test(r.instanceId) && r.pid === process.pid && r.timestamp));
});

test('token refresh, code exchange and profile reads also pass through the wrapper', async t => {
  const respond = url => url.hostname === 'accounts.spotify.com'
    ? { data: { access_token: 'NEW_SECRET_ACCESS', refresh_token: 'NEW_SECRET_REFRESH', expires_in: 3600 } }
    : url.pathname === '/v1/me' ? { data: { id: 'PRIVATE_USER_ID', display_name: 'PRIVATE_PROFILE_NAME' } }
      : { data: { devices: [] } };
  const refreshed = fixture(t, respond, { expired: true });
  await refreshed.p.getDevices();
  assert.equal(refreshed.p.getDiagnostics().totals.upstreamStarted, 2);
  assert.ok(refreshed.lines().some(r => r.endpoint === '/api/token'));

  const profile = fixture(t, respond, { login: '' });
  await profile.p.status();
  assert.equal(profile.p.getDiagnostics().totals.upstreamStarted, 1);
  assert.ok(profile.lines().some(r => r.endpoint === '/me'));

  const exchanged = fixture(t, respond);
  const auth = exchanged.p.buildAuthUrl('http://127.0.0.1:3031/stream/spotify/callback');
  assert.equal((await exchanged.p.exchangeCode('SECRET_AUTH_CODE', auth.state)).ok, true);
  assert.equal(exchanged.p.getDiagnostics().totals.upstreamStarted, 2);
  for (const x of [refreshed, profile, exchanged]) {
    assert.doesNotMatch(readFileSync(x.logFile, 'utf8'), /SECRET_|PRIVATE_|NEW_SECRET|code_verifier|grant_type/);
  }
});

test('429 logs its known reason, normalized header and deadline while cooldown persistence stays minimal', async t => {
  const x = fixture(t, () => ({
    status: 429, retryAfter: ' 73100 ',
    data: { error: { reason: 'QUOTA_EXCEEDED', message: 'SECRET_BODY_TOKEN SECRET_SONG_NAME' } },
  }));
  const result = await x.p.getDevices();
  assert.equal(result.error, 'rate_limited');
  assert.equal(result.retryAfterMs, 73100000);
  const record = x.lines().find(r => r.event === 'rate_limit');
  assert.equal(record.reason, 'QUOTA_EXCEEDED');
  assert.deepEqual(record.retryAfter, { kind: 'seconds', value: 73100 });
  assert.equal(record.retryAt, result.retryAt);
  assert.equal(record.endpoint, '/me/player/devices');
  assert.equal(record.source, 'spotify_429');
  assert.ok(record.observedAt);
  assert.doesNotMatch(readFileSync(x.logFile, 'utf8'), /SECRET_|PRIVATE_|message/);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(x.tokensFile + '.spotify-cooldown.json', 'utf8'))), ['retryAt']);
  await x.p.getPlayer();
  await x.p.getQueue();
  assert.equal(x.calls.length, 1);
  assert.equal(x.p.getDiagnostics().totals.blockedCalls, 2);
});

test('unknown or malformed provider data never becomes arbitrary log text', async t => {
  for (const json of [
    async () => ({ error: { reason: 'SECRET_ACCESS_TOKEN', message: 'SECRET_RESPONSE' } }),
    async () => { throw new Error('SECRET_PARSE_ERROR'); },
  ]) {
    const x = fixture(t, () => ({ status: 429, retryAfter: 'SECRET_HEADER', json }));
    const r = await x.p.getDevices();
    assert.equal(r.retryAfterMs, 60000);
    const record = x.lines().find(line => line.event === 'rate_limit');
    assert.equal(record.reason, 'unknown');
    assert.deepEqual(record.retryAfter, { kind: 'invalid' });
    assert.doesNotMatch(readFileSync(x.logFile, 'utf8'), /SECRET/);
  }
});

test('slow429 diagnostic JSON cannot delay the guard or hold the command indefinitely', { timeout: 3000 }, async t => {
  const reading = gate();
  const x = fixture(t, () => ({
    status: 429, retryAfter: '7200',
    json: () => { reading.resolve(); return new Promise(() => {}); },
  }));
  const first = x.p.getDevices();
  await reading.promise;
  const blocked = await x.p.getPlayer();
  assert.equal(blocked.error, 'rate_limited');
  assert.equal(blocked.retryAfterMs, 7200000);
  assert.equal(x.calls.length, 1);
  assert.equal((await first).error, 'rate_limited');
  assert.equal(x.lines().find(r => r.event === 'rate_limit').reason, 'unknown');
});

test('oversized streaming429 bodies are cancelled without logging their contents', async t => {
  let cancelled = false;
  const x = fixture(t, () => ({
    status: 429, retryAfter: '60',
    body: {
      getReader: () => ({
        read: async () => ({ done: false, value: new Uint8Array(5000) }),
        cancel: async () => { cancelled = true; },
      }),
    },
  }));
  assert.equal((await x.p.getDevices()).error, 'rate_limited');
  assert.equal(cancelled, true);
  assert.equal(x.lines().find(r => r.event === 'rate_limit').reason, 'unknown');
});

test('cache/coalescing/blocked calls have separate counters and sparse interval summaries', async t => {
  const started = gate(), release = gate();
  const x = fixture(t, async () => { started.resolve(); await release.promise; return { data: { devices: [] } }; });
  const first = x.p.getDevices();
  await started.promise;
  const second = x.p.getDevices();
  const third = x.p.query('devices');
  release.resolve();
  await Promise.all([first, second, third]);
  await x.p.getDevices();
  assert.equal(x.p.getDiagnostics().totals.upstreamStarted, 1);
  assert.equal(x.p.getDiagnostics().totals.coalescedHits, 2);
  assert.equal(x.p.getDiagnostics().totals.cacheHits, 1);
  await x.p.pauseUntil(x.time.now + 600000);
  x.time.now += 60000;
  await x.p.status();
  for (let i = 0; i < 20; i++) await x.p.getDevices();
  assert.equal(x.lines().filter(r => r.event === 'summary').length, 1);
  x.time.now += 60000;
  await x.p.status();
  const summaries = x.lines().filter(r => r.event === 'summary');
  assert.equal(summaries.length, 2);
  assert.equal(summaries[1].counts.upstreamStarted, 0);
  assert.ok(summaries[1].counts.blockedCalls >= 20);
  assert.equal(x.calls.length, 1);
  const snapshot = x.p.getDiagnostics();
  snapshot.totals.upstreamStarted = 100;
  snapshot.endpoints['GET /me/player/devices'] = 100;
  assert.equal(x.p.getDiagnostics().totals.upstreamStarted, 1);
  assert.equal(x.p.getDiagnostics().endpoints['GET /me/player/devices'], 1);
});

test('restored cooldown is explicitly unknown, creates a new instance and makes no outgoing request', async t => {
  const x = fixture(t, () => { throw new Error('must not fetch'); });
  const until = x.time.now + 7200000;
  await x.p.pauseUntil(until);
  const restored = createSpotifyProvider({
    clientId: 'SECRET_CLIENT_ID', tokensFile: x.tokensFile, debugLogFile: x.logFile,
    now: () => x.time.now, fetch: async () => { throw new Error('must not fetch'); },
  });
  const status = await restored.status();
  assert.equal(status.retryAt, until);
  const record = x.lines().find(r => r.event === 'cooldown_restored');
  assert.equal(record.reason, 'not_recorded');
  assert.equal(record.source, 'persisted');
  assert.notEqual(restored.getDiagnostics().instanceId, x.p.getDiagnostics().instanceId);
  assert.equal(restored.getDiagnostics().totals.upstreamStarted, 0);
});

test('rotation keeps only current two MiB plus one bounded predecessor; I/O errors remain fail-open', async t => {
  const x = fixture(t, () => ({ data: { devices: [] } }));
  writeFileSync(x.logFile, 'a'.repeat(MAX_BYTES));
  const log = createSpotifyDebugLog(x.logFile, 'test-instance');
  log.write('test', { count: 1 });
  assert.equal(statSync(x.logFile + '.1').size, MAX_BYTES);
  assert.ok(statSync(x.logFile).size < MAX_BYTES);
  writeFileSync(x.logFile, 'b'.repeat(MAX_BYTES));
  log.write('test', { count: 2 });
  assert.equal(statSync(x.logFile + '.1').size, MAX_BYTES);
  assert.equal(readFileSync(x.logFile + '.1', 'utf8')[0], 'b');
  assert.equal(existsSync(x.logFile + '.2'), false);
  const badPath = join(x.dir, 'directory');
  mkdirSync(badPath);
  assert.doesNotThrow(() => createSpotifyDebugLog(badPath, 'test').write('event', {}));
  const failedLogProvider = createSpotifyProvider({
    clientId: 'fixture', tokensFile: x.tokensFile, debugLogFile: badPath,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ devices: [] }) }),
  });
  assert.equal((await failedLogProvider.getDevices()).ok, true);
});

test('network failures log only a fixed classification', async t => {
  const x = fixture(t, () => { throw new Error('SECRET_NETWORK_CONTEXT'); });
  assert.deepEqual(await x.p.getDevices(), { ok: false, error: 'network' });
  assert.equal(x.p.getDiagnostics().totals.networkErrors, 1);
  assert.equal(x.lines().find(r => r.event === 'request_end').error, 'network');
  assert.doesNotMatch(readFileSync(x.logFile, 'utf8'), /SECRET_/);
});
