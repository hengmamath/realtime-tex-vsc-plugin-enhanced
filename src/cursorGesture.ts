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
 * selecting a word, punctuation or bracket contents is indistinguishable through this public API. */
export function cursorGesturePosition<P extends CursorPosition>(
  mode: FollowCursorMode,
  selections: readonly CursorSelection<P>[],
  wordAt: (position: P) => CursorRange | undefined,
  lineText?: (line: number) => string,
  wordSeparators?: string,
): P | undefined {
  if (mode === 'off' || selections.length !== 1) return undefined;
  const selection = selections[0];
  const empty = same(selection.start, selection.end);
  if (mode === 'singleClick') return empty ? selection.active : undefined;
  if (empty || selection.start.line !== selection.end.line) return undefined;
  const word = wordAt(selection.start);
  if (word && same(word.start, selection.start) && same(word.end, selection.end)) return selection.start;
  // TeX's word pattern excludes operators, delimiters and whitespace selected by a double-click.
  const line = lineText?.(selection.start.line);
  const text = line?.slice(selection.start.character, selection.end.character);
  if (text && /^[^\p{L}\p{N}\p{M}]+$/u.test(text)) return selection.start;
  // Native double-clicks can select a whole bracket's contents, such as {align*}.
  if (text && ['{}', '[]', '()'].some(pair => line![selection.start.character - 1] === pair[0]
    && line![selection.end.character] === pair[1])) return selection.start;
  // Native mouse selection uses editor.wordSeparators, which can include a_1 as one word.
  const nativeWord = (ch: string) => !!ch && !/\s/.test(ch) && !wordSeparators!.includes(ch);
  return wordSeparators !== undefined && text && [...text].every(nativeWord)
    && !nativeWord(line![selection.start.character - 1] ?? '') && !nativeWord(line![selection.end.character] ?? '')
    ? selection.start : undefined;
}
