import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Model = require('../js/ambient-editor-model.js');
const SOURCE = readFileSync(new URL('../js/ambient-editor.js', import.meta.url), 'utf8');

class ClassList {
  constructor(node) { this.node = node; }
  values() { return new Set(String(this.node.className || '').split(/\s+/).filter(Boolean)); }
  add(...names) { const set = this.values(); names.forEach(name => set.add(name)); this.node.className = [...set].join(' '); }
  remove(...names) { const set = this.values(); names.forEach(name => set.delete(name)); this.node.className = [...set].join(' '); }
  toggle(name, force) {
    const set = this.values();
    const on = force == null ? !set.has(name) : !!force;
    if (on) set.add(name); else set.delete(name);
    this.node.className = [...set].join(' ');
    return on;
  }
}

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.classList = new ClassList(this);
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
  }
  set innerHTML(value) {
    this._innerHTML = value;
    if (String(value).includes('<span')) this.appendChild(new FakeNode('span'));
  }
  get innerHTML() { return this._innerHTML || ''; }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
  }
  setAttribute(name, value) { this[name] = String(value); }
  removeAttribute(name) { delete this[name]; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type) { this.listeners.delete(type); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const cls = selector.startsWith('.') ? selector.slice(1) : '';
    const out = [];
    const visit = node => {
      for (const child of node.children) {
        if (!cls || child.classList.values().has(cls)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 80 }; }
}

function loadEditor() {
  const stage = new FakeNode();
  const overlay = new FakeNode();
  const body = new FakeNode('body');
  const replacements = [];
  const window = {
    AmbientEditorModel: Model,
    AmbientCanvas: {
      isOpen: () => true,
      replaceScene: scene => { replacements.push(structuredClone(scene)); return true; },
    },
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1280,
    innerHeight: 720,
    t: key => key,
  };
  const document = {
    body,
    createElement: tag => new FakeNode(tag),
    getElementById: id => (id === 'ambient-canvas-stage' ? stage : id === 'ambient-canvas-overlay' ? overlay : null),
  };
  const context = vm.createContext({ window, document, console, CSS: { escape: value => value }, structuredClone });
  vm.runInContext(SOURCE, context);
  return { editor: window.AmbientEditor, replacements, body };
}

test('Cancel restores the original draft and never invokes save', () => {
  const { editor, replacements, body } = loadEditor();
  const scene = Model.createDefaultScene();
  let saves = 0;
  let cancels = 0;
  assert.equal(editor.open(scene, { onDone: () => { saves++; }, onCancel: () => { cancels++; } }), true);
  assert.equal(editor.isEditing(), true);
  assert.equal(body.classList.values().has('ambient-layout-editing'), true);
  assert.equal(editor.cancel(), true);
  assert.equal(saves, 0);
  assert.equal(cancels, 1);
  assert.deepEqual(replacements.at(-1), scene);
  assert.equal(editor.isEditing(), false);
});

test('Done saves exactly once and renders the committed scene returned by persistence', () => {
  const { editor, replacements } = loadEditor();
  const scene = Model.createDefaultScene();
  const committed = Model.createDefaultScene({ id: 'saved-scene', name: 'Saved' });
  let saves = 0;
  editor.open(scene, { onDone: () => { saves++; return committed; } });
  assert.equal(editor.done(), true);
  assert.equal(saves, 1);
  assert.deepEqual(replacements.at(-1), committed);
  assert.equal(editor.isEditing(), false);
});

test('a rejected save keeps the draft editor open', () => {
  const { editor } = loadEditor();
  editor.open(Model.createDefaultScene(), { onDone: () => null });
  assert.equal(editor.done(), false);
  assert.equal(editor.isEditing(), true);
  editor.abort();
});
