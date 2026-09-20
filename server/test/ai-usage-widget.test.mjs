import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';

const source = readFileSync(new URL('../js/ai-usage-widget.js', import.meta.url), 'utf8');

async function setup(copies = 1, options = {}) {
  const requests = [];
  const { document, mkEl } = makeDom();
  const listeners = {};
  const emit = (type, event = {}) => (listeners[type] || []).forEach(fn => fn({ preventDefault() {}, ...event }));
  document.addEventListener = (type, fn) => (listeners[type] ||= []).push(fn);
  function makeEl(tag, className = '', text) {
    const node = mkEl(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    node.contains = target => {
      for (let n = target; n; n = n.parentNode) if (n === node) return true;
      return false;
    };
    node.focus = () => { document.activeElement = node; emit('focusin', { target: node }); };
    node.getClientRects = () => [node.getBoundingClientRect()];
    node._rect = { width: 400, height: 900 };
    node.offsetWidth = 400; node.scrollHeight = 900; node.offsetHeight = 30;
    node.dataset = new Proxy(node.dataset, { set(target, key, value) {
      target[key] = value;
      node.setAttribute('data-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), value);
      return true;
    } });
    return node;
  }
  const pager = makeEl('div', 'pager-page');
  document.body.append(pager);
  const mounts = Array.from({ length: copies }, (_, index) => {
    const tile = makeEl('section', 'aiusage-panel');
    tile.dataset.dashboardWidget = 'aiusage';
    if (index) tile.dataset.dashboardInstance = 'aiusage~test' + index;
    const mount = makeEl('div', 'ai-usage-widget-mount');
    tile.append(mount); pager.append(tile);
    return mount;
  });
  const daily = Array.from({ length: 30 }, (_, i) => ({
    day: new Date(Date.UTC(2026, 7, 13 + i)).toISOString().slice(0, 10),
    tokens: 0, cost: 0, unpriced: 0,
  }));
  Object.assign(daily[26], { tokens: 1234567, cost: 2.75 });
  Object.assign(daily[28], { tokens: 40, cost: .12, unpriced: 20 });
  Object.assign(daily[29], { tokens: 20, unpriced: 20 });
  const totals = { tokens: 1234627, cost: 2.87, input: 100, output: 20, cacheRead: 0, cacheWrite: 0, unpriced: 40, models: [] };
  const payload = { generatedAt: Date.now(), checkedAt: Date.now(), refresh: { cached: false }, timeZone: 'Asia/Bangkok', providers: ['claude', 'codex'].map(id => ({
    id, daily, connection: { status: 'not_linked' }, periods: { today: totals, yesterday: totals, month: totals }, limits: [], found: true,
  })) };
  const window = { t: key => key, addEventListener: document.addEventListener, ClipboardItem: options.ClipboardItem };
  const imageBlob = new Blob(['png fixture'], { type: 'image/png' });
  document.createElement = tag => tag === 'canvas' ? {
    getContext: () => ({ drawImage() {} }),
    toBlob: cb => cb(options.encodingFails ? null : imageBlob),
  } : mkEl(tag);
  vm.runInNewContext(source, { document, window, makeEl, Intl, Date, AbortController, localStorage: options.storage,
    setInterval() {}, setTimeout() {}, clearTimeout() {}, timeParts: () => ({}),
    navigator: { clipboard: options.clipboard },
    getComputedStyle: () => Object.assign([], { getPropertyValue: () => '', marginBottom: '14px' }),
    XMLSerializer: class { serializeToString() { return '<div xmlns="http://www.w3.org/1999/xhtml" />'; } },
    Image: class { async decode() {} },
    fetch: async (url, init) => { requests.push({ url, init }); return options.fetch ? options.fetch(url, init, payload) : { ok: true, json: async () => payload }; },
  });
  window.AIUsageWidget.renderWidgets();
  await settle();
  const chart = (provider = 'claude', copy = 0) => mounts[copy].querySelector('.aiu-' + provider + ' .aiu-trend');
  const bars = (provider, copy) => chart(provider, copy).querySelectorAll('.aiu-bar-button');
  const tip = (provider, copy) => chart(provider, copy).querySelector('.aiu-trend-tip');
  return { document, emit, mounts, chart, bars, tip, requests, payload, widget: window.AIUsageWidget };
}

test('daily bars open exact dated usage on click, including empty days', async () => {
  const h = await setup();
  assert.equal(h.chart().querySelector('.aiu-bars').getAttribute('role'), 'group');
  assert.equal(h.bars().length, 30);
  assert.equal(h.bars()[0].tagName, 'BUTTON');
  assert.equal(h.tip().hidden, true);
  h.bars()[26].click();
  assert.equal(h.tip().hidden, false);
  assert.match(h.tip().textContent, /1,234,567/);
  assert.match(h.tip().textContent, /Sep 8, 2026/);
  assert.match(h.tip().textContent, /≈ \$2\.75/);
  assert.equal(h.bars()[26].getAttribute('aria-describedby'), h.tip().id);
  h.bars()[0].click();
  assert.equal(h.bars()[26].getAttribute('aria-expanded'), 'false');
  assert.match(h.tip().textContent, /aiu_tokens0/);
  assert.match(h.tip().textContent, /≈ \$0\.00/);
  h.bars()[0].click();
  assert.equal(h.tip().hidden, true);
});

test('unknown daily prices stay unavailable or partial in the tooltip', async () => {
  const h = await setup();
  h.bars()[29].click();
  assert.match(h.tip().textContent, /aiu_equivalent—/);
  assert.match(h.tip().textContent, /aiu_partial/);
  assert.doesNotMatch(h.tip().textContent, /\$0\.00/);
  h.bars()[28].click();
  assert.match(h.tip().textContent, /≥ \$0\.12/);
  assert.match(h.tip().textContent, /aiu_partial/);
});

test('only one tooltip opens across providers and copies; outside click and Escape dismiss it', async () => {
  const h = await setup(2);
  assert.notEqual(h.tip().id, h.tip('claude', 1).id);
  h.bars()[26].click();
  h.bars('codex', 1)[26].click();
  assert.equal(h.tip().hidden, true);
  assert.equal(h.tip('codex', 1).hidden, false);
  h.emit('pointerdown', { target: h.tip('codex', 1) });
  assert.equal(h.tip('codex', 1).hidden, false);
  h.emit('pointerdown', { target: h.document.body });
  assert.equal(h.tip('codex', 1).hidden, true);
  h.bars()[26].click();
  h.emit('keydown', { key: 'Escape' });
  assert.equal(h.tip().hidden, true);
  assert.equal(h.bars()[26].getAttribute('aria-describedby'), null);
});

test('keyboard navigation uses one tab stop and keeps the selected day focused', async () => {
  const h = await setup();
  assert.equal(h.bars().filter(b => b.tabIndex === 0).length, 1);
  const key = (index, value) => h.bars()[index]._handlers.keydown.forEach(fn => fn({ key: value, preventDefault() {} }));
  key(29, 'ArrowLeft');
  assert.equal(h.document.activeElement, h.bars()[28]);
  assert.equal(h.bars()[28].getAttribute('aria-expanded'), 'true');
  assert.equal(h.bars().filter(b => b.tabIndex === 0).length, 1);
  key(28, 'Home');
  assert.equal(h.document.activeElement, h.bars()[0]);
  key(0, 'ArrowLeft');
  assert.equal(h.tip().hidden, false);
  key(0, 'End');
  assert.equal(h.document.activeElement, h.bars()[29]);
  h.emit('focusin', { target: h.document.body });
  assert.equal(h.tip().hidden, true);
});

test('scroll, resize and repaint dismiss stale tooltip content', async () => {
  const h = await setup();
  for (const type of ['scroll', 'resize']) {
    h.bars()[26].click();
    h.emit(type);
    assert.equal(h.tip().hidden, true, type);
  }
  h.bars()[26].click();
  h.widget.renderWidgets();
  assert.equal(h.tip().hidden, true);
  h.bars()[26].click();
  assert.equal(h.tip().hidden, false);
});


test('manual refresh stays usable without a status strip and preserves data on failure', async () => {
  let release, fail = false;
  const h = await setup(1, { fetch: (url, init, payload) => {
    if (!url.includes('?')) return { ok: true, json: async () => payload };
    if (fail) return { ok: false };
    return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => payload }); });
  } });
  h.mounts[0].querySelector('.aiu-refresh-btn').click();
  assert.equal(h.requests.at(-1).url, '/api/ai-usage?refresh=1');
  assert.equal(h.requests.at(-1).init.cache, 'no-store');
  assert.equal(h.mounts[0].getAttribute('aria-busy'), 'true');
  assert.equal(h.mounts[0].querySelector('.aiu-refresh-btn').disabled, true);
  assert.match(h.mounts[0].querySelector('.aiu-refresh-label').textContent, /aiu_refreshing/);
  assert.equal(h.mounts[0].querySelector('.aiu-refresh-result'), null);
  release(); await settle();
  assert.equal(h.mounts[0].getAttribute('aria-busy'), 'false');
  assert.equal(h.mounts[0].querySelector('.aiu-refresh-btn').disabled, false);
  assert.equal(h.mounts[0].querySelector('.aiu-refresh-result'), null);
  fail = true;
  h.mounts[0].querySelector('.aiu-refresh-btn').click(); await settle();
  assert.equal(h.mounts[0].querySelector('.aiu-refresh-result'), null);
  assert.match(h.mounts[0].querySelector('.aiu-warning').textContent, /aiu_refresh_failed/);
  assert.equal(h.bars().length, 30, 'last known data remains visible');
});

test('cached usage renders without help controls or a refresh status strip', async () => {
  const h = await setup(1, { fetch: (url, init, payload) => ({ ok: true, json: async () => ({ ...payload, refresh: { cached: true } }) }) });
  assert.equal(h.mounts[0].querySelector('[data-aiu-focus="help"]'), null);
  assert.equal(h.mounts[0].querySelector('.aiu-help'), null);
  assert.equal(h.mounts[0].querySelector('.aiu-refresh-result'), null);
  assert.equal(h.mounts[0].querySelector('.aiu-controls').querySelectorAll('button').length, 2);
  assert.ok(h.mounts[0].querySelector('.aiu-grid'));
});

test('connecting Claude uses the usage-only endpoint and shows the next required step', async () => {
  const h = await setup(1, { fetch: (url, init, payload) => {
    if (url === '/api/claude/link-usage') {
      assert.equal(init.method, 'POST');
      payload.providers[0].connection.status = 'waiting';
      return { ok: true, json: async () => ({ ok: true, usageLinked: true }) };
    }
    return { ok: true, json: async () => payload };
  } });
  h.mounts[0].querySelector('.aiu-connect-btn').click(); await settle(16);
  assert.equal(h.mounts[0].querySelector('.aiu-connect-btn'), null);
  assert.match(h.mounts[0].querySelector('.aiu-connection').textContent, /aiu_claude_waiting/);
  assert.ok(h.requests.some(r => r.url === '/api/claude/link-usage'));
  assert.ok(h.requests.some(r => r.url === '/api/ai-usage?refresh=1'));
  assert.ok(!h.requests.some(r => r.url === '/api/claude/link'));
});

test('long totals retain every digit and cent when selecting another period', async () => {
  const h = await setup(1, { fetch: (url, init, payload) => {
    payload.providers[0].periods = { ...payload.providers[0].periods, month: { ...payload.providers[0].periods.month, cost: 1234567.89 } };
    return { ok: true, json: async () => payload };
  } });
  h.mounts[0].querySelector('[data-aiu-focus="month"]').click();
  const total = h.mounts[0].querySelector('.aiu-total');
  assert.equal(total.textContent, '$1,234,570.76');
  assert.equal(total.title, total.textContent);
  assert.equal(total.style.getPropertyValue('--aiu-digits'), String(total.textContent.length));
});

test('image copy waits for the clipboard, prevents duplicate writes, and preserves period and details', async () => {
  let complete, writes = 0, item;
  const h = await setup(1, {
    ClipboardItem: class { constructor(data) { this.data = data; } },
    clipboard: { write(items) { writes++; item = items[0]; return new Promise(resolve => { complete = resolve; }); } },
  });
  const mount = h.mounts[0];
  mount.querySelector('[data-aiu-focus="month"]').click();
  const details = mount.querySelector('.aiu-details');
  details.open = true; details._handlers.toggle[0]();
  mount.scrollTop = 90;
  mount.querySelector('.aiu-copy-btn').click();
  assert.equal(writes, 1);
  assert.equal(mount.querySelector('.aiu-copy-btn').disabled, true);
  assert.equal(mount.querySelector('.aiu-copy-result').textContent, 'aiu_copying');
  mount.querySelector('.aiu-copy-btn').click();
  assert.equal(writes, 1);
  assert.equal((await item.data['image/png']).type, 'image/png');
  complete(); await settle();
  assert.equal(mount.querySelector('.aiu-copy-result').textContent, 'aiu_copied');
  assert.equal(mount.querySelector('.aiu-copy-btn').disabled, false);
  assert.equal(mount.querySelector('[data-aiu-focus="month"]').getAttribute('aria-pressed'), 'true');
  assert.equal(mount.querySelector('.aiu-details').open, true);
  assert.equal(mount.scrollTop, 90);
});

test('unavailable clipboard, denied writes, and failed encoding never report a copied image', async () => {
  for (const options of [
    {},
    { ClipboardItem: class {}, clipboard: { write: async () => { throw Error('denied'); } } },
    { encodingFails: true, ClipboardItem: class { constructor(data) { this.data = data; } }, clipboard: { write: async items => { await items[0].data['image/png']; } } },
  ]) {
    const h = await setup(1, options);
    h.mounts[0].querySelector('.aiu-copy-btn').click(); await settle();
    assert.equal(h.mounts[0].querySelector('.aiu-copy-btn').disabled, false);
    assert.equal(h.mounts[0].querySelector('.aiu-copy-result').textContent, options.clipboard ? 'aiu_copy_failed' : 'aiu_copy_unavailable');
  }
});

test('live quota source and stale-read warning remain visible together', async () => {
  const h = await setup(1, { fetch: async (url, init, payload) => {
    payload.providers[1].connection = { source: 'provider_api', liveStatus: 'rate_limited' };
    payload.providers[1].limits = [{ id: 'codex', observedAt: Date.now() - 600000,
      windows: [{ usedPercent: 40, windowMinutes: 300, resetsAt: Date.now() / 1000 + 3600 }] }];
    return { ok: true, json: async () => payload };
  } });
  const card = h.mounts[0];
  assert.match(card.querySelector('.aiu-codex .aiu-source').textContent, /aiu_provider_api/);
  assert.match(card.querySelector('.aiu-codex .aiu-warning').textContent, /aiu_live_rate_limited/);
});

test('layout persists per instance, survives refresh, and restores after remount', async () => {
  const saved = new Map();
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const h = await setup(2, { storage });
  const select = h.mounts[1].querySelector('.aiu-layout-select');
  select.value = 'list'; select._handlers.change[0]();
  assert.equal(h.mounts[0].querySelector('.aiu-wrap').dataset.layout, 'auto');
  assert.equal(h.mounts[1].querySelector('.aiu-wrap').dataset.layout, 'list');
  h.widget.renderWidgets();
  assert.equal(h.mounts[1].querySelector('.aiu-wrap').dataset.layout, 'list');
  const restored = await setup(2, { storage });
  assert.equal(restored.mounts[1].querySelector('.aiu-wrap').dataset.layout, 'list');
  assert.equal(restored.mounts[0].querySelector('.aiu-wrap').dataset.layout, 'auto');
});

test('invalid saved layouts fall back to auto; unavailable storage keeps change in memory', async () => {
  const h = await setup(1, { storage: { getItem: () => '999', setItem: () => { throw new Error('blocked'); } } });
  assert.equal(h.mounts[0].querySelector('.aiu-wrap').dataset.layout, 'auto');
  const select = h.mounts[0].querySelector('.aiu-layout-select');
  select.value = '2'; select._handlers.change[0]();
  assert.equal(h.mounts[0].querySelector('.aiu-wrap').dataset.layout, '2');
  assert.match(h.mounts[0].textContent, /aiu_layout_save_failed/);
});

test('three providers render with quota-only OpenCode and no fabricated history', async () => {
  const h = await setup(1, { fetch: async (url, init, payload) => {
    if (payload.providers.length === 2) payload.providers.push({
      ...payload.providers[1], id: 'opencode', historyUnavailable: true,
      limits: [{ id: 'opencode', windows: [{ usedPercent: 25, windowMinutes: 300 }] }],
    });
    return { ok: true, json: async () => payload };
  } });
  assert.equal(h.mounts[0].querySelectorAll('.aiu-provider').length, 3);
  assert.equal(h.mounts[0].querySelector('.aiu-opencode .aiu-trend'), null);
  assert.match(h.mounts[0].textContent, /OpenCode/);
  assert.match(h.mounts[0].textContent, /aiu_history_unavailable/);
});

test('compact list folds history, preserves expansion on refresh, and leaves grid untouched', async () => {
  const h = await setup(1, { storage: { getItem: () => 'list' } });
  let row = h.mounts[0].querySelector('.aiu-compact');
  assert.equal(row.open, false);
  assert.equal(row.querySelector('.aiu-compact-summary').querySelectorAll('.aiu-compact-quota').length, 3);
  assert.ok(row.querySelector('.aiu-compact-body .aiu-trend'));
  row.open = true; row._handlers.toggle[0]();
  h.widget.renderWidgets();
  row = h.mounts[0].querySelector('.aiu-compact');
  assert.equal(row.open, true);
  const selector = h.mounts[0].querySelector('.aiu-layout-select');
  selector.value = '2'; selector._handlers.change[0]();
  assert.equal(h.mounts[0].querySelector('.aiu-compact'), null);
  assert.ok(h.mounts[0].querySelector('.aiu-provider .aiu-trend'));
});
