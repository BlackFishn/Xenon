'use strict';

// Host-owned editor for native Ambient canvas scenes. Geometry remains in the
// existing percentage schema; this module adds only draft/history and pointer
// interaction. The live component renderer stays in ambient-canvas.js.
(function () {
  if (typeof window === 'undefined') return;

  const SNAP_X = 100 / 24;
  const SNAP_Y = 100 / 12;
  const MIN_W = 8;
  const MIN_H = 8;
  const HISTORY_LIMIT = 20;
  let active = null;

  const ICONS = {
    add: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z"/></svg>',
    undo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7V3L2 9l7 6v-4c5 0 8.5 1.5 11 5-1-5-4-9-11-9Z"/></svg>',
    reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 1 1-7.4 11H7a6 6 0 1 0 1.2-6.8L11 11H3V3l3.8 3.8A7.9 7.9 0 0 1 12 4Z"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.4 5 12.6 12.6-1.4 1.4L5 6.4 6.4 5Zm11.2 0L19 6.4 6.4 19 5 17.6 17.6 5Z"/></svg>',
    done: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.2 17.2-4.4-4.4 1.4-1.4 3 3 8.6-8.6 1.4 1.4-10 10Z"/></svg>',
    move: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 4 4h-3v5h5V8l4 4-4 4v-3h-5v5h3l-4 4-4-4h3v-5H6v3l-4-4 4-4v3h5V6H8l4-4Z"/></svg>',
    remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 6V4h10v2h4v2h-2v12H5V8H3V6h4Zm0 2v10h10V8H7Zm2 2h2v6H9v-6Zm4 0h2v6h-2v-6Z"/></svg>',
    resize: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 19h6v-6h2v8h-8v-2Zm2-4 4-4v3h2V8h-6v2h3l-4 4 1 1Z"/></svg>',
  };

  function model() { return window.AmbientEditorModel; }
  function canvas() { return window.AmbientCanvas; }
  function stage() { return document.getElementById('ambient-canvas-stage'); }
  function overlay() { return document.getElementById('ambient-canvas-overlay'); }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function tt(key, fallback) {
    const value = typeof window.t === 'function' ? window.t(key) : key;
    return value === key ? fallback : value;
  }
  function clamp(value, lo, hi) { return Math.min(hi, Math.max(lo, value)); }
  function snap(value, step, bypass) { return bypass ? value : Math.round(value / step) * step; }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  function componentById(id) {
    return active && active.draft.components.find(component => component.id === id);
  }

  function button(className, label, icon, onClick) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = className;
    node.title = label;
    node.setAttribute('aria-label', label);
    node.innerHTML = icon + '<span></span>';
    node.querySelector('span').textContent = label;
    node.addEventListener('click', onClick);
    return node;
  }

  function iconButton(className, label, icon, onClick) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = className;
    node.title = label;
    node.setAttribute('aria-label', label);
    node.innerHTML = icon;
    node.addEventListener('click', onClick);
    return node;
  }

  function pushHistory(scene) {
    if (!active || !scene) return;
    active.history.push(clone(scene));
    if (active.history.length > HISTORY_LIMIT) active.history.shift();
  }

  function updateDock() {
    if (!active || !active.dock) return;
    active.undoButton.disabled = active.history.length === 0;
  }

  function decorateItems() {
    const root = stage();
    if (!active || !root) return;
    root.classList.add('is-editing');
    root.querySelectorAll('.ac-item').forEach(item => {
      const id = item.dataset.ambientId;
      const comp = componentById(id);
      if (!comp) return;
      item.classList.add('is-editable');
      item.classList.toggle('is-selected', id === active.selectedId);
      item.tabIndex = 0;
      item.setAttribute('aria-label', tt('ui_layout', 'Layout') + ': ' + comp.type);
      item.addEventListener('focus', () => select(id));
      item.addEventListener('pointerdown', event => {
        if (event.target.closest('button')) return;
        select(id);
        startPointer(event, 'move', id);
      });

      const grip = document.createElement('button');
      grip.type = 'button';
      grip.className = 'ambient-editor-grip';
      grip.innerHTML = ICONS.move + '<span class="ambient-editor-item-label"></span>';
      grip.querySelector('span').textContent = comp.type;
      grip.title = tt('layout_customize', 'Move widget');
      grip.setAttribute('aria-label', grip.title);
      grip.addEventListener('pointerdown', event => startPointer(event, 'move', id));

      const remove = iconButton('ambient-editor-remove', tt('ambient_scene_delete', 'Remove'), ICONS.remove, event => {
        event.stopPropagation();
        removeSelected(id);
      });
      const resize = iconButton('ambient-editor-resize', tt('layout_customize', 'Resize widget'), ICONS.resize, () => {});
      resize.addEventListener('pointerdown', event => startPointer(event, 'resize', id));
      const size = document.createElement('button');
      size.type = 'button';
      size.className = 'ambient-editor-size';
      size.textContent = Math.round(comp.w) + ' × ' + Math.round(comp.h);
      size.title = tt('layout_resize', 'Change widget size');
      size.setAttribute('aria-label', size.title);
      size.addEventListener('click', event => {
        event.stopPropagation();
        cycleSize(id);
      });
      item.append(grip, remove, resize, size);
      item.classList.toggle('is-compact-editor', item.getBoundingClientRect().height < 96);
    });
  }

  function renderDraft() {
    if (!active || !canvas() || !canvas().replaceScene(active.draft)) return false;
    decorateItems();
    updateDock();
    return true;
  }

  function select(id) {
    if (!active) return;
    active.selectedId = componentById(id) ? id : '';
    const root = stage();
    if (root) root.querySelectorAll('.ac-item').forEach(item => {
      item.classList.toggle('is-selected', item.dataset.ambientId === active.selectedId);
    });
  }

  function geometryForPointer(pointer, event) {
    const rect = pointer.rect;
    const dx = (event.clientX - pointer.clientX) / Math.max(1, rect.width) * 100;
    const dy = (event.clientY - pointer.clientY) / Math.max(1, rect.height) * 100;
    const start = pointer.start;
    const bypass = !!event.altKey;
    if (pointer.mode === 'resize') {
      const w = clamp(snap(start.w + dx, SNAP_X, bypass), MIN_W, 100 - start.x);
      const h = clamp(snap(start.h + dy, SNAP_Y, bypass), MIN_H, 100 - start.y);
      return { w, h };
    }
    const x = clamp(snap(start.x + dx, SNAP_X, bypass), 0, 100 - start.w);
    const y = clamp(snap(start.y + dy, SNAP_Y, bypass), 0, 100 - start.h);
    return { x, y };
  }

  function paintPointer(pointer, geometry) {
    const node = stage() && stage().querySelector(`.ac-item[data-ambient-id="${CSS.escape(pointer.id)}"]`);
    if (!node) return;
    if (geometry.x != null) node.style.left = geometry.x + '%';
    if (geometry.y != null) node.style.top = geometry.y + '%';
    if (geometry.w != null) node.style.width = geometry.w + '%';
    if (geometry.h != null) node.style.height = geometry.h + '%';
    const comp = { ...pointer.start, ...geometry };
    const size = node.querySelector('.ambient-editor-size');
    if (size) size.textContent = Math.round(comp.w) + ' × ' + Math.round(comp.h);
  }

  function onPointerMove(event) {
    if (!active || !active.pointer || event.pointerId !== active.pointer.pointerId) return;
    event.preventDefault();
    const px = event.clientX - active.pointer.clientX;
    const py = event.clientY - active.pointer.clientY;
    if (!active.pointer.activated && Math.hypot(px, py) < 6) return;
    active.pointer.activated = true;
    const geometry = geometryForPointer(active.pointer, event);
    active.pointer.geometry = geometry;
    active.pointer.changed = Object.keys(geometry).some(key => Math.abs(geometry[key] - active.pointer.start[key]) > 0.01);
    paintPointer(active.pointer, geometry);
  }

  function finishPointer(event) {
    if (!active || !active.pointer || event.pointerId !== active.pointer.pointerId) return;
    const pointer = active.pointer;
    active.pointer = null;
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', finishPointer, true);
    window.removeEventListener('pointercancel', finishPointer, true);
    if (event.type === 'pointercancel' || !pointer.changed) { renderDraft(); return; }
    pushHistory(pointer.before);
    active.draft = model().updateComponentGeometry(active.draft, pointer.id, pointer.geometry);
    renderDraft();
  }

  function startPointer(event, mode, id) {
    if (!active || active.pointer || !componentById(id)) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    select(id);
    const comp = componentById(id);
    active.pointer = {
      id,
      mode,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      rect: stage().getBoundingClientRect(),
      start: clone(comp),
      before: clone(active.draft),
      geometry: {},
      changed: false,
      activated: false,
    };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* detached target */ }
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', finishPointer, true);
    window.addEventListener('pointercancel', finishPointer, true);
  }

  function removeSelected(id) {
    if (!active) return;
    const targetId = id || active.selectedId;
    if (!componentById(targetId)) return;
    pushHistory(active.draft);
    active.draft = model().removeComponent(active.draft, targetId);
    active.selectedId = '';
    renderDraft();
  }

  function sizePresets(type) {
    if (type === 'date') return [[34, 10], [46, 14], [60, 18]];
    if (type === 'clock') return [[30, 20], [40, 28], [54, 38]];
    if (type === 'weather') return [[30, 24], [40, 34], [52, 44]];
    return [[32, 20], [40, 24], [54, 34]];
  }

  function cycleSize(id) {
    if (!active) return;
    const comp = componentById(id);
    if (!comp) return;
    const sizes = sizePresets(comp.type);
    let nearest = 0;
    let distance = Infinity;
    sizes.forEach(([w, h], index) => {
      const nextDistance = Math.abs(comp.w - w) + Math.abs(comp.h - h);
      if (nextDistance < distance) { distance = nextDistance; nearest = index; }
    });
    const [wantedW, wantedH] = sizes[(nearest + 1) % sizes.length];
    pushHistory(active.draft);
    active.draft = model().updateComponentGeometry(active.draft, id, {
      w: Math.min(wantedW, 100 - comp.x),
      h: Math.min(wantedH, 100 - comp.y),
    });
    active.selectedId = id;
    renderDraft();
  }

  function componentTemplate(type) {
    const index = active ? active.draft.components.length : 0;
    const offset = (index % 6) * 4;
    const common = { type, x: clamp(12 + offset, 0, 60), y: clamp(14 + offset, 0, 66), z: index + 1 };
    if (type === 'clock') return { ...common, w: 36, h: 24, props: { format: 'auto', seconds: false } };
    if (type === 'date') return { ...common, w: 34, h: 10, props: { variant: 'full' } };
    if (type === 'weather') return { ...common, w: 36, h: 30, props: { detail: true, art: true } };
    return { ...common, w: 40, h: 24, props: { art: true, controls: true } };
  }

  function addComponent(type) {
    if (!active || !['clock', 'date', 'weather', 'media'].includes(type)) return;
    const beforeIds = new Set(active.draft.components.map(component => component.id));
    pushHistory(active.draft);
    active.draft = model().addComponent(active.draft, componentTemplate(type));
    const added = active.draft.components.find(component => !beforeIds.has(component.id));
    active.selectedId = added ? added.id : '';
    active.addRow.classList.remove('is-open');
    renderDraft();
  }

  function undo() {
    if (!active || !active.history.length) return;
    active.draft = active.history.pop();
    if (!componentById(active.selectedId)) active.selectedId = '';
    renderDraft();
  }

  function reset() {
    if (!active || same(active.draft, active.baseline)) return;
    pushHistory(active.draft);
    active.draft = clone(active.baseline);
    active.selectedId = '';
    renderDraft();
  }

  function teardown() {
    if (!active) return null;
    const state = active;
    if (state.pointer) {
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', finishPointer, true);
      window.removeEventListener('pointercancel', finishPointer, true);
    }
    window.removeEventListener('keydown', onKeyDown, true);
    if (state.dockCleanup) state.dockCleanup();
    const root = stage();
    if (root) {
      if (state.stagePointerDown) root.removeEventListener('pointerdown', state.stagePointerDown);
      root.classList.remove('is-editing');
      root.querySelectorAll('.ac-item').forEach(item => {
        item.classList.remove('is-editable', 'is-selected');
        item.removeAttribute('tabindex');
        item.removeAttribute('aria-label');
        item.querySelectorAll('.ambient-editor-grip, .ambient-editor-remove, .ambient-editor-resize, .ambient-editor-size').forEach(node => node.remove());
      });
    }
    document.body.classList.remove('ambient-layout-editing');
    if (state.dock) state.dock.remove();
    active = null;
    return state;
  }

  function cancel() {
    if (!active) return false;
    const state = active;
    canvas().replaceScene(state.original);
    teardown();
    if (state.onCancel) state.onCancel(state.original);
    return true;
  }

  function done() {
    if (!active) return false;
    const state = active;
    let scene = state.draft;
    if (state.onDone) {
      scene = state.onDone(clone(scene));
      if (!scene) return false;
    }
    canvas().replaceScene(scene);
    teardown();
    return true;
  }

  function abort() {
    if (!active) return false;
    teardown();
    return true;
  }

  function nudge(key, large) {
    const comp = componentById(active && active.selectedId);
    if (!comp) return;
    const step = large ? 5 : 1;
    const patch = {};
    if (key === 'ArrowLeft') patch.x = clamp(comp.x - step, 0, 100 - comp.w);
    if (key === 'ArrowRight') patch.x = clamp(comp.x + step, 0, 100 - comp.w);
    if (key === 'ArrowUp') patch.y = clamp(comp.y - step, 0, 100 - comp.h);
    if (key === 'ArrowDown') patch.y = clamp(comp.y + step, 0, 100 - comp.h);
    if (!Object.keys(patch).length) return;
    pushHistory(active.draft);
    active.draft = model().updateComponentGeometry(active.draft, comp.id, patch);
    renderDraft();
  }

  function onKeyDown(event) {
    if (!active) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancel(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); event.stopImmediatePropagation(); undo(); return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && active.selectedId) {
      event.preventDefault(); event.stopImmediatePropagation(); removeSelected(); return;
    }
    if (event.key.startsWith('Arrow') && active.selectedId) {
      event.preventDefault(); event.stopImmediatePropagation(); nudge(event.key, event.shiftKey);
    }
  }

  function buildDock() {
    const dock = document.createElement('div');
    dock.className = 'ambient-editor-dock';
    dock.setAttribute('role', 'toolbar');
    dock.setAttribute('aria-label', tt('layout_customize', 'Edit Ambient layout'));
    const title = document.createElement('span');
    title.className = 'ambient-editor-dock-title';
    title.textContent = 'Ambient layout';
    const actions = document.createElement('div');
    actions.className = 'ambient-editor-actions';
    const add = button('ambient-editor-chip', tt('layout_add_widget', 'Add widget'), ICONS.add, () => {
      active.addRow.classList.toggle('is-open');
    });
    const undoButton = button('ambient-editor-chip', tt('ai_undo', 'Undo'), ICONS.undo, undo);
    const resetButton = button('ambient-editor-chip danger', tt('layout_reset', 'Reset layout'), ICONS.reset, reset);
    const cancelButton = button('ambient-editor-chip', tt('perf_sheet_cancel', 'Cancel'), ICONS.close, cancel);
    const doneButton = button('ambient-editor-chip primary', tt('layout_exit', 'Done'), ICONS.done, done);
    actions.append(add, undoButton, resetButton, cancelButton, doneButton);
    const addRow = document.createElement('div');
    addRow.className = 'ambient-editor-add-row';
    for (const type of ['clock', 'date', 'weather', 'media']) {
      const label = type[0].toUpperCase() + type.slice(1);
      addRow.appendChild(button('ambient-editor-add-chip', label, ICONS.add, () => addComponent(type)));
    }
    dock.append(title, actions, addRow);
    active.undoButton = undoButton;
    active.addRow = addRow;
    return dock;
  }

  function wireDockDrag(dock) {
    const handle = dock.querySelector('.ambient-editor-dock-title');
    if (!handle) return () => {};
    let drag = null;
    const move = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      const left = clamp(drag.left + event.clientX - drag.x, 8, Math.max(8, window.innerWidth - drag.width - 8));
      const top = clamp(drag.top + event.clientY - drag.y, 8, Math.max(8, window.innerHeight - drag.height - 8));
      dock.style.left = left + 'px';
      dock.style.top = top + 'px';
      dock.style.right = 'auto';
      dock.style.bottom = 'auto';
      dock.style.transform = 'none';
    };
    const up = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = null;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
    const down = event => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      const rect = dock.getBoundingClientRect();
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      try { handle.setPointerCapture(event.pointerId); } catch { /* detached */ }
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', up, true);
    };
    handle.addEventListener('pointerdown', down);
    return () => {
      handle.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }

  function open(scene, options = {}) {
    if (active || !model() || !canvas() || !canvas().isOpen()) return false;
    const original = model().createDraft(scene);
    if (!original) return false;
    let draft = original.imported
      ? model().forkImportedScene(original, { id: options.forkId, name: options.forkName })
      : model().createDraft(original);
    if (!draft) return false;
    active = {
      original,
      baseline: clone(draft),
      draft,
      history: [],
      selectedId: '',
      pointer: null,
      dock: null,
      addRow: null,
      undoButton: null,
      stagePointerDown: null,
      dockCleanup: null,
      onDone: typeof options.onDone === 'function' ? options.onDone : null,
      onCancel: typeof options.onCancel === 'function' ? options.onCancel : null,
    };
    active.dock = buildDock();
    overlay().appendChild(active.dock);
    active.dockCleanup = wireDockDrag(active.dock);
    document.body.classList.add('ambient-layout-editing');
    window.addEventListener('keydown', onKeyDown, true);
    active.stagePointerDown = event => {
      if (event.target === stage()) select('');
    };
    stage().addEventListener('pointerdown', active.stagePointerDown);
    renderDraft();
    return true;
  }

  window.AmbientEditor = { open, cancel, done, abort, undo, reset, isEditing: () => !!active };
})();
