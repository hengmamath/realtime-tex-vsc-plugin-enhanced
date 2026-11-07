import type { LayoutUpdateEvent } from '../../src/protocol';

export function isConvergedLayout(event: LayoutUpdateEvent, revision: number): boolean {
  return (event.source_revision ?? event.versions.source_revision) >= revision &&
    event.convergence?.state === 'Converged' && event.compile?.state === 'Ok';
}

/** passes and wall_ms accumulate within a background run, including its provisional layouts. */
export function layoutWork(layouts: LayoutUpdateEvent[]): { texRuns: number; fullCompileWallMs: number } {
  let texRuns = 0;
  let fullCompileWallMs = 0;
  let pending: LayoutUpdateEvent | undefined;
  for (const event of layouts) {
    const previous = pending;
    const continues = previous &&
      (previous.source_revision ?? previous.versions.source_revision) ===
        (event.source_revision ?? event.versions.source_revision) &&
      event.wall_ms >= previous.wall_ms &&
      (event.passes > previous.passes || (event.passes === 0 && event.compile.state === 'Failed'));
    // shortcut: count only reported completed passes until the protocol exposes failed attempts.
    texRuns += continues ? Math.max(0, event.passes - previous.passes) : event.passes;
    fullCompileWallMs += continues ? event.wall_ms - previous.wall_ms : event.wall_ms;
    pending = event.convergence.state === 'Stale' ||
      (event.convergence.state === 'Converging' && event.convergence.reasons.includes('another pass is running'))
      ? event : undefined;
  }
  return { texRuns, fullCompileWallMs };
}
