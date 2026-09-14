'use strict';

// ChatGPT subscription access uses the official Codex app-server protocol.
// Codex owns OAuth and refresh tokens in a separate Xenon profile. No token is
// read by Xenon or sent to the dashboard. No API billing fallback is used.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const aiLocal = require('./ai-local');
const { sanitizeModel } = require('./ai-openai');

function chatgptError(message, code = 'chatgpt_error') {
  return Object.assign(new Error(message), { code });
}

function findCodexExecutable({ platform = process.platform, arch: cpuArch = process.arch, env = process.env } = {}) {
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  if (platform === 'win32' && env.APPDATA) dirs.unshift(path.join(env.APPDATA, 'npm'));
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[cpuArch];
  const target = { win32: 'pc-windows-msvc', darwin: 'apple-darwin', linux: 'unknown-linux-musl' }[platform];
  for (const dir of dirs) {
    const direct = path.join(dir, exe);
    if (fs.existsSync(direct)) {
      const real = fs.realpathSync(direct);
      // npm's Unix shim is JS; resolve its native package below instead.
      if (!real.endsWith('.js')) return real;
    }
    if (!arch || !target) continue;
    const roots = [path.join(dir, 'node_modules'), path.resolve(dir, '../lib/node_modules')];
    roots.push(...roots.map(root => path.join(root, '@openai', 'codex', 'node_modules')));
    for (const root of roots) {
      for (const pkg of ['codex-' + platform + '-' + cpuArch, 'codex']) {
        for (const binDir of ['bin', 'codex']) {
          const candidate = path.join(root, '@openai', pkg, 'vendor', arch + '-' + target, binDir, exe);
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    }
  }
  throw chatgptError('Install or update Codex CLI (npm install -g @openai/codex), then restart Xenon.', 'codex_missing');
}

function safeAuthUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol === 'https:' && !u.username && !u.password && !u.port
        && ['auth.openai.com', 'chatgpt.com', 'auth.chatgpt.com'].includes(u.hostname)) return u.href;
  } catch { /* invalid URL */ }
  throw chatgptError('Codex returned an invalid sign-in link. Update Codex CLI and try again.');
}

// These overrides also apply to thread/start. Environment tools are disabled,
// and all server-side approval requests are refused: only Xenon's dynamic tools
// may perform actions, through its existing allowlists and executeAiTool gates.
const CODEX_CONFIG = Object.freeze({
  model_provider: 'openai', forced_login_method: 'chatgpt',
  cli_auth_credentials_store: 'file', approval_policy: 'never', sandbox_mode: 'read-only',
  'features.shell_tool': false, 'features.unified_exec': false,
  'features.apply_patch_freeform': false, 'features.apps': false,
  'features.image_generation': false, 'features.multi_agent': false,
  'agents.enabled': false, web_search: 'disabled',
  project_doc_max_bytes: 0, 'history.persistence': 'none',
});

function createClient({ profileDir = path.join(__dirname, 'data', 'chatgpt'), spawnProcess = spawn,
  executable = findCodexExecutable, requestTimeoutMs = 30000, turnTimeoutMs = 180000 } = {}) {
  let child = null, starting = null, nextId = 0, login = null, loginError = '';
  const pending = new Map();
  const turns = new Map();

  function stop(error = chatgptError('ChatGPT connection closed. Please retry.')) {
    const proc = child;
    child = null;
    login = null;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
    for (const turn of turns.values()) turn.reject(error);
    turns.clear();
    if (proc) { proc.stdin.destroy(); proc.kill(); }
  }

  function send(message) {
    if (!child) throw chatgptError('ChatGPT is not connected.');
    child.stdin.write(JSON.stringify(message) + '\n');
  }

  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => stop(chatgptError('ChatGPT request timed out. Please retry.', 'timeout')), requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { send({ id, method, params }); }
      catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  async function onMessage(msg, proc) {
    if (child !== proc) return;
    if (msg.method && msg.id !== undefined) {
      const p = msg.params || {};
      const turn = turns.get(p.threadId);
      if (msg.method !== 'item/tool/call' || !turn || !turn.allowed.has(p.tool)
          || (p.namespace != null && p.namespace !== '') || ++turn.calls > 40
          || !p.arguments || typeof p.arguments !== 'object' || Array.isArray(p.arguments)) {
        send({ id: msg.id, error: { code: -32601, message: 'This action is not available in Xenon.' } });
        return;
      }
      let result;
      try {
        const { fnResult, clientActions, pendingScreenImage } = await turn.executeTool(p.tool, p.arguments);
        turn.actions.push(...(clientActions || []));
        const contentItems = [{ type: 'inputText', text: JSON.stringify(fnResult ?? {}) }];
        if (pendingScreenImage) contentItems.push({ type: 'inputImage', imageUrl: 'data:image/jpeg;base64,' + pendingScreenImage });
        result = { success: true, contentItems };
      } catch {
        result = { success: false, contentItems: [{ type: 'inputText', text: 'The Xenon action failed.' }] };
      }
      if (child === proc && turns.get(p.threadId) === turn) send({ id: msg.id, result });
      return;
    }
    if (msg.id !== undefined) {
      const item = pending.get(msg.id);
      if (!item) return;
      pending.delete(msg.id);
      clearTimeout(item.timer);
      // Protocol errors can contain request/credential details. Keep them server-only.
      if (msg.error) item.reject(chatgptError('Codex could not complete the request. Check your sign-in, quota and model, or update Codex CLI.'));
      else item.resolve(msg.result);
      return;
    }
    const p = msg.params || {};
    if (msg.method === 'account/login/completed' && login && p.loginId === login.loginId) {
      login = null;
      loginError = p.success ? '' : 'ChatGPT sign-in failed or was cancelled. Please try again.';
    }
    const turn = turns.get(p.threadId);
    if (!turn) return;
    if (msg.method === 'item/completed' && p.item?.type === 'agentMessage') {
      if (p.item.phase === 'final_answer' || p.item.phase == null) turn.text = p.item.text || '';
    }
    if (msg.method === 'turn/completed') {
      if (p.turn?.status === 'completed') turn.resolve(turn.text);
      else turn.reject(chatgptError('ChatGPT could not finish this reply. Check your subscription quota and selected model, then retry.'));
    }
  }

  async function start() {
    if (starting) return starting;
    if (child) return;
    starting = (async () => {
      const command = executable();
      await fs.promises.mkdir(profileDir, { recursive: true, mode: 0o700 });
      // Do not inherit Codex app/session metadata, API keys, or user MCP hooks.
      const env = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (!/^(CODEX_|OPENAI_|CHATGPT_)/i.test(key)) env[key] = value;
      }
      env.CODEX_HOME = profileDir;
      const args = ['app-server', '--listen', 'stdio://'];
      for (const [key, value] of Object.entries(CODEX_CONFIG)) args.push('-c', key + '=' + JSON.stringify(value));
      const proc = spawnProcess(command, args, { cwd: profileDir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
      child = proc;
      proc.on('error', () => { if (child === proc) stop(chatgptError('Codex could not start. Install or update Codex CLI, then restart Xenon.', 'codex_missing')); });
      proc.on('exit', () => { if (child === proc) stop(); });
      proc.stdin.on('error', () => { if (child === proc) stop(); });
      let buffer = '';
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 16 * 1024 * 1024) { stop(); return; }
        let pos;
        while ((pos = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
          if (!line.trim()) continue;
          try { onMessage(JSON.parse(line), proc).catch(() => { if (child === proc) stop(); }); }
          catch { stop(chatgptError('Invalid Codex response. Update Codex CLI and retry.')); return; }
        }
      });
      const initialized = await request('initialize', { clientInfo: { name: 'xenon_ai', title: 'Xenon AI', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      const version = /^[^/]+[/]([0-9]+)[.]([0-9]+)[.]([0-9]+)/.exec(initialized?.userAgent || '');
      if (!version || (Number(version[1]) === 0 && (Number(version[2]) < 153 || (Number(version[2]) === 153 && Number(version[3]) < 4)))) {
        throw chatgptError('Update Codex CLI to 0.153.4 or newer, then restart Xenon.', 'codex_version');
      }
      send({ method: 'initialized', params: {} });
    })();
    try { await starting; } catch (e) { stop(e); throw e; } finally { starting = null; }
  }

  async function status() {
    try {
      await start();
      const { account } = await request('account/read', { refreshToken: false });
      const connected = account?.type === 'chatgpt';
      return { available: true, connected, email: connected ? String(account.email || '').slice(0, 254) : '',
        plan: connected ? String(account.planType || '').slice(0, 40) : '', pending: !!login, error: loginError };
    } catch (e) { return { available: false, connected: false, pending: false, error: e.message, code: e.code }; }
  }

  async function loginStart() {
    await start();
    if (login) return { authUrl: login.authUrl };
    loginError = '';
    const result = await request('account/login/start', { type: 'chatgpt' });
    login = { loginId: result.loginId, authUrl: safeAuthUrl(result.authUrl) };
    return { authUrl: login.authUrl };
  }

  async function logout() {
    await start();
    if (turns.size) throw chatgptError('Wait for the current ChatGPT reply before disconnecting.');
    if (login) await request('account/login/cancel', { loginId: login.loginId });
    await request('account/logout');
    login = null; loginError = '';
    return { ok: true };
  }

  async function catalog(stored = 'auto') {
    const account = await status();
    if (!account.connected) return { models: [], roles: { chat: { kind: 'chat' } }, resolved: {}, error: account.error };
    const models = [];
    let cursor = null;
    do {
      const result = await request('model/list', { cursor, limit: 100, includeHidden: false });
      for (const m of result.data || []) {
        if (typeof m.model === 'string' && m.model.length <= 60) models.push({ id: m.model, label: String(m.displayName || m.model), kind: 'chat', family: '', isDefault: m.isDefault === true });
      }
      cursor = result.nextCursor || null;
    } while (cursor && models.length < 500);
    const pinned = sanitizeModel(stored);
    return { models, roles: { chat: { kind: 'chat' } }, resolved: { chat: pinned.startsWith('auto') ? (models.find(m => m.isDefault)?.id || '') : pinned } };
  }

  async function chat({ model, geminiTools = [], history = [], systemText = '', executeTool = async () => ({}) }) {
    const account = await status();
    if (!account.connected) throw chatgptError(account.error || 'Sign in with ChatGPT in Settings → Xenon AI.', 'chatgpt_signin');
    const tools = aiLocal.geminiToolsToOpenAI(geminiTools).map(({ function: fn }) => ({
      type: 'function', name: fn.name, description: fn.description || '', inputSchema: fn.parameters,
    }));
    const chosen = sanitizeModel(model);
    const { thread } = await request('thread/start', {
      model: chosen.startsWith('auto') ? null : chosen, modelProvider: 'openai',
      cwd: profileDir, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
      environments: [], baseInstructions: systemText, config: CODEX_CONFIG, dynamicTools: tools,
    });
    let timer;
    const turn = { text: '', calls: 0, actions: [], allowed: new Set(tools.map(t => t.name)), executeTool };
    const completion = new Promise((resolve, reject) => { turn.resolve = resolve; turn.reject = reject; });
    // Attach immediately: an app-server exit can precede turn/start's response.
    completion.catch(() => {});
    turns.set(thread.id, turn);
    timer = setTimeout(() => stop(chatgptError('ChatGPT reply timed out. Please retry.', 'timeout')), turnTimeoutMs);
    try {
      // Xenon already owns history. Start an ephemeral Codex thread per request
      // so different dashboard clients and background summaries cannot mix.
      const input = [];
      for (const msg of aiLocal.geminiHistoryToOpenAI(history, { supportsVision: true })) {
        input.push({ type: 'text', text: '\n' + (msg.role === 'assistant' ? 'Assistant' : 'User') + ':\n' });
        if (typeof msg.content === 'string') input.push({ type: 'text', text: msg.content });
        else for (const part of msg.content || []) {
          if (part.type === 'text') input.push({ type: 'text', text: part.text });
          if (part.type === 'image_url') input.push({ type: 'image', url: part.image_url.url });
        }
      }
      await request('turn/start', { threadId: thread.id, input });
      const text = await completion;
      return { text, clientActions: turn.actions, newContent: { role: 'model', parts: [{ text }] } };
    } finally {
      clearTimeout(timer);
      turns.delete(thread.id);
      if (child) await request('thread/unsubscribe', { threadId: thread.id }).catch(() => {});
    }
  }

  async function oneShot({ model, systemText, userText }) {
    const result = await chat({ model, systemText, history: [{ role: 'user', parts: [{ text: String(userText || '') }] }] });
    return result.text.trim();
  }
  return { status, loginStart, logout, catalog, chat, oneShot, stop };
}

function usesChatgpt(settings) { return settings?.openaiAuthMode === 'chatgpt'; }

module.exports = { createClient, usesChatgpt, findCodexExecutable, safeAuthUrl, CODEX_CONFIG };
