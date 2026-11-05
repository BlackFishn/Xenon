import { test } from 'node:test';
import assert from 'node:assert/strict';
import live from '../ai-usage-live.js';
import usage from '../ai-usage.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
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

// Grok's account allowance, as the Grok CLI shows under /usage. Protocol after
// OpenUsage's GrokUsageClient / GrokCreditsConfigDecoder.
const grokConfig = (extra = {}) => ({ config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY',
  start: '2027-01-10T06:00:00Z', end: '2027-01-17T06:00:00Z' }, ...extra } });

test('Grok maps its billing period to one window, and an absent percent is a real 0', () => {
  const [out] = live._internal.mapUsage('grok', grokConfig({ creditUsagePercent: 12.5 }), now);
  assert.equal(out.id, 'grok');
  assert.equal(out.windows.length, 1);
  assert.equal(out.windows[0].usedPercent, 12.5);
  assert.equal(out.windows[0].windowMinutes, 10080, 'a week, so it lands in the Weekly slot');
  assert.equal(out.windows[0].resetsAt, Date.parse('2027-01-17T06:00:00Z') / 1000);
  assert.equal(out.windows[0].source, 'provider_api');
  // proto-JSON drops zero values: a fresh week arrives with no percent at all.
  assert.equal(live._internal.mapUsage('grok', grokConfig(), now)[0].windows[0].usedPercent, 0);
  assert.equal(live._internal.mapUsage('grok', grokConfig({ creditUsagePercent: 140 }), now)[0].windows[0].usedPercent, 100);
});

test('a Grok reply that changed shape maps to nothing, never to 0% used', () => {
  for (const bad of [
    grokConfig({ creditUsagePercent: '12' }),
    grokConfig({ creditUsagePercent: null }),
    { config: { currentPeriod: { type: 'x', start: 'soon', end: 'later' } } },
    { config: { currentPeriod: { start: '2027-01-17T06:00:00Z', end: '2027-01-10T06:00:00Z' } } },
    { config: {} }, {}, null, [],
  ]) assert.deepEqual(live._internal.mapUsage('grok', bad, now), [], JSON.stringify(bad));
});

test('Grok sends only the CLI access token, to its fixed endpoint, and never refreshes it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xenon-grok-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'auth.json'), JSON.stringify({
    'https://other.example::client': { key: 'OTHER_PRIVATE' },
    'https://auth.x.ai::b1a00492': { key: 'GROK_PRIVATE', refresh_token: 'REFRESH_PRIVATE', auth_mode: 'oidc',
      expires_at: new Date(now + 3600000).toISOString(), email: 'someone@example.com' },
  }));
  const credentials = live.createCredentialsReader({ grokDir: dir });
  const read = live.createLiveQuotaReader({ credentials: id => id === 'grok' ? credentials(id) : null,
    clock: () => now, fetchImpl: async (url, init) => {
      assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits');
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, 'Bearer GROK_PRIVATE');
      assert.equal(init.headers['X-XAI-Token-Auth'], 'xai-grok-cli');
      assert.ok(!JSON.stringify(init).includes('REFRESH_PRIVATE'));
      return new Response(JSON.stringify(grokConfig({ creditUsagePercent: 20 })));
    } });
  const out = await read();
  assert.equal(out.grok.status, 'ready');
  assert.equal(out.grok.limits[0].windows[0].usedPercent, 20);
  assert.ok(!/PRIVATE|someone@/.test(JSON.stringify(out)));
});

test('an expired Grok token waits for the CLI instead of calling out', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xenon-grok-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'auth.json'), JSON.stringify({
    'https://auth.x.ai::c': { key: 'GROK_PRIVATE', expires_at: new Date(now - 1000).toISOString() } }));
  const credentials = live.createCredentialsReader({ grokDir: dir });
  let calls = 0;
  const read = live.createLiveQuotaReader({ credentials: id => id === 'grok' ? credentials(id) : null,
    clock: () => now, fetchImpl: async () => { calls++; return new Response('{}'); } });
  assert.equal((await read()).grok.status, 'sign_in_required');
  assert.equal(calls, 0);
});

test('a Grok team account (412) says there is no personal allowance', async () => {
  const read = live.createLiveQuotaReader({ credentials: async id => id === 'grok' ? { token: 'T', account: '', expiresAt: 0 } : null,
    clock: () => now, fetchImpl: async () => new Response(JSON.stringify({ error: 'no personal team' }), { status: 412 }) });
  assert.equal((await read()).grok.status, 'no_personal_quota');
});

test('the Grok CLI log supplies a reading, with its plan, and no credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xenon-grok-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const line = (ts, pct) => JSON.stringify({ ts, src: 'shell', lvl: 'info', msg: 'billing: fetched credits config',
    ctx: { config: { creditUsagePercent: pct, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2027-01-10T06:00:00Z', end: '2027-01-17T06:00:00Z' } }, subscriptionTier: 'SuperGrok' } });
  const file = join(dir, 'unified.jsonl');
  await writeFile(file, [
    line(new Date(now - 7200000).toISOString(), 3),
    JSON.stringify({ ts: new Date(now - 3600000).toISOString(), msg: 'something else', ctx: { token: 'PRIVATE' } }),
    line(new Date(now - 60000).toISOString(), 9),
    '{"truncated', '',
  ].join('\n'));
  const reading = await usage.createGrokQuotaReader({ file })(now);
  assert.equal(reading.limits[0].plan, 'SuperGrok');
  assert.equal(reading.limits[0].windows[0].usedPercent, 9, 'the newest reading wins');
  assert.equal(reading.limits[0].windows[0].source, 'local_cache');
  assert.equal(reading.observedAt, now - 60000);
  assert.ok(!JSON.stringify(reading).includes('PRIVATE'));
  assert.equal(await usage.createGrokQuotaReader({ file: join(dir, 'missing.jsonl') })(now), null);
});

test('service shows Grok only where its CLI left a trace, newest reading first, quota only', async () => {
  let status = 'not_signed_in', saved = null, remoteLimits = [];
  const reading = (pct, at, source, plan = '') => ({ id: 'grok', name: 'Grok', plan, observedAt: at,
    windows: [{ id: 'grok-period', usedPercent: pct, windowMinutes: 10080, resetsAt: now / 1000 + 86400, observedAt: at, source }] });
  const service = usage.createService({
    claudeReader: { getUsage: async () => ({ daily: [], total: { reqs: 0 }, live: {} }) },
    codexReader: { getUsage: async () => ({ daily: [], limits: [], found: false }) },
    bridge: () => null, liveQuota: async () => ({ grok: { status, limits: remoteLimits } }),
    grokQuota: async () => saved,
  });
  assert.equal((await service.snapshot(now)).providers.length, 2, 'no Grok CLI on this PC: no card');
  saved = { limits: [reading(5, now - 600000, 'local_cache', 'SuperGrok')], observedAt: now - 600000 };
  let p = (await service.snapshot(now + 1)).providers[2];
  assert.equal(p.id, 'grok');
  assert.equal(p.historyUnavailable, true);
  assert.equal(p.periods.today.tokens, 0);
  assert.equal(p.limits[0].windows[0].usedPercent, 5);
  assert.equal(p.connection.source, 'local_cache');
  status = 'ready'; remoteLimits = [reading(7, now, 'provider_api')];
  p = (await service.snapshot(now + 2, { force: true })).providers[2];
  assert.equal(p.limits[0].windows[0].usedPercent, 7, 'the live reading is newer');
  assert.equal(p.limits[0].plan, 'SuperGrok', 'and the plan name comes from the CLI log');
  assert.equal(p.connection.source, 'provider_api');
  saved = null; remoteLimits = []; status = 'sign_in_required';
  p = (await service.snapshot(now + 3, { force: true })).providers[2];
  assert.equal(p.id, 'grok', 'signed in but nothing read yet still shows the card');
  assert.equal(p.connection.liveStatus, 'sign_in_required');
});

test('OpenCode is gone from the live reader and the service', () => {
  const src = fs.readFileSync(new URL('../ai-usage-live.js', import.meta.url), 'utf8')
    + fs.readFileSync(new URL('../ai-usage.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /opencode/i);
});
