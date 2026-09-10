import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const INDEX = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const MODE = readFileSync(new URL('../js/ambient-mode.js', import.meta.url), 'utf8');
const CANVAS = readFileSync(new URL('../js/ambient-canvas.js', import.meta.url), 'utf8');
const EDITOR = readFileSync(new URL('../js/ambient-editor.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../components/AmbientCanvas/AmbientEditor.css', import.meta.url), 'utf8');

test('Ambient surfaces expose host-owned layout edit buttons', () => {
  assert.match(INDEX, /id="ambient-builtin-edit"[^>]+type="button"/);
  assert.match(INDEX, /id="ambient-canvas-edit"[^>]+type="button"/);
  assert.match(INDEX, /AmbientMode\.edit\(\)/);
  assert.match(INDEX, /components\/AmbientCanvas\/AmbientEditor\.css/);
});

test('Ambient editor scripts load after the scene model and canvas renderer', () => {
  const scene = INDEX.indexOf('<script src="js/ambient-scene.js"');
  const model = INDEX.indexOf('<script src="js/ambient-editor-model.js"');
  const canvas = INDEX.indexOf('<script src="js/ambient-canvas.js"');
  const editor = INDEX.indexOf('<script src="js/ambient-editor.js"');
  assert.ok(scene >= 0 && scene < model);
  assert.ok(model < canvas && canvas < editor);
});

test('Canvas and Ambient mode expose the narrow editor lifecycle seams', () => {
  assert.match(CANVAS, /replaceScene, sceneSnapshot/);
  assert.match(MODE, /window\.AmbientMode = \{ toggle, open, close, edit,/);
  assert.match(EDITOR, /window\.AmbientEditor = \{ open, cancel, done, abort, undo, reset,/);
});

test('edit chrome is scoped and touch-safe', () => {
  assert.match(CSS, /body\.ambient-layout-editing/);
  assert.match(CSS, /\.ambient-canvas-stage\.is-editing/);
  assert.match(CSS, /\.ambient-editor-resize[\s\S]+touch-action: none/);
  assert.match(CSS, /@media \(pointer: coarse\)/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/);
});
