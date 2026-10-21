import type { FollowCursorMode } from './followCursor';

interface CursorPosition { line: number; character: number }
interface CursorRange<P extends CursorPosition = CursorPosition> { start: P; end: P }
interface CursorSelection<P extends CursorPosition> extends CursorRange<P> { active: P }

function same(a: CursorPosition, b: CursorPosition): boolean {
  return a.line === b.line && a.character === b.character;
}

/** VS Code exposes mouse selection ranges rather than mouse click counts. A native
 * double-click selects a word; keyboard/command changes are filtered by the caller.
 * Ignore multiline/partial-word drags and multiple cursors. A drag or Shift-click
 * selecting exactly one whole word is indistinguishable through this public API. */
export function cursorGesturePosition<P extends CursorPosition>(
  mode: FollowCursorMode,
  selections: readonly CursorSelection<P>[],
  wordAt: (position: P) => CursorRange | undefined,
): P | undefined {
  if (mode === 'off' || selections.length !== 1) return undefined;
  const selection = selections[0];
  const empty = same(selection.start, selection.end);
  if (mode === 'singleClick') return empty ? selection.active : undefined;
  if (empty || selection.start.line !== selection.end.line) return undefined;
  const word = wordAt(selection.start);
  return word && same(word.start, selection.start) && same(word.end, selection.end) ? selection.start : undefined;
}
