import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { decodeSoundVolumeCsv } = require('../soundvolume-csv.js');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const MIC = readFileSync(new URL('../js/mic.js', import.meta.url), 'utf8');
const VOLUME = readFileSync(new URL('../js/volume.js', import.meta.url), 'utf8');

test('SoundVolumeView UTF-8 exports preserve non-ASCII device IDs and drop the BOM', () => {
  const csv = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('Microphone,Device,Capture,RØDE NT-USB Mini\n', 'utf8'),
  ]);

  const decoded = decodeSoundVolumeCsv(csv);
  assert.equal(decoded, 'Microphone,Device,Capture,RØDE NT-USB Mini\n');
  assert.ok(!decoded.startsWith('\uFEFF'));
});

test('microphone mute targets the live default endpoint and verifies the result', () => {
  const start = SERVER.indexOf('async function setMicMute(mute)');
  const end = SERVER.indexOf('\nasync function svvExec(args)', start);
  const body = SERVER.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(body, /svvExec\(\[action, 'DefaultCaptureDevice'\]\)/);
  assert.match(body, /await _getAudioInfoRaw\(\)/);
  assert.match(body, /actual === wanted/);
});

test('toggle route and microphone UI use confirmed hardware state', () => {
  const start = SERVER.indexOf("reqPath === '/toggle'");
  const end = SERVER.indexOf("reqPath === '/ping'", start);
  const route = SERVER.slice(start, end);

  assert.match(route, /await getAudioInfo\(\)/);
  assert.match(route, /await setMicMute\(!current\)/);
  assert.match(MIC, /!res\.ok \|\| typeof data\.muted !== 'boolean'/);
  assert.match(VOLUME, /applyUI\(!!data\.mic\.muted\)/);
});

test('microphone picker validates and confirms the requested default device', () => {
  const start = SERVER.indexOf('async function setDefaultMic(id)');
  const end = SERVER.indexOf('\nasync function svvExec(args)', start);
  const body = SERVER.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(body, /before\.mics\.find\(mic => mic\.id === wanted\)/);
  assert.match(body, /await svvExec\(\['\/SetDefault', wanted, 'all'\]\)/);
  assert.match(body, /after\.mic\.id !== wanted/);
});
