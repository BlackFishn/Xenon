import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const tclAcProfile = require('../../packages/core/src/tcl-ac.js');
const DashboardInstances = require('../js/dashboard-instances.js');
const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const server = read('../server.js');
const settings = read('../js/settings.js');

// Execute the production helpers without starting a backend or reading a data store.
function functionSource(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, name + ' ending');
  return source.slice(source.slice(Math.max(0, start - 6), start) === 'async ' ? start - 6 : start, end + 2);
}
function constantSource(name) {
  const start = settings.indexOf('const ' + name + ' =');
  assert.ok(start >= 0, name);
  const firstLine = settings.slice(start, settings.indexOf('\n', start));
  const end = firstLine.endsWith('Object.freeze({') ? settings.indexOf('\n});', start) + 4 : settings.indexOf(';', start);
  return settings.slice(start, end + 1);
}
function layoutNormalizer() {
  const constants = ['DASHBOARD_WIDGET_IDS', 'DASHBOARD_TAB_IDS', 'CALENDAR_TAB_IDS', 'MEDIA_VIEW_IDS', 'DASHBOARD_CARD_IDS', 'DASHBOARD_CARD_SIZES', 'DASHBOARD_GRID_COLUMNS', 'DASHBOARD_GRID_MAX_ROW', 'DEFAULT_DASHBOARD_LAYOUT'];
  const start = settings.indexOf('function cloneDashboardLayout(');
  const end = settings.indexOf('function normalizeTopbarRails(', start);
  return new Function('DashboardInstances', constants.map(constantSource).join('\n') + '\n' + settings.slice(start, end) + ';return normalizeDashboardLayout;')(DashboardInstances);
}

test('TCL state is projected independently of Smart Home and Energy selections', async () => {
  let config = { homeAssistant: { url: 'http://ha.invalid', token: 'private-test-token', entities: [], energyEntities: ['sensor.power'] } };
  const deckHa = { isConnected: () => true, snapshot: (ids) => ids.map(id => ({ id, state: 'available' })) };
  const build = new Function('readHubSettings', 'deckHa', 'tclAcProfile', functionSource(server, 'buildHaState') + ';return buildHaState;')(async () => config, deckHa, tclAcProfile);
  const first = await build();
  assert.equal(first.connected, true);
  assert.deepEqual(first.entities, []);
  assert.deepEqual(first.energy.map(e => e.id), ['sensor.power']);
  assert.deepEqual(first.tclAc.map(e => e.id), tclAcProfile.ids);
  assert.equal(JSON.stringify(first).includes('private-test-token'), false);
  config.homeAssistant.entities = ['light.desk', tclAcProfile.profile.climate];
  assert.deepEqual((await build()).entities.map(e => e.id), config.homeAssistant.entities);
  config = {};
  assert.deepEqual(await build(), { configured: false, connected: false, entities: [], energy: [], tclAc: [] });
});

test('an AC-only dashboard keeps the shared HA watch open with no Smart Home selection', async () => {
  let watched = 0;
  let stopped = 0;
  const sseClients = new Set(['dashboard']);
  const deckHa = { watch: () => { watched++; return () => { stopped++; }; } };
  const refresh = new Function('readHubSettings', 'deckHa', 'sseClients', 'scheduleHaBroadcast', 'buildHaState', 'broadcastSSE',
    'let haStopWatch = null, haNotifyTimer = null, _haConfigSig = null, _haDeckStatesLast = "";\n' + functionSource(server, 'refreshHaWatch') + ';return refreshHaWatch;')(
    async () => ({ homeAssistant: { url: 'http://ha.invalid', token: 'test', entities: [] }, dashboardLayout: { widgets: { 'tcl-ac': { visible: true }, smarthome: { visible: false } } } }),
    deckHa, sseClients, () => {}, async () => ({}), () => {});
  await refresh();
  await refresh();
  assert.equal(watched, 1);
  assert.equal(stopped, 0);
  sseClients.clear();
  await refresh();
  assert.equal(stopped, 1);
});

test('TCL layouts remain opt-in and preserve resize, copies, pages, and removal across normalization', () => {
  const normalize = layoutNormalizer();
  assert.equal(normalize({}).widgets['tcl-ac'].visible, false);
  const raw = {
    gridCols: 24,
    pages: [{ id: 'dashboard', name: 'Main' }, { id: 'bedroom', name: 'Bedroom' }],
    widgets: { 'tcl-ac': { x: 3, y: 4, w: 10, h: 14, page: 'bedroom', visible: true }, smarthome: { x: 2, y: 6, w: 5, h: 8, page: 'dashboard', visible: true } },
    copies: [{ id: 'tcl-ac~test', widget: 'tcl-ac', x: 12, y: 4, w: 8, h: 10, page: 'bedroom' }],
    groups: {},
  };
  const saved = normalize(raw);
  assert.deepEqual(saved.widgets['tcl-ac'], raw.widgets['tcl-ac']);
  assert.deepEqual(saved.widgets.smarthome, raw.widgets.smarthome);
  assert.deepEqual(saved.copies, raw.copies);
  assert.deepEqual(normalize(saved), saved);
  assert.equal(DashboardInstances.isDuplicable('tcl-ac'), true);
  assert.equal(DashboardInstances.isMirrorWidget('tcl-ac'), false);
  saved.widgets['tcl-ac'].visible = false;
  const removed = normalize(saved);
  assert.equal(removed.widgets['tcl-ac'].visible, false);
  assert.equal(removed.copies.length, 1, 'removing the primary must retain the independent copy');
});

test('client Smart Home normalization does not append the TCL profile', () => {
  const helpers = ['normalizeHomeAssistantTileSections', 'normalizeHomeAssistantTileCards', 'normalizeHomeAssistant'].map(name => functionSource(settings, name)).join('\n');
  const normalize = new Function('normalizeCamAngles', helpers + ';return normalizeHomeAssistant;')(() => ({}));
  const entities = [tclAcProfile.profile.climate, 'light.desk'];
  assert.deepEqual(normalize({ entities }).entities, entities);
  assert.deepEqual(normalize({ entities: [] }).entities, []);
  assert.equal(normalize({ entities: Array.from({ length: 120 }, (_, i) => 'sensor.item_' + i) }).entities.length, 100);
});

test('TCL mounts, scripts, state delivery, and layout render hooks are registered', () => {
  const index = read('../index.html');
  const main = read('../js/main.js');
  const layout = read('../js/dashboard-layout.js');
  const palette = read('../js/dashboard-palette.js');
  assert.match(index, /data-dashboard-widget="tcl-ac"[^>]*data-dashboard-hidden="true"/);
  assert.match(index, /class="tcl-ac-widget-mount"/);
  assert.ok(index.indexOf('shared/src/tcl-ac.js') < index.indexOf('js/tcl-ac-widget.js'));
  assert.match(main, /TclAcWidget\.onSSE\(d\)/);
  assert.match(main, /TclAcWidget\.disconnected\(\)/);
  assert.match(layout, /TclAcWidget\.renderWidgets\(\)/);
  assert.match(palette, /'smarthome', 'tcl-ac', 'unifi'/);
  assert.match(read('../js/i18n.js'), /'layout_widget_tcl-ac': 'TCL Air Conditioner'/);
});

test('the shared service route passes the optional profile without changing generic Smart Home requests', async () => {
  const start = server.indexOf("reqPath === '/api/homeassistant/service' && req.method === 'POST') {");
  const bodyStart = server.indexOf('{', start) + 1;
  const bodyEnd = server.indexOf('  } else if (reqPath', bodyStart);
  assert.ok(start > 0 && bodyEnd > bodyStart);
  const calls = [];
  const results = [];
  const route = new Function('deckHa', 'readBody', 'json', 'return async function(req) {' + server.slice(bodyStart, bodyEnd) + '}')(
    { callService: async (...args) => { calls.push(args); return { ok: true }; } },
    async (req) => JSON.stringify(req), (result) => results.push(result));
  await route({ domain: 'homeassistant', service: 'toggle', entityId: 'switch.desk' });
  await route({ domain: 'climate', service: 'set_hvac_mode', entityId: tclAcProfile.profile.climate, data: { hvac_mode: 'cool' }, profile: 'tcl-ac' });
  assert.deepEqual(calls[0], ['homeassistant', 'toggle', { entity_id: 'switch.desk' }, {}, undefined]);
  assert.deepEqual(calls[1], ['climate', 'set_hvac_mode', { entity_id: tclAcProfile.profile.climate }, { hvac_mode: 'cool' }, 'tcl-ac']);
  assert.deepEqual(results, [{ ok: true }, { ok: true }]);
});
