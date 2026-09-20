'use strict';

// Provider protocol reference: robinebers/openusage (MIT); see docs/ai-usage-widget.md.
// Credentials stay in this backend. Never rotate shared refresh tokens: the owning
// CLI/app renews them, avoiding invalidating a concurrent coding session.
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { normalizeLimits, normalizeClaudeQuotaCache } = require('./ai-usage')._internal;
const URLS = Object.freeze({
  claude: 'https://api.anthropic.com/api/oauth/usage',
  codex: 'https://chatgpt.com/backend-api/wham/usage',
  opencode: 'https://opencode.ai/zen/go/v1/usage',
});
const clean = value => typeof value === 'string' && value.length <= 16384 && !/[\x00-\x20\x7f]/.test(value) ? value : '';
const positive = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

async function readJson(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch { return null; }
}

function createCredentialsReader({
  codexDir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  opencodeDir = process.env.OPENCODE_DATA_DIR || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode'),
  claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
} = {}) {
  return async id => {
    if (id === 'opencode') {
      const data = await readJson(path.join(opencodeDir, 'auth.json'));
      const token = clean(data?.['opencode-go']?.key);
      return token ? { token, account: '', expiresAt: 0 } : null;
    }
    const data = await readJson(path.join(id === 'claude' ? claudeDir : codexDir,
      id === 'claude' ? '.credentials.json' : 'auth.json'));
    const auth = id === 'claude' ? data?.claudeAiOauth : data?.tokens;
    const token = clean(id === 'claude' ? auth?.accessToken : auth?.access_token);
    if (!token) return null; // API keys are not subscription logins.
    return { token, account: id === 'codex' ? clean(auth.account_id) : '',
      expiresAt: id === 'claude' ? positive(auth.expiresAt) : 0 };
  };
}

function mapUsage(id, body, now) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  if (id === 'opencode') {
    const windows = [['rolling', 300], ['weekly', 10080], ['monthly', 43200]].flatMap(([key, minutes]) => {
      const raw = body.usage?.[key];
      if (!raw || typeof raw.percent !== 'number' || !Number.isFinite(raw.percent) || raw.percent < 0) return [];
      return [{ id: 'opencode-' + key, usedPercent: Math.min(100, raw.percent), windowMinutes: minutes,
        resetsAt: typeof raw.resetsAt === 'string' ? positive(Date.parse(raw.resetsAt) / 1000) : 0,
        observedAt: now, source: 'provider_api' }];
    });
    return windows.length ? [{ id: 'opencode', name: 'OpenCode Go', plan: 'Go', windows, observedAt: now }] : [];
  }
  if (id === 'claude') {
    const quota = normalizeClaudeQuotaCache({ oauthAccount: { accountUuid: 'current' },
      cachedUsageUtilization: { accountUuid: 'current', fetchedAtMs: now, utilization: body } }, now);
    return quota ? [{ id: 'claude', observedAt: now,
      windows: quota.windows.map(w => ({ ...w, source: 'provider_api' })) }] : [];
  }
  function bucket(raw, id, name, main = false) {
    const win = (w, minutes) => w && ({
      used_percent: w.used_percent,
      window_minutes: positive(w.limit_window_seconds) / 60 || minutes,
      resets_at: positive(w.reset_at) || (positive(w.reset_after_seconds) ? now / 1000 + w.reset_after_seconds : 0),
    });
    return normalizeLimits({ limit_id: id, limit_name: name,
      plan_type: main ? body.plan_type : undefined, credits: main ? body.credits : undefined,
      primary: win(raw?.primary_window, 300), secondary: win(raw?.secondary_window, 10080) }, now);
  }
  const result = [bucket(body.rate_limit, 'codex', 'Codex', true)];
  for (const [index, extra] of (Array.isArray(body.additional_rate_limits) ? body.additional_rate_limits.slice(0, 32) : []).entries()) {
    if (extra && typeof extra === 'object') result.push(bucket(extra.rate_limit,
      'codex-extra-' + index, extra.limit_name || extra.metered_feature));
  }
  return result.filter(b => b.windows.length || b.credits);
}

function createLiveQuotaReader({ credentials = createCredentialsReader(), fetchImpl = globalThis.fetch,
  clock = Date.now } = {}) {
  const states = new Map();
  async function read(id, force) {
    const now = clock();
    let auth;
    try { auth = await credentials(id); } catch { /* No credential details leave this module. */ }
    if (!auth?.token) { states.delete(id); return { status: 'not_signed_in', limits: [] }; }
    const key = createHash('sha256').update(auth.token + '\n' + (auth.account || '')).digest('hex');
    let state = states.get(id);
    if (!state || state.key !== key) {
      state = { key, limits: [], nextAt: 0, cooldown: 0, lastAttempt: -Infinity, status: 'waiting' };
      states.set(id, state);
    }
    if (state.pending) return state.pending;
    const result = () => ({ status: state.status, limits: state.limits, retryAt: state.nextAt });
    if (now < state.cooldown || now - state.lastAttempt < 10000 || (!force && now < state.nextAt)) return result();
    if (auth.expiresAt && auth.expiresAt <= now) {
      state.status = 'sign_in_required';
      return result();
    }
    state.pending = (async () => {
      state.lastAttempt = now;
      state.nextAt = now + 300000;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const headers = { Authorization: 'Bearer ' + auth.token, Accept: 'application/json' };
        if (id === 'claude') headers['anthropic-beta'] = 'oauth-2025-04-20';
        if (id === 'codex' && auth.account) headers['ChatGPT-Account-Id'] = auth.account;
        const response = await fetchImpl(URLS[id], { method: 'GET', headers,
          redirect: 'error', signal: controller.signal });
        if (!response.ok) {
          state.status = response.status === 401 || response.status === 403 ? 'sign_in_required'
            : response.status === 429 ? 'rate_limited' : 'unavailable';
          if (response.status === 429) {
            const retry = response.headers.get('retry-after');
            const duration = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now;
            state.cooldown = now + Math.max(300000, Number.isFinite(duration) ? duration : 0);
            state.nextAt = state.cooldown;
          } else state.cooldown = state.nextAt;
          await response.body?.cancel();
          return result();
        }
        // Bound response memory even when content-length is missing or incorrect.
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 1024 * 1024) throw new Error('oversized response');
          chunks.push(Buffer.from(chunk));
        }
        const limits = mapUsage(id, JSON.parse(Buffer.concat(chunks).toString('utf8')), clock());
        if (!limits.length) throw new Error('no quota');
        // A sign-out/account change while awaiting the network invalidates this result.
        const current = await credentials(id);
        if (!current || current.token !== auth.token || current.account !== auth.account) {
          if (states.get(id) === state) states.delete(id);
          return { status: 'account_changed', limits: [] };
        }
        state.limits = limits;
        state.status = 'ready';
      } catch {
        state.status = 'unavailable';
        state.cooldown = state.nextAt;
      } finally {
        clearTimeout(timeout);
      }
      return result();
    })().finally(() => { state.pending = null; });
    return state.pending;
  }
  return async ({ force = false } = {}) => {
    const entries = await Promise.all(Object.keys(URLS).map(async id => [id, await read(id, force)]));
    return Object.fromEntries(entries);
  };
}

module.exports = { createLiveQuotaReader, createCredentialsReader, _internal: { mapUsage } };
