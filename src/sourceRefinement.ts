// Click-time, line-local refinement of an engine-confirmed source anchor. This does
// not participate in drawing/compilation and never searches or changes source lines.
import type { FontDesc, Item, Line } from './protocol';

export interface RefinementHit {
  row: Line;
  fonts: Record<string, FontDesc>;
  x: number;
  y: number;
  file: string;
  line: number;
}

export interface SourceSelection { start: number; end: number; kind: 'word' | 'math' }

const PT = 65536;
const MAX_LINE = 16000;
const MAX_ITEMS = 12000;
const wordChar = /[\p{L}\p{M}\p{N}]/u;
const mathEnvironments = new Set(['equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*',
  'flalign', 'flalign*', 'gather', 'gather*', 'multline', 'multline*', 'displaymath', 'eqnarray', 'eqnarray*']);
const textWrappers = new Set(['textbf', 'textit', 'emph', 'textrm', 'textnormal', 'textsf', 'texttt',
  'textsc', 'textup', 'textsl', 'textmd', 'underline', 'mbox', 'text']);
const declarations = new Set(['normalfont', 'bfseries', 'mdseries', 'rmfamily', 'sffamily', 'ttfamily',
  'upshape', 'itshape', 'slshape', 'scshape', 'noindent', 'smallskip', 'medskip', 'bigskip',
  'par', 'ignorespaces', 'unskip', 'protect', 'relax', 'small', 'large', 'Large', 'footnotesize', 'normalsize']);
const nonText = new Set(['label', 'ref', 'eqref', 'pageref', 'nocite', 'vspace', 'hspace', 'index', 'hypertarget']);

interface SourceAtom extends SourceSelection { text: string; signature?: string; content?: string }
interface RenderAtom { kind: 'word' | 'math'; text: string; signature?: string; x: number; end: number; y: number; size: number }
interface MathMode { delimiter?: string; environment?: string }
interface MathRange { start: number; end: number; contentStart: number; contentEnd: number; display: boolean }

function norm(text: string): string { return text.normalize('NFKC'); }
function escaped(text: string, at: number): boolean {
  let count = 0;
  while (at > 0 && text[--at] === '\\') count++;
  return count % 2 === 1;
}
function commentEnd(text: string, at: number): number {
  const end = text.indexOf('\n', at);
  return end < 0 ? text.length : end;
}
function command(text: string, at: number): { name: string; end: number } {
  const match = /^[a-zA-Z@]+\*?/.exec(text.slice(at + 1));
  return match ? { name: match[0].replace(/\*$/, ''), end: at + 1 + match[0].length }
    : { name: text[at + 1] ?? '', end: Math.min(text.length, at + 2) };
}
function skipSpace(text: string, at: number): number { while (/\s/.test(text[at] ?? '') && at < text.length) at++; return at; }
function groupEnd(text: string, at: number, open = '{', close = '}'): number | undefined {
  if (text[at] !== open) return undefined;
  let depth = 1;
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === '%' && !escaped(text, i)) { i = commentEnd(text, i) - 1; continue; }
    if (escaped(text, i)) continue;
    if (text[i] === open) depth++;
    if (text[i] === close && --depth === 0) return i + 1;
  }
  return undefined;
}

/** Only TeX's explicit math delimiters/environments are recognised. A bounded context
 * which starts in an unknown environment cannot manufacture a math range. */
function mathRanges(text: string, before: string, knownContext: boolean): MathRange[] {
  let mode: MathMode | undefined;
  let start = -1, contentStart = -1, display = false;
  const ranges: MathRange[] = [];
  const scan = (input: string, collect: boolean) => {
    if (collect && mode) { start = 0; contentStart = 0; display = true; }
    for (let i = 0; i < input.length;) {
      if (input[i] === '%' && !escaped(input, i)) { i = commentEnd(input, i); continue; }
      let token = '', end = i + 1, env: string | undefined, opening = false, closing = false;
      if (input[i] === '$' && !escaped(input, i)) {
        token = input[i + 1] === '$' ? '$$' : '$'; end = i + token.length;
        // A bounded preceding context can start halfway through $...$. Its dollar
        // parity is unknown. Only explicit \[ / \begin openers establish prior math.
        opening = collect && !mode; closing = collect && mode?.delimiter === token;
      } else if (input[i] === '\\' && !escaped(input, i)) {
        const c = command(input, i); end = c.end;
        if (c.name === '(' || c.name === '[') { token = c.name; opening = !mode; }
        else if (c.name === ')' || c.name === ']') { token = c.name === ')' ? '(' : '['; closing = mode?.delimiter === token; }
        else if (c.name === 'begin' || c.name === 'end') {
          const a = skipSpace(input, end), b = groupEnd(input, a);
          if (b !== undefined) {
            env = input.slice(a + 1, b - 1); end = b;
            opening = c.name === 'begin' && !mode && mathEnvironments.has(env);
            closing = c.name === 'end' && mode?.environment === env;
          }
        }
      }
      if (opening) {
        mode = env ? { environment: env } : { delimiter: token };
        if (collect) { start = i; contentStart = end; display = !!env || token === '$$' || token === '['; }
      } else if (closing) {
        if (collect && start >= 0) ranges.push({ start, end, contentStart, contentEnd: i, display });
        mode = undefined; start = contentStart = -1;
      }
      i = end;
    }
    if (collect && mode && start >= 0 && (knownContext || mode.environment || !mode.delimiter?.startsWith('$'))) {
      let end = input.length;
      for (let i = contentStart; i < input.length; i++) if (input[i] === '%' && !escaped(input, i)) { end = i; break; }
      ranges.push({ start, end, contentStart, contentEnd: end, display });
    }
  };
  scan(before, false);
  scan(text, true);
  return ranges;
}

/** A deliberately small signature, used only to distinguish multiple formulas. Unknown
 * commands disable it; there is no guess at a custom macro's rendered expansion. */
function sourceMathSignature(text: string): string | undefined | null {
  const wrappers = new Set(['frac', 'dfrac', 'tfrac', 'sqrt', 'left', 'right', 'big', 'Big', 'bigl', 'bigr',
    'Bigl', 'Bigr', 'mathit', 'mathrm', 'mathbf', 'mathsf', 'mathtt', 'mathcal', 'mathbb',
    'operatorname', 'text', 'overset', 'underset', 'overline', 'underline', 'hat', 'bar', 'tilde',
    'widehat', 'widetilde', 'vec', 'limits', 'nolimits', 'displaystyle', 'textstyle', 'scriptstyle',
    'qquad', 'quad', 'notag', 'nonumber']);
  const symbols = new Set(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta',
    'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma', 'tau', 'upsilon',
    'phi', 'varphi', 'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma',
    'Upsilon', 'Phi', 'Psi', 'Omega', 'le', 'leq', 'ge', 'geq', 'ne', 'neq', 'in', 'notin', 'to',
    'rightarrow', 'leftarrow', 'longrightarrow', 'infty', 'sum', 'prod', 'int', 'iint', 'oint',
    'times', 'cdot', 'pm', 'mp', 'cup', 'cap', 'subset', 'subseteq', 'supset', 'supseteq', 'emptyset',
    'partial', 'nabla', 'forall', 'exists', 'sim', 'simeq', 'approx', 'equiv', 'propto', 'ldots', 'cdots']);
  const operators = new Set(['sin', 'cos', 'tan', 'log', 'ln', 'exp', 'lim', 'limsup', 'liminf', 'max', 'min', 'sup', 'inf', 'det']);
  let out = '';
  for (let i = 0; i < text.length;) {
    if (text[i] === '%' && !escaped(text, i)) { i = commentEnd(text, i); continue; }
    if (text[i] === '\\') {
      const c = command(text, i); i = c.end;
      if (c.name === 'label') { const a = skipSpace(text, i), b = groupEnd(text, a); if (b === undefined) return null; i = b; }
      else if (operators.has(c.name)) out += c.name;
      else if (!wrappers.has(c.name) && !symbols.has(c.name) && !/^[,;!: {}\\|]$/.test(c.name)) return null;
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    if (/[a-zA-Z0-9]/.test(ch)) out += ch;
    else if (wordChar.test(ch)) return null;
    i += ch.length;
  }
  return out || undefined;
}

/** Shared conservative gate for a structurally confirmed display block. Known symbols
 * can have no ASCII fingerprint; distinguish that from an unknown command expansion. */
export function isKnownMathSource(text: string): boolean {
  return text.length <= MAX_LINE && sourceMathSignature(text) !== null;
}

function sourceAtoms(text: string, before: string, knownContext: boolean): { atoms: SourceAtom[]; unsafeText: boolean; generatedText: boolean; display: boolean } {
  const ranges = mathRanges(text, before, knownContext);
  const atoms: SourceAtom[] = [];
  let unsafeText = false;
  let generatedText = false;
  const atRange = new Map(ranges.map((range) => [range.start, range]));
  for (let i = 0; i < text.length;) {
    const range = atRange.get(i);
    if (range) {
      let start = range.start, end = range.end;
      if (range.display) {
        start = range.contentStart; end = range.contentEnd;
        while (start < end && /[\s&]/.test(text[start])) start++;
        while (end > start && /\s/.test(text[end - 1])) end--;
        // An equation label is metadata; select the ink-producing expression instead.
        while (text.startsWith('\\label', start)) {
          const a = skipSpace(text, start + 6), b = groupEnd(text, a);
          if (b === undefined || b > end) break;
          start = skipSpace(text, b);
        }
        end = text.slice(start, end).replace(/(?:\s*\\(?:label\{[^}]*\}|notag|nonumber)|\s*\\\\(?:\[[^\]]*\])?)+\s*$/, '').length + start;
      }
      if (end > start) atoms.push({ kind: 'math', start, end, text: '',
        content: text.slice(range.contentStart, range.contentEnd), signature: sourceMathSignature(text.slice(range.contentStart, range.contentEnd)) ?? undefined });
      i = range.end;
      continue;
    }
    if (text[i] === '%' && !escaped(text, i)) break;
    if (text[i] === '$' && !escaped(text, i)) { unsafeText = true; i++; continue; }
    if (text[i] === '\\') {
      const c = command(text, i); i = c.end;
      if (textWrappers.has(c.name) || declarations.has(c.name) || /^[%$&#_{}\\ ,;!:~]$/.test(c.name)) continue;
      if (c.name === 'begin' || c.name === 'end' || c.name === 'color' || c.name === 'textcolor' || c.name === 'colorbox' || nonText.has(c.name)) {
        if (c.name === 'ref' || c.name === 'eqref' || c.name === 'pageref') generatedText = true;
        let a = skipSpace(text, i);
        if (text[a] === '[') { const b = groupEnd(text, a, '[', ']'); if (b !== undefined) a = skipSpace(text, b); }
        const b = groupEnd(text, a);
        if (b !== undefined) i = b;
        continue;
      }
      // A custom command may generate text unlike its arguments. Refining elsewhere on
      // this line could accidentally match that output to a literal duplicate.
      unsafeText = true;
      let a = skipSpace(text, i);
      while (text[a] === '{' || text[a] === '[') {
        const b = groupEnd(text, a, text[a], text[a] === '{' ? '}' : ']');
        if (b === undefined) break;
        i = b; a = skipSpace(text, b);
      }
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    if (wordChar.test(ch)) {
      const start = i;
      i += ch.length;
      while (i < text.length) {
        const next = String.fromCodePoint(text.codePointAt(i)!);
        if (wordChar.test(next)) i += next.length;
        else if ((next === "'" || next === '’') && wordChar.test(text[i + 1] ?? '')) i += next.length;
        else break;
      }
      atoms.push({ kind: 'word', start, end: i, text: norm(text.slice(start, i)) });
    } else i += ch.length;
  }
  return { atoms, unsafeText, generatedText, display: ranges.some((r) => r.display) };
}

/** TFM char numbers are encoding slots, not Unicode. Only known text encodings get
 * ASCII/ligature decoding; unknown or math symbol fonts cannot invent prose words. */
function glyphText(item: Item, fonts: Record<string, FontDesc>, math = false): string | undefined {
  const font = fonts[String(item[1])];
  const code = item[2];
  if (!font || typeof code !== 'number' || !Number.isSafeInteger(code) || code < 0 || code > 0x10ffff) return undefined;
  const name = font.name ?? '';
  const unicode = /(?:opentype|truetype)/i.test(`${font.format ?? ''} ${font.type ?? ''}`)
    || /\.(?:otf|ttf|ttc)$/i.test(font.filename ?? '');
  if (unicode) {
    if (code >= 0xe000 && code <= 0xf8ff || code >= 0xf0000) return undefined;
    return norm(String.fromCodePoint(code));
  }
  const t1 = /^(?:ec-|t1-|ec(?:rm|ti|sl|bx|ss|tt|sc))/.test(name);
  const ot1 = /^(?:cm(?:r|ti|sl|bx|ss|tt|vtt|csc)\d|(?:rm|ot1)-lm)/.test(name);
  const mathItalic = /^(?:cmmi|lmmi|mi-lm)/.test(name);
  if (!t1 && !ot1 && !(math && mathItalic)) return undefined;
  const ligatures: Record<number, string> = t1 ? { 27: 'ff', 28: 'fi', 29: 'fl', 30: 'ffi', 31: 'ffl' }
    : { 11: 'ff', 12: 'fi', 13: 'fl', 14: 'ffi', 15: 'ffl' };
  if (!mathItalic && ligatures[code]) return ligatures[code];
  return code >= 32 && code <= 126 ? String.fromCodePoint(code) : undefined;
}

function renderAtoms(hit: RefinementHit): RenderAtom[] {
  const atoms: RenderAtom[] = [];
  let word: RenderAtom | undefined;
  let invalidWord = false;
  let last: { end: number; x: number; y: number; size: number } | undefined;
  const firstMath = hit.row.items.find((item) => item[0] === 'm');
  let math: RenderAtom | undefined = firstMath?.[1] === 'off'
    ? { kind: 'math', text: '', signature: '', x: hit.row.x, end: hit.row.x, y: hit.row.y, size: 10 * PT } : undefined;
  const spaces = (hit.row.source_anchors ?? []).filter((a) => a.kind === 'g' && Number.isFinite(a.x)).map((a) => a.x).sort((a, b) => a - b);
  let spaceIndex = 0;
  const flush = () => { if (word && !invalidWord) atoms.push(word); word = undefined; last = undefined; invalidWord = false; };
  for (const item of hit.row.items) {
    if (item[0] === 'm' && typeof item[2] === 'number') {
      flush();
      if (item[1] === 'on') math = { kind: 'math', text: '', signature: '', x: item[2], end: item[2], y: hit.row.y, size: 10 * PT };
      else if (item[1] === 'off' && math) {
        math.end = Math.max(math.end, item[2]); atoms.push(math); math = undefined;
      }
      continue;
    }
    if (item[0] !== 'g') continue;
    const x = item[4], y = item[5], width = item[6];
    if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || !Number.isFinite(x + y + width)) { flush(); continue; }
    const size = hit.fonts[String(item[1])]?.size ?? 10 * PT;
    if (math) {
      math.end = Math.max(math.end, x + Math.max(0, width));
      const decoded = glyphText(item, hit.fonts, true);
      math.signature += decoded?.replace(/[^a-zA-Z0-9]/g, '') ?? '';
      continue;
    }
    const decoded = glyphText(item, hit.fonts);
    const gap = last ? x - last.end : 0;
    while (spaceIndex < spaces.length && spaces[spaceIndex] < (last?.x ?? x) - PT / 20) spaceIndex++;
    const separated = last && (gap > Math.max(PT, Math.min(size, last.size) * 0.16)
      || Math.abs(y - last.y) > Math.max(size, last.size) * 0.35
      || (spaces[spaceIndex] !== undefined && spaces[spaceIndex] >= last.end - PT / 20 && spaces[spaceIndex] < x - PT / 20));
    if (separated) flush();
    if (!decoded) {
      // A missing/unknown glyph inside a word must not turn its remaining letters into
      // a different, deceptively valid word somewhere else on the source line.
      word = undefined; invalidWord = true;
      last = { x, end: x + Math.max(0, width), y, size };
      continue;
    }
    for (const ch of decoded) {
      if (wordChar.test(ch) || ((ch === "'" || ch === '’') && word)) {
        if (invalidWord) continue;
        if (!word) word = { kind: 'word', text: '', x, end: x + Math.max(0, width), y, size };
        word.text += ch; word.end = Math.max(word.end, x + Math.max(0, width));
      } else flush();
    }
    last = { x, end: x + Math.max(0, width), y, size };
  }
  flush();
  if (math && math.end > math.x) atoms.push(math);
  return atoms;
}

function contextScore(source: SourceAtom[], rendered: RenderAtom[], si: number, ri: number): number {
  let score = 0;
  for (const direction of [-1, 1]) for (let distance = 1; distance <= 3; distance++) {
    const s = source[si + direction * distance], r = rendered[ri + direction * distance];
    if (!s || !r || s.kind !== r.kind) break;
    const same = s.kind === 'word' ? s.text === r.text : !!s.signature && s.signature === r.signature;
    if (!same) break;
    score += 4 - distance;
  }
  return score;
}

/** Geometry only: callers still need a trusted source construct before selecting it. */
export function isNearSourceInk(hit: RefinementHit): boolean {
  if (!Number.isFinite(hit.x + hit.y) || hit.row.items.length > MAX_ITEMS
    || hit.row.items.some((item) => item[0] === 'M' || item[0] === 'u')) return false;
  return hit.row.items.some((item) => {
    if (item[0] === 'g') {
      const x = item[4] as number, y = item[5] as number, width = item[6] as number;
      const size = hit.fonts[String(item[1])]?.size ?? 10 * PT;
      return Number.isFinite(x + y + width) && hit.x >= x - 2 * PT && hit.x <= x + Math.max(0, width) + 2 * PT
        && Math.abs(hit.y - (y - size * 0.25)) <= size;
    }
    if (item[0] === 'r') {
      const x = item[1] as number, y = item[2] as number, width = item[3] as number, height = item[4] as number;
      return Number.isFinite(x + y + width + height) && hit.x >= x - PT && hit.x <= x + width + PT
        && hit.y >= y - PT && hit.y <= y + height + PT;
    }
    return false;
  });
}

function parsedSource(text: string, hit: RefinementHit, before?: string): ReturnType<typeof sourceAtoms> | undefined {
  if (!text || text.length > MAX_LINE || /[\r\n]/.test(text) || hit.row.items.length > MAX_ITEMS
    || !Number.isFinite(hit.x + hit.y) || !Number.isSafeInteger(hit.line) || hit.line < 1
    || hit.row.items.some((item) => item[0] === 'M' || item[0] === 'u')) return undefined;
  // Drop complete old lines, never a prefix which might cut through a TeX command.
  let boundedContext = before ?? '';
  if (boundedContext.length > 16000) {
    const boundary = boundedContext.indexOf('\n', boundedContext.length - 16000);
    boundedContext = boundary < 0 ? '' : boundedContext.slice(boundary + 1);
  }
  const contextLines = boundedContext.split('\n').slice(-65);
  const parsed = sourceAtoms(text, contextLines.join('\n'), before !== undefined);
  return parsed.unsafeText ? undefined : parsed;
}

function matchedSource(parsed: ReturnType<typeof sourceAtoms>, rendered: RenderAtom[], ri: number): SourceSelection | undefined {
  const clicked = rendered[ri];
  const candidates: { atom: SourceAtom; score: number }[] = [];
  parsed.atoms.forEach((atom, index) => {
    if (atom.kind !== clicked.kind || atom.kind === 'word' && atom.text !== norm(clicked.text)) return;
    if (atom.kind === 'math' && atom.signature && clicked.signature && atom.signature !== clicked.signature) return;
    const context = contextScore(parsed.atoms, rendered, index, ri);
    // Reference output is absent from literal source. A unique "3" alone must not
    // mistake a generated equation reference for a separate literal 3 on this line.
    if (parsed.generatedText && context === 0) return;
    const signatureMatch = atom.kind === 'math' && atom.signature && atom.signature === clicked.signature;
    candidates.push({ atom, score: context + (signatureMatch ? 20 : 0) });
  });
  if (!candidates.length) return undefined;
  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length > 1 && (candidates[0].score === 0 || candidates[0].score === candidates[1].score)) return undefined;
  const { start, end, kind } = candidates[0].atom;
  return { start, end, kind };
}

/** Refine only the engine-confirmed line. Ambiguity, unknown fonts/macros, malformed
 * input and oversized lines retain the existing accurate line-level jump. */
export function refineSourceSelection(text: string, hit: RefinementHit, before?: string): SourceSelection | undefined {
  const parsed = parsedSource(text, hit, before);
  if (!parsed) return undefined;
  const maths = parsed.atoms.filter((atom) => atom.kind === 'math');
  // Display math has no inline on/off records. Its confirmed source line is the safe
  // formula fragment; do not interpret its legacy math-font slots as prose characters.
  if (parsed.display && maths.length === 1 && !parsed.atoms.some((atom) => atom.kind === 'word')) {
    if (!isNearSourceInk(hit)) return undefined;
    const { start, end, kind } = maths[0]; return { start, end, kind };
  }
  const rendered = renderAtoms(hit);
  if (!parsed.atoms.length || !rendered.length) return undefined;
  // Math nodes carry explicit horizontal boundaries, including fraction/radical gaps.
  // Prefer those over neighbouring prose when the click falls inside the formula.
  let ri = rendered.findIndex((atom) => atom.kind === 'math' && hit.x >= atom.x - PT / 2 && hit.x <= atom.end + PT / 2
    && Math.abs(hit.y - hit.row.y) <= Math.max(hit.row.h + hit.row.d, 15 * PT));
  if (ri < 0) {
    let best = Infinity;
    rendered.forEach((atom, i) => {
      const dx = Math.max(atom.x - hit.x, hit.x - atom.end, 0);
      const dy = Math.abs(hit.y - (atom.y - atom.size * 0.25));
      if (dx > 2 * PT || dy > atom.size * 1.4) return;
      const distance = dx + dy * 0.1;
      if (distance < best) { best = distance; ri = i; }
    });
  }
  if (ri < 0) return undefined;
  return matchedSource(parsed, rendered, ri);
}

/** Locate the closest confirmed source word/formula in one rendered row. This lets a
 * long source line wrap over several preview rows without reverting to a byte ratio. */
export function refinePreviewPosition(text: string, hit: RefinementHit, character: number): { x: number; distance: number } | undefined {
  if (!Number.isSafeInteger(character) || character < 0) return undefined;
  const parsed = parsedSource(text, hit);
  if (!parsed || parsed.display) return undefined;
  const rendered = renderAtoms(hit);
  let best: { x: number; distance: number } | undefined;
  rendered.forEach((atom, index) => {
    const source = matchedSource(parsed, rendered, index);
    if (!source) return;
    const distance = Math.max(source.start - character, character - source.end, 0);
    if (!best || distance < best.distance) best = { x: atom.x, distance };
  });
  return best;
}
