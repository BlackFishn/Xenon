// The call you are in, drawn the way Discord draws it: a tile per person with
// their picture, their name and a ring while they talk.
//
// Asked for by the fork's owner, looking at a strip of name chips: "show the
// avatars and who is speaking, like the real Discord". Two things about it can
// be run without a browser — how the stage is cut into tiles, and what stands
// in for a picture that has not arrived — and the rest is pinned at the source,
// because the rules that matter here are about what must NOT happen on a paint
// that runs every time someone opens their mouth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WIDGET = readFileSync(new URL('../js/discord-widget.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../components/DiscordWidget/DiscordWidget.css', import.meta.url), 'utf8');

function lift(name) {
  const at = WIDGET.indexOf('function ' + name + '(');
  assert.notEqual(at, -1, `js/discord-widget.js must still define ${name}`);
  return WIDGET.slice(at, WIDGET.indexOf('\n  }', at) + 4);
}
function constant(name) {
  const m = WIDGET.match(new RegExp('const ' + name + ' = ([^;]+);'));
  assert.ok(m, `js/discord-widget.js must still define ${name}`);
  // eslint-disable-next-line no-new-func
  return new Function('return ' + m[1])();
}

const MIN_W = constant('STAGE_MIN_W');
const MIN_H = constant('STAGE_MIN_H');
const MAX_H = constant('STAGE_MAX_H');
const GAP = constant('STAGE_GAP');
// eslint-disable-next-line no-new-func
const stageFit = new Function('STAGE_MIN_W', 'STAGE_MIN_H', 'STAGE_MAX_H', `${lift('stageFit')}; return stageFit;`)(MIN_W, MIN_H, MAX_H);
// eslint-disable-next-line no-new-func
const avatarFallback = new Function('AVATAR_TINTS', `${lift('avatarFallback')}; return avatarFallback;`)(constant('AVATAR_TINTS'));

// ── Cutting the stage ────────────────────────────────────────────────────────

test('five people in a roomy widget are three and two, not a row of pillars', () => {
  // The owner's own tile: about 800 × 400 of stage for a five-person channel.
  const fit = stageFit(5, 800, 404, GAP);
  assert.equal(fit.cols, 3);
  assert.ok(fit.w * 3 + GAP * 2 <= 800, 'three tiles and their gaps fit the width');
  assert.ok(fit.h * 2 + GAP <= 404, 'two rows and their gap fit the height');
  assert.ok(fit.w / fit.h > 1 && fit.w / fit.h < 2, `a card, not a strip (${fit.w}×${fit.h})`);
});

test('the grid follows the shape of the stage, not just the head-count', () => {
  assert.equal(stageFit(4, 900, 200, GAP).cols, 4, 'wide and short: one row');
  assert.equal(stageFit(4, 420, 500, GAP).cols, 2, 'squarer: two by two');
  assert.equal(stageFit(12, 800, 380, GAP).cols, 4, 'a dozen: four by three');
});

test('the tiles never outgrow the stage', () => {
  for (const n of [1, 2, 3, 5, 8, 12]) {
    for (const [w, h] of [[800, 404], [520, 300], [1400, 700]]) {
      const fit = stageFit(n, w, h, GAP);
      const rows = Math.ceil(n / fit.cols);
      // Only checked while the tiles are above their minimum: below it the stage
      // is meant to scroll, which is the next test.
      if (fit.h > MIN_H && fit.w > MIN_W) {
        assert.ok(fit.w * fit.cols + GAP * (fit.cols - 1) <= w, `${n} in ${w}×${h}: width`);
        assert.ok(fit.h * rows + GAP * (rows - 1) <= h, `${n} in ${w}×${h}: height`);
      }
    }
  }
});

test('a crowded call stops shrinking and scrolls instead', () => {
  const fit = stageFit(40, 500, 200, GAP);
  assert.ok(fit.w >= MIN_W && fit.h >= MIN_H, `still a tile you can read and press (${fit.w}×${fit.h})`);
  assert.equal(fit.crowded, true);
  assert.match(CSS, /\.dc-call-members\.is-crowded \{[^}]*overflow-y: auto/, 'and the stage is what scrolls');
});

test('a call that fits cannot grow a scrollbar', () => {
  // Found in the first build of this view: the stage was always scrollable, so
  // shrinking by one pixel (a font finishing loading) overflowed it for a
  // frame, the scrollbar took ten pixels of width, the third tile wrapped onto
  // a new row, and the overflow that had been one pixel was now a whole row —
  // permanently, since the scrollbar that caused it was also what kept it.
  assert.equal(stageFit(5, 800, 404, GAP).crowded, false);
  assert.equal(stageFit(12, 800, 380, GAP).crowded, false);
  const grid = CSS.slice(CSS.indexOf('@container dcw ((min-width: 560px)'));
  const stage = grid.slice(grid.indexOf('.dc-call-members {'), grid.indexOf('.dc-call-members.is-crowded'));
  assert.match(stage, /overflow: hidden;/);
  assert.doesNotMatch(stage, /overflow-y: auto/);
  assert.match(lift('layoutStage'), /stage\.classList\.toggle\('is-crowded', fit\.crowded\)/);
});

test('one or two people are cards, not banners or pillars', () => {
  const one = stageFit(1, 800, 404, GAP);
  assert.ok(one.h <= MAX_H, 'not the full height of the stage');
  assert.ok(one.w <= one.h * 2, `not the full width either (${one.w}×${one.h})`);
  const two = stageFit(2, 800, 404, GAP);
  assert.equal(two.cols, 2);
  assert.ok(two.h <= MAX_H);
  // What is left over is shared above and below — `safe`, so that when the
  // tiles overflow instead, the first row is not centred out of reach.
  assert.match(CSS, /align-content: flex-start; align-content: safe center;/);
});

test('nonsense sizes do not produce nonsense tiles', () => {
  for (const args of [[0, 800, 400], [5, 0, 0], [3, -10, 50]]) {
    const fit = stageFit(...args, GAP);
    assert.ok(Number.isFinite(fit.w) && Number.isFinite(fit.h) && fit.cols >= 1, JSON.stringify(args));
    assert.ok(fit.w >= MIN_W && fit.h >= MIN_H);
  }
});

// ── Before the picture arrives ───────────────────────────────────────────────

test('the stand-in is the first letter of the name', () => {
  assert.equal(avatarFallback({ id: '1', name: 'Kuncard' }).initial, 'K');
  assert.equal(avatarFallback({ id: '1', name: 'blackfishn' }).initial, 'B');
  assert.equal(avatarFallback({ id: '1', name: '@Cc' }).initial, 'C', 'punctuation is not a letter');
  assert.equal(avatarFallback({ id: '1', name: '9lives' }).initial, '9');
});

test('a Thai name gets its consonant, not the vowel written in front of it', () => {
  // เ แ โ ใ ไ are written BEFORE the consonant they follow. Alone, one of them
  // is a stray mark; the letter a reader would call the first is the next one.
  assert.equal(avatarFallback({ id: '1', name: 'เหลี่ยมโหดุน' }).initial, 'ห');
  assert.equal(avatarFallback({ id: '1', name: 'ชีวิตติดลิมิต' }).initial, 'ช');
  assert.equal(avatarFallback({ id: '1', name: 'ไ' }).initial, 'ไ', 'unless it is all there is');
});

test('a name with no letters, or no name, is a blank disc rather than a crash', () => {
  for (const m of [null, {}, { id: '5' }, { id: '5', name: '' }, { id: '5', name: '···' }]) {
    const fb = avatarFallback(m);
    assert.equal(fb.initial, '', JSON.stringify(m));
    assert.match(fb.tint, /^#[0-9a-f]{6}$/);
  }
});

test('the same person keeps the same colour', () => {
  const a = avatarFallback({ id: '175928847299117063', name: 'Bob' });
  const b = avatarFallback({ id: '175928847299117063', name: 'Bobby (renamed)' });
  assert.equal(a.tint, b.tint, 'keyed by id, so a nickname change does not repaint them');
});

// ── What a paint must not do ─────────────────────────────────────────────────

test('tiles are kept by member id, never rebuilt on a paint', () => {
  // paint() runs on every SPEAKING event. A stage rebuilt each time reloads every
  // picture and drops a press that was halfway down on a tile.
  const sync = lift('syncTiles');
  assert.match(sync, /n\.dataset\.dcId/);
  assert.match(sync, /box\.insertBefore\(tile, at\)/);
  assert.doesNotMatch(sync, /replaceChildren|innerHTML\s*=/);
  assert.doesNotMatch(lift('updateTile'), /createElement\(|\bel\(|innerHTML\s*=/, 'an update only flips classes and text');
});

test('a picture is loaded once per URL, and only over https', () => {
  const set = lift('setAvatar');
  assert.match(set, /m\.avatar\.startsWith\('https:\/\/'\)/, 'the server builds it; the page still checks');
  assert.match(set, /if \(av\.dataset\.dcSrc === src\) return;/, 'the same URL is left alone, loaded or failed');
  assert.match(set, /img\.addEventListener\('error', \(\) => img\.remove\(\)\)/, 'a failed picture is the letter underneath');
  assert.match(set, /img\.referrerPolicy = 'no-referrer'/, 'Discord is not told which dashboard asked');
  assert.match(CSS, /\.dc-tav-img \{[^}]*opacity: 0/, 'hidden until it has loaded: no broken-image glyph');
  assert.match(CSS, /\.dc-tav\.has-img \.dc-tav-img \{ opacity: 1; \}/);
});

test('names reach the page as text', () => {
  assert.match(lift('updateTile'), /name\.textContent = label/);
  const paint = WIDGET.slice(WIDGET.indexOf('function paint()'));
  assert.match(paint, /\.dc-call-speaking-txt'\)\.textContent = talking\.join\(', '\)/);
});

test('the stage is measured when the head-count changes, not on every paint', () => {
  const paint = WIDGET.slice(WIDGET.indexOf('function paint()'));
  assert.match(paint, /if \(stage\.dataset\.dcCount !== String\(members\.length\)\) \{/);
  assert.match(WIDGET, /new ResizeObserver\(\(entries\) => entries\.forEach\(\(e\) => layoutStage\(e\.target\)\)\)/,
    'and a resize reaches it without a paint at all');
  // offset*, so a scrollbar appearing cannot change the answer and start the
  // tiles and the scrollbar taking turns.
  assert.match(lift('layoutStage'), /stage\.offsetWidth, height = stage\.offsetHeight/);
});

// ── Which layout, and the things that stay true in both ──────────────────────

test('the widget picks grid or rows from its own box', () => {
  assert.match(CSS, /\.dc-wrap \{[^}]*container: dcw \/ size;/);
  assert.match(CSS, /@container dcw \(\(min-width: 560px\) and \(min-height: 400px\)\) or \(\(min-width: 460px\) and \(min-height: 520px\)\) \{/);
  // Rows are the default, so a widget too small for either threshold — and an
  // engine without container queries — still shows everyone.
  const base = CSS.slice(CSS.indexOf('.dc-call-members {'), CSS.indexOf('@container dcw'));
  assert.match(base, /grid-template-columns: repeat\(auto-fill, minmax\(220px, 1fr\)\)/);
});

test('your own tile is not a button, and everyone else\'s opens their volume', () => {
  const sync = lift('syncTiles');
  assert.match(sync, /const adjustable = canAdjust\(m\);/);
  assert.match(sync, /tile\.classList\.contains\('is-adjustable'\) !== adjustable/,
    'and a tile built before selfId arrived is rebuilt once it does');
  assert.match(lift('buildTile'), /el\(adjustable \? 'button' : 'div', 'dc-tile'\)/);
});

test('speaking outranks the open outline, on the tile and in the call bar', () => {
  const open = CSS.indexOf('.dc-tile.is-open {');
  const speaking = CSS.indexOf('.dc-tile.is-speaking {');
  assert.ok(open !== -1 && speaking > open, 'declared after .is-open, at the same specificity');
  assert.match(CSS, /\.dc-tile\.is-speaking \.dc-tav, \.dc-self\.is-speaking \.dc-tav \{ outline-color:/);
});
