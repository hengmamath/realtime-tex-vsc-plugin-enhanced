import type { Item } from '../src/protocol';

export interface NativeGlyphRun {
  /** Private-use characters in display-list order; never source Unicode text. */
  text: string;
  /** Inclusive index of the last glyph consumed from items. */
  last: number;
}

const MAX_GLYPHS = 64;
const MAX_ORIGIN_ERROR_SP = 1;

function glyphId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff;
}

function coordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function mappedCharacter(chars: ReadonlyMap<number, string>, id: number): string | undefined {
  const char = chars.get(id);
  if (!char || char.length > 2) return undefined;
  // One mapped Unicode scalar; a supplementary scalar is one glyph, not two.
  const first = char.charCodeAt(0);
  if (char.length === 1) return first < 0xd800 || first > 0xdfff ? char : undefined;
  const second = char.charCodeAt(1);
  return first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff ? char : undefined;
}

/** Batch only glyphs whose independent TeX origins agree with the unshaped font
 * advances. The font's browser-facing cmap must map chars to these exact GIDs and
 * have substitution/positioning disabled. This does not infer words or recompute
 * spacing: every intervening operator, gap, font/baseline/expansion change ends it.
 *
 * Source-coordinate tolerance is cumulative from the first origin, never a fresh
 * per-glyph tolerance. Rendering precision of the browser still needs visual tests.
 */
export function nativeGlyphRun(
  items: readonly Item[],
  start: number,
  chars: ReadonlyMap<number, string>,
  advance: (gid: number) => number | undefined,
  spPerFontUnit: number,
): NativeGlyphRun | undefined {
  if (!Number.isInteger(start) || start < 0 || start >= items.length) return undefined;
  const first = items[start];
  if (first[0] !== 'g' || !coordinate(first[1]) || !Number.isInteger(first[1]) || first[1] < 0 || !glyphId(first[3]) ||
      !coordinate(first[4]) || !coordinate(first[5])) return undefined;
  const firstChar = mappedCharacter(chars, first[3]);
  if (!firstChar) return undefined;
  const result: NativeGlyphRun = { text: firstChar, last: start };
  // Unusual reflected/degenerate font transforms retain individual glyph drawing.
  if (!Number.isFinite(spPerFontUnit) || spPerFontUnit <= 0) return result;
  const font = first[1], baseline = first[5], origin = first[4], expansion = first[7] ?? 0;
  if (!coordinate(expansion)) return result;
  let previousId = first[3], advanceSp = 0;
  while (result.last + 1 < items.length && result.last - start + 1 < MAX_GLYPHS) {
    const next = items[result.last + 1];
    if (next[0] !== 'g' || next[1] !== font || next[5] !== baseline ||
        (next[7] ?? 0) !== expansion || !glyphId(next[3]) || !coordinate(next[4])) break;
    const char = mappedCharacter(chars, next[3]);
    if (!char) break;
    const width = advance(previousId);
    // Zero-width marks/overprints retain separate draws; equal source positions
    // alone do not establish equivalent browser overlap/antialias composition.
    if (width === undefined || !Number.isFinite(width) || width <= 0) break;
    const nextAdvance = advanceSp + width * spPerFontUnit;
    if (!Number.isFinite(nextAdvance) || Math.abs(next[4] - (origin + nextAdvance)) > MAX_ORIGIN_ERROR_SP) break;
    result.text += char;
    result.last++;
    advanceSp = nextAdvance;
    previousId = next[3];
  }
  return result;
}
