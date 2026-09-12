import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/streaming-page.js', import.meta.url), 'utf8');
const start = source.indexOf('  async function startLogin(');
const end = source.indexOf('  // Called by settings.js', start);
assert.ok(start >= 0 && end > start);

function element(tag, className = '', textContent = '') {
  return {
    tag, className, textContent, children: [], isConnected: true,
    appendChild(child) { child.parent = this; this.children.push(child); return child; },
    querySelectorAll(selector) {
      const classes = selector.split(',').map(s => s.trim().slice(1));
      return this.children.filter(child => classes.some(cls => child.className.split(' ').includes(cls)));
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); },
  };
}

function panel(responses) {
  const timers = new Map();
  const calls = [];
  let nextTimer = 0;
  let renders = 0;
  let visible = true;
  const context = vm.createContext({
    el: element, t: (_key, fallback) => fallback,
    sectionVisible: () => visible,
    pollTimer: null,
    stopPoll() { timers.delete(context.pollTimer); context.pollTimer = null; },
    setTimeout(fn, ms) { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
    render() { renders++; },
    api: async (url, options) => {
      calls.push({ url, options });
      assert.ok(responses.length, 'Unexpected request: ' + url);
      return responses.shift();
    },
  });
  vm.runInContext(source.slice(start, end), context);
  const card = element('div', 'streaming-card');
  const button = element('button');
  card.appendChild(button);
  return {
    card, button, calls, timers,
    get renders() { return renders; },
    hide() { visible = false; },
    start: () => context.startLogin({ key: 'youtube', base: '/stream/youtube' }, card, button),
    async tick() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      await timer.fn();
      return timer.ms;
    },
  };
}

const login = { ok: true, userCode: 'ABC-DEF', deviceCode: 'DEVICE', verificationUri: 'https://www.google.com/device', interval: 5, expiresIn: 1800 };

test('invalid_client after the first poll explains how to repair credentials and allows retry', async () => {
  const ui = panel([login, { ok: false, error: 'invalid_client' }]);
  await ui.start();
  assert.ok(ui.card.querySelector('.streaming-login'));
  assert.equal(await ui.tick(), 5000);
  const note = ui.card.querySelector('.streaming-err');
  assert.ok(note, 'the provider failure must stay visible instead of silently rebuilding the card');
  assert.match(note.textContent, /invalid_client/);
  assert.match(note.textContent, /Client ID.*Client Secret.*same.*TVs and Limited Input devices/);
  assert.match(note.textContent, /Edit credentials/);
  assert.equal(ui.button.disabled, false);
  assert.equal(ui.card.querySelector('.streaming-login'), null);
  assert.equal(ui.timers.size, 0);
  assert.equal(ui.renders, 0);
});

test('pending authorization keeps the code past ten seconds and respects slow_down until success', async () => {
  const ui = panel([login, { pending: true }, { pending: true, slowDown: true }, { ok: true }]);
  await ui.start();
  const code = ui.card.querySelector('.streaming-login');
  assert.equal(await ui.tick(), 5000);
  assert.equal(await ui.tick(), 5000);
  assert.equal(ui.card.querySelector('.streaming-login'), code);
  assert.equal(ui.button.disabled, true);
  assert.equal(await ui.tick(), 10000);
  assert.equal(ui.renders, 1);
  assert.equal(ui.timers.size, 0);
  assert.deepEqual(JSON.parse(ui.calls[1].options.body), { deviceCode: 'DEVICE' });
});

test('expired, denied and failed requests show a reason and leave Connect usable', async () => {
  for (const [result, message] of [
    [{ error: 'expired' }, /expired/i],
    [{ error: 'denied' }, /denied/i],
    [{ error: 'network' }, /connection/i],
    [null, /connection/i],
  ]) {
    const ui = panel([login, result]);
    await ui.start();
    await ui.tick();
    assert.match(ui.card.querySelector('.streaming-err')?.textContent || '', message);
    assert.equal(ui.button.disabled, false);
    assert.equal(ui.timers.size, 0);
  }
});

test('closing settings stops polling without another authorization request', async () => {
  const ui = panel([login]);
  await ui.start();
  ui.hide();
  await ui.tick();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.timers.size, 0);
});
