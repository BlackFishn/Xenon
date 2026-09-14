import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import usage from '../ai-usage.js';
import claude from '../claude-usage.js';

const { parseLine, newSession, normalizeLimits, days } = usage._internal;
const now = new Date(2026, 8, 11, 12).getTime();
const context = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-astra' } });
function event(input, output, options = {}) {
  return JSON.stringify({ type: 'event_msg', timestamp: new Date(options.at || now).toISOString(), payload: {
    type: 'token_count', info: input === null ? null : { total_token_usage: {
      input_tokens: input, cached_input_tokens: options.cache || 0, cache_write_input_tokens: options.write || 0,
      output_tokens: output, reasoning_output_tokens: 80, total_tokens: input + output,
    } }, rate_limits: options.limits,
  } });
}
const limits = { limit_id: 'codex', plan_type: 'pro', primary: { used_percent: 22, window_minutes: 10080, resets_at: now / 1000 + 3600 },
  credits: { balance: '0', unlimited: false }, secret: 'DO_NOT_EXPOSE' };

test('Codex cumulative snapshots count once, cache is a subset, reasoning is not added twice', () => {
  const state = newSession();
  for (const line of [context, event(1000, 100, { cache: 800 }), event(1000, 100, { cache: 800 }),
    event(1500, 200, { cache: 1000, write: 100 })]) parseLine(line, state);
  const day = [...state.daily.values()][0];
  assert.equal(day.tokens, 1700);
  assert.equal(day.input, 400);
  assert.equal(day.cacheRead, 1000);
  assert.equal(day.cacheWrite, 100);
  assert.equal(day.output, 200);
  assert.equal(day.reqs, 2);
  assert.ok(Math.abs(day.cost - 0.01625) < 1e-9);
});

test('counter resets start a new segment; malformed, negative and nonnumeric data are ignored', () => {
  const state = newSession();
  for (const line of [context, event(1000, 100), event(100, 20), event(-1, 4), event('200', 4), '{"token_count":', 'null']) parseLine(line, state);
  const day = [...state.daily.values()][0];
  assert.equal(day.tokens, 1220);
  assert.equal(day.reqs, 2);
});

test('unknown models retain tokens and explicitly leave cost unpriced', () => {
  const state = newSession();
  parseLine(event(1000, 100), state);
  const day = [...state.daily.values()][0];
  assert.equal(day.tokens, 1100);
  assert.equal(day.cost, 0);
  assert.equal(day.unpriced, 1);
  const suspicious = newSession();
  parseLine(JSON.stringify({ type: 'turn_context', payload: { model: '__proto__' } }), suspicious);
  parseLine(event(1000, 100), suspicious);
  assert.equal([...suspicious.daily.values()][0].unpriced, 1);
});

test('rate-limit telemetry is allowlisted, weekly primary stays weekly, zero credits stay zero', () => {
  const out = normalizeLimits(limits, now);
  assert.equal(out.windows[0].windowMinutes, 10080);
  assert.equal(out.windows[0].usedPercent, 22);
  assert.equal(out.credits.balance, 0);
  assert.equal(out.plan, 'pro');
  assert.ok(!JSON.stringify(out).includes('DO_NOT_EXPOSE'));
  for (const used_percent of [null, '', '22', -1, Infinity]) {
    assert.equal(normalizeLimits({ primary: { used_percent } }, now).windows.length, 0);
  }
});

test('quota-only events and additional buckets survive without fabricated token activity', () => {
  const state = newSession();
  parseLine(event(null, null, { limits }), state);
  parseLine(event(null, null, { limits: { ...limits, limit_id: 'codex_spark', primary: { used_percent: 0, window_minutes: 300 } } }), state);
  assert.equal(state.daily.size, 0);
  assert.equal(state.limits.size, 2);
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'xenon-ai-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionDir = join(dir, 'sessions', '2026', '09', '11');
  await mkdir(sessionDir, { recursive: true });
  return { dir, file: join(sessionDir, 'rollout-test.jsonl') };
}

test('reader coalesces reads, retries partial lines, detects rewrites and archived moves', async t => {
  const { dir, file } = await fixture(t);
  const row = event(1000, 100, { limits });
  await writeFile(file, context + '\n' + row.slice(0, 60));
  const reader = usage.createCodexReader({ dir });
  const first = await reader.getUsage(now);
  assert.equal(first.daily.at(-1).tokens, 0);
  await appendFile(file, row.slice(60) + '\n');
  const [a, b] = await Promise.all([reader.getUsage(now + 1), reader.getUsage(now + 1)]);
  assert.equal(a.daily.at(-1).tokens, 1100);
  assert.deepEqual(a, b);
  await appendFile(file, event(1500, 200) + '\n');
  assert.equal((await reader.getUsage(now + 2)).daily.at(-1).tokens, 1700);
  await writeFile(file, context + '\n' + event(10, 2) + '\n');
  assert.equal((await reader.getUsage(now + 3)).daily.at(-1).tokens, 12);
  await mkdir(join(dir, 'archived_sessions'));
  await rename(file, join(dir, 'archived_sessions', 'rollout-test.jsonl'));
  assert.equal((await reader.getUsage(now + 60001)).daily.at(-1).tokens, 12);
});

test('missing folders are an honest empty state and browser payload excludes prompts/paths', async t => {
  const { dir, file } = await fixture(t);
  await writeFile(file, JSON.stringify({ type: 'response_item', payload: { content: 'PRIVATE PROMPT' } }) + '\n' + context + '\n' + event(10, 2, { limits }) + '\n');
  const out = await usage.createCodexReader({ dir }).getUsage(now);
  assert.equal(out.found, true);
  assert.ok(!JSON.stringify(out).includes('PRIVATE'));
  assert.ok(!JSON.stringify(out).includes(dir));
  const missing = await usage.createCodexReader({ dir: join(dir, 'missing') }).getUsage(now);
  assert.equal(missing.found, false);
  assert.equal(missing.daily.length, 30);
});

test('periods separate local today, yesterday and last 30 days; model details follow the filter', () => {
  const key = days(now);
  const series = [{ day: key.at(-1), tokens: 10, cost: 1, models: [{ model: 'a', tokens: 10, cost: 1 }] },
    { day: key.at(-2), tokens: 20, cost: 2, models: [{ model: 'b', tokens: 20, cost: 2 }] }];
  assert.equal(usage._internal.summarize(series, key.slice(-1)).cost, 1);
  assert.equal(usage._internal.summarize(series, key.slice(-2, -1)).models[0].model, 'b');
  assert.equal(usage._internal.summarize(series, key).tokens, 30);
  assert.equal(new Set(days(new Date(2026, 10, 5).getTime())).size, 30);
});

test('Claude exposes daily cost and token details from the existing deduplicated records', () => {
  const cache = new Map([['session', { records: [
    { t: now, in: 100, out: 10, cc: 20, cr: 30, model: 'claude-sonnet-5', proj: 'test' },
    { t: now - 86400000, in: 200, out: 10, cc: 0, cr: 0, model: 'claude-opus-5', proj: 'test' },
  ], meta: null }]]);
  const out = claude._internal.aggregate(cache, now);
  assert.equal(out.daily.at(-1).tokens, 160);
  assert.equal(out.daily.at(-1).input, 100);
  assert.equal(out.daily.at(-1).models[0].model, 'claude-sonnet-5');
  assert.equal(out.daily.at(-2).models[0].model, 'claude-opus-5');
  assert.equal(out.daily.at(-1).cost, 0.000356);
});

test('service shares in-flight scans but always reads fresh bridge limits without exposing sessions', async () => {
  let reads = 0, pct = 5;
  const service = usage.createService({
    claudeReader: { async getUsage() { reads++; return { daily: [], total: { reqs: 1 }, live: { at: now }, sessions: [{ prompt: 'SECRET' }] }; } },
    codexReader: { async getUsage() { return { daily: [], limits: [], found: false, lastAt: 0 }; } },
    bridge: () => ({ limits: { at: now, fiveHour: { pct, resetsAt: now / 1000 + 100 } }, secret: 'SECRET' }),
  });
  await Promise.all([service.snapshot(now), service.snapshot(now)]);
  assert.equal(reads, 1);
  pct = 40;
  const result = await service.snapshot(now + 1);
  assert.equal(result.providers[0].limits[0].windows[0].usedPercent, 40);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});


test('manual refresh bypasses the history cache and coalesces concurrent forced scans', async () => {
  const calls = [];
  const service = usage.createService({
    claudeReader: { async getUsage(at, options) { calls.push(['claude', options.force]); return { daily: [], total: { reqs: 0 }, live: { at: 0 } }; } },
    codexReader: { async getUsage(at, options) { calls.push(['codex', options.force]); return { daily: [], limits: [], found: false, lastAt: 0 }; } },
    bridge: () => ({}),
  });
  assert.equal((await service.snapshot(now)).refresh.cached, false);
  const cached = await service.snapshot(now + 1);
  assert.equal(cached.refresh.cached, true);
  assert.equal(cached.checkedAt, now + 1);
  assert.equal(cached.generatedAt, now);
  const [a, b] = await Promise.all([service.snapshot(now + 2, { force: true }), service.snapshot(now + 2, { force: true })]);
  assert.deepEqual(calls, [['claude', false], ['codex', false], ['claude', true], ['codex', true]]);
  assert.equal(a.refresh.cached, false);
  assert.equal(a.refresh.forced, true);
  assert.equal(b.generatedAt, now + 2);
});

test('connection diagnostics distinguish setup, waiting, and live quotas without leaking settings', async () => {
  let linked = false, report = null, broken = false;
  const service = usage.createService({
    claudeReader: { async getUsage() { return { daily: [], total: { reqs: 0 }, live: { at: 0 } }; } },
    codexReader: { async getUsage() { return { daily: [], limits: [], found: false, lastAt: 0 }; } },
    bridge: () => ({ limits: report }),
    connection: async () => { if (broken) throw new Error('SECRET'); return { usageLinked: linked, settingsPath: 'SECRET', chained: 'SECRET' }; },
  });
  const status = async () => (await service.snapshot(now)).providers[0].connection.status;
  assert.equal(await status(), 'not_linked');
  linked = true;
  assert.equal(await status(), 'waiting');
  broken = true;
  assert.equal(await status(), 'unavailable');
  report = { at: now, fiveHour: { pct: 0, resetsAt: now / 1000 + 1000 }, sevenDay: { pct: 35, resetsAt: now / 1000 + 2000 } };
  assert.equal(await status(), 'ready');
  const result = await service.snapshot(now);
  assert.deepEqual(result.providers[0].limits[0].windows.map(w => w.usedPercent), [0, 35]);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('forced Codex scan discovers a new session inside the normal one-minute scan interval', async t => {
  const { dir, file } = await fixture(t);
  await writeFile(file, context + '\n' + event(100, 10) + '\n');
  const reader = usage.createCodexReader({ dir });
  assert.equal((await reader.getUsage(now)).daily.at(-1).tokens, 110);
  await writeFile(file.replace('.jsonl', '-new.jsonl'), context + '\n' + event(200, 20) + '\n');
  assert.equal((await reader.getUsage(now + 1)).daily.at(-1).tokens, 110);
  assert.equal((await reader.getUsage(now + 2, { force: true })).daily.at(-1).tokens, 330);
});


function accountQuotaProfile(at = now) {
  return { oauthAccount: { accountUuid: 'account-one', emailAddress: 'PRIVATE' }, cachedUsageUtilization: {
    fetchedAtMs: at, accountUuid: 'account-one', utilization: {
      five_hour: { utilization: 0, resets_at: new Date(now + 3600000).toISOString() },
      seven_day: { utilization: 35, resets_at: new Date(now + 86400000).toISOString() },
    },
  }, projects: { private: 'PRIVATE' } };
}

test('Claude account cache supplies zero session use and Team weekly quota without a status line', () => {
  const result = usage._internal.normalizeClaudeQuotaCache(accountQuotaProfile(), now);
  assert.deepEqual(result.windows.map(w => [w.windowMinutes, w.usedPercent]), [[300, 0], [10080, 35]]);
  assert.equal(result.windows[0].resetsAt, (now + 3600000) / 1000);
  assert.equal(result.windows[0].observedAt, now);
  assert.equal(result.windows[0].source, 'local_cache');
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.ok(!JSON.stringify(result).includes('account-one'));
});

test('Claude quota cache validates account, timestamp and numbers, and supports typed quota windows', () => {
  const normalize = usage._internal.normalizeClaudeQuotaCache;
  const profile = accountQuotaProfile();
  profile.cachedUsageUtilization.accountUuid = 'old-account';
  assert.equal(normalize(profile, now), null);
  profile.cachedUsageUtilization.accountUuid = 'account-one';
  profile.cachedUsageUtilization.fetchedAtMs = now + 120000;
  assert.equal(normalize(profile, now), null);
  profile.cachedUsageUtilization.fetchedAtMs = now;
  profile.cachedUsageUtilization.utilization = { five_hour: { utilization: '35' }, seven_day: { utilization: -1 } };
  assert.equal(normalize(profile, now), null);
  profile.cachedUsageUtilization.utilization = { limits: [
    { kind: 'session', percent: 0, resets_at: new Date(now + 3600000).toISOString() },
    { kind: 'weekly_scoped', percent: 99 },
    { kind: 'weekly_all', percent: 35, resets_at: new Date(now + 86400000).toISOString() },
  ] };
  assert.deepEqual(normalize(profile, now).windows.map(w => w.usedPercent), [0, 35]);
});

test('offline quota reader refreshes saved reports and safely handles missing or damaged files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xenon-quota-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, '.claude.json');
  const read = usage.createClaudeQuotaReader({ file });
  assert.equal(await read(now), null);
  await writeFile(file, JSON.stringify(accountQuotaProfile()));
  assert.equal((await read(now)).windows[1].usedPercent, 35);
  const next = accountQuotaProfile(now + 1);
  next.cachedUsageUtilization.utilization.seven_day.utilization = 36;
  await writeFile(file, JSON.stringify(next));
  assert.equal((await read(now + 2)).windows[1].usedPercent, 36);
  await writeFile(file, '{invalid');
  assert.equal(await read(now + 3), null);
});

test('service chooses the latest quota per window and rereads the Claude cache on history cache hits', async () => {
  let cachedAt = now, reads = 0;
  const service = usage.createService({
    claudeReader: { async getUsage() { return { daily: [], total: { reqs: 0 }, live: { at: 0 } }; } },
    codexReader: { async getUsage() { return { daily: [], limits: [], found: false, lastAt: 0 }; } },
    bridge: () => ({ limits: { at: now + 1, fiveHour: { pct: 7, resetsAt: now / 1000 + 2000 } } }),
    quotaCache: async at => { reads++; return usage._internal.normalizeClaudeQuotaCache(accountQuotaProfile(cachedAt), at); },
  });
  const first = await service.snapshot(now + 2);
  assert.equal(first.providers[0].connection.status, 'ready');
  assert.deepEqual(first.providers[0].limits[0].windows.map(w => w.usedPercent), [7, 35]);
  cachedAt = now + 3;
  const next = await service.snapshot(now + 4);
  assert.equal(next.refresh.cached, true);
  assert.equal(reads, 2);
  assert.deepEqual(next.providers[0].limits[0].windows.map(w => w.usedPercent), [0, 35]);
  assert.equal(next.providers[0].limits[0].observedAt, now + 3);
  assert.ok(!JSON.stringify(next).includes('PRIVATE'));
});
