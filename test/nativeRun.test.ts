import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Item } from '../src/protocol';
import { nativeGlyphRun } from '../webview/nativeRun';

const chars = new Map([[1, '\ue000'], [2, '\ue001'], [3, '\ue002'], [6401, '\u{f0000}']]);
const g = (id: number, x: number, opts: { font?: number; y?: number; ef?: number; sourceChar?: number } = {}): Item =>
  ['g', opts.font ?? 7, opts.sourceChar ?? 65, id, x, opts.y ?? 100, 123, opts.ef ?? 0];
const constantAdvance = () => 500;

test('contiguous glyph runs preserve mapped glyph identity and display-list order', () => {
  const items = [g(2, 30, { sourceChar: 102 }), g(6401, 530, { sourceChar: 0 }), g(1, 1030, { sourceChar: 0xfb03 })];
  assert.deepEqual(nativeGlyphRun(items, 0, chars, constantAdvance, 1), { text: '\ue001\u{f0000}\ue000', last: 2 });
  assert.deepEqual(nativeGlyphRun(items, 1, chars, constantAdvance, 1), { text: '\u{f0000}\ue000', last: 2 });
  assert.equal([...nativeGlyphRun(items, 0, chars, constantAdvance, 1)!.text].length, 3,
    'a ligature/unencoded glyph remains one mapped glyph; source Unicode is not reshaped');
});

test('kerning, glue, overprinting and reordered glyphs break runs at their TeX origins', () => {
  for (const x of [0, 498, 502, -500, 900]) {
    assert.deepEqual(nativeGlyphRun([g(1, 0), g(2, x)], 0, chars, constantAdvance, 1),
      { text: '\ue000', last: 0 }, `next origin ${x}`);
  }
  assert.deepEqual(nativeGlyphRun([g(1, 0), g(2, 500), g(3, 1300)], 0, chars, constantAdvance, 1),
    { text: '\ue000\ue001', last: 1 });
  assert.deepEqual(nativeGlyphRun([g(1, 0), g(2, 0)], 0, chars, () => 0, 1),
    { text: '\ue000', last: 0 }, 'zero-width overprints retain independent draws');
});

test('font, baseline, expansion and every intervening drawing operator terminate a run', () => {
  for (const next of [g(2, 500, { font: 8 }), g(2, 500, { y: 101 }), g(2, 500, { ef: 1 })]) {
    assert.equal(nativeGlyphRun([g(1, 0), next], 0, chars, constantAdvance, 1)!.last, 0);
  }
  const operators: Item[] = [['c', 0, 1, '1 0 0 rg'], ['M', 'save', 0, 0, ''], ['r', 0, 0, 5, 1],
    ['L', 'target', 0, 0, 1, 1], ['m', 'on', 0], ['u', 'unknown', '']];
  for (const op of operators) {
    assert.deepEqual(nativeGlyphRun([g(1, 0), op, g(2, 500)], 0, chars, constantAdvance, 1), { text: '\ue000', last: 0 });
  }
  const withoutExpansion: Item = ['g', 7, 65, 2, 500, 100, 123];
  assert.equal(nativeGlyphRun([g(1, 0), withoutExpansion], 0, chars, constantAdvance, 1)!.last, 1,
    'an omitted expansion value is the protocol default zero');
});

test('fractional advances use a cumulative one-sp bound without per-glyph rounding', () => {
  const exact = [g(1, 9), g(2, 11.6), g(3, 14.2), g(1, 16.8)];
  assert.equal(nativeGlyphRun(exact, 0, chars, () => 13, 0.2)!.last, 3);
  const roundedEveryGlyph = [g(1, 0), g(2, 3), g(3, 6), g(1, 9), g(2, 12)];
  assert.equal(nativeGlyphRun(roundedEveryGlyph, 0, chars, () => 13, 0.2)!.last, 2,
    'repeated 0.4sp discrepancies exceed one sp cumulatively at the fourth glyph');
  assert.equal(nativeGlyphRun([g(1, 0), g(2, 501)], 0, chars, constantAdvance, 1)!.last, 1);
  assert.equal(nativeGlyphRun([g(1, 0), g(2, 501.001)], 0, chars, constantAdvance, 1)!.last, 0);
});

test('missing/invalid glyph metadata cannot consume the next item or erase a valid starting glyph', () => {
  for (const id of [-1, 0.5, NaN, Infinity, 65536, 99]) {
    assert.equal(nativeGlyphRun([g(id, 0)], 0, chars, constantAdvance, 1), undefined);
    assert.deepEqual(nativeGlyphRun([g(1, 0), g(id, 500)], 0, chars, constantAdvance, 1), { text: '\ue000', last: 0 });
  }
  for (const width of [undefined, -1, NaN, Infinity]) {
    assert.deepEqual(nativeGlyphRun([g(1, 0), g(2, 500)], 0, chars, () => width, 1), { text: '\ue000', last: 0 });
  }
  assert.deepEqual(nativeGlyphRun([g(1, 0), g(2, 500), g(3, 1000)], 0, chars,
    id => id === 1 ? 500 : undefined, 1), { text: '\ue000\ue001', last: 1 });
  for (const value of [NaN, Infinity]) {
    assert.equal(nativeGlyphRun([g(1, value)], 0, chars, constantAdvance, 1), undefined);
    assert.equal(nativeGlyphRun([g(1, 0), g(2, value)], 0, chars, constantAdvance, 1)!.last, 0);
  }
  for (const mapped of ['', 'ab', '\ud800', '\ue000x']) {
    const invalidChars = new Map(chars); invalidChars.set(2, mapped);
    assert.equal(nativeGlyphRun([g(2, 0)], 0, invalidChars, constantAdvance, 1), undefined);
    assert.equal(nativeGlyphRun([g(1, 0), g(2, 500)], 0, invalidChars, constantAdvance, 1)!.last, 0);
  }
  for (const start of [-1, 0.5, 1, NaN]) assert.equal(nativeGlyphRun([g(1, 0)], start, chars, constantAdvance, 1), undefined);
  assert.equal(nativeGlyphRun([['r', 0, 0, 1, 1]], 0, chars, constantAdvance, 1), undefined);
});

test('bounded runs consume at most 64 glyphs and retain single draws for unusual scales', () => {
  const items = Array.from({ length: 130 }, (_, i) => g(1, 500 * i));
  assert.deepEqual(nativeGlyphRun(items, 0, chars, constantAdvance, 1), { text: '\ue000'.repeat(64), last: 63 });
  assert.deepEqual(nativeGlyphRun(items, 64, chars, constantAdvance, 1), { text: '\ue000'.repeat(64), last: 127 });
  assert.deepEqual(nativeGlyphRun(items, 128, chars, constantAdvance, 1), { text: '\ue000'.repeat(2), last: 129 });
  for (const scale of [-1, 0, NaN, Infinity]) {
    assert.deepEqual(nativeGlyphRun(items, 0, chars, constantAdvance, scale), { text: '\ue000', last: 0 });
  }
});
