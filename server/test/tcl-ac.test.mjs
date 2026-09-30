import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureStates, mockHa, ha, tcl } from './fixtures/tcl-ac.mjs';
const p = tcl.profile;
const compact = () => fixtureStates().map((e) => ha.compactEntity(e));

test('TCL grouping expands all exact companions without dropping devices, order or settings', () => {
  const entities = ['light.desk', p.climate, 'climate.other', ...Array.from({ length: 97 }, (_, i) => 'sensor.s' + i)];
  const config = { url: 'http://localhost:8123', token: 'private', entities, tileLayout: 'custom', tileSections: [{ id: 'shs_room', title: 'Room', parent: '' }], tileCards: { 'light.desk': { width: 2, height: 2, section: 'shs_room' } }, energyEntities: ['sensor.power'], cameras: ['camera.door'] };
  const result = ha.normalizeHomeAssistant(config);
  assert.deepEqual(result.entities.slice(0, 100), entities);
  for (const id of tcl.ids) assert.ok(result.entities.includes(id));
  assert.equal(result.entities.length, 109);
  assert.deepEqual(ha.normalizeHomeAssistant(result), result, 'normalization is idempotent');
  assert.deepEqual(result.tileCards, config.tileCards);
  assert.deepEqual(result.tileSections, config.tileSections);
  assert.equal(ha.redactHaToken({ homeAssistant: result }).homeAssistant.token, '');
  assert.equal(ha.preserveHaToken({ homeAssistant: { ...result, token: '' } }, { homeAssistant: result }).homeAssistant.token, 'private');
  assert.ok(result.entities.includes('switch.split_ac_c8emtcvgaae_diplay_light_switch'));
  assert.deepEqual(tcl.expandSelection(['climate.other']), ['climate.other']);
});

test('TCL capability validation allows only live raw options, supported cooling modes and temperature steps', () => {
  const entities = compact();
  const check = (domain, service, id, data) => tcl.validate(domain, service, id, data, entities);
  assert.deepEqual(tcl.modes(entities[0]), ['off', 'cool', 'dry', 'fan_only', 'auto']);
  assert.equal(entities[0].unit, '°C');
  for (const temperature of [16, 26.5, 36]) assert.equal(check('climate', 'set_temperature', p.climate, { temperature }), null);
  for (const temperature of [15, 37, 26.25, '26', NaN]) assert.ok(check('climate', 'set_temperature', p.climate, { temperature }));
  assert.ok(check('climate', 'set_hvac_mode', p.climate, { hvac_mode: 'heat' }));
  assert.ok(check('climate', 'set_fan_mode', p.climate, { fan_mode: 'Auto' }));
  assert.equal(check('select', 'select_option', p.fan, { option: 'Medium' }), null);
  assert.ok(check('select', 'select_option', p.fan, { option: 'medium' }));
  assert.ok(check('select', 'select_option', p.fan, { option: 'Medium', entity_id: 'select.other' }));
  assert.ok(check('switch', 'toggle', p.eco, {}));
  assert.equal(check('switch', 'turn_on', p.eco, {}), null);
  entities[0].state = 'unavailable';
  assert.ok(check('switch', 'turn_on', p.eco, {}));
  assert.equal(check('climate', 'set_hvac_mode', 'climate.other', { hvac_mode: 'heat' }), null);
});

test('TCL backend rejects invalid payloads before forwarding and waits for reseeded HA connection', async () => {
  const mock = await mockHa();
  try {
    mock.delayReads(40);
    const connected = mock.client.test();
    assert.equal(mock.client.isConnected(), false);
    await connected;
    assert.equal(mock.client.isConnected(), true);
    const send = (id, service, data) => mock.client.callService(id.split('.')[0], service, { entity_id: id }, data);
    assert.equal((await send(p.climate, 'set_temperature', { temperature: 36.5 })).ok, false);
    assert.equal((await send(p.fan, 'select_option', { option: 'medium' })).ok, false);
    assert.equal(mock.calls.length, 0);
    assert.equal((await send(p.horizontal, 'select_option', { option: 'Left and right swing' })).ok, true);
    assert.deepEqual(mock.calls[0].target, { entity_id: p.horizontal });
    assert.deepEqual(mock.calls[0].service_data, { option: 'Left and right swing' });
    assert.equal((await send(p.climate, 'set_temperature', { temperature: 26.5 })).ok, true);
    assert.equal(mock.client.snapshot([p.climate])[0].target, 26, 'service success never invents state');
    mock.update(p.climate, { attributes: { temperature: 26.5 } });
    await mock.client.refreshStates();
    assert.equal(mock.client.snapshot([p.climate])[0].target, 26.5);
    mock.client.close();
    assert.equal(mock.client.isConnected(), false);
    mock.update(p.climate, { state: 'unavailable' });
    assert.equal((await send(p.eco, 'turn_on', {})).ok, false, 'reconnect revalidates current main climate state');
    assert.equal(mock.calls.length, 2);
    assert.equal((await send('climate.other', 'set_hvac_mode', { hvac_mode: 'heat' })).ok, true);
  } finally { await mock.close(); }
});
