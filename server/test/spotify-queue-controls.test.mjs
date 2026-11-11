import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSpotifyProvider } = require('../stream-spotify.js');
const { createRegistry } = require('../actions/registry.js');
const sdk = require('../sdk-widgets.js');

function provider(t, respond) {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-queue-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'tokens.json');
  writeFileSync(file, JSON.stringify({ spotify: { accessToken: 'fixture', refreshToken: 'fixture', expiresAt: Date.now() + 1e6 } }));
  const calls = [];
  const p = createSpotifyProvider({
    clientId: 'fixture',
    tokensFile: file,
    fetch: async (url, init) => {
      const call = { url: new URL(url), method: init.method, body: init.body ? JSON.parse(init.body) : null };
      calls.push(call);
      const r = await respond(call, calls.length);
      const status = r.status || 200;
      return {
        ok: status < 400, status,
        headers: { get: name => name === 'retry-after' ? String(r.retryAfter || 5) : null },
        json: async () => r.data,
      };
    },
  });
  return { p, calls };
}
const TRACK = {
  uri: 'spotify:track:Track123', name: 'A song', artists: [{ name: 'An artist' }],
  album: { images: [{ url: 'large-cover' }, { url: 'small-cover' }] },
};
const LITE = { uri: TRACK.uri, name: 'A song', artist: 'An artist', image: 'small-cover' };

test('queue search sends a bounded catalog query and returns safe track metadata', async t => {
  const { p, calls } = provider(t, () => ({ data: { tracks: { items: Array.from({ length: 14 }, () => ({ ...TRACK, secret: 'omit' })) } } }));
  const r = await p.searchTracks('  artist เพลง & song  ');
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 10);
  assert.deepEqual(r.results[0], LITE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/v1/search');
  assert.equal(calls[0].url.searchParams.get('q'), 'artist เพลง & song');
  assert.equal(calls[0].url.searchParams.get('type'), 'track');
  assert.equal(calls[0].url.searchParams.get('limit'), '10');
  assert.deepEqual(await p.searchTracks(' '), { ok: false, error: 'no_query' });
  assert.deepEqual(await p.searchTracks('q'.repeat(201)), { ok: false, error: 'query_too_long' });
  assert.equal(calls.length, 1, 'invalid input must not spend account quota');
});

test('track URI and Spotify share links resolve via a fixed API path', async t => {
  const { p, calls } = provider(t, () => ({ data: TRACK }));
  for (const query of [
    TRACK.uri,
    'https://open.spotify.com/track/Track123?si=share',
    'https://open.spotify.com/intl-th/track/Track123',
    'open.spotify.com/track/Track123',
  ]) {
    assert.deepEqual(await p.searchTracks(query), { ok: true, results: [LITE] });
  }
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.url.origin, 'https://api.spotify.com');
    assert.equal(call.url.pathname, '/v1/tracks/Track123');
    assert.equal(call.url.search, '');
  }
});

test('pasted links reject alternate hosts, credentials, types and path injection without fetching', async t => {
  const { p, calls } = provider(t, () => { throw new Error('must not fetch'); });
  for (const query of [
    'spotify:album:Track123', 'spotify:track:../../me', 'spotify:track:Track123?x=1',
    'https://open.spotify.com.evil.test/track/Track123',
    'https://open.spotify.com@evil.test/track/Track123',
    'https://user:pw@open.spotify.com/track/Track123',
    'https://open.spotify.com:8443/track/Track123',
    'http://open.spotify.com/track/Track123',
    'https://open.spotify.com/album/Track123',
    'https://open.spotify.com/track/Track123/more',
    'https://127.0.0.1/track/Track123', 'file:///track/Track123',
  ]) assert.deepEqual(await p.searchTracks(query), { ok: false, error: 'bad_uri' }, query);
  assert.equal(calls.length, 0);
});

test('search and link errors stay actionable and missing tracks cannot be queued as blank rows', async t => {
  for (const [status, data, error] of [
    [401, {}, 'not_connected'],
    [403, { error: { message: 'Insufficient client scope' } }, 'forbidden'],
    [500, {}, 'search_failed'],
  ]) {
    const { p } = provider(t, () => ({ status, data }));
    assert.deepEqual(await p.searchTracks('song'), { ok: false, error });
  }
  const missing = provider(t, () => ({ status: 404, data: {} })).p;
  assert.deepEqual(await missing.searchTracks(TRACK.uri), { ok: false, error: 'not_found' });
  const wrong = provider(t, () => ({ data: { ...TRACK, uri: 'spotify:track:Other' } })).p;
  assert.deepEqual(await wrong.searchTracks(TRACK.uri), { ok: false, error: 'not_found' });
  const empty = provider(t, () => ({ data: { tracks: { items: [null, { name: 'Unavailable' }] } } })).p;
  assert.deepEqual(await empty.searchTracks('song'), { ok: true, results: [] });
});

test('registry queues exactly the selected track without replacing or advancing playback', async t => {
  const { p, calls } = provider(t, () => ({ status: 204 }));
  const reg = createRegistry({ spotify: action => p.runAction(action) });
  assert.deepEqual(await reg.run({ type: 'spotifyQueueUri', uri: TRACK.uri, ignored: 'drop' }), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url.pathname, '/v1/me/player/queue');
  assert.equal(calls[0].url.searchParams.get('uri'), TRACK.uri);
  assert.equal(calls[0].body, null);
  assert.ok(!sdk.SDK_ACTION_TYPES.includes('spotifyQueueUri'), 'adding the built-in control must not grant SDK access');
});

test('enqueue validates track URI before any Spotify request', async t => {
  const { p, calls } = provider(t, () => { throw new Error('must not fetch'); });
  for (const uri of ['', null, 'spotify:album:Track123', 'spotify:episode:Track123',
    'https://open.spotify.com/track/Track123', 'spotify:track:Track123&device_id=other',
    'spotify:track:' + 'x'.repeat(41)]) {
    assert.deepEqual(await p.queueUri(uri), { ok: false, error: 'bad_uri' }, String(uri));
  }
  assert.equal(calls.length, 0);
});

test('queue and picked-track failures map to actionable errors without replay retries', async t => {
  for (const [status, data, error] of [
    [401, {}, 'not_connected'],
    [403, { error: { reason: 'PREMIUM_REQUIRED' } }, 'premium_required'],
    [403, { error: { message: 'Insufficient client scope' } }, 'forbidden'],
    [404, { error: { reason: 'NO_ACTIVE_DEVICE', message: 'No active device found' } }, 'no_active_device'],
    [500, {}, null],
  ]) {
    for (const action of ['spotifyQueueUri', 'spotifyPlayUri']) {
      const { p, calls } = provider(t, () => ({ status, data }));
      const reg = createRegistry({ spotify: a => p.runAction(a) });
      const r = await reg.run({ type: action, uri: TRACK.uri, contextUri: 'spotify:playlist:List123' });
      assert.deepEqual(r, { ok: false, error: error || (action === 'spotifyPlayUri' ? 'play_failed' : 'queue_failed') });
      assert.equal(calls.length, 1, action + ' must not blindly retry HTTP ' + status);
    }
  }
});

test('rate limit and network failures survive registry and do not retry context playback', async t => {
  for (const type of ['spotifyQueueUri', 'spotifyPlayUri']) {
    const { p, calls } = provider(t, () => ({ status: 429, retryAfter: 120 }));
    const reg = createRegistry({ spotify: a => p.runAction(a) });
    const r = await reg.run({ type, uri: TRACK.uri, contextUri: 'spotify:playlist:List123' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'rate_limited');
    assert.ok(r.retryAfterMs > 110000 && r.retryAfterMs <= 120000);
    assert.equal(calls.length, 1);
    assert.equal((await p.searchTracks('song')).error, 'rate_limited');
    assert.equal(calls.length, 1, 'reads also respect the shared cooldown');
    const failed = provider(t, () => { throw new Error('offline'); });
    assert.deepEqual(await failed.p.runAction({ type, uri: TRACK.uri, contextUri: 'spotify:playlist:List123' }), { ok: false, error: 'network' });
    assert.equal(failed.calls.length, 1);
  }
});

test('invalid offset or missing context retries the same chosen track once', async t => {
  for (const status of [400, 404]) {
    const { p, calls } = provider(t, (_call, n) => n === 1
      ? { status, data: { error: { message: 'Invalid offset or context' } } }
      : { status: 204 });
    assert.deepEqual(await p.playUri(TRACK.uri, 'spotify:playlist:List123'), { ok: true });
    // 5.0 looks up the track's album first (it plays there when it has one);
    // this fixture has none, so the track plays alone, once.
    const plays = calls.filter(c => c.method === 'PUT');
    assert.equal(plays.length, 2);
    assert.deepEqual(plays[0].body, { context_uri: 'spotify:playlist:List123', offset: { uri: TRACK.uri } });
    assert.deepEqual(plays[1].body, { uris: [TRACK.uri] });
    assert.equal(calls.length, 3);
  }
});

test('dashboard search route forwards the submitted query and hides thrown errors', async () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf("  } else if (reqPath === '/stream/spotify/search'");
  assert.ok(start > 0);
  const bodyStart = source.indexOf('\n', start);
  const end = source.indexOf("\n  } else if (reqPath === '/stream/spotify/queue'", bodyStart);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const route = new AsyncFunction('streamSpotify', 'urlObj', 'json', source.slice(bodyStart, end));
  const outputs = [];
  const expected = { ok: true, results: [LITE] };
  await route({ searchTracks: async q => { assert.equal(q, 'a song'); return expected; } },
    new URL('http://localhost/stream/spotify/search?q=a%20song'), r => outputs.push(r));
  assert.deepEqual(outputs, [expected]);
  await route({ searchTracks: async () => { throw new Error('private error'); } },
    new URL('http://localhost/stream/spotify/search'), r => outputs.push(r));
  assert.deepEqual(outputs[1], { ok: false, error: 'search_failed' });
});
