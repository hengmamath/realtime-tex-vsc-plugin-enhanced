import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { nativeSfntCodePoint, prepareNativeSfnt } from '../src/nativeSfnt';
import type { FontResource } from '../src/fontKey';
import type { DisplayList } from '../src/protocol';
import { FontStore, IDENTITY, ImageStore, Painter, inexactReason } from '../webview/render';

function syntheticFont(): Uint8Array {
  const { Font, Glyph, Path } = require('opentype.js');
  const outline = new Path(); outline.moveTo(0, 0); outline.lineTo(400, 0); outline.lineTo(200, 600); outline.close();
  return new Uint8Array(new Font({ familyName: 'Native Drawing Synthetic', styleName: 'Regular', unitsPerEm: 1000,
    ascender: 800, descender: -200, glyphs: [
      new Glyph({ name: '.notdef', advanceWidth: 500, path: new Path() }),
      new Glyph({ name: 'A', unicode: 65, advanceWidth: 500, path: outline }),
      new Glyph({ name: 'unencoded-alternate', advanceWidth: 500, path: outline }),
    ] }).toArrayBuffer());
}

function environment(t: TestContext) {
  const previous = new Map(['FontFace', 'document', 'Path2D'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const faces: FakeFace[] = [], registered = new Set<FakeFace>();
  const gates: (() => Promise<unknown>)[] = [];
  let paths = 0;
  class FakeFace {
    constructor(readonly family: string, readonly data: ArrayBuffer) { faces.push(this); }
    async load(): Promise<this> { const gate = gates.shift(); if (gate) await gate(); return this; }
  }
  class FakePath {
    constructor(_data?: string) { paths++; }
    moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} closePath() {}
  }
  Object.defineProperty(globalThis, 'FontFace', { configurable: true, value: FakeFace });
  Object.defineProperty(globalThis, 'Path2D', { configurable: true, value: FakePath });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { fonts: {
    add(face: FakeFace) { registered.add(face); }, delete(face: FakeFace) { return registered.delete(face); },
  } } });
  t.after(() => { for (const [key, desc] of previous) {
    if (desc) Object.defineProperty(globalThis, key, desc); else Reflect.deleteProperty(globalThis, key);
  } });
  return { faces, registered, gates, get paths() { return paths; } };
}

function display(index: number | null = 2, char = 65): DisplayList {
  return { kind: 'page', flags: [], fonts: { '1': { id: 1, filename: 'synthetic.otf', size: 1000 } },
    lines: [], other: [['g', 1, char, index, 10, 20, 500, 0]], width: 1000, height: 1000, depth: 0 };
}

function context() {
  const texts: { text: string; matrix: number[]; color: string }[] = [], fills: unknown[] = [];
  let matrix: number[] = [];
  const ctx = { fillStyle: 'black', font: '', textAlign: '', textBaseline: '', direction: '', fontKerning: '',
    setTransform(...m: number[]) { matrix = m; },
    fillText(text: string) { texts.push({ text, matrix: matrix.slice(), color: String(this.fillStyle) }); },
    fill(path: unknown) { fills.push(path); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, fills };
}
const images = () => new ImageStore(async () => { throw new Error('No images in synthetic font test'); });
const key = 'file:synthetic.otf#0';

test('native SFNT uses the exact unencoded glyph ID and keeps TeX position, expansion, slant and color', async (t) => {
  const env = environment(t), fonts = new FontStore(); t.after(() => fonts.clear());
  fonts.add(key, { kind: 'sfnt', data: syntheticFont() }); await fonts.whenReady();
  assert.equal(fonts.nativeStatus().loaded, 1);
  // FontFace received a cmap exposing the otherwise unencoded TeX alternate.
  const { parse } = require('opentype.js');
  const native = parse(env.faces[0].data);
  assert.equal(native.charToGlyphIndex(String.fromCodePoint(nativeSfntCodePoint(2, 3)!)), 2);
  const dl = display(); dl.fonts['1'].extend = 1100; dl.fonts['1'].slant = 200;
  dl.other.unshift(['c', 0, 0, '1 0 0 rg']); dl.other[1][7] = 20000;
  const original = JSON.stringify(dl), ink = context();
  fonts.glyph = () => { throw new Error('A ready native glyph must not parse a Path2D'); };
  assert.equal(inexactReason(dl, fonts, images()), undefined);
  new Painter(ink.ctx, IDENTITY, fonts, images(), { nativeText: true }).draw(dl, dl.other);
  assert.equal(ink.texts[0].text, String.fromCodePoint(nativeSfntCodePoint(2, 3)!));
  assert.equal(ink.texts[0].color, 'rgb(255,0,0)');
  // fontPixels clamps at 100 while units-per-em is 1000; the compensating
  // transform preserves the exact requested 1.122x expansion and baseline.
  assert.deepEqual(ink.texts[0].matrix.map(x => Math.round(x * 1e9) / 1e9), [11.22, 0, -2, 10, 10, 20]);
  assert.equal(ink.fills.length, 0); assert.equal(env.paths, 0);
  assert.equal(JSON.stringify(dl), original, 'native rendering must not rewrite TeX layout records');
});

test('new characters and duplicate resource deliveries reuse one registered font', async (t) => {
  const env = environment(t), fonts = new FontStore(); t.after(() => fonts.clear());
  const data = syntheticFont(); fonts.add(key, { kind: 'sfnt', data }); await fonts.whenReady();
  fonts.add(key, { kind: 'sfnt', data: data.slice() }); await fonts.whenReady();
  const dl = display(1), ink = context(), painter = new Painter(ink.ctx, IDENTITY, fonts, images(), { nativeText: true });
  painter.draw(dl, dl.other); dl.other[0][3] = 2; painter.draw(dl, dl.other);
  assert.deepEqual(ink.texts.map(x => x.text), [1, 2].map(gid => String.fromCodePoint(nativeSfntCodePoint(gid, 3)!)));
  assert.equal(env.faces.length, 1); assert.equal(env.registered.size, 1); assert.equal(env.paths, 0);
});

test('native runs consume only adjacent exact advances and respect TeX spacing and color changes', async (t) => {
  const env = environment(t), fonts = new FontStore(); t.after(() => fonts.clear());
  fonts.add(key, { kind: 'sfnt', data: syntheticFont() }); await fonts.whenReady();
  const dl = display();
  dl.other = [
    ['g', 1, 65, 1, 10, 20, 500, 0], ['g', 1, 65, 2, 510, 20, 500, 0],
    ['g', 1, 65, 1, 1012, 20, 500, 0], // TeX explicitly adjusted this origin.
    ['c', 0, 0, '1 0 0 rg'], ['g', 1, 65, 2, 1512, 20, 500, 0],
  ];
  const original = JSON.stringify(dl), ink = context();
  fonts.glyph = () => { throw new Error('A native run must not construct a Path2D'); };
  new Painter(ink.ctx, IDENTITY, fonts, images(), { nativeText: true }).draw(dl, dl.other);
  assert.deepEqual(ink.texts.map(x => x.text), ['\ue000\ue001', '\ue000', '\ue001']);
  assert.deepEqual(ink.texts.map(x => x.matrix.slice(4)), [[10, 20], [1012, 20], [1512, 20]]);
  assert.deepEqual(ink.texts.map(x => x.color), ['rgb(0,0,0)', 'rgb(0,0,0)', 'rgb(255,0,0)']);
  assert.equal(ink.fills.length, 0); assert.equal(env.paths, 0);
  assert.equal(JSON.stringify(dl), original);
});

test('host-prepared SFNT loads directly, and missing glyph IDs retain exactness checks', async (t) => {
  const env = environment(t), fonts = new FontStore(); t.after(() => fonts.clear());
  const n = prepareNativeSfnt(syntheticFont());
  fonts.add(key, { kind: 'sfnt', data: n.data, native: { upem: n.upem, numGlyphs: n.numGlyphs } });
  await fonts.whenReady();
  assert.deepEqual(new Uint8Array(env.faces[0].data), n.data);
  assert.match(inexactReason(display(999), fonts, images())!, /glyph is missing/);
  assert.match(inexactReason(display(null), fonts, images())!, /glyph is missing/);
});

test('native preparation/load failure and explicitly unsupported fonts keep their outline fallback', async (t) => {
  const env = environment(t), fonts = new FontStore(); t.after(() => fonts.clear());
  env.gates.push(async () => { throw new Error('synthetic browser sanitizer refusal'); });
  fonts.add(key, { kind: 'sfnt', data: syntheticFont() }); await fonts.whenReady();
  assert.equal(fonts.nativeStatus().failed, 1); assert.equal(env.registered.size, 0);
  const dl = display(), ink = context();
  assert.equal(inexactReason(dl, fonts, images()), undefined);
  new Painter(ink.ctx, IDENTITY, fonts, images(), { nativeText: true }).draw(dl, dl.other);
  assert.equal(ink.texts.length, 0); assert.equal(ink.fills.length, 1);
  fonts.clear();
  fonts.add(key, { kind: 'sfnt', data: syntheticFont(), native: null }); await fonts.whenReady();
  assert.equal(fonts.nativeStatus().loaded, 0); assert.equal(env.faces.length, 1);
  assert.equal(inexactReason(dl, fonts, images()), undefined);
});

test('a page waits only for its own font; reset prevents late FontFace resurrection', async (t) => {
  const env = environment(t), fonts = new FontStore(); t.after(() => fonts.clear());
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  env.gates.push(() => held);
  fonts.add('unrelated', { kind: 'sfnt', data: syntheticFont() });
  fonts.add(key, { kind: 'sfnt', data: syntheticFont() });
  await fonts.whenReady([key]);
  assert.equal(fonts.hasPending([key]), false); assert.equal(fonts.hasPending(['unrelated']), true);
  assert.equal(env.registered.size, 1);
  let loaded = 0; fonts.onLoaded = () => { loaded++; };
  const late = fonts.whenReady(['unrelated']); fonts.clear(); release(); await late;
  assert.equal(env.registered.size, 0); assert.equal(loaded, 0);
  assert.deepEqual(fonts.nativeStatus(), { loaded: 0, pending: 0, failed: 0, errors: [] });
});

test('Type1 keeps its character-code mapping and previous native transform', async (t) => {
  const env = environment(t), fonts = new FontStore(); t.after(() => fonts.clear());
  const resource: FontResource = { kind: 'type1', upem: 1000, glyphs: { 65: 'M0 0L400 0L200 600Z' } };
  const dl = display(999); dl.fonts['1'] = { id: 1, name: 'synthetic-type1', size: 1000 };
  fonts.add('tfm:synthetic-type1', resource); await fonts.whenReady();
  const ink = context(); new Painter(ink.ctx, IDENTITY, fonts, images(), { nativeText: true }).draw(dl, dl.other);
  assert.equal(ink.texts[0].text, '\ue000');
  assert.deepEqual(ink.texts[0].matrix.map(x => x || 0), [1, 0, 0, 1, 10, 20]);
  assert.equal(env.paths, 0);
});
