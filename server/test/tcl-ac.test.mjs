import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fixtureStates, mockHa, ha, tcl } from './fixtures/tcl-ac.mjs';
const p = tcl.profile;
const compact = () => fixtureStates().map((e) => ha.compactEntity(e));

test('the dedicated TCL widget leaves Smart Home selections, order and settings unchanged', () => {
  const entities = ['light.desk', p.climate, 'climate.other', ...Array.from({ length: 97 }, (_, i) => 'sensor.s' + i)];
  const config = { url: 'http://localhost:8123', token: 'private', entities, tileLayout: 'custom', tileSections: [{ id: 'shs_room', title: 'Room', parent: '' }], tileCards: { 'light.desk': { width: 2, height: 2, section: 'shs_room' } }, energyEntities: ['sensor.power'], cameras: ['camera.door'] };
  const result = ha.normalizeHomeAssistant(config);
  assert.deepEqual(result.entities, entities);
  assert.equal(result.entities.length, 100);
  assert.deepEqual(ha.normalizeHomeAssistant(result), result, 'normalization is idempotent');
  assert.deepEqual(result.tileCards, config.tileCards);
  assert.deepEqual(result.tileSections, config.tileSections);
  assert.equal(ha.redactHaToken({ homeAssistant: result }).homeAssistant.token, '');
  assert.equal(ha.preserveHaToken({ homeAssistant: { ...result, token: '' } }, { homeAssistant: result }).homeAssistant.token, 'private');
  assert.equal(ha.normalizeHomeAssistant({ entities: [] }).entities.length, 0);
  assert.equal(tcl.profile.display, 'switch.split_ac_c8emtcvgaae_diplay_light_switch');
  assert.equal(tcl.ids.length, 10, 'dedicated snapshot maps all companions without adding Smart Home selections');
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
    const send = (id, service, data) => mock.client.callService(id.split('.')[0], service, { entity_id: id }, data, 'tcl-ac');
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
    assert.equal((await send('climate.other', 'set_hvac_mode', { hvac_mode: 'heat' })).ok, false, 'profile cannot target another device');
    assert.equal((await mock.client.callService('homeassistant', 'toggle', { entity_id: p.eco }, {})).ok, true, 'original Smart Home TCL switch remains usable');
    assert.equal((await mock.client.callService('climate', 'set_hvac_mode', { entity_id: 'climate.other' }, { hvac_mode: 'heat' })).ok, true);
    assert.equal((await mock.client.callService('switch', 'turn_on', { entity_id: p.eco }, {}, 'unknown-profile')).ok, false);
  } finally { await mock.close(); }
});

test('HA refresh preserves newer live changes and removals for both widgets', async () => {
  const mock = await mockHa();
  try {
    await mock.client.test();
    mock.delayReads(100);
    const refresh = mock.client.refreshStates();
    await delay(20);
    mock.update(p.climate, { attributes: { temperature: 27 } });
    mock.update('sensor.pm25', { state: '12' });
    mock.update(p.beep, null);
    await delay(20);
    assert.equal(mock.client.snapshot([p.climate])[0].target, 27);
    await refresh;
    assert.equal(mock.client.snapshot([p.climate])[0].target, 27, 'older get_states reply cannot undo live AC state');
    assert.equal(mock.client.snapshot(['sensor.pm25'])[0].state, '12', 'Smart Home updates survive refresh too');
    assert.deepEqual(mock.client.snapshot([p.beep]), [], 'removed entities cannot be resurrected');
  } finally { await mock.close(); }
});
