import { createRequire } from 'node:module';
import { once } from 'node:events';
const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');
export const tcl = require('../../../packages/core/src/tcl-ac.js');
export const ha = require('../../actions/home-assistant.js');

export function fixtureStates() {
  const p = tcl.profile;
  return [
    { entity_id: p.climate, state: 'cool', attributes: { friendly_name: 'แอร์ห้องนอน', temperature: 26, current_temperature: 28.5, min_temp: 16, max_temp: 36, target_temp_step: 0.5, temperature_unit: '°C', supported_features: 1, hvac_modes: ['off', 'cool', 'dry', 'fan_only', 'auto', 'heat'] } },
    ...Object.entries({ fan: ['Auto', 'Mute', 'Low', 'Medium', 'High', 'Strong'], vertical: ['Up and down swing', 'Top fix', 'Bottom fix'], horizontal: ['Left and right swing', 'Left fix', 'Right fix'], sleep: ['off', 'Standard', 'Elderly', 'Child'] }).map(([key, options]) => ({ entity_id: p[key], state: options[0], attributes: { friendly_name: key, options } })),
    ...['eco', 'soft', 'display', 'beep'].map((key) => ({ entity_id: p[key], state: 'off', attributes: { friendly_name: key } })),
    { entity_id: p.current, state: '28.5', attributes: { unit_of_measurement: '°C' } },
    { entity_id: 'light.desk', state: 'on', attributes: { friendly_name: 'Desk light' } },
    { entity_id: 'sensor.pm25', state: '8', attributes: { friendly_name: 'Air quality', unit_of_measurement: 'µg/m³' } },
    { entity_id: 'climate.other', state: 'heat', attributes: { friendly_name: 'Other thermostat', hvac_modes: ['off', 'heat'], temperature: 22 } },
  ];
}

export async function mockHa() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const states = new Map(fixtureStates().map((e) => [e.entity_id, e]));
  const calls = [];
  let readDelay = 0;
  server.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'auth_required' }));
    socket.on('message', (raw) => {
      const message = JSON.parse(raw);
      if (message.type === 'auth') { socket.send(JSON.stringify({ type: 'auth_ok' })); return; }
      if (message.type === 'call_service') calls.push(message);
      const result = message.type === 'get_states' ? [...states.values()] : [];
      const reply = () => { if (socket.readyState === 1) socket.send(JSON.stringify({ id: message.id, type: 'result', success: true, result })); };
      if (message.type === 'get_states' && readDelay) setTimeout(reply, readDelay); else reply();
    });
  });
  const client = ha.createHomeAssistant(async () => ({ baseUrl: 'http://127.0.0.1:' + server.address().port, token: 'mock-only-token' }));
  return {
    client, states, calls,
    delayReads(ms) { readDelay = ms; },
    update(id, patch) {
      const previous = states.get(id);
      const next = patch === null ? null : { ...previous, ...patch, attributes: { ...previous?.attributes, ...patch.attributes } };
      if (next) states.set(id, next); else states.delete(id);
      for (const socket of server.clients) if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'event', event: { data: { entity_id: id, new_state: next } } }));
    },
    async close() {
      client.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
