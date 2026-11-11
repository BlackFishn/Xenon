import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../components/AudioSection/AudioSection.css', import.meta.url), 'utf8');
const JS = readFileSync(new URL('../js/volume.js', import.meta.url), 'utf8');
const LAYOUT_JS = readFileSync(new URL('../js/dashboard-layout.js', import.meta.url), 'utf8');

test('speaker renderer updates count and visibility without another polling loop', () => {
  const start = JS.indexOf('function renderSpeakerApps(apps)');
  const end = JS.indexOf('\nfunction onMicVolumeInput', start);
  const body = JS.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(body, /count\.textContent = String\(apps\.length\)/);
  assert.match(body, /mixer\.hidden = apps\.length === 0/);
  assert.doesNotMatch(body, /setInterval|requestAnimationFrame/);
});

test('Volume controls keep touch targets and a narrow-screen layout', () => {
  assert.match(CSS, /\.audio-block \.volume-wrap \{[\s\S]*?padding: 0;/);
  assert.match(CSS, /\.speaker-mixer \.app-mix-mute \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
  assert.match(CSS, /@media \(max-width: 580px\)[\s\S]*?grid-template-rows: auto auto;/);
  const workspace = CSS.slice(CSS.indexOf('/* ── Volume workspace'));
  assert.doesNotMatch(workspace, /animation\s*:|backdrop-filter\s*:/);
});

test('dashboard copies remove the singleton app mixer card', () => {
  const start = LAYOUT_JS.indexOf('function stripSpeakerMixerClone(clone)');
  const end = LAYOUT_JS.indexOf('\nfunction stripAudioClone', start);
  const body = LAYOUT_JS.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(body, /querySelector\('\.speaker-mixer'\)/);
  assert.match(body, /mixer\.remove\(\)/);
  assert.match(LAYOUT_JS, /function stripSystemClone[\s\S]*?stripSpeakerMixerClone\(clone\)/);
});
