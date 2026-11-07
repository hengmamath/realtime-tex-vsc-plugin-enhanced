// Selectable text follows the captured glyphs in the same page and live rows as the canvas.
import { SP_PER_PT, type DisplayList, type FontDesc, type Item, type Line } from '../src/protocol';
import { TransformState } from './affine';
import { rowBands } from './links';
import type { OverlayRow, PageOverlay } from './model';

interface Word {
  text: string;
  x: number;
  y: number;
  w: number;
  size: number;
  eol?: boolean;
}

const ligatures = ['ff', 'fi', 'fl', 'ffi', 'ffl', 'st', 'st'];
// Common TeX text encodings use different slots even for dashes and quotes.
const ot1Low = [...'ΓΔΘΛΞΠΣΥΦΨΩ', ...ligatures.slice(0, 5), ...'ıȷ`´ˇ˘¯˚¸ßæœøÆŒØ'];
const t1Low = [...'`´ˆ˜¨˝˚ˇ˘¯˙¸˛‚‹›“”„«»–—', '', '', 'ı', 'ȷ', ...ligatures.slice(0, 5)];
const t1High = 'ĂĄĆČĎĚĘĞĹĽŁŃŇŊŐŔŘŚŠŞŤŢŰŮŸŹŽŻĲİđ§'
  + 'ăąćčďěęğĺľłńňŋőŕřśšşťţűůÿźžżĳ¡¿£'
  + 'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖŒØÙÚÛÜÝÞẞ'
  + 'àáâãäåæçèéêëìíîïðñòóôõöœøùúûüýþß';
const ot1Extra: Partial<Record<number, string>> = {
  34: '”', 60: '¡', 62: '¿', 92: '“', 94: 'ˆ', 95: '˙', 123: '–', 124: '—', 125: '˝', 126: '˜', 127: '¨',
};
const ot1Accents: Partial<Record<number, string>> = {
  18: '\u0300', 19: '\u0301', 20: '\u030c', 21: '\u0306', 22: '\u0304', 23: '\u030a', 24: '\u0327',
  94: '\u0302', 95: '\u0307', 125: '\u030b', 126: '\u0303', 127: '\u0308',
};
const monoLow = ['↑', '↓', "'", '¡', '¿'];
const base1Low = [
  '', '˙', 'fi', 'fl', ...'⁄˝Łł˛˚', '', '˘', '−', '', ...'Žžˇıȷ', 'ff', 'ffi', 'ffl', ...'≠∞≤≥∂∑∏π', '`', "'",
];
const base1High = [...'€∫‚ƒ„…†‡ˆ‰Š‹ŒΩ√≈', '', '', '', ...'“”•–—˜™š›œ∆◊Ÿ'];

type Encoding = 't1' | 'ot1' | 'mono' | 'base1' | 'mathItalic' | 'unknown';
const encodings = new WeakMap<FontDesc, Encoding>();
function encoding(font: FontDesc): Encoding {
  const cached = encodings.get(font);
  if (cached) return cached;
  const name = font.name ?? '';
  const value = /^(?:ec-|t1-|ec(?:rm|ti|sl|bx|ss|tt|sc))/.test(name) ? 't1'
    : /^(?:cm(?:tt|vtt)\d|(?:rm|ot1)-(?:lmt[cklt]|qcr))/.test(name) ? 'mono'
    : /^(?:cm(?:r|ti|sl|bx|ss|csc)\d|(?:rm|ot1)-)/.test(name) ? 'ot1'
    : /^p(?:ag|bk|cr|hv|nc|pl|tm|zc)[a-z]*8r(?:n)?$/.test(name) ? 'base1'
    : /^(?:cmmi|lmmi|mi-lm)/.test(name) ? 'mathItalic' : 'unknown';
  encodings.set(font, value);
  return value;
}

function glyphText(font: FontDesc, code: number, index: unknown): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return '';
  if (typeof index === 'number') {
    // Expand standard ligatures while preserving the other displayed Unicode characters.
    if (code < 32 || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xf8ff)
        || (code >= 0xf0000 && code <= 0x10fffd)) return '';
    return ligatures[code - 0xfb00] ?? String.fromCodePoint(code);
  }
  const fontEncoding = encoding(font);
  if (fontEncoding === 'mathItalic') {
    return code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122
      ? String.fromCharCode(code) : '';
  }
  // shortcut: skip unknown legacy encodings, use glyph-name metadata if they need selection.
  if (fontEncoding === 'unknown') return '';
  if (fontEncoding === 'base1') {
    if (code < 32) return base1Low[code] ?? '';
    if (code >= 128 && code < 160) return base1High[code - 128];
    if (code === 173) return '-';
    if (code === 127 || code === 160 || code > 255) return '';
  }
  if (fontEncoding === 'mono') {
    if (code >= 11 && code <= 15) return monoLow[code - 11];
    if (code === 32) return '␣';
    if (code >= 33 && code < 127) return String.fromCharCode(code);
  }
  if (code < 32) return (fontEncoding === 't1' ? t1Low : ot1Low)[code] ?? '';
  if (fontEncoding !== 'base1' && code >= 128) return t1High[code - 128] ?? '';
  if (fontEncoding === 'ot1' && ot1Extra[code]) return ot1Extra[code]!;
  if (code === 127) return fontEncoding === 't1' ? '-' : '¨';
  if (code === 39) return '’';
  if (code === 96) return '‘';
  return String.fromCharCode(code);
}

type Bands = ReturnType<typeof rowBands>;
interface TextRow { line?: Line; words: Word[] }

function textRows(dl: DisplayList, rows: readonly OverlayRow[], masks: Bands = []): TextRow[] {
  const transform = new TransformState();
  const out: TextRow[] = [];
  const append = (items: readonly Item[], dx: number, dy: number, line?: Line) => {
    let words: Word[] = [];
    let word: Word | undefined;
    let accent = '';
    const finish = () => {
      if (words.length) {
        words[words.length - 1].eol = true;
        out.push({ line, words });
      }
      words = [];
      word = undefined;
    };
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item[0] === 'M') { transform.apply(item, dx, dy); continue; }
      if (item[0] !== 'g') continue;
      const [, id, code, index, gx, gy, advance] = item as [string, number, number, number | null, number, number, number];
      const font = dl.fonts[String(id)];
      let text = font ? glyphText(font, code, index) : '';
      const [a, b, c, d, e, f] = transform.matrix;
      const x = a * (gx + dx) + e, y = d * (gy + dy) + f;
      const w = a * advance, size = d * (font?.size ?? 10 * SP_PER_PT);
      // shortcut: skip rotated glyphs, add rotated selection geometry when needed.
      if (!text || b || c || a <= 0 || size <= 0 || !Number.isFinite(x + y + w + size) ||
          masks.some(([left, top, right, bottom]) => x + w > left && x < right && y >= top && y <= bottom)) {
        word = undefined;
        accent = '';
        continue;
      }
      if (accent) {
        text = ((text === 'ı' ? 'i' : text === 'ȷ' ? 'j' : text) + accent).normalize('NFC');
        accent = '';
      } else if (index == null && ot1Accents[code] && font && encoding(font) === 'ot1') {
        const next = items[i + 1];
        // OT1 puts a separate accent glyph directly over its base letter.
        if (next?.[0] === 'g' && next[1] === id && typeof next[2] === 'number' &&
            /\p{L}/u.test(glyphText(font, next[2], next[3])) &&
            Math.abs(gx + advance / 2 - (Number(next[4]) + Number(next[6]) / 2)) < size / 6 &&
            Math.abs(gy - Number(next[5])) < size / 2) {
          accent = ot1Accents[code]!;
          continue;
        }
      }
      if (!line && words.length && Math.abs(y - words[0].y) > size * 0.3) finish();
      if (!word || Math.abs(y - word.y) > size * 0.3 || x < word.x || x - (word.x + word.w) > size / 6) {
        const last = words.at(-1);
        if (last) last.text += ' ';
        word = { x, y, w: 0, size, text: '' };
        words.push(word);
      }
      word.text += text;
      word.w = Math.max(word.w, x + w - word.x);
    }
    finish();
  };
  append(dl.other ?? [], 0, 0);
  for (const { line, dx, dy } of rows) append(line.items, dx, dy, line);
  return out;
}

/** Replace each captured unit in reading order, including when its column starts higher on the page. */
export function pageWords(dl: DisplayList, lines: readonly Line[], overlays: readonly PageOverlay[],
  replacedIndex: (parId: number) => number | undefined = () => undefined): Word[] {
  const masks = overlays.flatMap(({ rows }) => rowBands(rows));
  const page = textRows(dl, lines.map(line => ({ line, dx: 0, dy: 0 })), masks);
  if (!overlays.length && page.every(row => row.line)) return page.flatMap(row => row.words);
  const indices = new Map(dl.lines.map((line, i) => [line, i]));
  const captured = page.flatMap(row => row.line ? [{ ...row, index: indices.get(row.line)! }] : []);
  const position = (a: TextRow, b: TextRow) => a.words[0].y - b.words[0].y || a.words[0].x - b.words[0].x;
  const insert = (row: TextRow, index?: number) => ({ ...row, index: index ??
    (captured.find(base => position(row, base) < 0)?.index ?? dl.lines.length) - 0.5 });
  const other = page.filter(row => !row.line).map(row => insert(row));
  const live = overlays.flatMap(({ overlay, rows }) => {
    const index = replacedIndex(overlay.parId);
    return textRows(overlay.dl, rows).map(row => insert(row, index));
  });
  return [...captured, ...other, ...live].sort((a, b) => a.index - b.index || position(a, b)).flatMap(row => row.words);
}

const displayed = new WeakMap<HTMLElement, { words: readonly Word[]; scale: number }>();
let measure: CanvasRenderingContext2D | null | undefined;

export function renderTextLayer(layer: HTMLElement, words: readonly Word[], scale: number): void {
  const old = displayed.get(layer);
  if (old?.scale === scale && old.words.length === words.length && words.every((w, i) => {
    const p = old.words[i];
    return w.text === p.text && w.x === p.x && w.y === p.y && w.w === p.w && w.size === p.size && w.eol === p.eol;
  })) return;
  measure ??= document.createElement('canvas').getContext('2d');
  const content = document.createDocumentFragment();
  for (const word of words) {
    const span = document.createElement('span');
    const px = word.size * scale;
    span.textContent = word.text;
    span.style.left = `${word.x * scale}px`;
    span.style.top = `${(word.y - word.size * 0.8) * scale}px`;
    span.style.fontSize = `${px}px`;
    if (measure && word.w > 0) {
      measure.font = `${px}px serif`;
      const width = measure.measureText(word.text.trimEnd()).width;
      if (width > 0) span.style.transform = `scaleX(${word.w * scale / width})`;
    }
    content.append(span);
    if (word.eol) content.append('\n');
  }
  layer.replaceChildren(content);
  displayed.set(layer, { words, scale });
}

export function clearTextLayer(layer: HTMLElement): void {
  layer.replaceChildren();
  displayed.delete(layer);
}

export function copyPreviewSelection(event: ClipboardEvent, pages: HTMLElement): void {
  const selection = pages.ownerDocument.getSelection();
  if (!event.clipboardData || !selection || selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!pages.contains(range.startContainer) || !pages.contains(range.endContainer)) return;
  const content = range.cloneContents();
  content.querySelectorAll('.badge').forEach(badge => badge.remove());
  // Native HTML copy can put every absolutely positioned word on a separate line.
  const text = content.textContent;
  if (!text?.trim()) return;
  event.clipboardData.setData('text/plain', text);
  event.preventDefault();
}
