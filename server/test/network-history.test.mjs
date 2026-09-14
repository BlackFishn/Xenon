import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = file => readFileSync(new URL('../js/' + file, import.meta.url), 'utf8');

function networkHarness() {
  let now = 1_800_000_000_000;
  let pageVisible = true;
  let requests = 0;
  const timers = new Map();
  const histories = {};
  const root = {};
  const document = {
    hidden: false,
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll(selector) {
      return selector.includes('data-dashboard-widget') ? [root] : [];
    },
  };
  const context = {
    window: {
      DashboardGrid: { forEachInstance(_widget, fn) { fn(root); } },
      DashboardPager: { isOnCurrentPage: () => pageVisible },
    },
    document,
    Date: class extends Date { static now() { return now; } },
    currentSysTab: 'main',
    netInterval: null,
    fetchingNetwork: false,
    SERVER: '',
    sf: (_root, name) => name.endsWith('-fill') ? { name } : null,
    setInterval(fn, ms) { timers.set(1, { fn, ms }); return 1; },
    clearInterval(id) { timers.delete(id); },
  };
  vm.createContext(context);
  vm.runInContext(read('utils.js') + '\n' + read('network.js'), context);
  // Exercise the real poller, renderer's readings and bounded history reducer.
  context.setFill = (fill, plot, detail) => vm.runInContext(
    '_recordStatSparkSample(__hist, _statSparkSample(__plot, __detail))',
    Object.assign(context, {
      __hist: histories[fill.name] ||= [],
      __plot: plot,
      __detail: detail,
    }),
  );
  context.fetchWithDeadline = async () => {
    requests++;
    return { ok: true, json: async () => ({
      ping: 5 + requests % 4, latency: requests % 3, fps: 210 + requests % 20,
      downloadBps: 125000, uploadBps: 50000,
    }) };
  };
  return {
    context, document, timers, histories,
    get requests() { return requests; },
    setPageVisible(value) { pageVisible = value; },
    async tick() {
      now += 3000;
      for (const { fn } of timers.values()) await fn();
    },
    async tab(name) {
      context.setSystemTab(name, { silent: true });
      // setSystemTab starts its one-shot fetch without awaiting it.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test('network charts retain a full rolling window after six minutes on another dashboard page', async () => {
  const h = networkHarness();
  await h.tab('main');
  for (let i = 0; i < 10; i++) await h.tick();
  const existing = h.histories['net-ping-fill'];
  const before = existing.length;
  h.setPageVisible(false);
  await h.tick();
  h.setPageVisible(true);
  await h.tick();
  assert.equal(h.histories['net-ping-fill'], existing, 'a short page turn must reuse history');
  assert.ok(existing.length >= before);

  h.setPageVisible(false);
  for (let i = 0; i < 120; i++) await h.tick();
  h.setPageVisible(true);
  await h.tick();
  for (const name of ['net-ping-fill', 'net-fps-fill', 'net-latency-fill']) {
    const hist = h.histories[name];
    assert.ok(hist.length >= 37 && hist.length <= 40, name + ' lost its five-minute window');
    assert.ok(hist.at(-1).at - hist[0].at >= 292000, name + ' missed off-page samples');
    assert.ok(hist.every(sample => Number.isFinite(sample.displayValue)));
  }
});

test('Volume, Microphone and a saved non-System tab share one continuing network sampler', async () => {
  const h = networkHarness();
  await h.tab('volume');
  assert.equal(h.timers.size, 1, 'sampling must start even when Volume was saved');
  assert.equal(h.timers.get(1).ms, 3000);
  await h.tick();
  await h.tab('mic');
  await h.tick();
  await h.tab('main');
  assert.equal(h.timers.size, 1, 'tab changes must not add duplicate samplers');
  assert.ok(h.requests >= 3);
});

test('a hidden app still pauses network requests and resumes on the next timer tick', async () => {
  const h = networkHarness();
  await h.tab('main');
  const before = h.requests;
  h.document.hidden = true;
  await h.tick();
  assert.equal(h.requests, before);
  h.document.hidden = false;
  await h.tick();
  assert.equal(h.requests, before + 1);
});
