// Source positions captured by the engine, selected in the exact frame currently drawn.
// No document searching or interpolation through comments is used here.
import type { DisplayList, Line, SourceAnchor } from './protocol';
import type { PreviewModel } from '../webview/model';
import type { TextChange } from './edits';
import type { RefinementHit } from './sourceRefinement';

const PT = 65536;

export interface SourceAnchorHit {
  file: string;
  line: number;
  revision: number;
  /** Read only on a source click. Keeps refinement in the exact displayed row/frame. */
  refinement?: RefinementHit;
}

/** Only project TeX files may be opened. Engine metadata must never become an arbitrary
 * path or URI supplied to the editor. */
export function sourceFile(file: string): string | undefined {
  if (!file || /\0|:/.test(file) || /^[\\/]/.test(file)) return undefined;
  const parts = file.split(/[\\/]/);
  if (parts.includes('..')) return undefined;
  const rel = parts.filter((p) => p && p !== '.').join('/');
  return /\.tex$/i.test(rel) ? rel : undefined;
}

function pick(anchors: readonly SourceAnchor[], x: number): SourceAnchor | undefined {
  // Interword spaces carry more reliable source information than math spacing. The
  // following space was read with the clicked word, including words before a source newline.
  for (const kind of ['g', 'mg'] as const) {
    const candidates = anchors.filter((a) => a.kind === kind && sourceFile(a.file)
      && Number.isSafeInteger(a.line) && a.line > 0 && Number.isFinite(a.x) && Number.isFinite(a.w)).sort((a, b) => a.x - b.x);
    const after = candidates.find((a) => a.x >= x - PT / 2);
    if (after) return after;
    if (candidates.length) return candidates[candidates.length - 1];
  }
  // Box metadata records the paragraph's closing line, not necessarily the clicked row.
  return undefined;
}

/** Hit the row actually visible, including translated live overlays and excluding the
 * background rows they hide. An unanchored row cannot borrow a neighbouring row's source. */
export function hitSourceAnchor(model: PreviewModel, page: number, x: number, y: number): SourceAnchorHit | undefined {
  let best: { line: Line; dl: DisplayList; dx: number; dy: number; vertical: number; horizontal: number } | undefined;
  const consider = (line: Line, dl: DisplayList, dx = 0, dy = 0) => {
    const vertical = Math.abs(y - (line.y + dy - 3 * PT));
    if (vertical > 40 * PT) return;
    const left = line.x + dx;
    const horizontal = Math.max(left - x, x - left - Math.max(0, line.w), 0);
    if (!best || vertical < best.vertical || (vertical === best.vertical && horizontal < best.horizontal)) {
      best = { line, dl, dx, dy, vertical, horizontal };
    }
  };
  // Overlay rows win exact ties, just as they do in the drawing code.
  for (const ov of model.overlaysOn(page)) for (const row of ov.rows) consider(row.line, ov.overlay.dl, row.dx, row.dy);
  const background = model.pages.get(page)?.dl;
  if (background) {
    const hidden = model.hiddenLines(page);
    background.lines.forEach((line, i) => { if (!hidden.has(i)) consider(line, background); });
  }
  const row = best as { line: Line; dl: DisplayList; dx: number; dy: number } | undefined;
  if (!row || !Number.isSafeInteger(row.dl.source_revision) || row.dl.source_revision! < 1) return undefined;
  const anchor = pick(row.line.source_anchors ?? [], x - row.dx);
  const file = anchor && sourceFile(anchor.file);
  if (!anchor || !file) return undefined;
  const hit: SourceAnchorHit = { file, line: anchor.line, revision: row.dl.source_revision! };
  // Keep the public location shape stable: this click-only payload must not be serialized
  // into source location messages or copied with every incoming display list.
  Object.defineProperty(hit, 'refinement', { value: {
    row: row.line, fonts: row.dl.fonts, x: x - row.dx, y: y - row.dy, file, line: anchor.line,
  } satisfies RefinementHit });
  return hit;
}

/** Compatibility fallback is reserved for engines without the new source-map protocol.
 * Missing anchors in a supported document must not revive the whole-proof ratio estimate. */
export function hasSourceAnchors(model: PreviewModel): boolean {
  for (const p of model.pages.values()) if (p.dl.source_revision !== undefined) return true;
  for (const ov of model.overlays.values()) if (ov.dl.source_revision !== undefined) return true;
  return false;
}

/** A successful layout also confirms the source base of pages whose ink and anchor
 * coordinates did not change. Advance that base without redrawing those pages, so undoing
 * a deletion/split does not leave their restored source lines tied to an obsolete revision. */
export function advanceBackgroundSourceRevision(model: PreviewModel, revision: number | undefined): void {
  if (!Number.isSafeInteger(revision) || revision! < 1) return;
  for (const page of model.pages.values()) {
    if (page.dl.source_revision !== undefined) page.dl.source_revision = revision;
  }
}

export interface SourceLineChange {
  file: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  addedLines: number;
  /** No previous buffer is available for a whole-document replacement. */
  unknown?: boolean;
  /** A confirmed identical replacement does not invalidate word/fragment geometry. */
  unchanged?: boolean;
  /** Whether the inserted text leaves a surviving end line free of an added prefix. */
  preservesEndLine?: boolean;
}

interface Entry extends SourceLineChange { revision?: number; failed?: boolean }

function position(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let start = 0;
  for (let i = 0; i < Math.min(offset, text.length); i++) if (text.charCodeAt(i) === 10) { line++; start = i + 1; }
  return { line, column: offset - start };
}

/** Prepare small line transforms before ShadowText applies a VS Code change batch. */
export function sourceLineChanges(file: string, before: string, changes: readonly (TextChange & {
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
})[]): SourceLineChange[] {
  const out: SourceLineChange[] = [];
  let text = before;
  const needsOffsets = changes.some((change) => !change.range);
  for (const change of changes) {
    // VS Code already provides line positions; use them without walking a long paper on
    // every keystroke. Offset-only callers (tests/full-buffer replacements) use the fallback.
    const start = change.range ? { line: change.range.start.line + 1, column: change.range.start.character } : position(text, change.rangeOffset);
    const end = change.range ? { line: change.range.end.line + 1, column: change.range.end.character } : position(text, change.rangeOffset + change.rangeLength);
    const unchanged = change.rangeLength === 0 && change.text.length === 0
      || ((needsOffsets || changes.length === 1) && text.slice(change.rangeOffset, change.rangeOffset + change.rangeLength) === change.text);
    out.push({ file, startLine: start.line, endLine: end.line, startColumn: start.column, endColumn: end.column,
      addedLines: (change.text.match(/\n/g) ?? []).length, unchanged,
      preservesEndLine: change.text.endsWith('\n') || (start.column === 0 && change.text.length === 0) });
    if (needsOffsets) text = text.slice(0, change.rangeOffset) + change.text + text.slice(change.rangeOffset + change.rangeLength);
  }
  return out;
}

/** Rebase source lines from a displayed snapshot through edits acknowledged by the engine.
 * Keystrokes store only line counts, never a copy of a paper per revision. Ambiguous deleted
 * lines and unacknowledged edits are rejected until a fresh display list arrives. */
export class SourceLineJournal {
  private entries: Entry[] = [];
  private floor = 0;

  clear(): void { this.entries = []; this.floor = 0; }

  submit(change: SourceLineChange): Entry {
    const entry: Entry = { ...change };
    this.entries.push(entry);
    // Bound long-running sessions. Pages older than the retained history are refused,
    // rather than incorrectly rebased. A fresh background pass makes them usable again.
    if (this.entries.length > 50000) {
      const first = this.entries[0];
      if (first.revision !== undefined) {
        this.floor = Math.max(this.floor, first.revision);
        this.entries.shift();
      }
    }
    return entry;
  }

  replace(file: string, before: string | undefined, after: string): Entry {
    if (before === undefined) return this.submit({ file, startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, addedLines: 0, unknown: true });
    if (before === after) return this.submit({ file, startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, addedLines: 0, unchanged: true });
    // Whole-buffer sends (file watcher/close/recovery) often leave most or all text
    // unchanged. Retain those lines instead of treating the entire file as deleted.
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let end = before.length;
    let nextEnd = after.length;
    while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
    const change = sourceLineChanges(file, before, [{ rangeOffset: start, rangeLength: end - start, text: after.slice(start, nextEnd) }])[0];
    return this.submit(change);
  }

  acknowledge(entry: Entry, revision: number | undefined): void {
    if (Number.isSafeInteger(revision) && revision! > 0) entry.revision = revision;
    else entry.failed = true;
  }

  rebase(file: string, line: number, fromRevision: number): number | undefined {
    return this.rebaseLocation(file, line, fromRevision, false);
  }

  /** Fine selection may use an old row only if its source line is still unchanged.
   * Changes elsewhere can move the whole line; edits within it retain the existing line
   * jump but wait for a fresh displayed frame before matching words or formulas. */
  refineLine(file: string, line: number, fromRevision: number): number | undefined {
    return this.rebaseLocation(file, line, fromRevision, true);
  }

  /** A bounded preceding context must remain unchanged as a whole: a delimiter edit on
   * another line could otherwise classify old prose as current display math (or vice versa).
   * Whole-line shifts before the context are safe; edits inside it require fresh geometry. */
  refineContext(file: string, firstLine: number, lastLine: number, fromRevision: number): { firstLine: number; lastLine: number } | undefined {
    if (!Number.isSafeInteger(firstLine) || !Number.isSafeInteger(lastLine)
      || firstLine < 1 || lastLine < firstLine || fromRevision < this.floor) return undefined;
    let first = firstLine;
    let last = lastLine;
    for (const edit of this.entries) {
      if (edit.file !== file) continue;
      if (edit.failed || edit.revision === undefined) return undefined;
      if (edit.revision <= fromRevision) continue;
      if (edit.unknown) return undefined;
      if (edit.unchanged || last < edit.startLine) continue;
      const delta = edit.addedLines - (edit.endLine - edit.startLine);
      if (first > edit.endLine) { first += delta; last += delta; continue; }
      // The edit can touch the first line's column zero only when it leaves all that
      // line's characters intact and merely shifts the complete context down or up.
      if (first === edit.endLine && edit.endColumn === 0 && edit.preservesEndLine) {
        first = edit.startLine + edit.addedLines;
        last += delta;
        continue;
      }
      return undefined;
    }
    return { firstLine: first, lastLine: last };
  }

  private rebaseLocation(file: string, line: number, fromRevision: number, unchangedLine: boolean): number | undefined {
    if (!Number.isSafeInteger(line) || line < 1 || fromRevision < this.floor) return undefined;
    let current = line;
    for (const edit of this.entries) {
      if (edit.file !== file) continue;
      // An edit might already be in the engine while its acknowledgement is queued in
      // the extension host. Waiting for that reply is safer than using its unknown base.
      if (edit.failed || edit.revision === undefined) return undefined;
      if (edit.revision <= fromRevision) continue;
      if (edit.unknown) return undefined;
      if (edit.unchanged) continue;
      if (current < edit.startLine) continue;
      if (current > edit.endLine) {
        current += edit.addedLines - (edit.endLine - edit.startLine);
        continue;
      }
      // Ordinary typing changes no source line number.
      if (edit.startLine === edit.endLine && edit.addedLines === 0) {
        if (unchangedLine) return undefined;
        continue;
      }
      // Inserting complete lines at column zero moves the old line intact.
      if (edit.startLine === edit.endLine && edit.startColumn === 0 && edit.endColumn === 0) {
        if (unchangedLine && !edit.preservesEndLine) return undefined;
        current += edit.addedLines;
        continue;
      }
      // A replacement ending at the next line's column zero leaves that line intact.
      if (current === edit.endLine && edit.endColumn === 0) {
        if (unchangedLine && !edit.preservesEndLine) return undefined;
        current = edit.startLine + edit.addedLines;
        continue;
      }
      return undefined;
    }
    return current;
  }
}
