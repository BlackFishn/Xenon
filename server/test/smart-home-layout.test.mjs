import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../js/smart-home.js', import.meta.url), 'utf8');
const SETTINGS = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');

function extractFunction(name, source = SRC) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  let depth = 0;
  const brace = source.indexOf('{', start);
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

test('custom Smart Home layout keeps every entity separate and in saved order', () => {
  const groupUnits = new Function('primaryEntity', `${extractFunction('groupUnits')}; return groupUnits;`)((items) => items[0]);
  const entities = [
    { id: 'sensor.air_humidity', device: 'esp32' },
    { id: 'sensor.air_pm25', device: 'esp32' },
    { id: 'sensor.air_temperature', device: 'esp32' },
  ];
  assert.deepEqual(groupUnits(entities, true).map((u) => u.entity.id), entities.map((e) => e.id));
  assert.equal(groupUnits(entities, false).length, 1, 'room mode retains the established device merge');
});

test('saved selection order wins over Home Assistant discovery order', () => {
  const selectedEntityOrder = new Function(`${extractFunction('selectedEntityOrder')}; return selectedEntityOrder;`)();
  const items = [{ id: 'sensor.a' }, { id: 'sensor.b' }, { id: 'sensor.c' }];
  assert.deepEqual(selectedEntityOrder(items, ['sensor.c', 'sensor.a', 'sensor.c', 'missing.x']), ['sensor.c', 'sensor.a']);
});

test('the client settings mirror persists only supported Smart Home layouts', () => {
  const normalize = new Function('normalizeCamAngles', `${extractFunction('normalizeHomeAssistantTileSections', SETTINGS)}\n${extractFunction('normalizeHomeAssistantTileCards', SETTINGS)}\n${extractFunction('normalizeHomeAssistant', SETTINGS)}; return normalizeHomeAssistant;`)(() => ({}));
  assert.equal(normalize({ tileLayout: 'custom' }).tileLayout, 'custom');
  assert.equal(normalize({ tileLayout: 'anything-else' }).tileLayout, 'rooms');
  const result = normalize({
    tileSections: [
      { id: 'shs_air', title: ' Air ', parent: '' },
      { id: 'shs_particles', title: 'Particles', parent: 'shs_air' },
      { id: 'bad id', title: 'Nope' },
    ],
    tileCards: { 'sensor.pm25': { width: 9, height: 2, section: 'shs_particles' }, bad: { width: 2 } },
  });
  assert.deepEqual(result.tileSections, [
    { id: 'shs_air', title: 'Air', parent: '' },
    { id: 'shs_particles', title: 'Particles', parent: 'shs_air' },
  ]);
  assert.deepEqual(result.tileCards, { 'sensor.pm25': { width: 4, height: 2, section: 'shs_particles' } });
});

test('custom mode is wired to the dense card grid rather than adaptive device panels', () => {
  assert.match(SRC, /const expanded = hasBoard && mode !== 'compact' && !custom;/);
  assert.match(SRC, /groupUnits\(items, custom\)/);
  assert.match(SRC, /buildBoard\(expanded, custom\)/);
  assert.match(SRC, /beginCardPointerDrag\(event, slot, e\.id\)/, 'card reorder uses Pointer Events for mouse and touch');
  assert.match(SRC, /addTileSection\(section\.id\)/, 'root sections expose a subsection action');
});
