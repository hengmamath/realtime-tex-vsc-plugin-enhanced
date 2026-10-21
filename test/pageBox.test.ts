import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SP_PER_BP, SP_PER_PT } from '../src/protocol';
import { pageBox, pageGeometryKey } from '../webview/pageBox';

const PX_PER_BP = 96 / 72;
const A4 = [597.50787 * SP_PER_PT, 845.04684 * SP_PER_PT];
const LETTER = [614.295 * SP_PER_PT, 794.96999 * SP_PER_PT];

test('an A4 page at 100 % on a 2x screen is shown with exactly its own device pixels', () => {
  const k = PX_PER_BP / SP_PER_BP;
  const box = pageBox(A4[0], A4[1], k, 2);
  assert.deepEqual([box.pixelWidth, box.pixelHeight], [1587, 2245]);
  assert.deepEqual([box.cssWidth * 2, box.cssHeight * 2], [1587, 2245]);
  // separately rounded CSS pixels would have been shown in 1588 x 2246 device pixels
  assert.deepEqual([Math.round(A4[0] * k) * 2, Math.round(A4[1] * k) * 2], [1588, 2246]);
});

test('every zoom, panel width and screen scale maps canvas pixels 1:1 to the CSS box', () => {
  for (const [w, h] of [A4, LETTER, [455 * SP_PER_PT, 682 * SP_PER_PT]]) {
    for (const dpr of [1, 1.25, 1.5, 2, 2.4, 3]) {
      const scales = [25, 50, 67, 90, 100, 110, 125, 150, 175, 200, 300].map((z) => (z / 100) * (PX_PER_BP / SP_PER_BP));
      for (let avail = 120; avail < 2000; avail += 37) scales.push(avail / w);
      for (const k of scales) {
        const box = pageBox(w, h, k, dpr);
        assert.ok(Number.isInteger(box.pixelWidth) && Number.isInteger(box.pixelHeight));
        assert.ok(Math.abs(box.cssWidth * dpr - box.pixelWidth) < 1e-9, `width at dpr ${dpr}, scale ${k}`);
        assert.ok(Math.abs(box.cssHeight * dpr - box.pixelHeight) < 1e-9, `height at dpr ${dpr}, scale ${k}`);
        // the box stays within half a device pixel of the exact page size
        assert.ok(Math.abs(box.cssWidth - w * k) <= 0.5 / dpr + 1e-9 && Math.abs(box.cssHeight - h * k) <= 0.5 / dpr + 1e-9);
      }
    }
  }
});

test('a degenerate page still gets a drawable canvas', () => {
  assert.deepEqual(pageBox(0, 0, 1, 2), { pixelWidth: 1, pixelHeight: 1, cssWidth: 0.5, cssHeight: 0.5 });
});

test('fit width relayouts when screen scale changes but backing pixels stay the same', () => {
  const beforeScale = 950 / A4[0];
  const afterScale = 1900 / A4[0];
  const before = pageBox(A4[0], A4[1], beforeScale, 2);
  const after = pageBox(A4[0], A4[1], afterScale, 1);
  // Moving from a 2x screen to a 1x screen while widening the panel keeps the backing size.
  assert.deepEqual([before.pixelWidth, before.pixelHeight], [after.pixelWidth, after.pixelHeight]);
  assert.equal(beforeScale * 2, afterScale);
  assert.equal(before.cssWidth, 950);
  assert.equal(after.cssWidth, 1900);
  const beforeKey = pageGeometryKey(before, beforeScale, 2);
  const afterKey = pageGeometryKey(after, afterScale, 1);
  assert.notEqual(beforeKey, afterKey, 'changed CSS dimensions must invalidate the page geometry');
  assert.equal(pageGeometryKey(pageBox(A4[0], A4[1], afterScale, 1), afterScale, 1), afterKey);
  assert.equal(pageGeometryKey(pageBox(A4[0], A4[1], beforeScale, 2), beforeScale, 2), beforeKey);
});

test('a drawing scale change still invalidates geometry even when rounded dimensions match', () => {
  const beforeScale = 1;
  const afterScale = 1.0001;
  const before = pageBox(1000, 1400, beforeScale, 2);
  const after = pageBox(1000, 1400, afterScale, 2);
  assert.deepEqual(before, after);
  assert.notEqual(pageGeometryKey(before, beforeScale, 2), pageGeometryKey(after, afterScale, 2));
});
