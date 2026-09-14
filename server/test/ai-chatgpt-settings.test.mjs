import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
const start = source.indexOf('let _chatgptStatus = null;');
const end = source.indexOf('const AI_MODEL_CONTROLS =', start);
assert.ok(start >= 0 && end > start, 'ChatGPT settings handlers found');

function panel(responses) {
  const elements = Object.fromEntries(['status', 'login', 'logout'].map(id =>
    ['settings-chatgpt-' + id, { textContent: '', hidden: false, disabled: false }]));
  const calls = [];
  const models = [];
  const context = vm.createContext({
    $: id => elements[id], t: key => key,
    hubSettings: { aiProvider: 'openai', openaiAuthMode: 'chatgpt' },
    clearTimeout() {}, setTimeout() { throw new Error('Unexpected poll'); },
    _aiModelCatalog: {}, _aiRenderProviderControls() {},
    _aiLoadProviderModels: async provider => { models.push(provider); },
    fetch: async (url, options) => {
      calls.push({ url, options });
      assert.ok(responses.length, 'Unexpected request: ' + url);
      return responses.shift();
    },
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, calls, models, elements, status: elements['settings-chatgpt-status'] };
}

test('connection controls recover from empty HTTP errors and incomplete JSON', async t => {
  for (const handler of ['refreshChatgptStatus', 'connectChatgpt', 'disconnectChatgpt']) {
    for (const [status, body, expected] of [
      [404, '', 'settings_chatgpt_restart_backend'],
      [403, '', 'settings_chatgpt_local_only'],
      [500, '<html>server error</html>', 'settings_chatgpt_unavailable'],
      [200, '', 'settings_chatgpt_bad_response'],
      [200, '{', 'settings_chatgpt_bad_response'],
      [200, 'null', 'settings_chatgpt_bad_response'],
      [200, '[]', 'settings_chatgpt_bad_response'],
      [200, '{}', 'settings_chatgpt_bad_response'],
    ]) {
      await t.test(handler + ' ' + status + ' ' + JSON.stringify(body), async () => {
        const ui = panel([new Response(body, { status })]);
        await ui.context[handler]();
        assert.equal(ui.status.textContent, expected);
        assert.equal(ui.calls.length, 1, 'failed login must not open a browser');
        assert.equal(ui.elements['settings-chatgpt-login'].disabled, false);
        assert.equal(ui.elements['settings-chatgpt-logout'].disabled, false);
      });
    }
  }
});

test('sign-in opens the official login and refreshes the connected account and models', async () => {
  const authUrl = 'https://auth.openai.com/test';
  const ui = panel([
    Response.json({ authUrl }), Response.json({ ok: true }),
    Response.json({ available: true, connected: true, email: 'test@example.com', plan: 'plus' }),
  ]);
  await ui.context.connectChatgpt();
  assert.deepEqual(ui.calls.map(c => c.url), ['/api/ai/chatgpt/login', '/actions/run', '/api/ai/chatgpt/status']);
  assert.deepEqual(JSON.parse(ui.calls[1].options.body), { type: 'openUrl', url: authUrl });
  assert.equal(ui.calls[0].options.method, 'POST');
  assert.equal(ui.calls[2].options.cache, 'no-store');
  assert.equal(ui.status.textContent, 'settings_chatgpt_connected · test@example.com · plus');
  assert.equal(ui.elements['settings-chatgpt-login'].hidden, true);
  assert.equal(ui.elements['settings-chatgpt-logout'].hidden, false);
  assert.equal(ui.elements['settings-chatgpt-login'].disabled, false);
  assert.deepEqual(ui.models, ['chatgpt']);
});

test('browser-action failures and Codex errors leave sign-in available for retry', async () => {
  const ui = panel([Response.json({ authUrl: 'https://auth.openai.com/test' }), new Response('', { status: 404 })]);
  await ui.context.connectChatgpt();
  assert.equal(ui.status.textContent, 'settings_chatgpt_unavailable');
  assert.equal(ui.elements['settings-chatgpt-login'].disabled, false);
  const missing = panel([Response.json({ error: 'Install Codex CLI, then restart Xenon.' })]);
  await missing.context.connectChatgpt();
  assert.equal(missing.status.textContent, 'Install Codex CLI, then restart Xenon.');
  assert.equal(missing.calls.length, 1);
});

test('disconnect refreshes the signed-out state without requesting models', async () => {
  const ui = panel([Response.json({ ok: true }), Response.json({ available: true, connected: false, pending: false })]);
  await ui.context.disconnectChatgpt();
  assert.deepEqual(ui.calls.map(c => c.url), ['/api/ai/chatgpt/logout', '/api/ai/chatgpt/status']);
  assert.equal(ui.status.textContent, 'settings_chatgpt_signed_out');
  assert.equal(ui.elements['settings-chatgpt-login'].hidden, false);
  assert.equal(ui.elements['settings-chatgpt-logout'].hidden, true);
  assert.equal(ui.elements['settings-chatgpt-logout'].disabled, false);
  assert.deepEqual(ui.models, []);
});
