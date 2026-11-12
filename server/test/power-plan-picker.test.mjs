import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'js', 'performance.js'), 'utf8');

test('unsupported power-plan picker falls back to the original optimizer', () => {
  const fetchPlans = source.slice(
    source.indexOf('async function fetchPowerPlans'),
    source.indexOf('// ── Power-plan picker'),
  );
  const showPlans = source.slice(
    source.indexOf('async function showPowerPlans'),
    source.indexOf('function aiAvailable'),
  );

  assert.match(fetchPlans, /error === 'unsupported_platform'\) return d/);
  assert.match(showPlans,
    /data\.error === 'unsupported_platform'[\s\S]*?_closePlanMenu\(\);[\s\S]*?optimize\(\);/);
});

// Run the real picker in a small DOM: open it, pick a plan, and check that the
// menu closes and says so. After the 5.0 merge the success branch called a toast
// helper that no longer existed, so the plan switched but the menu stayed open
// with every row disabled.
async function pickPlan({ toast, setOk = true }) {
  const vm = await import('node:vm');
  const { makeDom, settle } = await import('./mini-dom.mjs');
  const { document } = makeDom();
  const posts = [];
  const toasts = [];
  const window = { innerWidth: 1600, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
  if (toast === 'ok') window.XenonToast = { show: (o) => toasts.push({ ...o }) }; // copied out of the vm realm
  if (toast === 'throws') window.XenonToast = { show: () => { throw new Error('toast broke'); } };
  const ctx = {
    window, document, SERVER: '',
    tr: (key, fallback) => fallback,
    requestAnimationFrame: (fn) => fn(),
    setTimeout: (fn) => fn(),
    optimize() {},
    fetch: async (url, opts) => {
      if (url === '/api/performance/powerplans') {
        return { json: async () => ({ ok: true, guid: 'aaaaaaaa-0000-0000-0000-000000000001', plans: [
          { guid: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Balanced', active: true },
          { guid: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'Power saver', active: false },
        ] }) };
      }
      posts.push(JSON.parse(opts.body).value);
      return { json: async () => (setOk ? { ok: true, guid: 'bbbbbbbb-0000-0000-0000-000000000002' } : { ok: false }) };
    },
  };
  vm.createContext(ctx);
  const from = source.indexOf('  async function powerPlan(');
  const until = source.indexOf('  function aiAvailable(');
  vm.runInContext('let _planMenuEl = null;\n' + source.slice(from, until)
    + '\nthis.showPowerPlans = showPowerPlans; this.menu = () => _planMenuEl;', ctx);
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  await ctx.showPowerPlans(anchor);
  const rows = document.querySelectorAll('.perf-plan-item');
  assert.equal(rows.length, 2);
  rows[1].click();
  await settle(20);
  return { ctx, posts, toasts, rows, document };
}

test('picking a plan switches it, closes the menu and says so', async () => {
  const { ctx, posts, toasts, document } = await pickPlan({ toast: 'ok' });
  assert.deepEqual(posts, ['bbbbbbbb-0000-0000-0000-000000000002']);
  assert.equal(ctx.menu(), null, 'the menu closed');
  assert.equal(document.querySelectorAll('.perf-plan-menu').length, 0, 'and left the page');
  assert.deepEqual(toasts, [{ type: 'success', title: 'Power plan changed · Power saver' }]);
});

test('the menu closes after a switch even with no toast, or a toast that throws', async () => {
  for (const toast of ['missing', 'throws']) {
    const { ctx, posts } = await pickPlan({ toast });
    assert.equal(posts.length, 1, toast);
    assert.equal(ctx.menu(), null, toast + ': the menu closed');
  }
});

test('a refused switch keeps the menu open, with its rows usable again', async () => {
  const { ctx, toasts, rows } = await pickPlan({ toast: 'ok', setOk: false });
  assert.notEqual(ctx.menu(), null);
  assert.ok(rows.every((b) => !b.disabled), 'rows enabled again');
  assert.equal(rows[1].classList.contains('is-busy'), false);
  assert.deepEqual(toasts, [{ type: 'error', title: 'Could not change power plan' }]);
});
