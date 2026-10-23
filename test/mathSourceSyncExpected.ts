import type { Line } from '../src/protocol';

// Fixture-only oracle: identify a drawn row by its unique glyph text, never its anchors.
export function expectedMathRow(sourceLine: string, character: number): string | undefined {
  const trailingBreak = /\\\\\s*$/.exec(sourceLine);
  if (trailingBreak && character >= trailingBreak.index + 2) return undefined;
  if (sourceLine.includes('a_2') && sourceLine.includes('d_2')) {
    return character < sourceLine.indexOf('\\\\') + 2 ? 'a2' : 'd2';
  }
  const rows: Record<string, string> = {
    a_1: 'a1', d_1: 'd1', f_1: 'd1', a_2: 'a2', d_2: 'd2',
    a_3: 'a3', d_3: 'd3', g_3: 'g3', a_4: 'a4', d_4: 'd4',
    a_5: 'a5', e_5: 'e5', a_6: 'a6', d_6: 'd6', a_7: 'a7', d_7: 'd7',
    a_8: 'a8', d_8: 'd8', a_9: 'a9', d_9: 'd9', j_2: 'j2',
  };
  return rows[/\b[adefgj]_[1-9]\b/.exec(sourceLine)?.[0] ?? ''];
}
export function mathRowGlyphY(row: Line, expected: string): number | undefined {
  const glyphs = row.items.filter(item => item[0] === 'g' && typeof item[2] === 'number'
    && typeof item[5] === 'number' && Number.isFinite(item[5]))
    .map(item => ({ text: String.fromCodePoint(item[2] as number), y: item[5] as number }));
  const text = glyphs.map(glyph => glyph.text).join('');
  const baselines = new Set<number>();
  let offset = 0;
  for (const glyph of glyphs) {
    if (text.startsWith(expected, offset)) baselines.add(glyph.y);
    offset += glyph.text.length;
  }
  return baselines.size === 1 ? [...baselines][0] : undefined;
}
