import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createClient, findCodexExecutable, safeAuthUrl, usesChatgpt, CODEX_CONFIG } = require('../ai-chatgpt');

async function fixture(t, { account = { type: 'chatgpt', email: 'test@example.com', planType: 'plus', accessToken: 'secret' }, onRequest, turnTimeoutMs = 1000 } = {}) {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'xenon-chatgpt-'));
  const sent = [], processes = [];
  let seq = 0, serverId = 1000;
  const client = createClient({ profileDir, executable: () => 'codex-test', turnTimeoutMs, requestTimeoutMs: 500,
    spawnProcess(command, args, opts) {
      assert.equal(command, 'codex-test');
      assert.equal(opts.shell, false);
      assert.equal(opts.windowsHide, true);
      assert.equal(opts.env.CODEX_HOME, profileDir);
      assert.equal(opts.env.OPENAI_API_KEY, undefined);
      const proc = new EventEmitter();
      proc.stdout = new PassThrough();
      proc.killed = false;
      proc.kill = () => { proc.killed = true; proc.emit('exit', 0); };
      proc.emitMessage = msg => {
        const line = JSON.stringify(msg) + '\n';
        // A JSON-RPC packet need not line up with stdout chunks.
        proc.stdout.write(line.slice(0, 7)); proc.stdout.write(line.slice(7));
      };
      proc.notify = (method, params) => proc.emitMessage({ method, params });
      proc.call = (method, params) => { const id = ++serverId; proc.emitMessage({ id, method, params }); return id; };
      proc.stdin = new Writable({ write(chunk, encoding, done) {
        for (const line of chunk.toString().trim().split('\n')) {
          const msg = JSON.parse(line);
          sent.push(msg);
          queueMicrotask(() => {
            if (onRequest?.(msg, proc) === true || !msg.method || msg.id == null) return;
            let result = {};
            if (msg.method === 'initialize') result = { userAgent: 'xenon_ai/0.153.4 (test)' };
            if (msg.method === 'account/read') result = { account };
            if (msg.method === 'account/login/start') result = { loginId: 'login-1', authUrl: 'https://auth.openai.com/authorize?state=test' };
            if (msg.method === 'account/logout') account = null;
            if (msg.method === 'model/list') result = msg.params.cursor
              ? { data: [{ model: 'gpt-test-mini', displayName: 'Small', isDefault: false }], nextCursor: null }
              : { data: [{ model: 'gpt-test', displayName: 'Test', isDefault: true }], nextCursor: 'page-2' };
            if (msg.method === 'thread/start') result = { thread: { id: 'thread-' + (++seq) } };
            proc.emitMessage({ id: msg.id, result });
          });
        }
        done();
      } });
      processes.push(proc);
      return proc;
    },
  });
  t.after(async () => { client.stop(); await rm(profileDir, { recursive: true, force: true }); });
  return { client, sent, processes };
}

function finish(proc, threadId, text, status = 'completed') {
  proc.notify('item/completed', { threadId, item: { type: 'agentMessage', text, phase: 'final_answer' } });
  proc.notify('turn/completed', { threadId, turn: { id: 'turn', status } });
}

test('subscription is opt-in; sign-in links allow only official HTTPS hosts', () => {
  assert.equal(usesChatgpt({}), false);
  assert.equal(usesChatgpt({ openaiAuthMode: 'api' }), false);
  assert.equal(usesChatgpt({ openaiAuthMode: 'chatgpt' }), true);
  assert.match(safeAuthUrl('https://auth.openai.com/authorize'), /^https:/);
  for (const url of ['http://auth.openai.com/a', 'https://auth.openai.com.evil.test/a', 'https://user@chatgpt.com/', 'https://chatgpt.com:8443/', 'javascript:alert(1)']) {
    assert.throws(() => safeAuthUrl(url));
  }
});

test('initialize once, redact account fields, paginate models, cancel login and logout', async t => {
  const { client, sent, processes } = await fixture(t);
  const statuses = await Promise.all([client.status(), client.status()]);
  assert.equal(statuses[0].connected, true);
  assert.equal(JSON.stringify(statuses).includes('secret'), false);
  assert.equal(sent.filter(m => m.method === 'initialize').length, 1);
  const catalog = await client.catalog();
  assert.deepEqual(catalog.models.map(m => m.id), ['gpt-test', 'gpt-test-mini']);
  assert.equal(catalog.resolved.chat, 'gpt-test');
  assert.equal((await client.catalog('gpt-pinned')).resolved.chat, 'gpt-pinned');
  const login = await client.loginStart();
  assert.equal(login.loginId, undefined);
  assert.deepEqual(await client.loginStart(), login);
  assert.equal(sent.filter(m => m.method === 'account/login/start').length, 1);
  assert.equal((await client.status()).pending, true);
  processes[0].notify('account/login/completed', { loginId: 'unrelated', success: false });
  assert.equal((await client.status()).pending, true);
  await client.logout();
  assert.ok(sent.some(m => m.method === 'account/login/cancel'));
  assert.equal((await client.status()).connected, false);
});

test('signed-out or API-key Codex accounts cannot start a subscription turn', async t => {
  for (const account of [null, { type: 'apiKey' }]) {
    const { client, sent } = await fixture(t, { account });
    await assert.rejects(client.oneShot({ userText: 'hello' }), { code: 'chatgpt_signin' });
    assert.equal(sent.some(m => m.method === 'thread/start'), false);
  }
});

test('chat preserves history/images, returns Xenon actions and refuses undeclared tools and approvals', async t => {
  const toolCalls = [];
  const { client, sent } = await fixture(t, { onRequest(msg, proc) {
    if (msg.method === 'turn/start') {
      const threadId = msg.params.threadId;
      proc.call('item/commandExecution/requestApproval', { threadId, command: 'unsafe' });
      proc.call('item/tool/call', { threadId, tool: 'disabled_tool', arguments: {} });
      proc.call('item/tool/call', { threadId, tool: 'capture_screen', arguments: 'invalid' });
      proc.call('item/tool/call', { threadId, tool: 'capture_screen', namespace: 'other', arguments: {} });
      proc.call('item/tool/call', { threadId, tool: 'capture_screen', arguments: { monitor: 1 } });
      proc.emitMessage({ id: msg.id, result: { turn: { id: 'turn' } } });
      return true;
    }
    if (msg.result?.contentItems) finish(proc, 'thread-1', 'เห็นหน้าจอแล้ว');
  } });
  const result = await client.chat({ model: 'auto', systemText: 'You are Xenon.',
    geminiTools: [{ name: 'capture_screen', description: 'Screen', parameters: { type: 'OBJECT', properties: {} } }],
    history: [{ role: 'model', parts: [{ text: 'Previous reply' }] }, { role: 'user', parts: [{ text: 'Look at this' }, { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] }],
    executeTool: async (name, args) => { toolCalls.push({ name, args }); return { fnResult: { ok: true }, clientActions: [{ type: 'test' }], pendingScreenImage: 'aW1hZ2U=' }; },
  });
  assert.equal(result.text, 'เห็นหน้าจอแล้ว');
  assert.deepEqual(result.clientActions, [{ type: 'test' }]);
  assert.equal(result.newContent.parts[0].text, result.text);
  assert.deepEqual(toolCalls, [{ name: 'capture_screen', args: { monitor: 1 } }]);
  assert.equal(sent.filter(m => m.error?.code === -32601).length, 4);
  const start = sent.find(m => m.method === 'thread/start').params;
  assert.equal(start.model, null);
  assert.equal(start.ephemeral, true);
  assert.equal(start.sandbox, 'read-only');
  assert.equal(start.approvalPolicy, 'never');
  assert.deepEqual(start.environments, []);
  assert.deepEqual(start.config, CODEX_CONFIG);
  assert.equal(start.dynamicTools[0].inputSchema.type, 'object');
  const input = sent.find(m => m.method === 'turn/start').params.input;
  assert.ok(input.some(i => i.text?.includes('Previous reply')));
  assert.ok(input.some(i => i.type === 'image' && i.url === 'data:image/png;base64,aGVsbG8='));
  assert.ok(sent.some(m => m.result?.contentItems?.some(i => i.type === 'inputImage')));
  assert.ok(sent.some(m => m.method === 'thread/unsubscribe'));
});

test('simultaneous summaries and chats use independent threads', async t => {
  const { client } = await fixture(t, { onRequest(msg, proc) {
    if (msg.method === 'turn/start') {
      const threadId = msg.params.threadId;
      proc.emitMessage({ id: msg.id, result: {} });
      setTimeout(() => finish(proc, threadId, threadId), threadId === 'thread-1' ? 20 : 0);
      return true;
    }
  } });
  const replies = await Promise.all([client.oneShot({ userText: 'A' }), client.oneShot({ userText: 'B' })]);
  assert.deepEqual(replies.sort(), ['thread-1', 'thread-2']);
});

test('failed and timed-out turns reject without retrying actions; reconnect works', async t => {
  let fail = true;
  const { client, processes } = await fixture(t, { turnTimeoutMs: 30, onRequest(msg, proc) {
    if (msg.method === 'turn/start' && fail) {
      proc.emitMessage({ id: msg.id, result: {} });
      finish(proc, msg.params.threadId, '', 'failed');
      return true;
    }
  } });
  await assert.rejects(client.oneShot({ userText: 'fail' }), /quota/);
  fail = false;
  await assert.rejects(client.oneShot({ userText: 'timeout' }), { code: 'timeout' });
  assert.equal(processes[0].killed, true);
  assert.equal((await client.status()).connected, true);
  assert.equal(processes.length, 2);
});

test('process exit and protocol errors do not expose secrets', async t => {
  const { client, processes } = await fixture(t, { onRequest(msg, proc) {
    if (msg.method === 'model/list') {
      proc.emitMessage({ id: msg.id, error: { message: 'access_token=secret' } });
      return true;
    }
  } });
  await assert.rejects(client.catalog(), error => !error.message.includes('secret'));
  processes[0].emit('exit', 1);
  assert.equal((await client.status()).connected, true);
});


test('discovers the nested Windows npm binary even if an extension is earlier on PATH', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'xenon-codex-lookup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const exe = path.join(dir, 'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
  const old = path.join(dir, 'extension/codex.exe');
  await mkdir(path.dirname(exe), { recursive: true });
  await mkdir(path.dirname(old), { recursive: true });
  await writeFile(exe, 'test');
  await writeFile(old, 'test');
  assert.equal(findCodexExecutable({ platform: 'win32', arch: 'x64', env: { APPDATA: dir, PATH: path.dirname(old) } }), exe);
  assert.throws(() => findCodexExecutable({ platform: 'win32', arch: 'x64', env: { PATH: '' } }), { code: 'codex_missing' });
});

test('an older CLI fails closed before it can start a model thread', async t => {
  const { client, sent } = await fixture(t, { onRequest(msg, proc) {
    if (msg.method === 'initialize') {
      proc.emitMessage({ id: msg.id, result: { userAgent: 'xenon_ai/0.150.0 (test)' } });
      return true;
    }
  } });
  const status = await client.status();
  assert.equal(status.available, false);
  assert.equal(status.code, 'codex_version');
  assert.equal(sent.some(m => m.method === 'thread/start'), false);
});


test('all AI entry points allow subscription mode without an API key', () => {
  const gates = [['ai.js', '_aiProviderReady', ''], ['media.js', '_aiHasKey', ''],
    ['disk-widget.js', 'advisorAiReady', '  '], ['performance.js', 'aiAvailable', '  ']];
  for (const [file, name, indent] of gates) {
    const source = readFileSync(new URL('../js/' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const from = source.indexOf('function ' + name + '(');
    const end = source.indexOf('\n' + indent + '}', from);
    assert.ok(from >= 0 && end > from, file + ' gate found');
    const fn = source.slice(from, end + indent.length + 2);
    for (const [settings, expected] of [
      [{ aiProvider: 'openai', openaiAuthMode: 'chatgpt', openaiApiKeySet: false }, true],
      [{ aiProvider: 'openai', openaiAuthMode: 'api', openaiApiKeySet: false }, false],
      [{ aiProvider: 'openai', openaiApiKeySet: true }, true],
      [{ aiProvider: 'anthropic', openaiAuthMode: 'chatgpt', anthropicApiKeySet: false }, false],
      [{ aiProvider: 'ollama' }, true],
    ]) {
      const gate = vm.runInNewContext('(' + fn + ')', { hubSettings: settings,
        _aiProviderCfg: () => ({ provider: settings.aiProvider }), geminiKeyReady: () => false });
      assert.equal(gate({ useAi: true }), expected, file + ' ' + JSON.stringify(settings));
    }
  }
});
