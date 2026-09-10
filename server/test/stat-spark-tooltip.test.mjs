import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function sparkHelpers() {
  const context = { window: {}, document: { getElementById() {} } };
  vm.runInNewContext(read('server/js/utils.js') + `
    globalThis.__spark = {
      sample: _statSparkSample,
      record: _recordStatSparkSample,
      nearest: _statSparkNearestIndex,
      valueText: _statSparkValueText,
      timeText: _statSparkTimeText,
      windowMs: STAT_SPARK_WINDOW_MS,
      bucketMs: STAT_SPARK_BUCKET_MS,
      maxPoints: STAT_SPARK_MAX_POINTS,
    };`, context);
  return context.__spark;
}

test('the closest plotted point is selected and clamped at both edges', () => {
  const { nearest } = sparkHelpers();
  assert.equal(nearest(40, 0), 0);
  assert.equal(nearest(40, 0.5), 20);
  assert.equal(nearest(40, 1), 39);
  assert.equal(nearest(40, -2), 0);
  assert.equal(nearest(40, 3), 39);
  assert.equal(nearest(0, 0.5), -1);
});

test('a chart sample keeps plot scale, real display value, unit and time separate', () => {
  const { sample, valueText, timeText } = sparkHelpers();
  const at = new Date(2026, 8, 10, 21, 37, 12).getTime();
  const ping = sample(98, { value: 4, unit: 'ms', at });
  assert.equal(ping.plotValue, 98);
  assert.equal(ping.displayValue, 4);
  assert.equal(ping.unit, 'ms');
  assert.equal(ping.at, at);
  assert.match(valueText(ping), /^4 ms$/);
  assert.match(timeText(at), /21|9/);
});

test('missing readings never become a fake zero in the tooltip', () => {
  const { sample, valueText } = sparkHelpers();
  assert.equal(valueText(sample(0, { value: null, unit: 'fps', at: 1 })), '');
});

test('one-second input stays a bounded five-minute chart with the original 40-point ceiling', () => {
  const { sample, record, windowMs, bucketMs, maxPoints } = sparkHelpers();
  const hist = [];
  const start = new Date(2026, 8, 10, 21, 30, 0).getTime();
  for (let second = 0; second <= 360; second++) {
    record(hist, sample(second % 100, { value: second, unit: '%', at: start + second * 1000 }));
  }
  assert.ok(hist.length <= maxPoints, `${hist.length} points exceeds the SVG cap`);
  assert.ok(hist[hist.length - 1].at - hist[0].at <= windowMs, 'history exceeds five minutes');
  assert.equal(maxPoints, 40, 'the five-minute window must not grow SVG complexity');
  assert.ok(hist[hist.length - 1].at - hist[0].at >= windowMs - bucketMs, 'history is shorter than five minutes');
  assert.equal(hist[hist.length - 1].displayValue, 360, 'the live edge keeps the newest reading');
});

test('several updates inside eight seconds replace one bucket instead of growing the path', () => {
  const { sample, record } = sparkHelpers();
  const hist = [];
  const start = new Date(2026, 8, 10, 21, 30, 0).getTime();
  record(hist, sample(10, { value: 10, unit: '%', at: start + 100 }));
  record(hist, sample(20, { value: 20, unit: '%', at: start + 2000 }));
  record(hist, sample(30, { value: 30, unit: '%', at: start + 7900 }));
  assert.equal(hist.length, 1);
  assert.equal(hist[0].displayValue, 30);
});

test('live callers provide the real value instead of the normalized plot value', () => {
  const system = read('server/js/system.js');
  const network = read('server/js/network.js');
  assert.match(system, /Date\.parse\(data\.now/);
  assert.match(system, /fillEl\('cpu-fill', cpu, cpu, '%'\)/);
  assert.match(network, /value: ping, unit: 'ms'/);
  assert.match(network, /value: fps == null \? null : Math\.round\(fps\), unit: 'fps'/);
  assert.match(network, /value: lat, unit: 'ms'/);
});

test('the chart shows detail only while pointer or keyboard input is held', () => {
  const js = read('server/js/utils.js');
  const css = read('server/components/SystemPanel/SystemPanel.css');
  for (const event of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'keydown', 'keyup']) {
    assert.match(js, new RegExp(`addEventListener\\('${event}'`));
  }
  assert.doesNotMatch(js, /addEventListener\('click'[^\n]*statSpark/);
  assert.match(js, /ArrowLeft/);
  assert.match(js, /ArrowRight/);
  assert.match(css, /\.stat-spark-tooltip/);
  assert.match(css, /touch-action:\s*pan-y/);
});
