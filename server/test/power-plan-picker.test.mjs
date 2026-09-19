import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'js', 'performance.js'), 'utf8');

test('unsupported power-plan picker falls back to the original optimizer', () => {
  const fetchPlans = source.slice(
    source.indexOf('async function fetchPowerPlans'),
    source.indexOf('// ── Power-plan picker'),
  );
  const showPlans = source.slice(
    source.indexOf('async function showPowerPlans'),
    source.indexOf('function aiAvailable'),
  );

  assert.match(fetchPlans, /error === 'unsupported_platform'\) return d/);
  assert.match(showPlans,
    /data\.error === 'unsupported_platform'[\s\S]*?_closePlanMenu\(\);[\s\S]*?optimize\(\);/);
});
