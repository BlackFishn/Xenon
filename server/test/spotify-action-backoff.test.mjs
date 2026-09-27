import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRegistry } = require('../actions/registry.js');

test('Spotify action results preserve the full retry deadline without other provider fields', async () => {
  const response = {
    ok: false, error: 'rate_limited', retryAfterMs: 7200000, retryAt: 1790500000000,
    data: { access_token: 'never-return-this' }, status: 429,
  };
  const registry = createRegistry({ spotify: async () => response });
  for (const action of [
    { type: 'spotifyVolume', mode: 'set', value: '40' },
    { type: 'spotifyPlay', mode: 'play' },
    { type: 'spotifyPlayUri', uri: 'spotify:track:abc' },
  ]) {
    assert.deepEqual(await registry.run(action), {
      ok: false, error: 'rate_limited', retryAfterMs: 7200000, retryAt: 1790500000000,
    });
  }
});

test('Spotify action results omit invalid retry metadata', async () => {
  for (const value of [undefined, -1, 0, Infinity, NaN, '7200000']) {
    const registry = createRegistry({ spotify: async () => ({
      ok: false, error: 'rate_limited', retryAfterMs: value, retryAt: value,
    }) });
    assert.deepEqual(await registry.run({ type: 'spotifyNext' }), {
      ok: false, error: 'rate_limited',
    });
  }
});
