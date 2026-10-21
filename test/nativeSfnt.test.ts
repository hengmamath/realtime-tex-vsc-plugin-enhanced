import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeSfntCodePoint, prepareNativeSfnt } from '../src/nativeSfnt';

const opentype = require('opentype.js');
const view = (data: Uint8Array): DataView => new DataView(data.buffer, data.byteOffset, data.byteLength);
const bufferOf = (data: Uint8Array): ArrayBuffer => Uint8Array.from(data).buffer;

function fixture(): Uint8Array {
  const a = new opentype.Path();
  a.moveTo(0, 0); a.lineTo(500, 0); a.lineTo(250, 700); a.close();
  const alternate = new opentype.Path();
  alternate.moveTo(-40, 0); alternate.curveTo(-40, 500, 450, 650, 500, 0); alternate.close();
  return new Uint8Array(new opentype.Font({ familyName: 'Native SFNT Synthetic', styleName: 'Regular',
    unitsPerEm: 1000, ascender: 800, descender: -200, glyphs: [
      new opentype.Glyph({ name: '.notdef', advanceWidth: 600, path: new opentype.Path() }),
      new opentype.Glyph({ name: 'A', unicode: 65, advanceWidth: 600, path: a }),
      // Deliberately unencoded: TeX can still request this exact glyph ID.
      new opentype.Glyph({ name: 'alternate', advanceWidth: 650, path: alternate }),
    ] }).toArrayBuffer());
}

interface Entry { tag: string; record: number; offset: number; length: number; bytes: Uint8Array }
function directory(data: Uint8Array): Map<string, Entry> {
  const v = view(data), entries = new Map<string, Entry>();
  for (let i = 0; i < v.getUint16(4); i++) {
    const record = 12 + i * 16, tag = String.fromCharCode(...data.subarray(record, record + 4));
    const offset = v.getUint32(record + 8), length = v.getUint32(record + 12);
    entries.set(tag, { tag, record, offset, length, bytes: data.slice(offset, offset + length) });
  }
  return entries;
}

/** Independent fixture assembler: production must additionally set every checksum.
 * Deliberately leaving input checksums unset also checks that source checksum quirks
 * do not prevent preparing a font whose programs and table bounds are otherwise valid.
 */
function assemble(signature: number, tables: Map<string, Uint8Array>): Uint8Array {
  const tags = [...tables.keys()];
  let offset = 12 + 16 * tags.length;
  const out = new Uint8Array(offset + tags.reduce((n, tag) => n + Math.ceil(tables.get(tag)!.length / 4) * 4, 0));
  const v = view(out); v.setUint32(0, signature); v.setUint16(4, tags.length);
  tags.forEach((tag, i) => {
    const record = 12 + i * 16, bytes = tables.get(tag)!;
    for (let j = 0; j < 4; j++) out[record + j] = tag.charCodeAt(j);
    v.setUint32(record + 8, offset); v.setUint32(record + 12, bytes.length);
    out.set(bytes, offset); offset += Math.ceil(bytes.length / 4) * 4;
  });
  return out;
}

function trueTypeFixture(numGlyphs = 3): Uint8Array {
  const tables = new Map([...directory(fixture())].map(([tag, e]) => [tag, e.bytes]));
  tables.delete('CFF ');
  const maxp = new Uint8Array(32), m = view(maxp);
  m.setUint32(0, 0x00010000); m.setUint16(4, numGlyphs); m.setUint16(14, 2);
  tables.set('maxp', maxp);
  view(tables.get('head')!).setInt16(50, 0);
  view(tables.get('hhea')!).setUint16(34, 1);
  const hmtx = new Uint8Array(4 + (numGlyphs - 1) * 2); view(hmtx).setUint16(0, 600);
  tables.set('hmtx', hmtx);
  tables.set('loca', new Uint8Array((numGlyphs + 1) * 2));
  tables.set('glyf', new Uint8Array());
  // Valid tiny stack programs; both tables must survive without reinterpretation.
  tables.set('fpgm', new Uint8Array([0xb0, 0, 0x21]));
  tables.set('prep', new Uint8Array([0xb0, 0, 0x21]));
  tables.set('cvt ', new Uint8Array([0, 64]));
  return assemble(0x00010000, tables);
}

function checksum(data: Uint8Array): number {
  const padded = new Uint8Array(Math.ceil(data.length / 4) * 4); padded.set(data);
  const v = view(padded);
  let n = 0;
  for (let at = 0; at < padded.length; at += 4) n = (n + v.getUint32(at)) >>> 0;
  return n;
}

test('native SFNT roundtrip exposes original CFF glyph IDs, including unencoded glyphs', () => {
  const original = fixture(), before = original.slice(), prepared = prepareNativeSfnt(original);
  const source = opentype.parse(bufferOf(original)), native = opentype.parse(bufferOf(prepared.data));
  assert.equal(prepared.upem, 1000); assert.equal(prepared.numGlyphs, 3);
  assert.equal(native.charToGlyphIndex('A'), 0, 'browser Unicode shaping cannot select the original text cmap');
  assert.equal(native.charToGlyphIndex(String.fromCodePoint(prepared.codePoint(1)!)), 1);
  assert.equal(native.charToGlyphIndex(String.fromCodePoint(prepared.codePoint(2)!)), 2);
  for (const gid of [1, 2]) {
    assert.deepEqual(native.glyphs.get(gid).path.commands, source.glyphs.get(gid).path.commands);
    assert.equal(native.glyphs.get(gid).advanceWidth, source.glyphs.get(gid).advanceWidth);
  }
  const oldTables = directory(original), newTables = directory(prepared.data);
  for (const tag of ['CFF ', 'hmtx', 'hhea', 'maxp', 'name', 'post']) assert.deepEqual(newTables.get(tag)!.bytes, oldTables.get(tag)!.bytes);
  assert.deepEqual(original, before, 'font preparation must not modify shared source bytes');
  const os2 = view(newTables.get('OS/2')!.bytes);
  assert.equal(os2.getUint32(46), 0x10000000, 'BMP private-use coverage, without non-BMP coverage');
  assert.equal(os2.getUint32(50), 0);
});

test('native SFNT computes correct table and whole-font checksums and handles byte views', () => {
  const original = fixture(), wrapped = new Uint8Array(original.length + 23);
  wrapped.fill(0xa5); wrapped.set(original, 11);
  const prepared = prepareNativeSfnt(wrapped.subarray(11, 11 + original.length));
  const v = view(prepared.data);
  for (const e of directory(prepared.data).values()) {
    if (e.tag === 'head') view(e.bytes).setUint32(8, 0);
    assert.equal(v.getUint32(e.record + 4), checksum(e.bytes), `${e.tag} table checksum`);
    assert.equal(e.offset % 4, 0);
  }
  assert.equal(checksum(prepared.data), 0xb1b0afba);
  assert.deepEqual(prepareNativeSfnt(original).data, prepared.data, 'preparation is deterministic');
});

test('native SFNT strips shaping/signature tables while preserving TrueType programs and metrics', () => {
  const input = trueTypeFixture();
  const tables = new Map([...directory(input)].map(([tag, e]) => [tag, e.bytes]));
  for (const tag of ['GSUB', 'GPOS', 'GDEF', 'kern', 'morx', 'mort', 'kerx', 'DSIG']) tables.set(tag, new Uint8Array([1, 2, 3, 4]));
  const prepared = prepareNativeSfnt(assemble(0x00010000, tables)), actual = directory(prepared.data);
  for (const tag of ['GSUB', 'GPOS', 'GDEF', 'kern', 'morx', 'mort', 'kerx', 'DSIG']) assert.equal(actual.has(tag), false, tag);
  for (const tag of ['glyf', 'loca', 'hmtx', 'maxp', 'fpgm', 'prep', 'cvt ']) assert.deepEqual(actual.get(tag)!.bytes, tables.get(tag), tag);
  const parsed = opentype.parse(bufferOf(prepared.data));
  assert.equal(parsed.charToGlyphIndex(String.fromCodePoint(prepared.codePoint(2)!)), 2);
});

test('all valid glyph IDs have stable private-use mappings, with complete supplementary cmap coverage', () => {
  const prepared = prepareNativeSfnt(trueTypeFixture(0xffff));
  const parsed = opentype.parse(bufferOf(prepared.data));
  assert.equal(prepared.codePoint(1), 0xe000);
  assert.equal(prepared.codePoint(6400), 0xf8ff);
  assert.equal(prepared.codePoint(6401), 0xf0000);
  assert.equal(nativeSfntCodePoint(2, 3), nativeSfntCodePoint(2, 0xffff));
  const os2 = view(directory(prepared.data).get('OS/2')!.bytes);
  assert.equal(os2.getUint32(46), 0x12000000, 'Unicode range bits 57 (non-BMP) and 60 (BMP private use)');
  assert.equal(os2.getUint32(50), 0x04000000, 'Unicode range bit 90 (supplementary private use)');
  assert.equal(os2.getUint16(64), 0xe000);
  assert.equal(os2.getUint16(66), 0xffff);
  for (let gid = 1; gid < prepared.numGlyphs; gid++) {
    const point = prepared.codePoint(gid)!;
    assert.ok(point <= 0xffffd && !(point >= 0xd800 && point <= 0xdfff));
    assert.equal(parsed.charToGlyphIndex(String.fromCodePoint(point)), gid);
  }
  for (const gid of [0, -1, 0xffff, 1.5, NaN, Infinity]) assert.equal(prepared.codePoint(gid), undefined);
  for (const count of [0, -1, 65536, 1.2, NaN]) assert.equal(nativeSfntCodePoint(1, count), undefined);
});

test('unsupported variable, collection, CFF2, color and bitmap fonts are rejected explicitly', () => {
  const tables = new Map([...directory(fixture())].map(([tag, e]) => [tag, e.bytes]));
  for (const tag of ['fvar', 'gvar', 'avar', 'HVAR', 'CFF2', 'VARC', 'COLR', 'CPAL', 'CBDT', 'sbix', 'SVG ', 'EBDT']) {
    const modified = new Map(tables); modified.set(tag, new Uint8Array([0, 1, 0, 0]));
    assert.throws(() => prepareNativeSfnt(assemble(0x4f54544f, modified)), /unsupported table/, tag);
  }
  const collection = fixture(); view(collection).setUint32(0, 0x74746366);
  assert.throws(() => prepareNativeSfnt(collection), /unsupported container/);
});

test('malformed table directories, required metadata and glyph locations cannot produce a native font', () => {
  assert.throws(() => prepareNativeSfnt(new Uint8Array(11)), /truncated font header/);
  assert.throws(() => prepareNativeSfnt(fixture().subarray(0, 30)), /truncated table directory/);
  const cases: [string, (data: Uint8Array, entries: Map<string, Entry>) => void, RegExp][] = [
    ['bounds', (d, es) => view(d).setUint32(es.get('name')!.record + 8, 0xfffffffc), /invalid bounds/],
    ['duplicate', (d, es) => { const at = es.get('name')!.record; d.set(new TextEncoder().encode('head'), at); }, /duplicate table/],
    ['overlap', (d, es) => view(d).setUint32(es.get('post')!.record + 8, es.get('name')!.offset), /overlapping/],
    ['upem', (d, es) => view(d).setUint16(es.get('head')!.offset + 18, 0), /units per em/],
    ['magic', (d, es) => view(d).setUint32(es.get('head')!.offset + 12, 0), /invalid head header/],
    ['metrics', (d, es) => view(d).setUint16(es.get('hhea')!.offset + 34, 0), /horizontal metrics/],
    ['missing', (d, es) => d.set(new TextEncoder().encode('TEST'), es.get('post')!.record), /missing or truncated table post/],
  ];
  for (const [label, mutate, pattern] of cases) {
    const data = fixture(); mutate(data, directory(data)); assert.throws(() => prepareNativeSfnt(data), pattern, label);
  }
  const ttf = trueTypeFixture(), loca = directory(ttf).get('loca')!;
  view(ttf).setUint16(loca.offset + 2, 1);
  assert.throws(() => prepareNativeSfnt(ttf), /invalid glyph locations/);
});
