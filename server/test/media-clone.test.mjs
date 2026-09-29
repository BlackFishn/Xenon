import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/dashboard-layout.js', import.meta.url), 'utf8');

test('Media clones discard inherited stream URLs before attaching to the dashboard', () => {
  const match = source.match(/function stripYouTubeClone\([^]*?\n}/);
  assert.ok(match);
  const strip = vm.runInNewContext('(' + match[0] + ')');
  const mount = {
    dataset: { ytBuilt: '5' },
    children: [{ src: '/media/local/stream?owner=original-player' }],
    replaceChildren() { this.children = []; },
  };
  strip({ querySelectorAll(selector) { assert.equal(selector, '.youtube-widget-mount'); return [mount]; } });
  assert.deepEqual(mount.children, []);
  assert.equal(mount.dataset.ytBuilt, undefined);
  assert.match(source, /youtube:\s*stripYouTubeClone/);
  const creation = source.slice(source.indexOf('function createCopyAtom('));
  assert.match(creation, /stripCloneFor\(widget, clone\)/);
});
