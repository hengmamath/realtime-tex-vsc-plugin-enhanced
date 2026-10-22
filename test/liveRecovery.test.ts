import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RtexEvent } from '../src/protocol';
import { realEngineFixture, realEngineUnavailable } from './realEngineFixture';

type Fixture = Awaited<ReturnType<typeof realEngineFixture>>;

async function eventAfter(f: Fixture, after: number, matches: (event: RtexEvent) => boolean, what: string): Promise<RtexEvent> {
  for (const t0 = Date.now(); Date.now() - t0 < 30000;) {
    const hit = f.events.slice(after).find(matches);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('an unfinished \\left keeps the last good rows, reports after settling, and completes live', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const f = await realEngineFixture('live-recovery.tex');
  try {
    await f.start();
    const lastGood = await f.editMarker('RECOVERY-MARK');

    // The outer dollars are already closed; the inner fence is still being typed.
    const at = f.source.indexOf('RECOVERY-MARKX') + 'RECOVERY-MARKX'.length;
    const after = f.events.length;
    const result = await f.edit(at, at, ' $\\left( a$');
    assert.equal(result.routed, 'background', result.reasons.join(', '));
    assert.ok(result.reasons.includes('IncompleteMath'), result.reasons.join(', '));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(!f.events.slice(after).some((event) => event.event === 'ParagraphUpdate' && event.par_id === lastGood.par_id),
      'the unfinished fence must not replace the last good rows with a live error');
    assert.ok(!f.events.slice(after).some((event) => event.event === 'Diagnostics' && event.items.some((d) => d.severity === 'error')),
      'ordinary incomplete typing must not report an error before the settle delay');

    await eventAfter(f, after, (event) => event.event === 'LayoutUpdate' &&
      (event.source_revision ?? event.versions.source_revision) >= result.source_revision &&
      event.compile.state !== 'Ok', 'the settled unfinished formula');
    assert.ok(f.events.slice(after).some((event) => event.event === 'Diagnostics' &&
      event.source === 'background' && event.items.some((d) => d.severity === 'error')),
      'leaving the formula unfinished must still produce a real background diagnostic');
    assert.ok(!f.events.slice(after).some((event) => event.event === 'EngineState' && event.state !== 'Ready'),
      'an unfinished fence must not restart the live engine');

    // The erroneous full pass must not make this paragraph permanently ineligible.
    const fixing = f.events.length;
    const close = f.source.indexOf('\\left( a$') + '\\left( a'.length;
    const completed = await f.editLive(close, close, ' \\right)', 'completed formula');
    assert.equal(completed.diagnostics.length, 0);
    await eventAfter(f, fixing, (event) => event.event === 'LayoutUpdate' &&
      (event.source_revision ?? event.versions.source_revision) >= completed.versions.source_revision &&
      event.compile.state === 'Ok', 'the clean repaired layout');
    assert.ok(!f.events.slice(after).some((event) => event.event === 'EngineState' && event.state !== 'Ready'));
  } finally {
    await f.close();
  }
});

test('changed content recovers live after a real engine crash while failed content stays blocked', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const f = await realEngineFixture('crash-recovery.tex');
  try {
    await f.start();
    await f.editMarker('CRASH-MARK');
    const at = f.source.indexOf('\\maybecrash{0}') + '\\maybecrash{'.length;
    assert.ok(at >= '\\maybecrash{'.length, 'missing synthetic crash call');
    const after = f.events.length;
    const broken = await f.edit(at, at + 1, '1');
    assert.equal(broken.routed, 'fast', broken.reasons.join(', '));
    await eventAfter(f, after, (event) => event.event === 'EngineState' && event.state === 'Restarting', 'the synthetic engine crash');
    await eventAfter(f, after, (event) => event.event === 'EngineState' && event.state === 'Ready', 'the replacement live engine');

    // An identical replacement has a new editor revision but the exact same failed body.
    const repeated = await f.edit(at, at + 1, '1');
    assert.equal(repeated.routed, 'background', repeated.reasons.join(', '));
    assert.ok(repeated.reasons.some((reason) => reason.includes('this version hung or crashed')), repeated.reasons.join(', '));
    await f.editMarker('HEALTHY-MARK');

    // No preamble edit or manual restart: a changed body queues its bounded retry itself.
    const fixing = f.events.length;
    const fixed = await f.editLive(at, at + 1, '2', 'body corrected after the crash');
    assert.equal(fixed.diagnostics.length, 0);
    await eventAfter(f, fixing, (event) => event.event === 'LayoutUpdate' &&
      (event.source_revision ?? event.versions.source_revision) >= fixed.versions.source_revision &&
      event.compile.state === 'Ok', 'the corrected full layout');

    // A successful recovery cannot erase the history and retry previously crashing bytes.
    const recovered = f.events.length;
    const originalFailure = await f.edit(at, at + 1, '1');
    assert.equal(originalFailure.routed, 'background', originalFailure.reasons.join(', '));
    assert.ok(originalFailure.reasons.some((reason) => reason.includes('this version hung or crashed')),
      originalFailure.reasons.join(', '));
    await f.editMarker('HEALTHY-MARK');
    assert.ok(!f.events.slice(recovered).some((event) => event.event === 'EngineState' && event.state === 'Restarting'),
      'returning to a known failed body must not crash the live engine again');
    assert.equal(f.events.slice(after).filter((event) => event.event === 'EngineState' && event.state === 'Restarting').length, 1);
  } finally {
    await f.close();
  }
});
