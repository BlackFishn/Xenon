import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { makeDom } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const AmbientScene = require('../js/ambient-scene.js');
const Model = require('../js/ambient-editor-model.js');
const source = readFileSync(new URL('../js/ambient-canvas.js', import.meta.url), 'utf8');

function setup() {
  const { document, mkEl } = makeDom();
  const events = {}, timers = new Map();
  let timerId = 0, frames = 0, unregisters = 0;
  document.addEventListener = (type, fn) => { events[type] = fn; };
  document.createElement = (tag) => {
    const node = mkEl(tag);
    node.replaceWith = replacement => {
      const parent = node.parentNode, index = parent.children.indexOf(node);
      parent.children[index] = replacement; replacement.parentNode = parent; node.parentNode = null;
    };
    return node;
  };
  const overlay = mkEl('section'); overlay.id = 'ambient-canvas-overlay'; overlay.hidden = true;
  const stage = mkEl('div'); stage.id = 'ambient-canvas-stage'; overlay.append(stage); document.body.append(overlay);
  const CustomWidget = { unregisterCanvasFrames() { unregisters++; } };
  const window = { AmbientScene, CustomWidget, t: key => key };
  vm.runInNewContext(source, {
    window, document, AmbientScene, CustomWidget,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame() { frames++; },
  });
  return { api: window.AmbientCanvas, stage, overlay, document, events, timers, frames: () => frames, unregisters: () => unregisters };
}

test('geometry edits retain component bodies and timers without restarting embedded frames', () => {
  const h = setup(), scene = Model.createDefaultScene();
  assert.equal(h.api.mount(scene), true);
  const clock = h.stage.querySelector('.ac-item-clock'), body = clock.querySelector('.ac-body');
  for (let i = 0; i < 20; i++) {
    const changed = Model.updateComponentGeometry(scene, 'clock', { x: 7.01 + i / 10, h: 30.25 });
    assert.equal(h.api.replaceScene(changed), true);
    assert.equal(h.stage.querySelector('.ac-item-clock'), clock);
    assert.equal(clock.querySelector('.ac-body'), body);
  }
  assert.equal(clock.style.left, '8.91%');
  assert.equal(clock.style.height, '30.25%');
  assert.equal(h.timers.size, 1);
  assert.equal(h.frames(), 0);
  assert.equal(h.unregisters(), 0);
});

test('background changes preserve live widgets while toggling inherited backdrop ownership', () => {
  const h = setup(), scene = Model.createDefaultScene();
  h.api.mount(scene);
  const clock = h.stage.querySelector('.ac-item-clock');
  const background = h.stage.querySelector('.ac-bg');
  assert.equal(h.overlay.classList.contains('uses-dashboard-background'), true);
  h.api.replaceScene({ ...scene, bg: { type: 'color', color: '#123456' } });
  assert.equal(h.overlay.classList.contains('uses-dashboard-background'), false);
  assert.notEqual(h.stage.querySelector('.ac-bg'), background);
  assert.equal(h.stage.querySelector('.ac-bg').style.background, '#123456');
  assert.equal(h.stage.querySelector('.ac-item-clock'), clock);
});

test('prop changes still use the full renderer and its SDK cleanup path', () => {
  const h = setup(), scene = Model.createDefaultScene();
  h.api.mount(scene);
  const clock = h.stage.querySelector('.ac-item-clock');
  scene.components[0].props.seconds = true;
  h.api.replaceScene(scene);
  assert.notEqual(h.stage.querySelector('.ac-item-clock'), clock);
  assert.equal(h.unregisters(), 1);
  assert.equal(h.timers.size, 1);
});

test('Ambient reading updates sleep while hidden and stop completely on unmount', () => {
  const h = setup();
  h.api.mount(Model.createDefaultScene());
  assert.equal(h.timers.size, 1);
  assert.ok([...h.timers.values()][0].delay > 0 && [...h.timers.values()][0].delay <= 1000);
  h.document.hidden = true; h.events.visibilitychange();
  assert.equal(h.timers.size, 0);
  h.document.hidden = false; h.events.visibilitychange();
  assert.equal(h.timers.size, 1);
  h.api.unmount();
  assert.equal(h.timers.size, 0);
  assert.equal(h.stage.children.length, 0);
  assert.equal(h.document.body.classList.contains('ambient-canvas-open'), false);
  h.events.visibilitychange();
  assert.equal(h.timers.size, 0);
});
