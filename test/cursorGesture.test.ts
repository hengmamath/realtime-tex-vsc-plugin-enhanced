import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cursorGesturePosition } from '../src/cursorGesture';

const start = { line: 12, character: 4 }, end = { line: 12, character: 11 };
const word = { start, end };
const caret = { start, end: start, active: start };
const selected = { ...word, active: end };
const wordAt = () => word;

test('single-click mode accepts a caret and ignores selection drags', () => {
  assert.deepEqual(cursorGesturePosition('singleClick', [caret], wordAt), start);
  assert.equal(cursorGesturePosition('singleClick', [selected], wordAt), undefined);
});

test('double-click mode requires a complete native word selection and targets its beginning', () => {
  assert.equal(cursorGesturePosition('doubleClick', [caret], wordAt), undefined);
  assert.deepEqual(cursorGesturePosition('doubleClick', [selected], wordAt), start);
  assert.deepEqual(cursorGesturePosition('doubleClick', [{ ...selected, active: start }], wordAt), start);
  assert.equal(cursorGesturePosition('doubleClick', [{ ...selected, end: { ...end, character: 9 } }], wordAt), undefined);
  assert.equal(cursorGesturePosition('doubleClick', [{ ...selected, end: { line: 13, character: 11 } }], wordAt), undefined);
  assert.equal(cursorGesturePosition('doubleClick', [selected], () => undefined), undefined);
});

test('off mode and multiple cursors never trigger a preview jump', () => {
  for (const selections of [[caret], [selected], [caret, caret], []]) {
    assert.equal(cursorGesturePosition('off', selections, wordAt), undefined);
  }
  assert.equal(cursorGesturePosition('singleClick', [caret, caret], wordAt), undefined);
  assert.equal(cursorGesturePosition('doubleClick', [selected, selected], wordAt), undefined);
});

test('native TeX punctuation and whitespace selections can reveal formulas without accepting partial words', () => {
  const text = String.raw`  \frac{a+b}{c} &= d`;
  for (const token of ['  ', '\\', '{', '+', '}{', '&=']) {
    const character = text.indexOf(token);
    const start = { line: 0, character }, end = { line: 0, character: character + token.length };
    assert.deepEqual(cursorGesturePosition('doubleClick', [{ start, end, active: end }], () => undefined, () => text), start, token);
  }
  const start = { line: 0, character: 4 }, end = { line: 0, character: 6 };
  assert.equal(cursorGesturePosition('doubleClick', [{ start, end, active: end }], () => undefined, () => text), undefined);
});

test('native editor words containing subscripts follow the configured separators', () => {
  const line = '  a_1+b_2';
  const start = { line: 0, character: 2 }, end = { line: 0, character: 5 };
  const selection = { start, end, active: end };
  assert.deepEqual(cursorGesturePosition('doubleClick', [selection], () => undefined, () => line, '+='), start);
  assert.equal(cursorGesturePosition('doubleClick', [selection], () => undefined, () => line, '_+='), undefined);
  assert.equal(cursorGesturePosition('doubleClick', [{ ...selection, end: { line: 0, character: 4 } }], () => undefined, () => line, '+='), undefined);
});

test('native bracket-content selections include starred environments and formula expressions', () => {
  for (const [line, token] of [[String.raw`\begin{align*}`, 'align*'], [String.raw`\frac{a+b}{c}`, 'a+b'], ['(a+b)', 'a+b']]) {
    const start = { line: 0, character: line.indexOf(token) }, end = { line: 0, character: line.indexOf(token) + token.length };
    assert.deepEqual(cursorGesturePosition('doubleClick', [{ start, end, active: end }], () => undefined, () => line, '+*{}()'), start);
    assert.equal(cursorGesturePosition('doubleClick', [{ start, end: { ...end, character: start.character + 2 }, active: end }],
      () => undefined, () => line, '+*{}()'), undefined, 'a partial bracket-content drag is still ignored');
  }
});
