// A narrow structural fallback for display math whose TeX glue carries the closing
// environment's source line. Ordinary body/source lines continue to use exact line anchors.
import { isKnownMathSource, isNearSourceInk, type RefinementHit } from './sourceRefinement';
import type { DisplayList, Line } from './protocol';
import type { PreviewModel } from '../webview/model';
import { sourceFile, type SourceLineJournal } from './sourceAnchors';
import type { PreviewTarget } from './sourceMap';

export interface MathBlockSelection {
  /** Source line offsets relative to the engine-confirmed closing-delimiter line. */
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

function escaped(text: string, at: number): boolean {
  let count = 0;
  while (at > 0 && text[--at] === '\\') count++;
  return count % 2 === 1;
}

/** Mask comments while retaining UTF-16 offsets and source line boundaries. */
function maskComments(text: string): string {
  const pieces: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '%' || escaped(text, i)) continue;
    let end = text.indexOf('\n', i);
    if (end < 0) end = text.length;
    pieces.push(text.slice(start, i), ' '.repeat(end - i));
    start = end;
    i = end;
  }
  pieces.push(text.slice(start));
  return pieces.join('');
}

function position(text: string, at: number, anchorLine: number): { line: number; column: number } {
  const prefix = text.slice(0, at);
  const line = (prefix.match(/\n/g) ?? []).length;
  return { line: line - anchorLine, column: at - prefix.lastIndexOf('\n') - 1 };
}

/** Select a single explicitly delimited display expression only when its entire bounded
 * source context has already been verified unchanged by SourceLineJournal. Undefined
 * context, unknown macros, nested environments, or ambiguous delimiters retain the old
 * line-level jump. The helper never searches prose or moves an ordinary source anchor. */
export function refineClosingDisplay(text: string, before: string | undefined, hit: RefinementHit): MathBlockSelection | undefined {
  if (text.length > 16000 || before === undefined || before.length > 16384 || !before.endsWith('\n')
    || (before.match(/\n/g) ?? []).length > 64 || /[\r\n]/.test(text)
    || !isNearSourceInk(hit)) return undefined;
  const close = maskComments(text).trim();
  const environment = /^\\end\s*\{(equation\*?|displaymath)\}$/.exec(close)?.[1];
  if (!environment && close !== '\\]') return undefined;
  const masked = maskComments(before);
  // The nearest structural delimiter must be this display's explicit opener. An inner
  // align/matrix, a previously closed equation, or unmatched syntax makes it ambiguous.
  const structural = /\\(?:begin|end)\s*\{[^}\r\n]+\}|\\[\[\]]|\$\$/g;
  let opening: RegExpExecArray | undefined;
  const displays: string[] = [];
  let nested = false;
  for (let match = structural.exec(masked); match; match = structural.exec(masked)) {
    if (escaped(masked, match.index)) continue;
    opening = match;
    const token = match[0];
    const begin = /^\\begin\s*\{(equation\*?|displaymath|align\*?|gather\*?|multline\*?)\}$/.exec(token)?.[1];
    const finish = /^\\end\s*\{(equation\*?|displaymath|align\*?|gather\*?|multline\*?)\}$/.exec(token)?.[1];
    if (begin || token === '\\[') {
      if (displays.length) nested = true;
      displays.push(begin ?? '[');
    } else if (finish || token === '\\]') {
      if (displays.at(-1) === (finish ?? '[')) displays.pop();
      else displays.length = 0;
      if (!displays.length) nested = false;
    }
  }
  if (!opening || nested || displays.length !== 1) return undefined;
  const opener = opening[0];
  if (environment ? /^\\begin\s*\{([^}]+)\}$/.exec(opener)?.[1] !== environment : opener !== '\\[') return undefined;
  const lineStart = masked.lastIndexOf('\n', opening.index - 1) + 1;
  if (masked.slice(lineStart, opening.index).trim()) return undefined;
  let start = opening.index + opener.length;
  let end = masked.length;
  // Labels are source metadata. Keeping their masked length preserves the exact columns
  // while allowing the selected range to begin/end at the actual expression.
  const expression = masked.slice(start).replace(/\\label\s*\{[^{}\r\n]*\}/g, (label) => ' '.repeat(label.length));
  while (start < end && /\s/.test(expression[start - opening.index - opener.length])) start++;
  while (end > start && /\s/.test(expression[end - opening.index - opener.length - 1])) end--;
  if (start === end) return undefined;
  const content = expression.slice(start - opening.index - opener.length, end - opening.index - opener.length);
  // Balanced grouping and the known primitive/math vocabulary exclude macro expansions
  // and source that requires another environment to interpret it.
  let depth = 0;
  for (let i = 0; i < content.length; i++) {
    if (escaped(content, i)) continue;
    if (content[i] === '{') depth++;
    if (content[i] === '}' && --depth < 0) return undefined;
    if (content[i] === '$' || content[i] === '&') return undefined;
    if (content[i] === '\\' && content[i + 1] === '\\') return undefined;
  }
  if (depth !== 0 || !isKnownMathSource(content)) return undefined;
  const anchorLine = (before.match(/\n/g) ?? []).length;
  const first = position(before, start, anchorLine);
  const last = position(before, end, anchorLine);
  return { startLine: first.line, startColumn: first.column, endLine: last.line, endColumn: last.column };
}

export interface ClosingDisplayContext {
  text: string;
  before: string;
  /** One-based current source line of the first complete line in `before`. */
  firstLine: number;
}

export const MAX_DISPLAY_CONTEXT_LINES = 1024;
export const MAX_DISPLAY_CONTEXT_CHARACTERS = 262144;

/** Match the explicit enclosing display, including balanced inner environments.
 * Forward navigation needs the block's extent, not a guess at its expanded math. */
function closingDisplayRange(text: string, before: string): { start: number; end: number } | undefined {
  const source = maskComments(before + text);
  const structural = /\\(begin|end)\s*\{([^}\r\n]+)\}|\\([\[\]])|\$\$/g;
  const tokens: RegExpExecArray[] = [];
  for (let match = structural.exec(source); match; match = structural.exec(source)) {
    if (!escaped(source, match.index)) tokens.push(match);
  }
  let closingIndex = tokens.length - 1;
  for (; closingIndex >= 0; closingIndex--) {
    const token = tokens[closingIndex];
    if (token.index < before.length) return undefined;
    if (token[1] ? token[1] === 'end' && /^(?:equation|displaymath|align|alignat|flalign|gather|multline|eqnarray)\*?$/.test(token[2])
      : !token[3] || token[3] === ']') break;
  }
  const closing = tokens[closingIndex];
  if (!closing) return undefined;
  const end = closing.index + closing[0].length;
  const name = closing[2] ?? (closing[3] ? '[' : '$$');
  const stack = [name];
  for (let i = closingIndex - 1; i >= 0; i--) {
    const token = tokens[i];
    const current = token[2] ?? (token[3] ? '[' : '$$');
    if (token[0] === '$$') {
      if (stack.length !== 1 || stack[0] !== '$$') return undefined;
      return { start: token.index, end };
    }
    if (token[1] === 'end' || token[3] === ']') stack.push(current);
    else {
      if (stack.pop() !== current) return undefined;
      if (!stack.length) return { start: token.index, end };
    }
  }
  return undefined;
}

/** Closing-only math anchors identify the verified visible display as a whole.
 * Preserve the narrower reverse-selection rules in refineClosingDisplay. */
export function targetClosingDisplay(
  model: PreviewModel,
  file: string,
  line: number,
  character: number,
  journal: SourceLineJournal,
  readContext: (closingLine: number) => ClosingDisplayContext | undefined,
): PreviewTarget | undefined {
  if (sourceFile(file) !== file || !Number.isSafeInteger(line) || line < 1
    || !Number.isSafeInteger(character) || character < 0) return undefined;
  const starts = new Map<number, number | undefined>();
  const blockStart = (closingLine: number): number | undefined => {
    if (starts.has(closingLine)) return starts.get(closingLine);
    starts.set(closingLine, undefined);
    const context = readContext(closingLine);
    if (!context || !Number.isSafeInteger(context.firstLine) || context.firstLine < 1 || context.firstLine > line
      || context.before.length + context.text.length > MAX_DISPLAY_CONTEXT_CHARACTERS
      || (context.before.length > 0 && !context.before.endsWith('\n')) || /[\r\n]/.test(context.text)) return undefined;
    const beforeLines = context.before.split('\n');
    if (beforeLines.length - 1 !== closingLine - context.firstLine || beforeLines.length - 1 > MAX_DISPLAY_CONTEXT_LINES) return undefined;
    const range = closingDisplayRange(context.text, context.before);
    if (!range || line === closingLine && character > range.end - context.before.length) return undefined;
    const prefix = (context.before + context.text).slice(0, range.start);
    const firstLine = context.firstLine + (prefix.match(/\n/g) ?? []).length;
    if (line < firstLine) return undefined;
    const cursorText = line === closingLine ? context.text : beforeLines[line - context.firstLine];
    if (!cursorText || character > cursorText.length || !maskComments(cursorText).trim()) return undefined;
    if (line === firstLine) {
      const column = range.start - prefix.lastIndexOf('\n') - 1;
      if (character < column && cursorText.slice(0, column).trim()) return undefined;
    }
    for (let i = 0; i <= Math.min(character, cursorText.length - 1); i++) {
      if (cursorText[i] === '%' && !escaped(cursorText, i)) return undefined;
    }
    starts.set(closingLine, firstLine);
    return firstLine;
  };
  let target: PreviewTarget | undefined;
  const consider = (page: number, row: Line, dl: DisplayList, dx = 0, dy = 0) => {
    const revision = dl.source_revision;
    if (!Number.isSafeInteger(revision) || revision! < 1) return;
    for (const anchor of row.source_anchors ?? []) {
      if (anchor.kind !== 'mg' || sourceFile(anchor.file) !== file
        || !Number.isSafeInteger(anchor.line) || anchor.line < 1 || !Number.isFinite(anchor.x + anchor.w) || anchor.w <= 0) continue;
      const closingLine = journal.rebase(file, anchor.line, revision!);
      if (closingLine === undefined || closingLine < line || closingLine - line > MAX_DISPLAY_CONTEXT_LINES) continue;
      const firstLine = blockStart(closingLine);
      if (firstLine === undefined) continue;
      const originalFirst = anchor.line - (closingLine - firstLine);
      const unchanged = journal.refineContext(file, originalFirst, anchor.line, revision!);
      if (unchanged?.firstLine !== firstLine || unchanged.lastLine !== closingLine) continue;
      const glyph = row.items.find((item) => item[0] === 'g'
        && [item[4], item[5], item[6]].every((value) => typeof value === 'number' && Number.isFinite(value))
        && (item[4] as number) < anchor.x + anchor.w && (item[4] as number) + (item[6] as number) > anchor.x);
      if (!glyph) continue;
      const x = (glyph[4] as number) + Math.max(0, glyph[6] as number) / 2;
      if (!Number.isFinite(x + dx + row.y + dy)) continue;
      // Closing-only anchors remain the fallback when no exact row source is available.
      if (!target || row.y + dy < target.y) target = { page, x: x + dx, y: row.y + dy };
      return;
    }
  };
  for (let page = 1; page <= model.pagesTotal && !target; page++) {
    for (const overlay of model.overlaysOn(page)) for (const row of overlay.rows) consider(page, row.line, overlay.overlay.dl, row.dx, row.dy);
    const dl = model.pages.get(page)?.dl;
    if (!dl) continue;
    const hidden = model.hiddenLines(page);
    dl.lines.forEach((row, index) => { if (!hidden.has(index)) consider(page, row, dl); });
  }
  return target;
}
