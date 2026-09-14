import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import path from 'node:path';
const require = createRequire(import.meta.url);
const local = require('../ai-local.js');
const { splitSentences } = require('../tts-chunks.js');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const client = readFileSync(new URL('../js/ai.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function extract(source, name) {
  const start = source.indexOf('function ' + name + '(');
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, name + ' found');
  return (source.slice(start - 6, start) === 'async ' ? 'async ' : '') + source.slice(start, end + 2);
}

test('Thai replies use Thai speech with English menus; existing voice choices remain', () => {
  assert.equal(local.voiceForLang('th-TH'), 'th-TH-PremwadeeNeural');
  assert.equal(local.voiceForLang('en', 'สวัสดีครับ ยินดีช่วยเหลือครับ'), 'th-TH-PremwadeeNeural');
  assert.equal(local.voiceForLang('it', 'Xenon พร้อมใช้งาน'), 'th-TH-PremwadeeNeural');
  assert.equal(local.voiceForLang('en', 'Hello there.'), 'en-US-AriaNeural');
  assert.equal(local.voiceForLang('ja', 'こんにちは'), 'ja-JP-NanamiNeural');
});

function serverVoice({ synth = async () => Buffer.from('wav'), play = async () => {}, settings = { openaiAuthMode: 'chatgpt' } } = {}) {
  const calls = [], files = new Set();
  let restores = 0;
  const context = vm.createContext({
    Buffer, path, os: { tmpdir: () => '/tmp' },
    fs: { promises: {
      writeFile: async file => { files.add(file); },
      unlink: async file => { files.delete(file); },
    } },
    process: { stdout: { write() {} } },
    _speakGenToken: 0, splitSentences,
    readHubSettings: async () => settings,
    usesChatgpt: s => s?.openaiAuthMode === 'chatgpt',
    aiLocal: { localTts: async (text, lang) => { calls.push(['edge', text, lang]); return synth(text, lang); } },
    aiOpenai: { tts: async () => { calls.push(['api']); throw new Error('Paid API must not be called'); } },
    getFfmpegPath: () => 'ffmpeg',
    _restoreSpeakerVolume: () => { restores++; },
    _playWavFile: async (file, token, options) => {
      calls.push(['play', options]);
      try { await play(file, context); } finally { files.delete(file); }
    },
  });
  context.stopServerSpeak = () => { context._speakGenToken++; };
  vm.runInContext(extract(server, 'speakOnServer'), context);
  return { context, calls, files, restores: () => restores,
    speak: text => context.speakOnServer(text, 'en', '', 'openai') };
}

test('subscription speech uses Edge without an API key and waits for playback', async () => {
  const voice = serverVoice();
  await voice.speak('สวัสดีครับ ทดสอบเสียงภาษาไทย');
  assert.deepEqual(voice.calls.map(c => c[0]), ['edge', 'play']);
  assert.equal(voice.restores(), 1);
  assert.equal(voice.files.size, 0);
});

test('synthesis failure, empty audio, and later chunk failure reject instead of reporting success', async () => {
  const failed = serverVoice({ synth: async () => { throw new Error('edge-tts produced no audio'); } });
  await assert.rejects(failed.speak('สวัสดีครับ'), /produced no audio/);
  assert.equal(failed.calls.some(c => c[0] === 'play'), false);
  const empty = serverVoice({ synth: async () => Buffer.alloc(0) });
  await assert.rejects(empty.speak('สวัสดีครับ'), /returned no audio/);
  let count = 0;
  const chunked = serverVoice({ synth: async () => {
    if (++count === 2) throw new Error('second sentence failed');
    return Buffer.from('wav');
  } });
  await assert.rejects(chunked.speak('This is the first long sentence. This is the second long sentence.'), /second sentence failed/);
  assert.equal(chunked.files.size, 0);
  assert.equal(chunked.restores(), 1);
});

test('player failure cleans up a prefetched sentence; cancellation ends quietly', async () => {
  const failed = serverVoice({ play: async () => { throw new Error('Audio playback failed'); } });
  await assert.rejects(failed.speak('This is the first long sentence. This is the second long sentence.'), /playback failed/);
  assert.equal(failed.files.size, 0);
  assert.equal(failed.restores(), 1);
  const canceled = serverVoice({ play: async (file, context) => { context.stopServerSpeak(); } });
  await canceled.speak('This is the first long sentence. This is the second long sentence.');
  assert.equal(canceled.calls.filter(c => c[0] === 'play').length, 1);
  assert.equal(canceled.files.size, 0);
});

test('WAV player reports process failures and timeouts while treating stop as cancellation', async () => {
  for (const kind of ['success', 'exit-error', 'spawn-error', 'timeout', 'canceled']) {
    const proc = new EventEmitter();
    let guard, unlinked = false, restored = false;
    proc.kill = () => {};
    const context = vm.createContext({
      _speakGenToken: 1, _speakProc: null,
      fs: { promises: { unlink: async () => { unlinked = true; } } },
      _duckSpeakerVolume() {}, broadcastSSE() {},
      _restoreSpeakerVolume() { restored = true; },
      _spawnWavPlayer: () => proc,
      setTimeout: fn => { guard = fn; return 1; }, clearTimeout() {},
    });
    vm.runInContext(extract(server, '_playWavFile'), context);
    const promise = context._playWavFile('/tmp/test.wav', 1);
    const expectation = ['success', 'canceled'].includes(kind) ? promise : assert.rejects(promise, /playback|spawn/);
    if (kind === 'timeout') guard();
    else if (kind === 'spawn-error') proc.emit('error', new Error('spawn failed'));
    else {
      if (kind === 'canceled') context._speakGenToken++;
      proc.emit('exit', kind === 'success' ? 0 : 1);
    }
    await expectation;
    assert.equal(unlinked, true, kind);
    assert.equal(restored, true, kind);
  }
});

function clientVoice() {
  const calls = [], pending = [], bubbles = [], timers = new Map();
  const hint = { textContent: '' };
  let done = 0, reply = '', nextTimer = 0;
  const context = vm.createContext({
    aiSpeaking: false, _aiVoiceSessionActive: true, _aiPendingVoiceReply: 'สวัสดีครับ',
    hubSettings: {}, lang: 'en',
    t: key => key, $: () => hint,
    _aiProviderCfg: () => ({ provider: 'openai' }),
    _aiAppendBubble: (role, text) => bubbles.push(text),
    _aiVoiceSetReply: text => { reply = text; }, _aiVoiceState() {},
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    fetch: (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/stop')) return Promise.resolve(new Response(null, { status: 204 }));
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
  });
  vm.runInContext('let _aiSpeakRequestId = 0;\n' + extract(client, '_aiStopSpeaking') + '\n' + extract(client, '_aiSpeak'), context);
  return { context, calls, pending, bubbles, timers, hint, done: () => done, reply: () => reply,
    speak: () => context._aiSpeak('สวัสดีครับ', () => { done++; }) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('voice UI shows failures, keeps reply visible, and does not reopen the microphone', async () => {
  for (const response of [Response.json({ error: 'synthesis failed' }, { status: 500 }), new Response(''), Response.json({ ok: false })]) {
    const ui = clientVoice();
    ui.speak();
    assert.deepEqual(ui.calls.map(c => c.url), ['/api/speak'], 'no racing stop request');
    ui.pending[0].resolve(response);
    await settle();
    assert.deepEqual(ui.bubbles, ['ai_tts_failed']);
    assert.equal(ui.hint.textContent, 'ai_tts_failed');
    assert.equal(ui.reply(), 'สวัสดีครับ');
    assert.equal(ui.context.aiSpeaking, false);
    assert.equal(ui.done(), 0, 'follow-up mic stays closed');
    assert.equal(ui.timers.size, 0);
  }
});

test('successful speech resumes listening exactly once; timeout stops playback', async () => {
  const ui = clientVoice();
  ui.speak();
  ui.pending[0].resolve(Response.json({ ok: true }));
  await settle();
  assert.equal(ui.done(), 1);
  assert.equal(ui.context.aiSpeaking, false);
  assert.equal(ui.timers.size, 0);
  const timed = clientVoice();
  timed.speak();
  [...timed.timers.values()][0]();
  timed.pending[0].resolve(Response.json({ ok: true }));
  await settle();
  assert.deepEqual(timed.bubbles, ['ai_tts_failed']);
  assert.equal(timed.done(), 0);
  assert.equal(timed.calls[1].url, '/api/speak/stop');
});

test('canceled and superseded speech cannot reopen the mic or display stale errors', async () => {
  const stopped = clientVoice();
  stopped.speak();
  stopped.context._aiStopSpeaking();
  stopped.pending[0].resolve(Response.json({ ok: true }));
  await settle();
  assert.equal(stopped.done(), 0);
  assert.deepEqual(stopped.bubbles, []);
  const replaced = clientVoice();
  replaced.speak();
  replaced.speak();
  replaced.pending[0].reject(new Error('old speech failed'));
  await settle();
  assert.equal(replaced.context.aiSpeaking, true);
  assert.deepEqual(replaced.bubbles, []);
  replaced.pending[1].resolve(Response.json({ ok: true }));
  await settle();
  assert.equal(replaced.done(), 1);
});
