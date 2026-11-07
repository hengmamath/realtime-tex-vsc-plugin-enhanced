import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LayoutUpdateEvent } from '../src/protocol';
import { isConvergedLayout, layoutWork } from './bench/layoutMetrics';

function layout(overrides: Partial<LayoutUpdateEvent> = {}): LayoutUpdateEvent {
  return { event: 'LayoutUpdate', source_revision: 4,
    versions: { source_revision: 4, layout_version: 1, engine_generation: 1, context_revision: 1 },
    compile: { state: 'Ok' }, convergence: { state: 'Converged' }, passes: 2, wall_ms: 3000,
    pages_changed: [], pages_total: 1, placements: [], eligible_paragraphs: [], pdf_fallback: null,
    ...overrides };
}

const provisional = { state: 'Converging', pass: 1, reasons: ['another pass is running'] } as const;
const intermediate = () => layout({ passes: 1, wall_ms: 2000,
  convergence: { ...provisional, reasons: [...provisional.reasons] } });

test('convergence requires a successful, settled layout of the target snapshot', () => {
  assert.equal(isConvergedLayout(layout(), 4), true);
  assert.equal(isConvergedLayout(layout(), 5), false);
  assert.equal(isConvergedLayout(layout({ source_revision: 3 }), 4), false);
  assert.equal(isConvergedLayout(layout({ source_revision: undefined }), 4), true);
  const unsettled: LayoutUpdateEvent['convergence'][] = [intermediate().convergence,
    { state: 'PassLimitReached', passes: 5, reasons: ['aux changed'] },
    { state: 'Stale', pending_since: 5 }];
  for (const convergence of unsettled) {
    assert.equal(isConvergedLayout(layout({ convergence }), 4), false);
  }
  for (const compile of [{ state: 'Failed' } as const, { state: 'CompiledWithErrors', count: 1 } as const]) {
    assert.equal(isConvergedLayout(layout({ compile }), 4), false);
  }
});

test('provisional and final cumulative work is counted once, including repeated runs of one revision', () => {
  assert.deepEqual(layoutWork([intermediate(), layout(), layout({ passes: 1, wall_ms: 500 })]),
    { texRuns: 3, fullCompileWallMs: 3500 });
  assert.deepEqual(layoutWork([intermediate()]), { texRuns: 1, fullCompileWallMs: 2000 });
});

test('a changed snapshot or reset pass counter starts a new run', () => {
  assert.deepEqual(layoutWork([intermediate(), layout({ source_revision: 5 })]),
    { texRuns: 3, fullCompileWallMs: 5000 });
  assert.deepEqual(layoutWork([intermediate(), layout({ passes: 1, wall_ms: 2500 })]),
    { texRuns: 2, fullCompileWallMs: 4500 });
});

test('stale intermediate results and a failed final pass do not double count earlier work', () => {
  const stale = { state: 'Stale', pending_since: 5 } as const;
  assert.deepEqual(layoutWork([layout({ convergence: stale, passes: 1, wall_ms: 2000 }),
    layout({ convergence: stale }), layout({ source_revision: 5, passes: 1, wall_ms: 1000 })]),
  { texRuns: 3, fullCompileWallMs: 4000 });
  assert.deepEqual(layoutWork([intermediate(), layout({ passes: 0, compile: { state: 'Failed' },
    convergence: { state: 'PassLimitReached', passes: 0, reasons: ['capture failed'] } })]),
  { texRuns: 1, fullCompileWallMs: 3000 });
  assert.deepEqual(layoutWork([]), { texRuns: 0, fullCompileWallMs: 0 });
});
