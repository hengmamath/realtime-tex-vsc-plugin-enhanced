/// <reference path="../webview/opentype.d.ts" />
import * as opentype from 'opentype.js';
import type { FontResource } from './fontKey';

export type GlyphCoverage = (char: number, index: number | null) => boolean;

/** Match the webview's actual glyph lookup, including lazy SFNT outline parsing. Results
 * are cached per font/glyph so ordinary live edits do not repeatedly parse outlines. */
export function glyphCoverage(resource: FontResource): GlyphCoverage {
  if (resource.kind === 'missing') return () => false;
  if (resource.kind === 'type1') return (char) => resource.glyphs[char] !== undefined;
  let font: opentype.Font;
  try {
    const data = resource.data;
    font = opentype.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  } catch {
    return () => false;
  }
  const checked = new Map<number, boolean>();
  return (_char, index) => {
    if (index === null || !Number.isInteger(index) || index < 0 || index >= font.numGlyphs) return false;
    const cached = checked.get(index);
    if (cached !== undefined) return cached;
    let present = false;
    try {
      const glyph = font.glyphs.get(index);
      // Accessing path.commands forces the same lazy outline decoder used by FontStore.
      present = !!glyph && Array.isArray(glyph.path.commands);
    } catch {
      // A valid SFNT header can still contain an unreadable individual glyph.
    }
    checked.set(index, present);
    return present;
  };
}
