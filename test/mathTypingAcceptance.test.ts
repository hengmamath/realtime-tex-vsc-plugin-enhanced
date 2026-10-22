import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelTextChecks } from './bench/mathTypingChecks';

const expected = { has: ['EDITED'], lacks: ['DELETED'], stable: ['UNCHANGED'] };
const finalText = 'UNCHANGED EDITED';

test('missing unchanged text fails even when the final model is restored', () => {
  const checks = new ModelTextChecks(expected);
  checks.observe('EDITED');
  checks.observe(finalText);
  assert.equal(checks.stableBroken, 1);
  assert.deepEqual(checks.problems(finalText), ['preview model lost stable text in 1 snapshots']);
});

test('a transient duplicate fails even when the final model is correct', () => {
  for (const snapshot of ['UNCHANGED UNCHANGED EDITED', 'UNCHANGED EDITED EDITED']) {
    const checks = new ModelTextChecks(expected);
    checks.observe(snapshot);
    checks.observe(finalText);
    assert.equal(checks.duplicated, 1);
    assert.deepEqual(checks.problems(finalText), ['preview model duplicated text in 1 snapshots']);
  }
});

test('edited text can arrive later while unchanged text remains intact', () => {
  const checks = new ModelTextChecks(expected);
  checks.observe('UNCHANGED');
  checks.observe(finalText);
  assert.deepEqual(checks.problems(finalText), []);
});

test('final checks require unchanged text and reject old or duplicate text', () => {
  const checks = new ModelTextChecks(expected);
  assert.deepEqual(checks.problems('EDITED'), ['final model lacks UNCHANGED']);
  assert.deepEqual(checks.problems('UNCHANGED'), ['final model lacks EDITED']);
  assert.deepEqual(checks.problems('UNCHANGED EDITED DELETED'), ['final model still shows DELETED']);
  assert.deepEqual(checks.problems('UNCHANGED EDITED EDITED'), ['final model shows EDITED twice']);
});
