import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const local = readFileSync(new URL('../ai-local.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const client = readFileSync(new URL('../js/ai.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function extract(source, name) {
  const from = source.indexOf('function ' + name + '(');
  const end = source.indexOf('\n}', from);
  assert.ok(from >= 0 && end > from, name);
  return (source.slice(from - 6, from) === 'async ' ? 'async ' : '') + source.slice(from, end + 2);
}

test('Whisper installer uses a completed stable CPU release when latest has no binaries', async () => {
  const cpu = { name: 'whisper-bin-x64.zip', browser_download_url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip' };
  const calls = [];
  const context = vm.createContext({ _httpsJson: async url => {
    calls.push(url);
    return url.endsWith('/latest') ? { tag_name: 'v1.9.4', assets: [] } : [
      { tag_name: 'v1.9.4', assets: [] },
      { tag_name: 'b5130', prerelease: true, assets: [cpu] },
      { tag_name: 'b4938', assets: [cpu] },
      { tag_name: 'v1.9.3', prerelease: true, assets: [cpu] },
      { tag_name: 'v1.9.2', assets: [cpu] },
    ];
  } });
  vm.runInContext(extract(local, 'whisperWindowsAsset'), context);
  assert.equal(await context.whisperWindowsAsset(), cpu);
  assert.equal(calls.length, 2);
  context._httpsJson = async () => ({ assets: [cpu] });
  assert.equal(await context.whisperWindowsAsset(), cpu);
  context._httpsJson = async () => ({ assets: [{ name: 'whisper-cuda-x64.zip', browser_download_url: 'test' }] });
  await assert.rejects(context.whisperWindowsAsset(), /No stable Windows x64 Whisper CPU package/);
});

test('subscription microphone preflight rejects missing Whisper but allows a capture-only mic test', async () => {
  const route = server.indexOf("reqPath === '/api/stt/start'");
  const start = server.indexOf('      const startBody =', route);
  const end = server.indexOf('      await Promise.race([', start);
  assert.ok(route > 0 && start > route && end > start);
  const gate = '(async () => {' + server.slice(start, end) + ' return true; })()';
  const context = vm.createContext({
    req: {}, __dirname: '/server',
    readBody: async () => JSON.stringify({ provider: 'openai' }),
    readHubSettings: async () => ({ aiProvider: 'openai', openaiAuthMode: 'chatgpt' }),
    usesChatgpt: s => s.openaiAuthMode === 'chatgpt',
    aiCli: { isCliProvider: p => ['claudecode', 'codex'].includes(p) },
    aiLocal: { sanitizeProvider: p => p, whisperExe: () => null, whisperPaths: () => ({ model: '/server/model.bin' }) },
    fs: { existsSync: () => false },
  });
  await assert.rejects(vm.runInContext(gate, context), /whisper_not_installed/);
  context.aiLocal.whisperExe = () => '/server/whisper-cli.exe';
  await assert.rejects(vm.runInContext(gate, context), /whisper_model_missing/);
  context.fs.existsSync = () => true;
  assert.equal(await vm.runInContext(gate, context), true);
  context.aiLocal.whisperExe = () => null;
  for (const provider of ['claudecode', 'codex', 'anthropic']) {
    context.readBody = async () => JSON.stringify({ provider });
    await assert.rejects(vm.runInContext(gate, context), /whisper_not_installed/, provider);
  }
  context.readBody = async () => JSON.stringify({ mode: 'test' });
  assert.equal(await vm.runInContext(gate, context), true);
});

test('recorder start errors leave visible setup guidance instead of an orphaned listening screen', async () => {
  const states = [], messages = [], requests = [];
  const context = vm.createContext({
    aiListening: false, aiPanelOpen: false, _aiServerRecordingId: null, _aiVoiceSessionActive: true,
    document: { body: { classList: { add() {}, remove() {} } } },
    $: () => ({ classList: { add() {}, remove() {} } }),
    t: key => key, _aiLog() {}, setAiStatus: s => states.push(s), _aiVoiceState: s => states.push(s),
    _aiProviderCfg: () => ({ provider: 'openai' }),
    _aiAppendBubble: (role, text) => messages.push(text),
    fetch: async (url, options) => {
      requests.push(JSON.parse(options.body));
      return Response.json({ error: 'whisper_not_installed' }, { status: 500 });
    },
  });
  context._aiEndVoiceSession = () => { context._aiVoiceSessionActive = false; context.aiPanelOpen = false; };
  context.openAiPanel = () => { context.aiPanelOpen = true; };
  vm.runInContext(extract(client, '_aiFormatApiError') + '\n' + extract(client, '_aiStartServerRecorder'), context);
  await context._aiStartServerRecorder();
  assert.equal(context.aiListening, false);
  assert.equal(context._aiVoiceSessionActive, false);
  assert.equal(context.aiPanelOpen, true);
  assert.equal(states.includes('listening'), false);
  assert.deepEqual(messages, ['ai_whisper_required']);
  assert.deepEqual(requests, [{ provider: 'openai' }]);
  states.length = 0;
  context._aiVoiceSessionActive = true;
  context.fetch = async () => Response.json({ id: 'recording' });
  await context._aiStartServerRecorder();
  assert.equal(context._aiServerRecordingId, 'recording');
  assert.equal(states.includes('listening'), true);
});

test('recorded voice keeps subscription transcription local while API mode uses its own key', async () => {
  const route = server.indexOf("reqPath === '/api/stt/stop'");
  const start = server.indexOf('      let sttText;', route);
  const end = server.indexOf('\n    } catch (e) {', start);
  assert.ok(route > 0 && start > route && end > start);
  for (const [provider, mode, expected] of [
    ['openai', 'chatgpt', 'local'], ['openai', 'api', 'openai'],
    ['claudecode', 'api', 'local'], ['codex', 'api', 'local'],
    ['anthropic', 'api', 'local'], ['gemini', 'api', 'gemini'],
  ]) {
    const calls = [];
    let response;
    const context = vm.createContext({
      sttProvider: provider, sttLang: 'en', apiKey: 'fixture-gemini', __dirname: '/server',
      wavData: Buffer.from('fixture-audio'),
      readHubSettings: async () => ({ openaiAuthMode: mode, openaiApiKey: 'fixture-openai' }),
      usesChatgpt: s => s?.openaiAuthMode === 'chatgpt',
      aiCli: { isCliProvider: p => ['claudecode', 'codex'].includes(p) },
      aiLocal: { localStt: async (_audio, lang) => { calls.push(['local', lang]); return 'สวัสดี'; } },
      aiOpenai: { stt: async ({ apiKey }) => { calls.push(['openai', apiKey]); return 'hello'; } },
      _transcribeAudio: async () => { calls.push(['gemini']); return 'hello'; },
      providerModelFor: () => 'fixture-model',
      process: { stdout: { write() {} } },
      res: { writeHead() {}, end: body => { response = JSON.parse(body); } },
    });
    await vm.runInContext('(async () => {' + server.slice(start, end) + '})()', context);
    assert.equal(calls.length, 1, provider + ':' + mode);
    assert.equal(calls[0][0], expected, provider + ':' + mode);
    if (expected === 'local') assert.equal(calls[0][1], 'auto');
    if (expected === 'openai') assert.equal(calls[0][1], 'fixture-openai');
    assert.equal(response.text, expected === 'local' ? 'สวัสดี' : 'hello');
  }
});

test('client keeps private ChatGPT and CLI model choices separate without requiring API keys', () => {
  const context = vm.createContext({ hubSettings: {}, geminiKeyReady: () => false });
  vm.runInContext(extract(client, '_aiProviderCfg') + '\n' + extract(client, '_aiProviderReady'), context);
  const settings = { openaiAuthMode: 'chatgpt', chatgptModel: 'private-model', openaiModel: 'api-model',
    codexModel: 'codex-model', claudeCodeModel: 'claude-model' };
  for (const [provider, expected] of [['openai', 'private-model'], ['codex', 'codex-model'], ['claudecode', 'claude-model']]) {
    context.hubSettings = { ...settings, aiProvider: provider };
    assert.equal(context._aiProviderCfg().model, expected);
    assert.equal(context._aiProviderReady(), true);
  }
  context.hubSettings = { ...settings, aiProvider: 'openai', openaiAuthMode: 'api' };
  assert.equal(context._aiProviderCfg().model, 'api-model');
  assert.equal(context._aiProviderReady(), false);
});
