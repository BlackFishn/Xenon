import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const tcl = require('../../packages/core/src/tcl-ac.js');
const source = readFileSync(new URL('../js/tcl-ac-widget.js', import.meta.url), 'utf8');

function harness() {
  let resolveFetch, rejectFetch;
  const response = new Promise((resolve, reject) => { resolveFetch = resolve; rejectFetch = reject; });
  const context = {
    window: { Xenon: { tclAc: tcl } },
    document: { readyState: 'loading', addEventListener() {}, querySelectorAll() { return []; } },
    makeEl() { throw new Error('Lifecycle test must not create UI'); },
    fetchWithDeadline: () => response,
    setTimeout, clearTimeout,
  };
  vm.createContext(context);
  const exportLine = 'window.TclAcWidget = { onSSE, disconnected, renderWidgets };';
  assert.ok(source.includes(exportLine));
  vm.runInContext(source.replace(exportLine, 'window.TclAcWidget = { onSSE, disconnected, seed, refreshAc, ac, getState: () => state };'), context);
  return {
    api: context.window.TclAcWidget,
    succeed: (data) => resolveFetch({ ok: true, json: async () => data }),
    fail: () => rejectFetch(new Error('obsolete request failed')),
  };
}
const snapshot = (target) => ({ configured: true, connected: true, tclAc: [{ id: tcl.profile.climate, state: 'cool', target, hvacModes: ['off', 'cool'] }] });

test('late initial GET cannot re-enable controls after the SSE stream disconnects', async () => {
  const h = harness();
  const request = h.api.seed();
  h.api.disconnected();
  h.succeed(snapshot(26));
  await request;
  assert.equal(h.api.getState().connected, false);
});

test('obsolete initial GET failure cannot replace a newer healthy SSE snapshot', async () => {
  const h = harness();
  const request = h.api.seed();
  h.api.onSSE(snapshot(27));
  h.fail();
  await request;
  assert.equal(h.api.getState().connected, true);
  assert.equal(h.api.getState().entities[0].target, 27);
  assert.equal(h.api.ac.uncertain, false);
  assert.equal(h.api.ac.error, '');
});

test('manual refresh does not replace newer SSE readback with an older HTTP snapshot', async () => {
  const h = harness();
  h.api.onSSE(snapshot(26));
  h.api.ac.uncertain = true;
  const request = h.api.refreshAc();
  h.api.onSSE(snapshot(27));
  h.succeed(snapshot(26));
  await request;
  assert.equal(h.api.getState().entities[0].target, 27);
  assert.equal(h.api.ac.uncertain, false);
});

test('manual refresh cannot clear uncertainty after a concurrent disconnect', async () => {
  const h = harness();
  h.api.onSSE(snapshot(26));
  h.api.ac.uncertain = true;
  const request = h.api.refreshAc();
  h.api.disconnected();
  h.succeed(snapshot(26));
  await request;
  assert.equal(h.api.getState().connected, false);
  assert.equal(h.api.ac.uncertain, true);
});
