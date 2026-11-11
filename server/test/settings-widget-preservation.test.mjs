import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DashboardInstances = require('../js/dashboard-instances.js');
// 5.0's portrait layout rules, shared by the client and the server normalizer.
const DashboardPortrait = require('../js/dashboard-portrait.js');
const { nextSettingsRev } = require('../settings-rev.js');
const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SERVER = read('../server.js');
const CLIENT = read('../js/settings.js');

function between(source, start, end, from = 0) {
  const at = source.indexOf(start, from);
  const until = source.indexOf(end, at);
  assert.ok(at >= 0 && until > at, `source anchors: ${start} / ${end}`);
  return source.slice(at, until);
}

function layoutNormalizer(source) {
  const names = ['DASHBOARD_WIDGET_IDS', 'DASHBOARD_TAB_IDS', 'CALENDAR_TAB_IDS', 'MEDIA_VIEW_IDS', 'DASHBOARD_CARD_IDS', 'DASHBOARD_CARD_SIZES', 'DASHBOARD_GRID_COLUMNS', 'DASHBOARD_GRID_MAX_ROW', 'DEFAULT_DASHBOARD_LAYOUT', 'LEGACY_SEEDED_GROUPS'];
  const constants = names.map(name => {
    const at = source.indexOf('const ' + name + ' =');
    assert.ok(at >= 0, name);
    const firstLine = source.slice(at, source.indexOf('\n', at));
    const end = firstLine.endsWith('Object.freeze({') ? source.indexOf('\n});', at) + 4 : source.indexOf(';', at);
    return source.slice(at, end + 1);
  });
  const layoutAt = source.indexOf('function normalizeDashboardLayout(');
  const end = source.indexOf('\n}', layoutAt) + 2;
  const helpers = source.slice(source.indexOf('function cloneDashboardLayout('), end);
  return new Function('DashboardInstances', 'DashboardPortrait', constants.join('\n') + '\n' + helpers + '; return normalizeDashboardLayout;')(DashboardInstances, DashboardPortrait);
}

const normalizeServerLayout = layoutNormalizer(SERVER);
const normalizeClientLayout = layoutNormalizer(CLIENT);

// Execute the actual POST's revision/grid/widget preservation path, then the
// real server layout normalizer. No backend, settings file or network is used.
const routeAt = SERVER.indexOf("reqPath === '/settings' && req.method === 'POST'");
assert.ok(routeAt >= 0);
const prepareSave = new Function('body', 'prev', 'preserveSettingsSecrets', 'nextSettingsRev', 'DASHBOARD_GRID_COLUMNS', 'console',
  between(SERVER, 'let incoming = preserveSettingsSecrets(', '      // lighting.providers', routeAt) + '\nreturn incoming;');
function save(raw, previous) {
  const incoming = prepareSave({ settings: structuredClone(raw) }, previous,
    (value) => value, nextSettingsRev, 24, { warn() {} });
  return { ...incoming, dashboardLayout: normalizeServerLayout(incoming.dashboardLayout) };
}

// Execute the real hydrate reconciliation before its UI side effects. The
// surrounding settings model is reduced to its relevant layout/revision fields;
// the layout normalizer itself is production code, including hidden defaults.
const hydrateAt = CLIENT.indexOf('async function _hydrateHubSettingsImpl(');
assert.ok(hydrateAt >= 0);
const hydrateMerge = new Function('raw', 'stored', 'normalizeSettings', `
  const data = { settings: stored };
  const SETTINGS_STORAGE_KEY = 'test-settings';
  const DASHBOARD_GRID_COLUMNS = 24;
  const localStorage = { getItem: () => JSON.stringify(raw) };
  const readKnownSettingsStore = () => stored.storeId;
  const settingsMirrorIsForeign = () => false;
  const getDashboardLayout = () => hubSettings.dashboardLayout;
  const _dashboardPlacementSig = layout => JSON.stringify(layout.widgets);
  const _weatherSyncSig = () => ({});
  const _weatherConfigDirty = false, _weatherConfigSavePending = false;
  let hubSettings = normalizeSettings(raw);
  ${between(CLIENT, 'let rawLocal = {};', '    saveHubSettings({ server: false });', hydrateAt)}
  return hubSettings;
`);
function hydrate(raw, stored) {
  return hydrateMerge(raw, stored, value => ({ ...value, dashboardLayout: normalizeClientLayout(value.dashboardLayout) }));
}

function fixture() {
  return {
    rev: 12,
    storeId: 'test-store',
    theme: 'dark',
    dashboardLayout: normalizeServerLayout({
      gridCols: 24,
      pages: [{ id: 'dashboard', name: 'Main' }, { id: 'bedroom', name: 'Bedroom' }],
      widgets: {
        'tcl-ac': { x: 8, y: 0, w: 8, h: 20, visible: true, page: 'bedroom' },
        smarthome: { x: 0, y: 0, w: 8, h: 20, visible: true, page: 'bedroom' },
      },
      groups: {},
    }),
  };
}

test('an older client save keeps omitted TCL placement and accepts other widget edits', () => {
  const stored = fixture();
  const oldClient = structuredClone(stored);
  delete oldClient.dashboardLayout.widgets['tcl-ac'];
  oldClient.dashboardLayout.widgets.smarthome.h = 16;
  const saved = save(oldClient, stored);
  assert.deepEqual(saved.dashboardLayout.widgets['tcl-ac'], stored.dashboardLayout.widgets['tcl-ac']);
  assert.equal(saved.dashboardLayout.widgets.smarthome.h, 16);
  assert.equal(saved.rev, 13);
  assert.equal(Object.hasOwn(oldClient.dashboardLayout.widgets, 'tcl-ac'), false, 'must not mutate the request');
});

test('explicit TCL hiding and moving remain supported by POST settings', () => {
  const stored = fixture();
  for (const patch of [{ visible: false }, { x: 3, y: 4, w: 10, h: 12, page: 'dashboard' }]) {
    const edited = structuredClone(stored);
    Object.assign(edited.dashboardLayout.widgets['tcl-ac'], patch);
    assert.deepEqual(save(edited, stored).dashboardLayout.widgets['tcl-ac'], edited.dashboardLayout.widgets['tcl-ac']);
  }
});

test('a genuinely fresh settings store still defaults TCL to hidden', () => {
  const result = save({ dashboardLayout: { gridCols: 24, widgets: {} } }, null);
  assert.deepEqual(result.dashboardLayout.widgets['tcl-ac'], { x: 0, y: 18, w: 8, h: 12, visible: false, page: 'dashboard' });
});

test('newer old-schema local cache does not launder an omitted TCL widget into a hidden default', () => {
  const stored = fixture();
  const local = structuredClone(stored);
  local.rev += 3;
  local.theme = 'light';
  delete local.dashboardLayout.widgets['tcl-ac'];
  local.dashboardLayout.widgets.smarthome.h = 16;
  const merged = hydrate(local, stored);
  assert.equal(merged.theme, 'light');
  assert.equal(merged.dashboardLayout.widgets.smarthome.h, 16);
  assert.deepEqual(merged.dashboardLayout.widgets['tcl-ac'], stored.dashboardLayout.widgets['tcl-ac']);
  assert.deepEqual(save(merged, stored).dashboardLayout.widgets['tcl-ac'], stored.dashboardLayout.widgets['tcl-ac']);
});

test('newer local cache retains explicit TCL removal and geometry edits', () => {
  const stored = fixture();
  for (const patch of [{ visible: false }, { x: 2, y: 5, w: 6, h: 10, page: 'dashboard' }]) {
    const local = structuredClone(stored);
    local.rev++;
    Object.assign(local.dashboardLayout.widgets['tcl-ac'], patch);
    assert.deepEqual(hydrate(local, stored).dashboardLayout.widgets['tcl-ac'], local.dashboardLayout.widgets['tcl-ac']);
  }
});

test('older local caches and pre-24-column mirrors still take the authoritative server layout', () => {
  const stored = fixture();
  for (const pre24 of [false, true]) {
    const local = structuredClone(stored);
    local.rev = stored.rev + (pre24 ? 2 : -2);
    if (pre24) delete local.dashboardLayout.gridCols;
    local.dashboardLayout.widgets['tcl-ac'].visible = false;
    local.dashboardLayout.widgets.smarthome.h = 3;
    assert.deepEqual(hydrate(local, stored).dashboardLayout, normalizeClientLayout(stored.dashboardLayout));
  }
});

test('a TCL copy survives an old client dropping both its unknown base and copy', () => {
  const stored = fixture();
  stored.dashboardLayout.widgets['tcl-ac'].visible = false;
  stored.dashboardLayout.copies = [{ id: 'tcl-ac~bedroom', widget: 'tcl-ac', x: 8, y: 2, w: 8, h: 16, page: 'bedroom' }];
  const oldClient = structuredClone(stored);
  oldClient.rev++;
  delete oldClient.dashboardLayout.widgets['tcl-ac'];
  oldClient.dashboardLayout.copies = [];
  for (const result of [save(oldClient, stored), hydrate(oldClient, stored)]) {
    assert.equal(result.dashboardLayout.widgets['tcl-ac'].visible, false);
    assert.deepEqual(result.dashboardLayout.copies, stored.dashboardLayout.copies);
  }
});

test('a modern client can explicitly remove the last TCL copy and reset its primary', () => {
  const stored = fixture();
  stored.dashboardLayout.widgets['tcl-ac'].visible = false;
  stored.dashboardLayout.copies = [{ id: 'tcl-ac~bedroom', widget: 'tcl-ac', x: 8, y: 2, w: 8, h: 16, page: 'bedroom' }];
  const edited = structuredClone(stored);
  edited.rev++;
  edited.dashboardLayout = normalizeClientLayout({});
  assert.equal(Object.hasOwn(edited.dashboardLayout.widgets, 'tcl-ac'), true);
  for (const result of [save(edited, stored), hydrate(edited, stored)]) {
    assert.deepEqual(result.dashboardLayout.copies, []);
    assert.deepEqual(result.dashboardLayout.widgets['tcl-ac'], edited.dashboardLayout.widgets['tcl-ac']);
  }
});
