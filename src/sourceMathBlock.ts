// A narrow structural fallback for display math whose TeX glue carries the closing
// environment's source line. Ordinary body/source lines continue to use exact line anchors.
import { isKnownMathSource, isNearSourceInk, type RefinementHit } from './sourceRefinement';

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
