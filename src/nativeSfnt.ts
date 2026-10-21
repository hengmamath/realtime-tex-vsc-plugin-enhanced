/** Browser-facing copy of a static SFNT font, with private-use characters mapped to
 * its original glyph IDs. Glyph programs, metrics and hinting are not reconstructed.
 * This deliberately excludes font instances the display-list protocol cannot describe.
 */
export interface NativeSfnt {
  readonly data: Uint8Array;
  readonly upem: number;
  readonly numGlyphs: number;
  codePoint(gid: number): number | undefined;
}

const BMP_PUA_START = 0xe000;
const BMP_PUA_COUNT = 0x1900;
const SUPPLEMENTARY_PUA_START = 0xf0000;
const SFNT_CHECKSUM = 0xb1b0afba;

/** GID zero is .notdef, not a drawable character. No mapping depends on which
 * glyphs are currently used, so a live edit never needs a new font subset.
 */
export function nativeSfntCodePoint(gid: number, numGlyphs: number): number | undefined {
  if (!Number.isInteger(numGlyphs) || numGlyphs < 1 || numGlyphs > 0xffff ||
      !Number.isInteger(gid) || gid < 1 || gid >= numGlyphs) return undefined;
  return gid <= BMP_PUA_COUNT
    ? BMP_PUA_START + gid - 1
    : SUPPLEMENTARY_PUA_START + gid - BMP_PUA_COUNT - 1;
}

// A mapped glyph has already been shaped and positioned by TeX. Prevent browser
// layout engines from replacing it, positioning a mark, or applying another kern.
const OMIT_TABLES = new Set([
  'cmap', 'GSUB', 'GPOS', 'GDEF', 'kern', 'BASE', 'JSTF',
  'morx', 'mort', 'kerx', 'feat', 'ankr', 'trak', 'prop',
  'lcar', 'opbd', 'bsln', 'just', 'Silf', 'Glat', 'Gloc', 'Sill', 'DSIG',
]);
const UNSUPPORTED_TABLES = new Set([
  'fvar', 'gvar', 'avar', 'cvar', 'HVAR', 'VVAR', 'MVAR', 'CFF2', 'VARC',
  'COLR', 'CPAL', 'CBDT', 'CBLC', 'sbix', 'SVG ',
  'EBDT', 'EBLC', 'EBSC', 'bdat', 'bloc',
]);

interface TableEntry { tag: string; offset: number; length: number }
const align4 = (n: number): number => Math.ceil(n / 4) * 4;
const viewOf = (data: Uint8Array): DataView => new DataView(data.buffer, data.byteOffset, data.byteLength);

function invalid(reason: string): never { throw new Error(`Cannot prepare native SFNT: ${reason}`); }

function checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const word = ((bytes[i] ?? 0) * 0x1000000 + (bytes[i + 1] ?? 0) * 0x10000 +
      (bytes[i + 2] ?? 0) * 0x100 + (bytes[i + 3] ?? 0)) >>> 0;
    sum = (sum + word) >>> 0;
  }
  return sum;
}

function privateCmap(numGlyphs: number): Uint8Array {
  const bmpCount = Math.min(numGlyphs - 1, BMP_PUA_COUNT);
  const supplementaryCount = Math.max(0, numGlyphs - 1 - bmpCount);
  const segments = bmpCount ? 2 : 1; // plus the required format-4 sentinel
  const format4Length = 16 + 8 * segments;
  const groups = Number(bmpCount > 0) + Number(supplementaryCount > 0);
  const format12Length = 16 + groups * 12;
  const format4Offset = 4 + 3 * 8;
  const format12Offset = format4Offset + format4Length;
  const data = new Uint8Array(format12Offset + format12Length);
  const v = viewOf(data);
  v.setUint16(2, 3);
  // Unicode full repertoire and Windows BMP/full repertoire records. The full
  // repertoire subtable includes every mapping from the BMP subtable.
  for (const [i, platform, encoding, offset] of [
    [0, 0, 4, format12Offset], [1, 3, 1, format4Offset], [2, 3, 10, format12Offset],
  ]) {
    const at = 4 + i * 8;
    v.setUint16(at, platform); v.setUint16(at + 2, encoding); v.setUint32(at + 4, offset);
  }
  let at = format4Offset;
  v.setUint16(at, 4); v.setUint16(at + 2, format4Length);
  v.setUint16(at + 6, segments * 2);
  const power = 2 ** Math.floor(Math.log2(segments));
  v.setUint16(at + 8, power * 2); v.setUint16(at + 10, Math.log2(power));
  v.setUint16(at + 12, segments * 2 - power * 2);
  if (bmpCount) {
    v.setUint16(at + 14, BMP_PUA_START + bmpCount - 1);
    v.setUint16(at + 16 + segments * 2, BMP_PUA_START);
    v.setUint16(at + 16 + segments * 4, (1 - BMP_PUA_START) & 0xffff);
  }
  const sentinel = segments - 1;
  v.setUint16(at + 14 + sentinel * 2, 0xffff);
  v.setUint16(at + 16 + segments * 2 + sentinel * 2, 0xffff);
  v.setUint16(at + 16 + segments * 4 + sentinel * 2, 1);
  at = format12Offset;
  v.setUint16(at, 12); v.setUint32(at + 4, format12Length); v.setUint32(at + 12, groups);
  let group = at + 16;
  if (bmpCount) {
    v.setUint32(group, BMP_PUA_START); v.setUint32(group + 4, BMP_PUA_START + bmpCount - 1);
    v.setUint32(group + 8, 1); group += 12;
  }
  if (supplementaryCount) {
    v.setUint32(group, SUPPLEMENTARY_PUA_START);
    v.setUint32(group + 4, SUPPLEMENTARY_PUA_START + supplementaryCount - 1);
    v.setUint32(group + 8, BMP_PUA_COUNT + 1);
  }
  return data;
}

export function prepareNativeSfnt(input: Uint8Array): NativeSfnt {
  if (input.length < 12) invalid('truncated font header');
  const v = viewOf(input);
  const signature = v.getUint32(0);
  const cff = signature === 0x4f54544f; // OTTO
  if (!cff && signature !== 0x00010000 && signature !== 0x74727565) {
    invalid('unsupported container (only standalone static OpenType/TrueType fonts are supported)');
  }
  const tableCount = v.getUint16(4);
  const directoryEnd = 12 + tableCount * 16;
  if (!tableCount || directoryEnd > input.length) invalid('truncated table directory');
  const entries = new Map<string, TableEntry>();
  for (let i = 0; i < tableCount; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(...input.subarray(at, at + 4));
    const offset = v.getUint32(at + 8), length = v.getUint32(at + 12);
    if (entries.has(tag)) invalid(`duplicate table ${tag}`);
    if (offset % 4 || offset < directoryEnd || offset > input.length || length > input.length - offset) {
      invalid(`invalid bounds for table ${tag}`);
    }
    entries.set(tag, { tag, offset, length });
  }
  const ranges = [...entries.values()].filter(e => e.length).sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].offset < ranges[i - 1].offset + ranges[i - 1].length) invalid('overlapping font tables');
  }
  for (const tag of entries.keys()) {
    if (UNSUPPORTED_TABLES.has(tag)) invalid(`unsupported table ${tag}`);
  }
  const table = (tag: string, minLength = 1): TableEntry => {
    const e = entries.get(tag);
    if (!e || e.length < minLength) invalid(`missing or truncated table ${tag}`);
    return e;
  };
  const head = table('head', 54), maxp = table('maxp', cff ? 6 : 32);
  const hhea = table('hhea', 36), hmtx = table('hmtx');
  table('name'); table('post'); table('OS/2', 68);
  if (v.getUint32(head.offset) !== 0x00010000 || v.getUint32(head.offset + 12) !== 0x5f0f3cf5) {
    invalid('invalid head header');
  }
  const upem = v.getUint16(head.offset + 18), numGlyphs = v.getUint16(maxp.offset + 4);
  if (upem < 16 || upem > 16384 || numGlyphs < 1) invalid('invalid units per em or glyph count');
  const metrics = v.getUint16(hhea.offset + 34);
  if (!metrics || metrics > numGlyphs || hmtx.length < metrics * 4 + (numGlyphs - metrics) * 2) {
    invalid('invalid horizontal metrics');
  }
  if (cff) {
    const program = table('CFF ', 4);
    if (entries.has('glyf') || entries.has('loca') || v.getUint32(maxp.offset) !== 0x00005000 ||
        input[program.offset] !== 1 || input[program.offset + 2] < 4 ||
        input[program.offset + 2] > program.length || input[program.offset + 3] < 1 || input[program.offset + 3] > 4) {
      invalid('unsupported CFF font program');
    }
  } else {
    const glyf = table('glyf', 0), loca = table('loca');
    const format = v.getInt16(head.offset + 50);
    if (entries.has('CFF ') || v.getUint32(maxp.offset) !== 0x00010000 || (format !== 0 && format !== 1)) {
      invalid('unsupported TrueType font program');
    }
    const stride = format ? 4 : 2;
    if (loca.length < (numGlyphs + 1) * stride) invalid('truncated glyph locations');
    let previous = 0;
    for (let i = 0; i <= numGlyphs; i++) {
      const offset = format ? v.getUint32(loca.offset + i * stride) : v.getUint16(loca.offset + i * stride) * 2;
      if (offset < previous || offset > glyf.length) invalid('invalid glyph locations');
      previous = offset;
    }
  }
  const tables = new Map<string, Uint8Array>();
  for (const e of entries.values()) if (!OMIT_TABLES.has(e.tag)) tables.set(e.tag, input.slice(e.offset, e.offset + e.length));
  tables.set('cmap', privateCmap(numGlyphs));
  const nativeHead = tables.get('head')!;
  viewOf(nativeHead).setUint32(8, 0);
  // Keep cmap coverage metadata consistent with the new private-use encoding.
  const os2 = viewOf(tables.get('OS/2')!);
  const supplementary = numGlyphs > BMP_PUA_COUNT + 1;
  os2.setUint32(42, 0);
  os2.setUint32(46, (numGlyphs > 1 ? 1 << 28 : 0) | (supplementary ? 1 << 25 : 0));
  os2.setUint32(50, supplementary ? 1 << 26 : 0); os2.setUint32(54, 0);
  os2.setUint16(64, numGlyphs > 1 ? BMP_PUA_START : 0);
  os2.setUint16(66, numGlyphs > BMP_PUA_COUNT + 1 ? 0xffff : numGlyphs > 1 ? BMP_PUA_START + numGlyphs - 2 : 0);

  const tags = [...tables.keys()].sort();
  // searchRange and rangeShift are uint16 fields in the standalone SFNT header.
  if (tags.length > 4095) invalid('too many font tables');
  const outputDirectoryEnd = 12 + tags.length * 16;
  const outputLength = tags.reduce((n, tag) => n + align4(tables.get(tag)!.length), outputDirectoryEnd);
  if (outputLength > 0xffffffff) invalid('font exceeds SFNT offset limits');
  const data = new Uint8Array(outputLength), out = viewOf(data);
  out.setUint32(0, signature); out.setUint16(4, tags.length);
  const power = 2 ** Math.floor(Math.log2(tags.length));
  out.setUint16(6, power * 16); out.setUint16(8, Math.log2(power)); out.setUint16(10, tags.length * 16 - power * 16);
  let offset = outputDirectoryEnd, outputHead = 0;
  tags.forEach((tag, i) => {
    const bytes = tables.get(tag)!, at = 12 + i * 16;
    for (let j = 0; j < 4; j++) data[at + j] = tag.charCodeAt(j);
    out.setUint32(at + 4, checksum(bytes)); out.setUint32(at + 8, offset); out.setUint32(at + 12, bytes.length);
    data.set(bytes, offset);
    if (tag === 'head') outputHead = offset;
    offset += align4(bytes.length);
  });
  out.setUint32(outputHead + 8, (SFNT_CHECKSUM - checksum(data)) >>> 0);
  return { data, upem, numGlyphs, codePoint: gid => nativeSfntCodePoint(gid, numGlyphs) };
}
