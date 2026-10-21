import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uncommented } from './source-anchors-source.mjs';

test('TeX comments respect the parity of immediately preceding backslashes', () => {
  for (let n = 0; n < 6; n++) {
    const prefix = 'visible ' + '\\'.repeat(n);
    const line = prefix + '% hidden marker';
    assert.equal(uncommented(line), n % 2 ? line : prefix, `backslashes: ${n}`);
  }
  assert.equal(uncommented(String.raw`50\% visible % comment`), String.raw`50\% visible `);
  assert.equal(uncommented(String.raw`\command argument % comment`), String.raw`\command argument `);
  assert.equal(uncommented('% all comment'), '');
});
