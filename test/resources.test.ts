import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fontKey } from '../src/fontKey';
import { glyphCoverage } from '../src/fontCoverage';
import type { DisplayList, Item, Line } from '../src/protocol';
import { displayListsNeedPdf, imageInfo, usedResources } from '../src/resourceUsage';
import { ResourceLoader } from '../src/resources';

function display(other: Item[] = [], lines: Item[][] = []): DisplayList {
  return { kind: 'page', fonts: {}, other, lines: lines.map((items): Line =>
    ({ x: 0, y: 100, w: 200, h: 10, d: 2, items })), flags: [], width: 200, height: 300, depth: 0 };
}
const glyph = (font: number, char = 65): Item => ['g', font, char, 900, 0, 0, 10, 0];
const image = (index: number): Item => ['i', index, 0, 0, 10, 10];

test('font loading follows actual glyph ids in page material and rows, ignoring unused virtual descriptors', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rtex-used-fonts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = path.join(root, 'first.otf');
  const second = path.join(root, 'second.ttf');
  await fs.writeFile(first, new Uint8Array([1, 2, 3]));
  await fs.writeFile(second, new Uint8Array([4, 5, 6]));
  const dl = display([
    ['c', 2, 0, '0 0 0 rg'], ['M', 'save', 2, 0, ''], glyph(7), ['M', 'restore', 0, 0, ''],
  ], [[glyph(9), glyph(7)]]);
  dl.fonts = {
    '2': { id: 2, name: 'fver8t' }, // real virtual-font metadata, expanded away before drawing
    '7': { id: 70, filename: first }, // the record's lookup id, not desc.id or glyph index
    '9': { id: 90, filename: second },
  };
  const loader = new ResourceLoader(process.env);
  loader.kpsewhich = async (name) => { throw new Error(`unused font must not be looked up: ${name}`); };
  const loaded = await loader.fontsFor([dl], new Set());
  assert.deepEqual([...loaded.keys()].sort(), [fontKey(dl.fonts['7']), fontKey(dl.fonts['9'])].sort());
  assert.equal(loaded.get(fontKey(dl.fonts['7']))?.kind, 'sfnt');
  assert.equal(loaded.get(fontKey(dl.fonts['9']))?.kind, 'sfnt');
  assert.deepEqual([...await loader.fontsFor([dl], new Set(loaded.keys()))], []);
});

test('image loading resolves actual direct and ranked references without fetching unused or cached images', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rtex-used-images-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'page.png'), new Uint8Array([1, 2]));
  await fs.writeFile(path.join(root, 'row.jpg'), new Uint8Array([3, 4]));
  const dl = display([image(1)], [[image(80), image(1)]]);
  dl.images_info = {
    '12': { file: 'cached.pdf', cached_picture: true },
    '41': { file: 'page.png' },
    '80': { file: 'row.jpg' },
    '99': { file: 'unused-missing.png' },
  };
  assert.equal(imageInfo(dl, 1)?.file, 'page.png');
  assert.equal(imageInfo(dl, 80)?.file, 'row.jpg');
  const loader = new ResourceLoader(process.env);
  const loaded = await loader.imagesFor([dl], new Set(), root);
  assert.deepEqual([...loaded.keys()].sort(), ['page.png', 'row.jpg']);
  assert.equal(loaded.get('page.png')?.kind, 'bitmap');
  assert.equal(loaded.get('row.jpg')?.kind, 'bitmap');
  assert.deepEqual([...await loader.imagesFor([dl], new Set(loaded.keys()), root)], []);
});

test('unused missing resource metadata does not force a PDF, but genuinely used missing resources do', () => {
  const dl = display([glyph(7)], [[image(1)]]);
  dl.fonts = { '2': { id: 2, name: 'fver8t' }, '7': { id: 7, name: 'actual-base-font' } };
  dl.images_info = { '1': { file: 'actual.png' }, '2': { file: 'unused.png' } };
  const unusedMissing = new Set(['tfm:fver8t', 'image:unused.png']);
  assert.equal(displayListsNeedPdf([dl], unusedMissing), false);
  assert.equal(displayListsNeedPdf([dl], new Set([...unusedMissing, 'tfm:actual-base-font'])), true);
  assert.equal(displayListsNeedPdf([dl], new Set([...unusedMissing, 'image:actual.png'])), true);
  assert.deepEqual([...usedResources(dl).fonts.keys()], ['tfm:actual-base-font']);
  assert.deepEqual([...usedResources(dl).images.keys()], ['actual.png']);
});

test('missing used descriptors and image references still select PDF fallback', () => {
  const glyphWithoutDescriptor = display([], [[glyph(77)]]);
  assert.equal(usedResources(glyphWithoutDescriptor).missingMetadata, true);
  assert.equal(displayListsNeedPdf([glyphWithoutDescriptor], new Set()), true);
  const imageWithoutInfo = display([image(4)]);
  assert.equal(displayListsNeedPdf([imageWithoutInfo], new Set()), true);
  imageWithoutInfo.images_info = { '4': { file: '' } };
  assert.equal(displayListsNeedPdf([imageWithoutInfo], new Set()), true);
});

test('unsupported drawing, extractor flags and cached PDF pictures retain real PDF fallback', () => {
  const flagged = display();
  flagged.flags = { virtual_unexpanded: 1 };
  const cached = display([image(10)]);
  cached.images_info = { '10': { file: 'cached.pdf', cached_picture: true } };
  for (const dl of [flagged, cached, display([['l', 0, 'q 0 0 0 0 re W n']]),
    display([], [[['u', 'cached_picture', '10 0 0 10 10']]])]) {
    assert.equal(displayListsNeedPdf([dl], new Set()), true);
  }
  assert.equal(displayListsNeedPdf([display()], new Set()), false);
});

test('resource selection keeps glyphs inside transform/color state and ignores navigation-only records', () => {
  const dl = display([
    ['M', 'save', 300, 0, ''], ['M', 'set', 400, 0, '1 0 0 1'],
    ['c', 500, 0, '1 0 0 rg'], glyph(12), ['M', 'restore', 0, 0, ''],
    ['D', 'target', 600, 0], ['L', 'target', 700, 0, 10, 10],
  ], [[glyph(13, 66)]]);
  dl.fonts = { '12': { id: 12, name: 'page-font' }, '13': { id: 13, name: 'row-font' },
    '300': { id: 300, name: 'not-a-glyph-font' } };
  const used = usedResources(dl);
  assert.deepEqual([...used.fonts.keys()], ['tfm:page-font', 'tfm:row-font']);
  assert.equal(used.missingMetadata, false);
  assert.equal(used.requiresPdf, false);
});

test('Type1 coverage uses actual character outlines rather than unrelated glyph indices', () => {
  const covers = glyphCoverage({ kind: 'type1', upem: 1000, glyphs: { 65: 'M0 0L100 0L50 100Z', 32: '' } });
  assert.equal(covers(65, 900), true);
  assert.equal(covers(32, null), true, 'an empty but present outline can legitimately draw no ink');
  assert.equal(covers(66, 65), false, 'a different available character must not mask a missing glyph');
  assert.equal(glyphCoverage({ kind: 'missing', reason: 'unavailable font' })(65, 1), false);
});

function sfntFixture(): Uint8Array {
  // Produce a real parseable OpenType font, so coverage tests exercise the same lazy
  // outline parser as the browser rather than a mocked font metadata object.
  const { Font, Glyph, Path } = require('opentype.js');
  const outline = new Path();
  outline.moveTo(0, 0); outline.lineTo(500, 0); outline.lineTo(250, 700); outline.close();
  const font = new Font({ familyName: 'Coverage Fixture', styleName: 'Regular', unitsPerEm: 1000,
    ascender: 800, descender: -200, glyphs: [
      new Glyph({ name: '.notdef', advanceWidth: 600, path: new Path() }),
      new Glyph({ name: 'A', unicode: 65, advanceWidth: 600, path: outline }),
    ] });
  return new Uint8Array(font.toArrayBuffer());
}

test('SFNT coverage preserves fallback for parse failures, missing indices and unavailable glyphs', () => {
  const covers = glyphCoverage({ kind: 'sfnt', data: sfntFixture() });
  assert.equal(covers(65, 1), true);
  assert.equal(covers(999, 1), true, 'the SFNT display list uses its glyph index');
  for (const index of [null, -1, 2, 100, 1.5]) assert.equal(covers(65, index), false);
  assert.equal(glyphCoverage({ kind: 'sfnt', data: new Uint8Array([1, 2, 3]) })(65, 1), false);
});

test('the resource loader checks real used SFNT glyphs without parsing unused font-table entries', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rtex-glyph-coverage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const valid = path.join(root, 'valid.otf');
  const invalid = path.join(root, 'invalid.ttf');
  await fs.writeFile(valid, sfntFixture());
  await fs.writeFile(invalid, new Uint8Array([1, 2, 3]));
  const dl = display([['g', 1, 65, 1, 0, 0, 600, 0]]);
  dl.fonts = { '1': { id: 1, filename: valid }, '2': { id: 2, filename: invalid } };
  const loader = new ResourceLoader(process.env);
  assert.equal(await loader.glyphsNeedPdf([dl]), false);
  dl.lines = display([], [[['g', 1, 65, 90, 0, 0, 600, 0]]]).lines;
  assert.equal(await loader.glyphsNeedPdf([dl]), true, 'an actually used missing glyph keeps fallback');
  dl.lines = [];
  dl.other = [glyph(2)];
  assert.equal(await loader.glyphsNeedPdf([dl]), true, 'an actually used malformed font keeps fallback');
});
