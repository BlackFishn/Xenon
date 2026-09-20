import { test } from 'node:test';
import assert from 'node:assert/strict';
import live from '../ai-usage-live.js';
import usage from '../ai-usage.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = 1800000000000;
const body = { plan_type: 'pro', rate_limit: { primary_window: { used_percent: 0,
  limit_window_seconds: 604800, reset_at: now / 1000 + 3600 } },
  additional_rate_limits: [{ limit_name: 'Spark', rate_limit: { primary_window: {
    used_percent: 35, limit_window_seconds: 18000, reset_after_seconds: 90 } } }],
  credits: { balance: '0', unlimited: false }, secret: 'PRIVATE' };
const ok = () => new Response(JSON.stringify(body));
function fixture(options = {}) {
  let time = now, calls = 0, auth = { token: 'PRIVATE', account: 'account' };
  const read = live.createLiveQuotaReader({ clock: () => time,
    credentials: async id => id === 'codex' ? auth : null,
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers['ChatGPT-Account-Id'], auth.account);
      return options.fetch ? options.fetch(init) : ok();
    } });
  return { read, advance: ms => { time += ms; }, calls: () => calls, setAuth: a => { auth = a; } };
}
test('API mapping keeps zero, durations, credits, extra buckets and excludes private fields', () => {
  const out = live._internal.mapUsage('codex', body, now);
  assert.equal(out[0].windows[0].windowMinutes, 10080);
  assert.equal(out[0].windows[0].usedPercent, 0);
  assert.equal(out[0].credits.balance, 0);
  assert.equal(out[1].windows[0].resetsAt, now / 1000 + 90);
  assert.ok(!JSON.stringify(out).includes('PRIVATE'));
  assert.deepEqual(live._internal.mapUsage('codex', {}, now), []);
});
test('Claude legacy and modern schemas map actual observation timestamps', () => {
  for (const body of [{ five_hour: { utilization: 0, resets_at: null } },
    { limits: [{ kind: 'session', percent: 0, resets_at: null }] }]) {
    const [out] = live._internal.mapUsage('claude', body, now);
    assert.equal(out.windows[0].usedPercent, 0);
    assert.equal(out.windows[0].source, 'provider_api');
    assert.equal(out.observedAt, now);
  }
});
test('single flight, five minute cache, force and click debounce', async () => {
  const f = fixture();
  await Promise.all([f.read(), f.read(), f.read()]);
  assert.equal(f.calls(), 1);
  await f.read({ force: true });
  assert.equal(f.calls(), 1);
  f.advance(11000);
  await f.read();
  assert.equal(f.calls(), 1);
  await f.read({ force: true });
  assert.equal(f.calls(), 2);
  f.advance(300001);
  await f.read();
  assert.equal(f.calls(), 3);
});
test('429 respects Retry-After even for forced refresh and retains original observation', async () => {
  let fail = false;
  const f = fixture({ fetch: () => fail ? new Response('', { status: 429, headers: { 'Retry-After': '900' } }) : ok() });
  await f.read();
  f.advance(11000); fail = true;
  const result = await f.read({ force: true });
  assert.equal(result.codex.status, 'rate_limited');
  assert.equal(result.codex.limits[0].observedAt, now);
  f.advance(300001);
  await f.read({ force: true });
  assert.equal(f.calls(), 2);
  f.advance(600000);
  await f.read();
  assert.equal(f.calls(), 3);
});
test('authentication failures do not refresh tokens or leak error bodies', async () => {
  const f = fixture({ fetch: () => new Response('PRIVATE', { status: 401 }) });
  const out = await f.read();
  assert.equal(out.codex.status, 'sign_in_required');
  assert.ok(!JSON.stringify(out).includes('PRIVATE'));
  await f.read({ force: true });
  assert.equal(f.calls(), 1);
});
test('invalid JSON, oversize responses and transport errors become bounded unavailable states', async () => {
  for (const fetch of [() => new Response('bad'), () => new Response('x'.repeat(1024 * 1024 + 1)),
    () => { throw new Error('PRIVATE'); }]) {
    const f = fixture({ fetch });
    const out = await f.read();
    assert.equal(out.codex.status, 'unavailable');
    assert.deepEqual(out.codex.limits, []);
    assert.ok(!JSON.stringify(out).includes('PRIVATE'));
  }
});
test('changed credentials invalidate previous quota, including in-flight account changes', async () => {
  const f = fixture();
  await f.read();
  f.setAuth(null);
  assert.deepEqual((await f.read()).codex.limits, []);
  f.setAuth({ token: 'NEW', account: 'new-account' });
  await f.read();
  assert.equal(f.calls(), 2);
  let finish;
  const g = fixture({ fetch: () => new Promise(resolve => { finish = resolve; }) });
  const pending = g.read();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  g.setAuth({ token: 'NEW', account: 'new-account' });
  finish(ok());
  assert.equal((await pending).codex.status, 'account_changed');
});
test('file reader respects custom roots and ignores API keys and malformed credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xenon-live-quota-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const read = live.createCredentialsReader({ codexDir: dir, claudeDir: dir });
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'PRIVATE' }));
  assert.equal(await read('codex'), null);
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'secret', account_id: 'account' } }));
  assert.equal((await read('codex')).account, 'account');
  await writeFile(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'bad\nheader' } }));
  assert.equal(await read('claude'), null);
});
test('service prefers live quota but preserves local history and falls back when unavailable', async () => {
  let remote = { codex: { status: 'ready', limits: live._internal.mapUsage('codex', body, now) } };
  const service = usage.createService({
    claudeReader: { getUsage: async () => ({ daily: [], total: { reqs: 0 }, live: {} }) },
    codexReader: { getUsage: async () => ({ daily: [], limits: [{ id: 'old', windows: [] }], found: true }) },
    bridge: () => null, liveQuota: async () => remote,
  });
  assert.equal((await service.snapshot(now)).providers[1].limits[0].id, 'codex');
  remote = { codex: { status: 'unavailable', limits: [] } };
  const fallback = (await service.snapshot(now + 1)).providers[1];
  assert.equal(fallback.limits[0].id, 'old');
  assert.equal(fallback.connection.liveStatus, 'unavailable');
});

test('OpenCode Go maps three windows without turning missing values into zero', () => {
  const [out] = live._internal.mapUsage('opencode', { usage: {
    rolling: { percent: 0, resetsAt: '2027-01-16T12:00:00Z' },
    weekly: { percent: 35 }, monthly: { percent: 70 },
  } }, now);
  assert.deepEqual(out.windows.map(w => w.windowMinutes), [300, 10080, 43200]);
  assert.equal(out.windows[0].usedPercent, 0);
  assert.equal(out.windows[0].resetsAt, Date.parse('2027-01-16T12:00:00Z') / 1000);
  assert.deepEqual(live._internal.mapUsage('opencode', { usage: { rolling: { percent: '0' } } }, now), []);
});

test('OpenCode credentials send only the Go key to its fixed endpoint', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xenon-opencode-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'auth.json'), JSON.stringify({
    'opencode-go': { type: 'api', key: 'GO_PRIVATE' }, openai: { access: 'UNRELATED_PRIVATE' },
  }));
  const credentials = live.createCredentialsReader({ opencodeDir: dir });
  const read = live.createLiveQuotaReader({ credentials: id => id === 'opencode' ? credentials(id) : null,
    clock: () => now, fetchImpl: async (url, init) => {
      assert.equal(url, 'https://opencode.ai/zen/go/v1/usage');
      assert.equal(init.headers.Authorization, 'Bearer GO_PRIVATE');
      assert.equal(init.headers['ChatGPT-Account-Id'], undefined);
      return new Response(JSON.stringify({ usage: { rolling: { percent: 20 } } }));
    } });
  const out = await read();
  assert.equal(out.opencode.status, 'ready');
  assert.ok(!JSON.stringify(out).includes('PRIVATE'));
});

test('service includes OpenCode only with credentials and marks history unavailable', async () => {
  let status = 'not_signed_in';
  const service = usage.createService({
    claudeReader: { getUsage: async () => ({ daily: [], total: { reqs: 0 }, live: {} }) },
    codexReader: { getUsage: async () => ({ daily: [], limits: [], found: false }) },
    bridge: () => null, liveQuota: async () => ({ opencode: { status, limits: [] } }),
  });
  assert.equal((await service.snapshot(now)).providers.length, 2);
  status = 'sign_in_required';
  const p = (await service.snapshot(now + 1)).providers[2];
  assert.equal(p.id, 'opencode');
  assert.equal(p.historyUnavailable, true);
  assert.equal(p.periods.today.tokens, 0);
  assert.equal(p.connection.liveStatus, 'sign_in_required');
});
