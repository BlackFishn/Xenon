// SDK scenes and canvas layouts with explicit backgrounds cover the wallpaper.
// Canvas layouts can also inherit the dashboard background; the settings note
// must explain only the scenes that cover it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SETTINGS = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const LOCK = readFileSync(new URL('../components/LockScreen/LockScreen.css', import.meta.url), 'utf8');
const CANVAS = readFileSync(new URL('../components/AmbientCanvas/AmbientCanvas.css', import.meta.url), 'utf8');

// ── The fact the note asserts ────────────────────────────────────────────────

// If any of these three ever changes, the note is telling the user something
// untrue — which is worse than the silence it replaced.
test('SDK and explicit canvas backgrounds stay opaque; inherited canvas backgrounds are transparent', () => {
  const rule = (css, sel) => {
    const at = css.indexOf(sel + ' {');
    assert.notEqual(at, -1, `${sel} must still exist`);
    return css.slice(at, css.indexOf('}', at));
  };
  assert.match(rule(LOCK, '.ambient-scene-overlay'), /background:\s*#000/, 'an SDK scene is opaque');
  assert.match(rule(CANVAS, '.ambient-canvas-overlay'), /background:\s*#000/, 'a canvas scene is opaque');
  assert.match(rule(CANVAS, '.ambient-canvas-overlay.uses-dashboard-background'), /background: linear-gradient/);
  assert.match(CANVAS, /body\.ambient-canvas-open \.shell \{ visibility: hidden/);
  // The classic one paints only translucent gradients — no opaque colour at all,
  // which is the whole reason a wallpaper reaches the screen behind it.
  const builtin = rule(LOCK, '.lockscreen-overlay');
  assert.match(builtin, /background:/, 'it still paints something');
  assert.ok(!/background:\s*#[0-9a-f]{3,6}\s*;/i.test(builtin), 'but never a flat opaque colour');
  assert.match(builtin, /rgba\(/, 'only translucent layers');
});

// ── When it is shown ─────────────────────────────────────────────────────────

test('the covers note excludes classic and dashboard-backed canvas scenes', () => {
  const fn = SETTINGS.slice(SETTINGS.indexOf('function syncAmbientSettings()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /const covers = cfg\.sceneId !== 'builtin' && selectedCanvas\?\.bg.type !== 'dashboard'/);
  assert.match(body, /sceneNote\.hidden = !covers/);
  // Classic widget toggles still belong only to the classic scene.
  assert.match(body, /builtinWidgets\.hidden = cfg\.sceneId !== 'builtin'/);
});

test('the note sits with the scene picker and starts hidden', () => {
  const row = HTML.slice(HTML.indexOf('id="settings-ambient-scene"'));
  const block = row.slice(0, row.indexOf('</div>'));
  assert.match(block, /id="settings-ambient-scene-note"/, 'it belongs to the scene row');
  assert.match(block, /<span[^>]*id="settings-ambient-scene-note"[^>]*\shidden[^>]*>/, 'and starts hidden');
});

// The language can change while Settings is open; the re-translate pass reads
// data-i18n, so text alone would freeze the note in the old language.
test('the note carries its key, not just its text', () => {
  const fn = SETTINGS.slice(SETTINGS.indexOf('const sceneNote ='));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(body, /setAttribute\('data-i18n', 'ambient_scene_covers'\)/);
  assert.match(body, /removeAttribute\('data-i18n'\)/, 'and drops it again on the classic scene');
});

// ── What it says ─────────────────────────────────────────────────────────────

test('the note is translated in every language the app ships', () => {
  const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];
  // ambient_scene_builtin too: the note names that option, so a language that
  // has the sentence but not the label points at a choice not in the list.
  for (const key of ['ambient_scene_covers', 'ambient_scene_builtin']) {
    const re = new RegExp(`(^|[\\s{,])${key}\\s*:`);
    const found = new Set();
    let cur = null;
    for (const line of I18N.split('\n')) {
      const ns = line.match(/^ {2}([a-z]{2}): \{/) || line.match(/^Object\.assign\(i18n\.([a-z]{2})/);
      if (ns) cur = ns[1];
      if (re.test(line)) found.add(cur);
    }
    assert.deepEqual(LANGS.filter((l) => !found.has(l)), [], `${key} is missing translations`);
  }
});
