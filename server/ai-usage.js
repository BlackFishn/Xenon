'use strict';

// Local, read-only telemetry. Never read auth files or return transcript content.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { localDayKey } = require('./claude-usage')._internal;
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'tokens', 'cost', 'reqs', 'unpriced'];
// Standard short-context API equivalent, USD / million tokens. Subscription bills
// and tool/fast-mode/long-context surcharges are not inferred from transcripts.
// https://developers.openai.com/api/docs/pricing (checked 2026-09-11)
const PRICES = {
  __proto__: null,
  'gpt-6-astra': [10, 1, 12.5, 50],
  'gpt-5.6-sol': [4, 0.4, 5, 20],
  'gpt-5.6-terra': [2, 0.2, 2.5, 12],
  'gpt-5.6-luna': [0.2, 0.02, 0.25, 1.2],
  // Older model pages publish no separate cache-write rate. If one appears in
  // their telemetry, leave that event unpriced instead of inventing a rate.
  'gpt-5.5': [5, 0.5, null, 30],
  'gpt-5.4': [2.5, 0.25, null, 15],
  'gpt-5.3-codex': [1.75, 0.175, null, 14],
};
const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
const label = v => typeof v === 'string' ? v.replace(/[\x00-\x1f]/g, '').slice(0, 80) : '';
const empty = () => Object.fromEntries(FIELDS.map(k => [k, 0]));
function add(target, source) { for (const key of FIELDS) target[key] += number(source[key]); }

function days(now) {
  return Array.from({ length: 30 }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - 29 + i);
    return localDayKey(d.getTime());
  });
}

function quotaWindow(value, at, id, minutes) {
  if (!value || typeof value !== 'object') return null;
  const used = value.used_percent ?? value.usedPercent ?? value.pct;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  return { id, usedPercent: Math.min(100, used),
    windowMinutes: number(value.window_minutes ?? value.windowDurationMins) || minutes,
    resetsAt: number(value.resets_at ?? value.resetsAt), observedAt: at };
}

function normalizeLimits(value, at) {
  if (!value || typeof value !== 'object') return null;
  const id = label(value.limit_id ?? value.limitId) || 'codex';
  const windows = ['primary', 'secondary'].map(key => quotaWindow(value[key], at, id + '-' + key, 0)).filter(Boolean);
  const balance = value.credits && value.credits.balance;
  const parsedBalance = (typeof balance === 'number' || (typeof balance === 'string' && /^\d+(\.\d+)?$/.test(balance))) ? Number(balance) : NaN;
  return { id, name: label(value.limit_name ?? value.limitName) || id,
    plan: label(value.plan_type ?? value.planType), windows,
    credits: value.credits ? { unlimited: value.credits.unlimited === true,
      balance: Number.isFinite(parsedBalance) && parsedBalance >= 0 ? parsedBalance : null } : null,
    observedAt: at };
}

function newSession() {
  return { model: '', previous: null, daily: new Map(), limits: new Map(), offset: 0, lastAt: 0 };
}

function parseLine(line, state) {
  // Most transcript lines contain prompts or tool results; skip without parsing.
  if (!line.includes('"token_count"') && !line.includes('"turn_context"')) return;
  let event;
  try { event = JSON.parse(line); } catch { return; }
  const p = event && event.payload;
  if (!p || typeof p !== 'object') return;
  if (event.type === 'turn_context') { state.model = label(p.model); return; }
  if (event.type !== 'event_msg' || p.type !== 'token_count') return;
  const at = Date.parse(event.timestamp);
  if (!Number.isFinite(at)) return;
  const limits = normalizeLimits(p.rate_limits, at);
  if (limits && (limits.windows.length || limits.credits)) {
    const old = state.limits.get(limits.id);
    if (!old || old.observedAt <= at) state.limits.set(limits.id, limits);
  }
  const total = p.info && p.info.total_token_usage;
  if (!total || typeof total !== 'object') return;
  const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens'];
  if (fields.some(k => total[k] !== undefined && (typeof total[k] !== 'number' || !Number.isFinite(total[k]) || total[k] < 0))) return;
  const current = fields.map(k => number(total[k]));
  // Cumulative counters repeat on quota-only updates. Delta them once per session;
  // a counter reset starts a new segment, while reasoning is already in output.
  const reset = state.previous && (current[0] < state.previous[0] || current[3] < state.previous[3]);
  const delta = current.map((v, i) => Math.max(0, v - (state.previous && !reset ? state.previous[i] : 0)));
  state.previous = current;
  if (!delta.some(Boolean)) return;
  const cacheRead = Math.min(delta[0], delta[1]);
  const cacheWrite = Math.min(delta[0] - cacheRead, delta[2]);
  const input = delta[0] - cacheRead - cacheWrite;
  const modelRate = PRICES[state.model.replace(/-\d{4}-\d{2}-\d{2}$/, '')];
  const rate = modelRate && (!cacheWrite || modelRate[2] !== null) ? modelRate : null;
  const record = { input, cacheRead, cacheWrite, output: delta[3], tokens: delta[0] + delta[3],
    reqs: 1, unpriced: rate ? 0 : 1,
    cost: rate ? (input * rate[0] + cacheRead * rate[1] + cacheWrite * rate[2] + delta[3] * rate[3]) / 1e6 : 0 };
  const day = localDayKey(at);
  const bucket = state.daily.get(day) || { ...empty(), models: new Map() };
  add(bucket, record);
  const model = state.model || 'unknown';
  const modelBucket = bucket.models.get(model) || empty();
  add(modelBucket, record);
  bucket.models.set(model, modelBucket);
  state.daily.set(day, bucket);
  state.lastAt = Math.max(state.lastAt, at);
}

async function sessionFiles(root) {
  const files = [];
  let incomplete = false;
  async function walk(dir, depth) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code !== 'ENOENT') incomplete = true; return; }
    for (const e of entries) {
      // Do not follow symlinks or junctions out of the telemetry directory.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory() && depth < 4) await walk(path.join(dir, e.name), depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(path.join(dir, e.name));
    }
  }
  await walk(path.join(root, 'sessions'), 0);
  await walk(path.join(root, 'archived_sessions'), 0);
  return { files, incomplete };
}

function createCodexReader({ dir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } = {}) {
  const cache = new Map();
  let inflight = null, lastScan = -Infinity, discovered = { files: [], incomplete: false };
  async function read(now, force) {
    if (force || now - lastScan >= 60000) {
      discovered = await sessionFiles(dir);
      lastScan = now;
      const present = new Set(discovered.files);
      for (const key of cache.keys()) if (!present.has(key)) cache.delete(key);
    }
    let incomplete = discovered.incomplete;
    for (const file of discovered.files) {
      try {
        const stat = await fs.promises.lstat(file);
        if (!stat.isFile()) continue;
        let state = cache.get(file);
        if (state && state.size === stat.size && state.mtime === stat.mtimeMs) continue;
        if (!state || stat.size <= state.size) state = newSession();
        // Stream complete lines only: an active writer's partial tail is retried.
        const stream = fs.createReadStream(file, { start: state.offset, end: Math.max(0, stat.size - 1) });
        let pending = Buffer.alloc(0);
        for await (const chunk of stream) {
          pending = Buffer.concat([pending, chunk]);
          let start = 0, end;
          while ((end = pending.indexOf(10, start)) >= 0) {
            parseLine(pending.toString('utf8', start, end), state);
            state.offset += end - start + 1;
            start = end + 1;
          }
          pending = pending.subarray(start);
          if (pending.length > 8 * 1024 * 1024) throw new Error('oversized telemetry line');
        }
        state.size = stat.size;
        state.mtime = stat.mtimeMs;
        state.error = false;
        cache.set(file, state);
      } catch { incomplete = true; const state = cache.get(file); if (state) state.error = true; }
    }
    const daily = new Map(days(now).map(day => [day, { day, ...empty(), models: new Map() }]));
    const limits = new Map();
    let lastAt = 0;
    for (const state of cache.values()) {
      incomplete ||= !!state.error;
      lastAt = Math.max(lastAt, state.lastAt);
      for (const [day, bucket] of state.daily) {
        if (!daily.has(day)) continue;
        const target = daily.get(day);
        add(target, bucket);
        for (const [model, b] of bucket.models) {
          const m = target.models.get(model) || empty();
          add(m, b); target.models.set(model, m);
        }
      }
      for (const [id, limit] of state.limits) {
        if (!limits.has(id) || limits.get(id).observedAt < limit.observedAt) limits.set(id, limit);
      }
    }
    return { daily: Array.from(daily.values(), d => ({ ...d, models: Array.from(d.models, ([model, b]) => ({ model, ...b })) })),
      limits: Array.from(limits.values()), lastAt, incomplete, found: cache.size > 0 };
  }
  return { getUsage(now, { force = false } = {}) {
    if (!inflight) inflight = read(now, force).finally(() => { inflight = null; });
    return inflight;
  } };
}

// Claude Code persists the same account reading shown by /usage here, including
// Team plans whose status-line payload may omit rate_limits. Read only this
// aggregate: never read credentials, refresh tokens, or call a provider API.
function normalizeClaudeQuotaCache(profile, now) {
  const cache = profile && profile.cachedUsageUtilization;
  if (!cache || typeof cache !== 'object' || typeof cache.accountUuid !== 'string' || !cache.accountUuid || cache.accountUuid !== profile.oauthAccount?.accountUuid) return null;
  const at = number(cache.fetchedAtMs);
  if (!at || at > now + 60000) return null;
  const data = cache.utilization;
  if (!data || typeof data !== 'object') return null;
  const windows = [];
  for (const [key, kind, minutes] of [['five_hour', 'session', 300], ['seven_day', 'weekly_all', 10080]]) {
    const old = data[key];
    const modern = Array.isArray(data.limits) ? data.limits.find(w => w && w.kind === kind) : null;
    const raw = old && typeof old.utilization === 'number' ? old : modern;
    if (!raw) continue;
    const reset = typeof raw.resets_at === 'string' ? Date.parse(raw.resets_at) / 1000 : raw.resets_at;
    const window = quotaWindow({ used_percent: raw.utilization ?? raw.percent, resets_at: number(reset) }, at, 'claude-' + kind, minutes);
    if (window) windows.push({ ...window, source: 'local_cache' });
  }
  return windows.length ? { windows, observedAt: at } : null;
}

function createClaudeQuotaReader({ file = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
  : path.join(os.homedir(), '.claude.json') } = {}) {
  return async function readQuota(now) {
    try {
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
      const profile = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      return normalizeClaudeQuotaCache(profile, now);
    } catch { return null; }
  };
}

function summarize(series, dayKeys) {
  const result = { ...empty(), models: [] };
  const models = new Map();
  for (const d of series) {
    if (!dayKeys.includes(d.day)) continue;
    add(result, d);
    for (const m of d.models || []) {
      const b = models.get(m.model) || empty();
      add(b, m); models.set(m.model, b);
    }
  }
  result.models = Array.from(models, ([model, b]) => ({ model, ...b })).sort((a, b) => b.tokens - a.tokens);
  return result;
}

function provider(id, daily, limits, now, extra = {}) {
  const keys = days(now);
  return { id, daily, limits, ...extra, periods: {
    today: summarize(daily, keys.slice(-1)), yesterday: summarize(daily, keys.slice(-2, -1)),
    month: summarize(daily, keys),
  } };
}

function createService({ claudeReader, bridge, connection = async () => ({}), quotaCache = async () => null, liveQuota = async () => ({}), codexReader = createCodexReader() }) {
  let cached = null, inflight = null, inflightForced = false;
  return { async snapshot(now, { force = false } = {}) {
    if (force && inflight && !inflightForced) await inflight;
    const scanned = force || !cached || now - cached.generatedAt >= 20000;
    if (scanned) {
      if (!inflight) {
        inflightForced = force;
        inflight = Promise.all([claudeReader.getUsage(now, { force }), codexReader.getUsage(now, { force })]).then(([claude, codex]) => {
          cached = { generatedAt: now, claude, codex };
        }).finally(() => { inflight = null; inflightForced = false; });
      }
      await inflight;
    }
    const [link, savedQuota, remote] = await Promise.all([
      connection().catch(() => ({ unavailable: true })),
      quotaCache(now).catch(() => null),
      liveQuota({ force }).catch(() => ({})),
    ]);
    const live = bridge();
    const limit = live && live.limits;
    const reported = limit ? [quotaWindow(limit.fiveHour, limit.at, 'claude-session', 300),
      quotaWindow(limit.sevenDay, limit.at, 'claude-weekly', 10080)].filter(Boolean) : [];
    const byDuration = new Map();
    for (const w of [...(savedQuota?.windows || []), ...reported, ...(remote.claude?.limits || []).flatMap(l => l.windows)]) {
      const previous = byDuration.get(w.windowMinutes);
      if (!previous || previous.observedAt <= w.observedAt) byDuration.set(w.windowMinutes, w);
    }
    const windows = Array.from(byDuration.values());
    const observedAt = Math.max(0, ...windows.map(w => w.observedAt));
    const quotaSource = windows.some(w => w.source === 'provider_api') ? 'provider_api' : windows.some(w => w.source === 'local_cache') ? 'local_cache' : 'statusline';
    const c = cached.claude, x = cached.codex;
    return { generatedAt: cached.generatedAt, checkedAt: now, refresh: { cached: !scanned, forced: force }, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      providers: [provider('claude', c.daily || [], windows.length ? [{ id: 'claude', windows, observedAt }] : [], now,
        { found: c.total.reqs > 0, lastAt: c.live.at, incomplete: false,
          connection: { status: windows.length ? 'ready' : link.unavailable ? 'unavailable' : link.usageLinked ? 'waiting' : 'not_linked', source: windows.length ? quotaSource : null, liveStatus: remote.claude?.status } }),
      provider('codex', x.daily, remote.codex?.limits?.length ? remote.codex.limits : x.limits, now, { found: x.found, lastAt: x.lastAt, incomplete: x.incomplete,
        connection: { source: remote.codex?.limits?.length ? 'provider_api' : 'local_history', liveStatus: remote.codex?.status } }),
      ...(remote.opencode && remote.opencode.status !== 'not_signed_in' ? [
        provider('opencode', [], remote.opencode.limits || [], now, {
          found: true, historyUnavailable: true, incomplete: false,
          connection: { source: remote.opencode.limits?.length ? 'provider_api' : null, liveStatus: remote.opencode.status },
        }),
      ] : [])] };
  } };
}

module.exports = { createService, createCodexReader, createClaudeQuotaReader, _internal: { parseLine, newSession, normalizeLimits, normalizeClaudeQuotaCache, summarize, days } };
