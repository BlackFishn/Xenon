// Optional browser regression: node tools/test-tcl-ac-ui.mjs
// PLAYWRIGHT_MODULE / PLAYWRIGHT_EXECUTABLE_PATH may select an existing runtime.
// Uses an isolated browser context and mock HA; never reads/writes server/data.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockHa, tcl, ha } from '../server/test/fixtures/tcl-ac.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const p = tcl.profile;
const port = Number(process.env.TCL_TEST_PORT) || 3031;
assert.notEqual(port, 3030, 'Never use the daily-use backend port');
const output = process.env.TCL_TEST_OUTPUT || resolve(root, 'test-results/tcl-ac');
const mock = await mockHa();
let browser, stopWatch;
const streams = new Set();
const serviceCalls = [];
let serviceReply = null;
let serviceDelay = 0;
let config = ha.normalizeHomeAssistant({ entities: [p.climate, p.eco, 'light.desk', 'sensor.pm25', 'climate.other'], tileLayout: 'custom', tileSections: [{ id: 'shs_bed', title: 'Bedroom', parent: '' }], tileCards: { [p.climate]: { width: 2, height: 2, section: 'shs_bed' }, 'light.desk': { width: 1, height: 1, section: '' } } });
const initialConfig = structuredClone(config);
const snapshot = () => ({ configured: true, connected: mock.client.isConnected(), entities: mock.client.snapshot(config.entities), tclAc: mock.client.snapshot(tcl.ids) });
const broadcast = () => { for (const stream of streams) stream.write('event: homeassistant\ndata: ' + JSON.stringify(snapshot()) + '\n\n'); };

// Execute the production route bodies and loopback Origin guard with mock I/O.
const serverSource = await readFile(resolve(root, 'server/server.js'), 'utf8');
function routeBody(path) {
  const start = serverSource.indexOf("} else if (reqPath === '" + path + "'");
  assert.ok(start > 0);
  return 'if (false) {' + serverSource.slice(start, serverSource.indexOf('\n  } else if', start + 1)) + '\n}';
}
const guardStart = serverSource.indexOf('function isAllowedRequest(req)');
const guardCode = serverSource.slice(guardStart, serverSource.indexOf('\n}', guardStart) + 2);
const allowed = new Function('LOOPBACK_IPS', 'ALLOWED_HOSTS', guardCode + '; return isAllowedRequest;')(new Set(['127.0.0.1', '::1']), new Set(['127.0.0.1:' + port]));
const route = new Function('deckHa', 'buildHaState', `return async function(req,res) {
  const urlObj = new URL(req.url, 'http://127.0.0.1'); const reqPath = urlObj.pathname;
  const json = (data) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(data)); };
  const err500 = (error) => { res.statusCode=500; json({ok:false,error}); };
  const readBody = async (req) => { let body=''; for await (const chunk of req) body+=chunk; return body; };
  ${routeBody('/api/homeassistant/state')}
  ${routeBody('/api/homeassistant/service')}
}`)(mock.client, async () => snapshot());
const assets = new Map([
  ['/core.js', 'packages/core/src/tcl-ac.js'], ['/utils.js', 'server/js/utils.js'],
  ['/smart-home.js', 'server/js/smart-home.js'], ['/smart-home.css', 'server/components/SmartHomePanel/SmartHomePanel.css'],
  ['/tcl-ac-widget.js', 'server/js/tcl-ac-widget.js'], ['/tcl-ac-widget.css', 'server/components/TclAcWidget/TclAcWidget.css'],
]);
const server = createServer(async (req, res) => {
  try {
    if (!allowed(req)) { res.writeHead(403); res.end('Forbidden'); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      streams.add(res); req.on('close', () => streams.delete(res)); broadcast(); return;
    }
    if (url.pathname === '/api/homeassistant/entities') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, entities: await mock.client.listEntities() })); return; }
    if (url.pathname === '/api/homeassistant/service') {
      serviceCalls.push(Date.now());
      const reply = serviceReply;
      if (serviceDelay) await new Promise((r) => setTimeout(r, serviceDelay));
      if (reply) { res.writeHead(reply.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reply.body)); return; }
    }
    if (url.pathname.startsWith('/api/homeassistant/')) { await route(req, res); return; }
    if (assets.has(url.pathname)) {
      res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(await readFile(resolve(root, assets.get(url.pathname)))); return;
    }
    if (url.pathname !== '/') { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/smart-home.css"><link rel="stylesheet" href="/tcl-ac-widget.css">
      <style>*{box-sizing:border-box}body{margin:0;background:#10171e;color:#e7e9ee;font:16px system-ui;--text:#e7e9ee;--accent-rgb:89,211,225;--bg:#10171e}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:20px;padding:16px}section[data-dashboard-widget]{height:calc(100vh - 32px);min-height:400px;border:1px solid #34434a;border-radius:18px;overflow:hidden}.pager-page{min-width:0}</style>
      <main>${[1, 2].map((n) => '<div class="pager-page"><section data-widget="tcl-ac" data-dashboard-widget="tcl-ac" class="tcl-ac-panel" id="tile' + n + '"><div class="tcl-ac-widget-mount"></div></section></div>').join('')}<div class="pager-page"><section data-widget="smarthome" data-dashboard-widget="smarthome" class="smarthome-panel" id="smart-home"><div class="smarthome-widget-mount"></div></section></div></main><div id="settings-smarthome-hub"></div>
      <script src="/core.js"></script><script src="/utils.js"></script><script>
      let config=${JSON.stringify(config)};
      window.t=(key)=>({smarthome_on:'On',smarthome_off:'Off',smarthome_title:'Smart Home',smarthome_no_area:'Other',smarthome_unsectioned:'Unsectioned',smarthome_hvac_cool:'Cool',smarthome_hvac_dry:'Dry',smarthome_hvac_auto:'Auto',smarthome_hvac_fan_only:'Fan only',smarthome_hvac_off:'Off'}[key]||key);
      window.getHomeAssistantSettings=()=>config;
      window.settingsPatches=[]; window.setHomeAssistantSettings=(patch)=>{config={...config,...patch};window.lastSettingsPatch=patch;window.settingsPatches.push(patch);};
      </script><script src="/smart-home.js"></script><script src="/tcl-ac-widget.js"></script><script>
      const stream=new EventSource('/events'); stream.addEventListener('homeassistant',e=>{const data=JSON.parse(e.data);SmartHome.onSSE(data);TclAcWidget.onSSE(data);}); stream.onerror=()=>TclAcWidget.disconnected();
      </script></html>`);
  } catch (error) { res.statusCode = 500; res.end(String(error)); }
});
try {
  await mock.client.test();
  stopWatch = mock.client.watch(broadcast);
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + port);
  const card = page.locator('#tile1 .sh-tcl-ac');
  const ctl = (name) => card.locator('[data-ac-control="' + name + '"]');
  await card.waitFor();
  assert.equal(await page.locator('.sh-tcl-ac').count(), 2, 'one AC card per dedicated duplicate widget');
  assert.equal(await page.locator('#smart-home .sh-tcl-ac').count(), 0, 'Smart Home keeps its existing renderer');
  assert.equal(await page.locator('#smart-home [data-entity-id="' + p.climate + '"]').count(), 1, 'the selected TCL climate remains an ordinary Smart Home tile');
  assert.equal(await page.locator('#smart-home .sh-card-slot--ac').count(), 0);
  assert.deepEqual(await page.evaluate(() => getHomeAssistantSettings()), initialConfig);
  assert.deepEqual(await page.evaluate(() => settingsPatches), [], 'mounting AC never rewrites Smart Home settings');
  const climateSlot = page.locator('#smart-home [data-entity-id="' + p.climate + '"]');
  assert.equal(await climateSlot.evaluate((node) => node.style.getPropertyValue('--sh-card-w')), '6');
  assert.equal(await climateSlot.evaluate((node) => node.style.getPropertyValue('--sh-card-h')), '2');
  assert.equal(await climateSlot.evaluate((node) => node.closest('[data-section-id]').dataset.sectionId), 'shs_bed');
  assert.equal(await page.locator('[data-entity-id="' + p.fan + '"]').count(), 0, 'no duplicate sibling tiles');
  assert.equal(await page.locator('[data-entity-id="light.desk"]').count(), 1);
  assert.equal(await page.locator('[data-entity-id="climate.other"]').count(), 1);
  assert.equal(await page.locator('[data-ac-control="heat"]').count(), 0);
  assert.equal(await ctl('fan').inputValue(), 'Auto');
  assert.match(await card.locator('.sh-ac-room').innerText(), /28.5/);
  console.log('PASS dedicated AC duplicates, original Smart Home renderer/settings/layout, other devices and cooling modes');

  config = { ...config, entities: [] };
  await page.evaluate((next) => { config = next; }, config);
  broadcast();
  await page.waitForFunction(() => !document.querySelector('#smart-home [data-entity-id]'));
  assert.equal(await page.locator('.sh-tcl-ac').count(), 2);
  assert.equal(await ctl('power').isDisabled(), false, 'AC works without any Smart Home entity selection');
  const independentState = await (await fetch('http://127.0.0.1:' + port + '/api/homeassistant/state')).json();
  assert.deepEqual(independentState.entities, []);
  assert.deepEqual(independentState.tclAc.map((entity) => entity.id), tcl.ids);
  config = structuredClone(initialConfig);
  await page.evaluate((next) => { config = next; }, config);
  broadcast();
  await page.locator('#smart-home [data-entity-id="light.desk"]').waitFor();
  console.log('PASS independent AC snapshots with empty Smart Home selection');

  await page.evaluate(() => {
    const duplicate = document.querySelector('#tile1').closest('.pager-page').cloneNode(true);
    duplicate.querySelector('section').id = 'tile3';
    document.querySelector('main').appendChild(duplicate);
    TclAcWidget.renderWidgets();
  });
  const copiedMore = page.locator('#tile3 [data-ac-control="more"]');
  await copiedMore.click();
  assert.equal(await copiedMore.getAttribute('aria-expanded'), 'true', 'cloned AC widget has live listeners');
  await copiedMore.click();
  await page.evaluate(() => document.querySelector('#tile3').closest('.pager-page').remove());
  assert.equal(await page.locator('.sh-tcl-ac').count(), 2);
  console.log('PASS cloned initialized widget mounts interactive controls');

  serviceDelay = 120;
  await ctl('plus').dblclick();
  await page.waitForFunction(() => document.querySelector('.sh-ac-feedback').textContent.includes('Waiting'));
  assert.equal(serviceCalls.length, 1, 'rapid duplicate clicks send once');
  assert.deepEqual(mock.calls.at(-1).service_data, { temperature: 26.5 });
  assert.equal(await card.locator('.sh-ac-temperature strong').innerText(), '26', 'no optimistic temperature');
  assert.equal(await page.locator('#tile2 [data-ac-control="plus"]').isDisabled(), true);
  mock.update(p.climate, { attributes: { temperature: 26.5 } });
  await page.waitForFunction(() => document.querySelector('.sh-ac-temperature strong').textContent === '26.5');
  serviceDelay = 0;
  const action = async (name, value, expected) => {
    if (value !== null) await ctl(name).selectOption(value); else await ctl(name).click();
    await page.waitForFunction(() => document.querySelector('.sh-ac-feedback').textContent.includes('Waiting'));
    const call = mock.calls.at(-1);
    assert.deepEqual({ domain: call.domain, service: call.service, target: call.target, data: call.service_data }, expected);
    const id = expected.target.entity_id;
    mock.update(id, { state: expected.data.option ?? expected.data.hvac_mode ?? (expected.service === 'turn_on' ? 'on' : 'off') });
    await page.waitForFunction(() => document.querySelector('.sh-ac-feedback').hidden);
  };
  for (const [field, option] of [['fan', 'Medium'], ['vertical', 'Bottom fix'], ['horizontal', 'Right fix']]) {
    await action(field, option, { domain: 'select', service: 'select_option', target: { entity_id: p[field] }, data: { option } });
  }
  for (const field of ['eco', 'soft']) await action(field, null, { domain: 'switch', service: 'turn_on', target: { entity_id: p[field] }, data: {} });
  await ctl('more').click();
  await action('sleep', 'Child', { domain: 'select', service: 'select_option', target: { entity_id: p.sleep }, data: { option: 'Child' } });
  for (const field of ['display', 'beep']) await action(field, null, { domain: 'switch', service: 'turn_on', target: { entity_id: p[field] }, data: {} });
  await action('dry', null, { domain: 'climate', service: 'set_hvac_mode', target: { entity_id: p.climate }, data: { hvac_mode: 'dry' } });
  await action('power', null, { domain: 'climate', service: 'set_hvac_mode', target: { entity_id: p.climate }, data: { hvac_mode: 'off' } });
  await action('power', null, { domain: 'climate', service: 'set_hvac_mode', target: { entity_id: p.climate }, data: { hvac_mode: 'dry' } });
  console.log('PASS exact payloads for temperature, modes, all 4 selects and all 4 switches; power restores mode');

  const genericCalls = mock.calls.length;
  await page.locator('#smart-home [data-entity-id="' + p.eco + '"] .sh-item--toggle').click();
  const genericDeadline = Date.now() + 5000;
  while (mock.calls.length === genericCalls && Date.now() < genericDeadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(mock.calls.length, genericCalls + 1, 'original Smart Home TCL switch still sends its generic service');
  const genericCall = mock.calls.at(-1);
  assert.deepEqual({ domain: genericCall.domain, service: genericCall.service, target: genericCall.target, data: genericCall.service_data }, { domain: 'homeassistant', service: 'toggle', target: { entity_id: p.eco }, data: {} });
  mock.update(p.eco, { state: 'off' });
  await page.waitForFunction(() => document.querySelector('[data-ac-control="eco"]').getAttribute('aria-pressed') === 'false');
  console.log('PASS unchanged Smart Home TCL switch toggle through the existing service route');

  await ctl('fan').focus();
  mock.update(p.climate, { attributes: { current_temperature: 29 } });
  await page.waitForFunction(() => document.querySelector('.sh-ac-room').textContent.includes('29'));
  assert.equal(await page.evaluate(() => document.activeElement.dataset.acControl), 'fan');
  mock.update(p.fan, null);
  await page.waitForFunction(() => document.querySelector('[data-ac-control="fan"]').disabled);
  assert.equal(await ctl('eco').isDisabled(), false);
  mock.update(p.climate, { state: 'unavailable' });
  await page.waitForFunction(() => document.querySelector('[data-ac-control="eco"]').disabled);
  mock.update(p.climate, { state: 'cool', attributes: { current_temperature: null, temperature: 36 } });
  await page.waitForFunction(() => document.querySelector('.sh-ac-room').textContent.includes('28.5'));
  assert.equal(await ctl('plus').isDisabled(), true);
  mock.update(p.climate, { attributes: { temperature: 16 } });
  await page.waitForFunction(() => document.querySelector('[data-ac-control="minus"]').disabled);
  await page.evaluate(() => TclAcWidget.disconnected());
  assert.equal(await ctl('power').isDisabled(), true);
  broadcast();
  await page.waitForFunction(() => !document.querySelector('[data-ac-control="power"]').disabled);
  console.log('PASS focus, missing siblings, climate unavailable, fallback sensor, bounds and reconnect');

  for (const reply of [{ status: 200, body: { ok: false, error: 'mock_rejected' } }, { status: 503, body: { ok: true } }]) {
    serviceReply = reply;
    await ctl('plus').click();
    await card.locator('.sh-ac-error').waitFor({ state: 'visible' });
    assert.equal(await ctl('plus').isDisabled(), true);
    serviceReply = null;
    await ctl('refresh').click();
    await page.waitForFunction(() => !document.querySelector('[data-ac-control="plus"]').disabled);
  }
  serviceDelay = 12500;
  serviceReply = { status: 503, body: { ok: false, error: 'mock_delayed_failure' } };
  await ctl('plus').click();
  await card.locator('.sh-ac-error').waitFor({ state: 'visible', timeout: 18000 });
  assert.equal(await ctl('plus').isDisabled(), true, 'request timeout requires refresh');
  serviceDelay = 0; serviceReply = null;
  await ctl('refresh').click();
  await page.waitForFunction(() => !document.querySelector('[data-ac-control="plus"]').disabled);
  await ctl('plus').click();
  await page.waitForFunction(() => document.querySelector('.sh-ac-error').textContent.includes('No matching'), null, { timeout: 25000 });
  assert.equal(await ctl('plus').isDisabled(), true);
  await ctl('refresh').click();
  await page.waitForFunction(() => !document.querySelector('[data-ac-control="plus"]').disabled);
  console.log('PASS HTTP errors, ok:false, request/readback timeouts and required refresh before retry');

  await ctl('more').focus();
  mock.update('sensor.pm25', { state: '12' });
  await page.waitForFunction(() => document.querySelector('[data-entity-id="sensor.pm25"]').textContent.includes('12'));
  assert.equal(await page.evaluate(() => document.activeElement.dataset.acControl), 'more', 'button focus survives other device updates');
  const expanded = await ctl('more').getAttribute('aria-expanded');
  await page.keyboard.press('Enter');
  assert.notEqual(await ctl('more').getAttribute('aria-expanded'), expanded, 'keyboard toggles advanced controls');

  const denied = await fetch('http://127.0.0.1:' + port + '/api/homeassistant/service', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 403);
  assert.equal(JSON.stringify(await (await fetch('http://127.0.0.1:' + port + '/api/homeassistant/state')).json()).includes('mock-only-token'), false);
  await page.evaluate(() => { config = { ...config, tileLayout: 'rooms' }; document.activeElement.blur(); SmartHome.renderWidgets(); });
  assert.equal(await page.locator('.sh-tcl-ac').count(), 2);
  await page.evaluate(() => { config = { ...config, tileLayout: 'custom' }; SmartHome.renderWidgets(); });
  await page.evaluate(() => {
    window.savedMockConfig = config;
    config = { ...config, url: 'http://mock.invalid', tokenSet: true, entities: ['light.desk', 'sensor.pm25', 'climate.other'] };
    SmartHome.initSettings();
  });
  const climatePicker = page.locator('.sh-set-check').filter({ has: page.locator('.sh-set-check-id', { hasText: p.climate }) }).locator('input');
  await climatePicker.check();
  const selected = await page.evaluate(() => lastSettingsPatch.entities);
  assert.deepEqual(selected.slice(0, 3), ['light.desk', 'sensor.pm25', 'climate.other']);
  assert.deepEqual(selected, ['light.desk', 'sensor.pm25', 'climate.other', p.climate], 'selecting TCL climate does not add companions');
  const companionPicker = page.locator('.sh-set-check').filter({ has: page.locator('.sh-set-check-id', { hasText: p.eco }) }).locator('input');
  assert.equal(await companionPicker.isEnabled(), true, 'companion remains independently selectable');
  await companionPicker.check();
  assert.deepEqual(await page.evaluate(() => lastSettingsPatch.entities), [...selected, p.eco]);
  await climatePicker.uncheck();
  assert.deepEqual(await page.evaluate(() => lastSettingsPatch.entities), ['light.desk', 'sensor.pm25', 'climate.other', p.eco], 'deselecting climate preserves an independently selected companion');
  await page.evaluate(() => { config = savedMockConfig; document.querySelector('#settings-smarthome-hub').replaceChildren(); SmartHome.renderWidgets(); });
  assert.deepEqual(await page.evaluate(() => getHomeAssistantSettings()), initialConfig, 'original entity order, sections and sizes remain intact');
  assert.equal(await page.locator('#smart-home .sh-tcl-ac').count(), 0);
  mock.update(p.fan, { entity_id: p.fan, state: 'Medium', attributes: { options: ['Auto', 'Medium', 'High'] } });
  mock.update(p.climate, { attributes: { temperature: 26, current_temperature: 28.5 } });
  await page.waitForFunction(() => document.querySelector('.sh-ac-temperature strong').textContent === '26');
  await mkdir(output, { recursive: true });
  for (const [name, width, height] of [['edge', 2560, 720], ['desktop', 1440, 1000], ['portrait', 720, 1280], ['narrow', 320, 900]]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: resolve(output, name + '.png'), fullPage: true });
    if (name === 'edge') await page.locator('#tile1').screenshot({ path: resolve(output, 'tcl-ac-widget.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + ' page overflow');
    const overflow = await page.locator('.sh-tcl-ac').evaluateAll((cards) => cards.some((c) => c.scrollWidth > c.clientWidth + 1));
    assert.equal(overflow, false, name + ' card overflow');
    if (await ctl('more').getAttribute('aria-expanded') !== 'true') await ctl('more').click();
    await ctl('beep').click({ trial: true });
    assert.equal(await ctl('beep').isVisible(), true, name + ' advanced controls reachable');
    await ctl('power').click({ trial: true });
  }
  assert.deepEqual(errors, []);
  console.log('PASS keyboard/focus, other device updates, independent selection, preserved layout, loopback Origin, token redaction, room/custom modes, 2560x720, desktop, portrait and 320px');
  console.log('Screenshots: ' + output);
} finally {
  if (browser) await browser.close();
  if (stopWatch) stopWatch();
  for (const stream of streams) stream.end();
  await new Promise((r) => server.close(r));
  await mock.close();
}
