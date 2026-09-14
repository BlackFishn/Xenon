import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Model = require('../js/ambient-editor-model.js');

test('default scene seeds schema-v1 Clock, Date, Weather, and Media geometry', () => {
  const scene = Model.createDefaultScene();
  assert.equal(scene.id, 'my-ambient');
  assert.equal(scene.v, 1);
  assert.equal(scene.bg.type, 'dashboard', 'customizing keeps the current dashboard background');
  assert.deepEqual(scene.components.map(component => component.type), ['clock', 'date', 'weather', 'media']);
  for (const component of scene.components) {
    assert.ok(component.x >= 0 && component.x <= 100);
    assert.ok(component.y >= 0 && component.y <= 100);
    assert.ok(component.w >= 2 && component.w <= 100);
    assert.ok(component.h >= 2 && component.h <= 100);
    assert.ok(component.x + component.w <= 100);
    assert.ok(component.y + component.h <= 100);
  }
  const other = Model.createDefaultScene();
  scene.components[0].props.seconds = true;
  assert.equal(other.components[0].props.seconds, false);
});

test('createDraft normalizes and deeply clones source data', () => {
  const source = Model.createDefaultScene({ id: 'draft-source' });
  const draft = Model.createDraft(source);
  draft.bg.color = '#ffffff';
  draft.components[0].props.seconds = true;
  assert.equal(source.bg.color, '#05060a');
  assert.equal(source.components[0].props.seconds, false);
});

test('forkImportedScene gives an imported scene a clean editable identity', () => {
  const source = {
    ...Model.createDefaultScene({ id: 'gallery-scene', name: 'Gallery Scene' }),
    imported: true,
    installId: 'xi_m5abc123deadbeef',
  };
  const fork = Model.forkImportedScene(source, { id: 'my-gallery', name: 'My Gallery' });
  assert.equal(fork.id, 'my-gallery');
  assert.equal(fork.name, 'My Gallery');
  assert.equal('imported' in fork, false);
  assert.equal('installId' in fork, false);
  assert.equal(source.imported, true);
  assert.equal(source.installId, 'xi_m5abc123deadbeef');
  fork.components[0].props.seconds = true;
  assert.equal(source.components[0].props.seconds, false);
});

test('geometry updates are immutable and normalized through AmbientScene bounds', () => {
  const source = Model.createDefaultScene();
  const changed = Model.updateComponentGeometry(source, 'clock', {
    x: -20, y: 999, w: 1, h: 999, rot: 999, z: -4, props: { seconds: true }, junk: 1,
  });
  const clock = changed.components.find(component => component.id === 'clock');
  assert.deepEqual(
    { x: clock.x, y: clock.y, w: clock.w, h: clock.h, rot: clock.rot, z: clock.z },
    { x: 0, y: 100, w: 2, h: 100, rot: 180, z: 0 },
  );
  assert.equal(clock.props.seconds, false);
  assert.equal(source.components.find(component => component.id === 'clock').x, 7);
});

test('components can be added with deterministic ids and removed without mutation', () => {
  const source = Model.createDefaultScene();
  const added = Model.addComponent(source, { type: 'clock', props: { seconds: true }, x: 10, y: 10, w: 20, h: 20 });
  assert.equal(source.components.length, 4);
  assert.equal(added.components.length, 5);
  assert.equal(added.components[4].id, 'clock-2');
  assert.equal(added.components[4].props.seconds, true);

  const removed = Model.removeComponent(added, 'weather');
  assert.equal(removed.components.some(component => component.id === 'weather'), false);
  assert.equal(added.components.some(component => component.id === 'weather'), true);
});

test('upsertScene immutably replaces in place and appends new ids', () => {
  const first = Model.createDefaultScene({ id: 'scene-one', name: 'One' });
  const second = Model.createDefaultScene({ id: 'scene-two', name: 'Two' });
  const original = [first];

  const replaced = Model.upsertScene(original, { ...first, name: 'One edited' });
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].name, 'One edited');
  assert.equal(original[0].name, 'One');
  assert.notEqual(replaced[0], original[0]);

  const appended = Model.upsertScene(replaced, second);
  assert.deepEqual(appended.map(scene => scene.id), ['scene-one', 'scene-two']);
  appended[1].components[0].props.seconds = true;
  assert.equal(second.components[0].props.seconds, false);
});

test('commitScene owns the stored list and active canvas reference', () => {
  const original = Model.createDefaultScene({ id: 'scene-one', name: 'One' });
  const edited = { ...original, name: 'One edited', imported: true, installId: 'xi_m5abc123deadbeef' };
  const result = Model.commitScene([original], edited, { enabled: true, idleMinutes: 5, sceneId: 'builtin' });
  assert.equal(result.ok, true);
  assert.equal(result.scenes.length, 1);
  assert.equal(result.scene.name, 'One edited');
  assert.equal('imported' in result.scene, false);
  assert.equal('installId' in result.scene, false);
  assert.equal(result.ambientMode.sceneId, 'canvas:scene-one');
  assert.equal(result.ambientMode.enabled, true);
});

test('commitScene refuses a missing 65th scene without creating a dead reference', () => {
  const scenes = Array.from({ length: 64 }, (_, index) => Model.createDefaultScene({
    id: 'scene-' + String(index).padStart(2, '0'),
    name: 'Scene ' + index,
  }));
  const mode = { enabled: true, idleMinutes: 5, sceneId: 'canvas:scene-00' };
  const rejected = Model.commitScene(scenes, Model.createDefaultScene({ id: 'scene-new' }), mode);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'limit');
  assert.equal(rejected.scenes.length, 64);
  assert.equal(rejected.ambientMode.sceneId, 'canvas:scene-00');
  assert.equal(rejected.scenes.some(scene => scene.id === 'scene-new'), false);

  const replacement = Model.commitScene(scenes, { ...scenes[0], name: 'Replaced' }, mode);
  assert.equal(replacement.ok, true);
  assert.equal(replacement.scenes.length, 64);
  assert.equal(replacement.scenes[0].name, 'Replaced');
});
