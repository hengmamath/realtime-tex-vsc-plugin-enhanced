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
