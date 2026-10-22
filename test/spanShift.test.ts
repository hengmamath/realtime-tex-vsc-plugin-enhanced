import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Span } from '../src/protocol';
import { shiftSpans } from '../src/spanShift';

const span = (id: number, start: number, end: number): Span => ({ id, range: { start, end }, kind: 'Body', hash: 0, last_revision: 1 });
const spans = [span(1, 0, 20), span(2, 22, 40), span(3, 42, 60)];
const outcome = (touched: number[], added: number[] = [], removed: number[] = []) => ({ touched, added, removed });

test('an edit inside one paragraph shifts the spans after it', () => {
  // a character typed in the middle of span 2
  assert.deepEqual(shiftSpans(spans, 30, 30, 1, outcome([2])), [span(1, 0, 20), span(2, 22, 41), span(3, 43, 61)]);
  // two bytes deleted from span 1
  assert.deepEqual(shiftSpans(spans, 5, 7, 0, outcome([1])), [span(1, 0, 18), span(2, 20, 38), span(3, 40, 58)]);
});

test('whitespace changed between paragraphs shifts the spans after it', () => {
  assert.deepEqual(shiftSpans(spans, 41, 41, 1, outcome([])), [span(1, 0, 20), span(2, 22, 40), span(3, 43, 61)]);
});

test('boundaries that may have moved are fetched again', () => {
  // split, merge or deletion of a whole span
  assert.equal(shiftSpans(spans, 30, 30, 2, outcome([2], [4])), undefined);
  assert.equal(shiftSpans(spans, 38, 44, 0, outcome([2], [], [3])), undefined);
  // the engine touched another span than the one around the edit, or the edit sits on a boundary
  assert.equal(shiftSpans(spans, 30, 30, 1, outcome([3])), undefined);
  assert.equal(shiftSpans(spans, 22, 22, 1, outcome([2])), undefined);
  assert.equal(shiftSpans(spans, 30, 30, 1, outcome([])), undefined);
  assert.equal(shiftSpans(spans, 30, 30, 1, outcome([2, 3])), undefined);
});
