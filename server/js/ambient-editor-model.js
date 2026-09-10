'use strict';

// Pure state helpers for the native Ambient scene editor. Runtime DOM/pointer
// handling belongs to ambient-editor.js; this module owns only normalized,
// immutable scene transitions so the editor can be tested without a browser.
(function (root) {
  function sceneApi() {
    if (root && root.AmbientScene) return root.AmbientScene;
    if (typeof require === 'function') return require('./ambient-scene.js');
    return null;
  }

  function clone(value) {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeScene(scene) {
    const AS = sceneApi();
    return AS && AS.normalizeScene ? AS.normalizeScene(clone(scene)) : null;
  }

  function validSceneId(value, fallback) {
    const AS = sceneApi();
    const id = String(value || '').trim().toLowerCase();
    return AS && AS.SCENE_ID_RE && AS.SCENE_ID_RE.test(id) ? id : fallback;
  }

  function createDraft(scene) {
    return normalizeScene(scene);
  }

  function createDefaultScene(options = {}) {
    const id = validSceneId(options.id, 'my-ambient');
    return normalizeScene({
      id,
      v: 1,
      name: typeof options.name === 'string' ? options.name : 'My Ambient',
      bg: { type: 'color', color: '#05060a', dim: 0, blur: 0 },
      components: [
        { id: 'clock', type: 'clock', x: 7, y: 20, w: 40, h: 28, z: 2, props: { format: 'auto', seconds: false } },
        { id: 'date', type: 'date', x: 7, y: 50, w: 40, h: 10, z: 3, props: { variant: 'full' } },
        { id: 'weather', type: 'weather', x: 53, y: 12, w: 40, h: 34, z: 2, props: { detail: true, art: true } },
        { id: 'media', type: 'media', x: 53, y: 52, w: 40, h: 24, z: 2, props: { art: true, controls: true } },
      ],
    });
  }

  function forkId(sceneId) {
    const suffix = '-copy';
    const raw = String(sceneId || 'ambient').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
    const base = (raw || 'ambient').slice(0, 41 - suffix.length).replace(/-+$/g, '') || 'ambient';
    return validSceneId(base + suffix, 'ambient-copy');
  }

  function forkImportedScene(scene, options = {}) {
    const source = normalizeScene(scene);
    if (!source) return null;
    const draft = clone(source);
    draft.id = validSceneId(options.id, forkId(source.id));
    draft.name = typeof options.name === 'string'
      ? options.name
      : ((source.name || 'My Ambient') + ' copy');
    delete draft.imported;
    delete draft.installId;
    return normalizeScene(draft);
  }

  function nextComponentId(scene, type) {
    const AS = sceneApi();
    const used = new Set((scene.components || []).map(component => component.id));
    const base = String(type || 'item').toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'item';
    if (AS.SCENE_ID_RE.test(base) && !used.has(base)) return base;
    for (let n = 2; n < 1000; n++) {
      const suffix = '-' + n;
      const candidate = base.slice(0, 41 - suffix.length).replace(/-+$/g, '') + suffix;
      if (AS.SCENE_ID_RE.test(candidate) && !used.has(candidate)) return candidate;
    }
    return null;
  }

  function addComponent(scene, component) {
    const AS = sceneApi();
    const draft = normalizeScene(scene);
    if (!AS || !draft || !component || typeof component !== 'object') return draft;
    if (draft.components.length >= AS.MAX_COMPONENTS) return draft;
    const requested = String(component.id || '');
    const duplicate = draft.components.some(item => item.id === requested);
    const id = (!duplicate && AS.SCENE_ID_RE.test(requested))
      ? requested
      : nextComponentId(draft, component.type);
    if (!id) return draft;
    const normalized = AS.normalizeComponent({ ...clone(component), id });
    if (!normalized) return draft;
    draft.components.push(normalized);
    return normalizeScene(draft);
  }

  function removeComponent(scene, componentId) {
    const draft = normalizeScene(scene);
    if (!draft) return null;
    draft.components = draft.components.filter(component => component.id !== componentId);
    return normalizeScene(draft);
  }

  function updateComponentGeometry(scene, componentId, patch) {
    const AS = sceneApi();
    const draft = normalizeScene(scene);
    if (!AS || !draft || !patch || typeof patch !== 'object') return draft;
    const index = draft.components.findIndex(component => component.id === componentId);
    if (index < 0) return draft;
    const allowed = ['x', 'y', 'w', 'h', 'rot', 'z'];
    const geometry = {};
    allowed.forEach(key => { if (Object.prototype.hasOwnProperty.call(patch, key)) geometry[key] = patch[key]; });
    const updated = AS.normalizeComponent({ ...draft.components[index], ...geometry });
    if (updated) draft.components[index] = updated;
    return normalizeScene(draft);
  }

  function upsertScene(scenes, scene) {
    const AS = sceneApi();
    if (!AS) return [];
    const list = AS.normalizeScenes(clone(Array.isArray(scenes) ? scenes : []));
    const next = normalizeScene(scene);
    if (!next) return list;
    const index = list.findIndex(item => item.id === next.id);
    if (index >= 0) list[index] = next;
    else list.push(next);
    return AS.normalizeScenes(list);
  }

  // One commit reducer shared by the browser persistence path and unit tests.
  // Refuse a 65th scene instead of allowing normalization to drop it while the
  // active reference points at an id that was never stored.
  function commitScene(scenes, scene, ambientMode) {
    const AS = sceneApi();
    const list = AS ? AS.normalizeScenes(clone(Array.isArray(scenes) ? scenes : [])) : [];
    const normalized = normalizeScene(scene);
    const mode = ambientMode && typeof ambientMode === 'object' ? clone(ambientMode) : {};
    if (!AS || !normalized) return { ok: false, reason: 'invalid', scenes: list, ambientMode: mode, scene: null };
    const owned = clone(normalized);
    delete owned.imported;
    delete owned.installId;
    const replacing = list.some(item => item.id === owned.id);
    if (!replacing && list.length >= AS.MAX_SCENES) {
      return { ok: false, reason: 'limit', scenes: list, ambientMode: mode, scene: null };
    }
    return {
      ok: true,
      reason: '',
      scenes: upsertScene(list, owned),
      ambientMode: { ...mode, sceneId: AS.canvasRef(owned.id) },
      scene: owned,
    };
  }

  const api = {
    createDraft,
    createDefaultScene,
    forkImportedScene,
    addComponent,
    removeComponent,
    updateComponentGeometry,
    upsertScene,
    commitScene,
  };

  if (root && typeof root === 'object') root.AmbientEditorModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
