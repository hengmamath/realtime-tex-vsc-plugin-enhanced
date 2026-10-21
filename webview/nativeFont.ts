import * as opentype from 'opentype.js';
import type { FontResource } from '../src/fontKey';
import { nativeSfntCodePoint, prepareNativeSfnt } from '../src/nativeSfnt';

/** Private character mapping for exact individually positioned TeX glyphs.
 * No browser shaping, kerning, substitution, PDF creation, or source font substitution.
 * Type1 outlines are wrapped once. Static SFNT fonts use a private cmap over the
 * original glyph ids, with browser substitution/positioning tables removed.
 */
export interface NativeOutlineFont {
  readonly family: string;
  readonly chars: ReadonlyMap<number, string>;
  readonly ready: Promise<void>;
  loaded: boolean;
  error?: string;
  dispose(): void;
}

/** Owned by one Painter; other canvas text writers must invalidate its font. */
export interface NativeTextState { font?: string; configured?: boolean }

type PathBuilder = { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void;
  curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void;
  quadTo(x1: number, y1: number, x: number, y: number): void; close(): void;
  getBoundingBox(): { y1: number; y2: number } };
interface FontBuilder { toArrayBuffer(): ArrayBuffer }
const builders = opentype as unknown as {
  Path: new () => PathBuilder;
  Glyph: new (options: { name: string; unicode?: number; advanceWidth: number; path: PathBuilder }) => unknown;
  Font: new (options: { familyName: string; styleName: string; unitsPerEm: number; ascender: number; descender: number; glyphs: unknown[] }) => FontBuilder;
};
let familyId = 0;

/** Read only the absolute commands emitted by src/type1.ts; reject unexpected syntax. */
export function pathFromType1Outline(data: string): PathBuilder {
  const tokens = data.match(/[MLCQZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? [];
  if (data.replace(/[MLCQZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?|[\s,]/g, '')) {
    throw new Error('Unsupported Type1 outline syntax');
  }
  const path = new builders.Path();
  let i = 0;
  const n = (): number => { const value = Number(tokens[i++]); if (!Number.isFinite(value)) throw new Error('Invalid outline number'); return value; };
  while (i < tokens.length) {
    switch (tokens[i++]) {
      case 'M': path.moveTo(n(), n()); break;
      case 'L': path.lineTo(n(), n()); break;
      case 'C': path.curveTo(n(), n(), n(), n(), n(), n()); break;
      case 'Q': path.quadTo(n(), n(), n(), n()); break;
      case 'Z': path.close(); break;
      default: throw new Error('Unsupported Type1 outline command');
    }
  }
  return path;
}

export function nativeFontFromType1(upem: number, outlines: Record<number, string>): NativeOutlineFont {
  const family = `RtexOutline${++familyId}`;
  const chars = new Map<number, string>();
  let face: FontFace | undefined;
  let disposed = false;
  const fontSet = document.fonts as FontFaceSet & { add(face: FontFace): FontFaceSet; delete(face: FontFace): boolean };
  const font: NativeOutlineFont = { family, chars, loaded: false, ready: Promise.resolve(), dispose() {
    disposed = true;
    font.loaded = false;
    if (face) fontSet.delete(face);
  } };
  const prepare = async (): Promise<void> => {
    const glyphs: unknown[] = [new builders.Glyph({ name: '.notdef', advanceWidth: upem, path: new builders.Path() })];
    let ascender = upem;
    let descender = -Math.round(upem / 4);
    for (const [key, data] of Object.entries(outlines)) {
      const id = Number(key);
      if (!Number.isInteger(id) || id < 0) throw new Error('Invalid glyph id');
      // Use BMP private-use slots first; supplementary PUA supports larger fonts too.
      const unicode = chars.size < 0x1900 ? 0xe000 + chars.size : 0xf0000 + chars.size - 0x1900;
      if (unicode > 0xffffd) throw new Error('Font has too many glyphs');
      const path = pathFromType1Outline(data);
      const box = path.getBoundingBox();
      ascender = Math.max(ascender, Math.ceil(box.y2));
      descender = Math.min(descender, Math.floor(box.y1));
      glyphs.push(new builders.Glyph({ name: `g${id}`, unicode, advanceWidth: upem, path }));
      chars.set(id, String.fromCodePoint(unicode));
    }
    const buffer = new builders.Font({ familyName: family, styleName: 'Regular', unitsPerEm: upem,
      ascender, descender, glyphs }).toArrayBuffer();
    face = new FontFace(family, buffer, { style: 'normal', weight: 'normal' });
    await face.load();
    if (disposed) return;
    fontSet.add(face);
    font.loaded = true;
  };
  const ready = prepare().catch((error: unknown) => { font.error = String(error); });
  Object.defineProperty(font, 'ready', { value: ready });
  return font;
}

/** Ordinary production resources are already prepared in ResourceLoader. Raw SFNT
 * resources remain accepted for standalone renderers and older diagnostic clients. */
export function nativeFontFromSfnt(resource: Extract<FontResource, { kind: 'sfnt' }>): NativeOutlineFont | undefined {
  if (resource.native === null) return undefined;
  const family = `RtexOutline${++familyId}`;
  const chars = new Map<number, string>();
  let face: FontFace | undefined;
  let disposed = false;
  const fontSet = document.fonts as FontFaceSet & { add(face: FontFace): FontFaceSet; delete(face: FontFace): boolean };
  const font: NativeOutlineFont = { family, chars, loaded: false, ready: Promise.resolve(), dispose() {
    disposed = true;
    font.loaded = false;
    if (face) fontSet.delete(face);
  } };
  const prepare = async (): Promise<void> => {
    const prepared = resource.native ? { ...resource.native, data: resource.data } : prepareNativeSfnt(resource.data);
    for (let id = 1; id < prepared.numGlyphs; id++) {
      const cp = nativeSfntCodePoint(id, prepared.numGlyphs);
      if (cp !== undefined) chars.set(id, String.fromCodePoint(cp));
    }
    const data = prepared.data;
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    face = new FontFace(family, buffer, { style: 'normal', weight: 'normal' });
    await face.load();
    if (disposed) return;
    fontSet.add(face);
    font.loaded = true;
  };
  const ready = prepare().catch((error: unknown) => { font.error = String(error); });
  Object.defineProperty(font, 'ready', { value: ready });
  return font;
}

/** FontStore composition helper. Unsupported font kinds keep using their existing paths. */
export class NativeFontRegistry {
  private readonly fonts = new Map<string, NativeOutlineFont>();
  private readonly pending = new Set<Promise<void>>();
  onLoaded: (key: string) => void = () => undefined;

  add(key: string, resource: FontResource): void {
    // Resources are immutable within one session. Duplicate deliveries must not
    // register another FontFace or interrupt an already prepared font.
    if (this.fonts.has(key)) return;
    const font = resource.kind === 'type1' ? nativeFontFromType1(resource.upem, resource.glyphs) :
      resource.kind === 'sfnt' ? nativeFontFromSfnt(resource) : undefined;
    if (!font) return;
    this.fonts.set(key, font);
    const ready = font.ready.then(() => {
      this.pending.delete(ready);
      if (this.fonts.get(key) === font && font.loaded) this.onLoaded(key);
    });
    this.pending.add(ready);
  }

  get(key: string): NativeOutlineFont | undefined { return this.fonts.get(key); }

  hasPending(keys: Iterable<string>): boolean {
    for (const key of keys) {
      const font = this.fonts.get(key);
      if (font && !font.loaded && !font.error) return true;
    }
    return false;
  }

  async whenReady(keys?: Iterable<string>): Promise<void> {
    await Promise.all(keys ? [...keys].map(key => this.fonts.get(key)?.ready) : [...this.pending]);
  }

  clear(): void {
    for (const font of this.fonts.values()) font.dispose();
    this.fonts.clear();
    this.pending.clear();
  }

  status(): { loaded: number; pending: number; failed: number; errors: string[] } {
    const errors = [...this.fonts].flatMap(([key, font]) => font.error ? [`${key}: ${font.error}`] : []);
    return { loaded: [...this.fonts.values()].filter(font => font.loaded).length,
      pending: this.pending.size, failed: errors.length, errors };
  }
}

/** `outlineTransform` is the existing font-units (y-up) → canvas transform.
 * Returns false without changing context when the browser font is unavailable.
 * The caller can then execute the original ctx.fill(path).
 */
export function drawNativeGlyph(
  ctx: CanvasRenderingContext2D,
  font: NativeOutlineFont | undefined,
  upem: number,
  glyphId: number,
  outlineTransform: readonly [number, number, number, number, number, number],
  fontPixels = upem,
  state?: NativeTextState,
  runText?: string,
): boolean {
  const char = font?.loaded && font.chars.get(glyphId);
  if (!font || !char) return false;
  const [a, b, c, d, e, f] = outlineTransform;
  // Canvas text already reverses font y-up coordinates around the alphabetic baseline.
  const factor = upem / fontPixels;
  ctx.setTransform(a * factor, b * factor, -c * factor, -d * factor, e, f);
  const cssFont = `${fontPixels}px "${font.family}"`;
  if (!state || state.font !== cssFont) { ctx.font = cssFont; if (state) state.font = cssFont; }
  if (!state?.configured) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.direction = 'ltr';
    ctx.fontKerning = 'none';
    if (state) state.configured = true;
  }
  ctx.fillText(runText ?? char, 0, 0);
  return true;
}
