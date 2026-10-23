import assert from 'node:assert/strict';
import { test } from 'node:test';
import { navigationKey, parsePageNumber, ReadingHistory, ReadingPosition } from '../webview/navigation';

const point = (page: number, fraction = 0, left = 0): ReadingPosition => ({ page, fraction, left });

test('history button availability follows visits, traversal, branching and document reset', () => {
  const history = new ReadingHistory();
  const available = () => [history.canMove('back'), history.canMove('forward')];
  assert.deepEqual(available(), [false, false]);
  assert.equal(history.move('back', point(1)), undefined);
  assert.deepEqual(available(), [false, false]);
  history.remember(point(1));
  assert.deepEqual(available(), [true, false]);
  assert.deepEqual(available(), [true, false], 'checking availability must not consume history');
  assert.deepEqual(history.move('back', point(2)), point(1));
  assert.deepEqual(available(), [false, true]);
  assert.deepEqual(history.move('forward', point(1)), point(2));
  assert.deepEqual(available(), [true, false]);
  history.move('back', point(2));
  history.remember(point(1, 0.5));
  assert.deepEqual(available(), [true, false], 'a new visit clears the previous forward branch');
  history.clear();
  assert.deepEqual(available(), [false, false]);
});

test('page input accepts only whole one-based pages within the current document', () => {
  assert.equal(parsePageNumber('1', 49), 1);
  assert.equal(parsePageNumber('49', 49), 49);
  assert.equal(parsePageNumber('  0028\n', 49), 28);
  assert.equal(parsePageNumber('1', 1), 1);
  assert.equal(parsePageNumber(String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  for (const value of ['', ' ', '0', '000', '-1', '+1', '1.0', '1.5', '1e1', '0x10', 'NaN', 'Infinity', '1 2', '１', '١', '49x', '50', '9007199254740992']) {
    assert.equal(parsePageNumber(value, 49), undefined, `reject ${JSON.stringify(value)}`);
  }
  for (const total of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parsePageNumber('1', total), undefined, `reject invalid page total ${total}`);
  }
});

test('reference visits return to the exact viewport and can go forward again', () => {
  const history = new ReadingHistory();
  const origin = point(3, 0.37, 655360);
  const equation = point(21, 0.12, 0);
  const appendix = point(43, 0.25, 0);
  history.remember(origin);
  history.remember(equation);
  assert.deepEqual(history.move('back', appendix), equation);
  assert.deepEqual(history.move('back', equation), origin);
  assert.equal(history.move('back', origin), undefined);
  assert.deepEqual(history.move('forward', origin), equation);
  assert.deepEqual(history.move('forward', equation), appendix);
  assert.equal(history.move('forward', appendix), undefined);
});

test('returning after a manual scroll remembers that reading position for forward', () => {
  const history = new ReadingHistory();
  const origin = point(2, 0.4);
  const scrolledTarget = point(12, 0.8);
  history.remember(origin);
  assert.deepEqual(history.move('back', scrolledTarget), origin);
  assert.deepEqual(history.move('forward', origin), scrolledTarget);
});

test('a new reference after returning discards the old forward branch', () => {
  const history = new ReadingHistory();
  history.remember(point(1));
  assert.deepEqual(history.move('back', point(2)), point(1));
  history.remember(point(1, 0.5));
  assert.equal(history.move('forward', point(3)), undefined);
  assert.deepEqual(history.move('back', point(3)), point(1, 0.5));
});

test('history is bounded, ignores duplicate positions and clears for a new document', () => {
  const history = new ReadingHistory(2);
  const first = point(1);
  history.remember(first);
  first.page = 99;
  history.remember(point(1));
  history.remember(point(2));
  history.remember(point(3));
  assert.deepEqual(history.move('back', point(4)), point(3));
  assert.deepEqual(history.move('back', point(3)), point(2));
  assert.equal(history.move('back', point(2)), undefined);
  history.clear();
  assert.equal(history.move('forward', point(1)), undefined);
});

test('only preview navigation shortcuts are captured', () => {
  const key = { key: '[', metaKey: true, altKey: false, ctrlKey: false, shiftKey: false };
  assert.equal(navigationKey(key), 'back');
  assert.equal(navigationKey({ ...key, key: ']' }), 'forward');
  assert.equal(navigationKey({ ...key, key: 'Unidentified', code: 'BracketLeft' }), 'back');
  assert.equal(navigationKey({ ...key, key: 'Unidentified', code: 'BracketRight' }), 'forward');
  assert.equal(navigationKey({ ...key, key: ']', code: 'BracketLeft' }), 'forward');
  assert.equal(navigationKey({ ...key, key: '[', code: 'BracketRight' }), 'back');
  assert.equal(navigationKey({ ...key, key: 'ArrowLeft' }), undefined);
  assert.equal(navigationKey({ ...key, key: 'ArrowRight' }), undefined);
  assert.equal(navigationKey({ ...key, key: 'ArrowLeft', metaKey: false, altKey: true }), 'back');
  assert.equal(navigationKey({ ...key, key: 'ArrowRight', metaKey: false, altKey: true }), 'forward');
  assert.equal(navigationKey({ ...key, metaKey: false }), undefined);
  assert.equal(navigationKey({ ...key, shiftKey: true }), undefined);
  assert.equal(navigationKey({ ...key, ctrlKey: true }), undefined);
  assert.equal(navigationKey({ ...key, altKey: true }), undefined);
  assert.equal(navigationKey({ ...key, key: 'a' }), undefined);
});
