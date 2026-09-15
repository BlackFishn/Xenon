import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const model = require('../../packages/core/src/crosshair');
const source = fs.readFileSync(new URL('../js/crosshair.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const online = { ...model.defaults, online: true, supported: true, installed: true, protocol: 2,
  visible: true, pinned: true, clickThrough: true, enabled: false };

async function editor() {
  const nodes = new Map(), requests = [], timers = new Map();
  let clock = 0, serial = 0;
  function node(key) {
    if (!nodes.has(key)) nodes.set(key, { style: {}, dataset: {}, attributes: {}, open: false,
      classList: { toggle() {} }, addEventListener() {}, focus() {}, observe() {},
      querySelector: node, querySelectorAll: () => [], getClientRects: () => [1],
      getBoundingClientRect: () => ({ width: 0, height: 0 }),
      setAttribute(k, v) { this.attributes[k] = v; }, getAttribute(k) { return this.attributes[k]; },
      show() { this.open = true; }, close() { this.open = false; } });
    return nodes.get(key);
  }
  const document = { hidden: false, getElementById: node, querySelector: node, addEventListener() {},
    querySelectorAll: selector => selector === '[data-crosshair-toggle]' ? [node('toggle')] : [] };
  const window = { XenonCrosshairModel: model };
  vm.runInNewContext(source, { window, document, SERVER: '', Blob, AbortController,
    ResizeObserver: class { observe() {} },
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch(url, options = {}) {
      if (url.endsWith('/presets')) return Promise.resolve({ ok: true, json: async () => [] });
      return new Promise((resolve, reject) => requests.push({ url, body: options.body && JSON.parse(options.body),
        reply(value) { resolve({ ok: true, json: async () => value }); }, reject }));
    }
  });
  requests[0].reply(online);
  await settle();
  return { api: window.XenonCrosshair, document, node, requests,
    async advance(ms) {
      const end = clock + ms;
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        clock = next[1].at; timers.delete(next[0]); next[1].fn(); await settle();
      }
      clock = end;
    } };
}

test('dragging sends before input stops and immediately drains only the latest pending value', async () => {
  const e = await editor();
  await e.api.apply({ length: 6 }); await e.advance(20);
  await e.api.apply({ length: 7 }); await e.advance(20);
  assert.equal(e.requests.length, 2, 'continuous input must not reset the send deadline');
  assert.equal(e.requests[1].body.length, 7);
  await e.api.apply({ length: 8 }); await e.api.apply({ length: 9 });
  await e.advance(200);
  assert.equal(e.requests.length, 2, 'only one command may be in flight');
  e.requests[1].reply({ ...online, length: 7 }); await settle();
  assert.equal(e.requests.length, 3, 'the latest value should send without another timeout');
  assert.equal(e.requests[2].body.length, 9);
  e.requests[2].reply({ ...online, length: 9 }); await settle();
  assert.equal(e.node('toggle').disabled, false);
});

for (const failed of [false, true]) test('late status ' + (failed ? 'failure' : 'response') + ' cannot replace a newer acknowledgement', async () => {
  const e = await editor(), opened = e.api.open();
  const stale = e.requests[1];
  const applied = e.api.apply({ enabled: true });
  e.requests[2].reply({ ...online, enabled: true }); await applied;
  if (failed) stale.reject(new Error('old request failed')); else stale.reply(online);
  await opened;
  assert.equal(e.node('toggle').attributes['aria-pressed'], 'true');
});

test('open editor refreshes promptly without overlapping reads or polling hidden pages', async () => {
  const e = await editor(), opened = e.api.open();
  e.requests[1].reply(online); await opened;
  await e.advance(250);
  assert.equal(e.requests.length, 3);
  await e.advance(1000);
  assert.equal(e.requests.length, 3, 'a slow read must not build a polling backlog');
  e.requests[2].reply({ ...online, enabled: true }); await settle();
  assert.equal(e.node('toggle').attributes['aria-pressed'], 'true');
  await e.advance(250);
  assert.equal(e.requests.length, 4);
  e.document.hidden = true;
  e.requests[3].reply(online); await settle();
  await e.advance(1000);
  assert.equal(e.requests.length, 4);
});
