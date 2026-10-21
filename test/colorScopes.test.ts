/// <reference lib="dom" />
/// <reference path="../webview/opentype.d.ts" />
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { prepareTestRuntime } from './runtimeFixture';
import type { DisplayList, Item } from '../src/protocol';
import { FontStore, IDENTITY, ImageStore, Painter, pdfColor } from '../webview/render';

const exec = promisify(execFile);
const RED = 'rgb(156,0,0)';
const BLUE = 'rgb(0,0,255)';
const BLACK = 'rgb(0,0,0)';
type Ink = { kind: 'glyph' | 'rule'; text: string; color: string };

// Record what the real painter sends to the canvas. Missing fonts select its plain-text
// fallback; the display-list glyph/color/rule traversal remains the production code.
function recorder() {
  const ink: Ink[] = [];
  const context = {
    fillStyle: BLACK,
    setTransform() {},
    fillText(this: { fillStyle: string }, text: string) { ink.push({ kind: 'glyph', text, color: this.fillStyle }); },
    fillRect(this: { fillStyle: string }) { ink.push({ kind: 'rule', text: '', color: this.fillStyle }); },
  } as unknown as CanvasRenderingContext2D;
  const fonts = { get: () => undefined } as unknown as FontStore;
  const images = { get: () => undefined } as unknown as ImageStore;
  const painter = new Painter(context, IDENTITY, fonts, images, { nativeText: true });
  return { ink, painter };
}

function blank(items: Item[] = []): DisplayList {
  return { kind: 'paragraph', fonts: { '1': { id: 1, size: 655360 } }, lines: [], other: items,
    flags: [], width: 0, height: 0, depth: 0 };
}
const glyph = (char: string): Item => ['g', 1, char.codePointAt(0), null, 0, 0, 655360, 0];

function assertWord(ink: Ink[], word: string, color: string): void {
  const glyphs = ink.filter((it) => it.kind === 'glyph');
  const text = glyphs.map((it) => it.text).join('');
  const at = text.indexOf(word);
  assert.notEqual(at, -1, `missing fixture marker ${word} in ${text}`);
  for (const it of glyphs.slice(at, at + word.length)) {
    assert.equal(it.color, color, `${word}: character ${it.text} has the wrong color`);
  }
}

test('PDF grayscale, RGB and CMYK colors keep their expected values', () => {
  assert.equal(pdfColor('0 g 0 G'), BLACK);
  assert.equal(pdfColor('0.612 0 0 rg 0.612 0 0 RG'), RED);
  assert.equal(pdfColor('0 0 1 rg'), BLUE);
  assert.equal(pdfColor('0 1 1 0 k'), 'rgb(255,0,0)');
});

test('current colorstack command selects that stack after another stack was active', () => {
  const dl = blank();
  const { ink, painter } = recorder();
  painter.draw(dl, [
    ['c', 0, 0, '0.612 0 0 rg'], glyph('R'),
    ['c', 7, 0, '0 0 1 rg'], glyph('B'),
    ['c', 0, 3, ''], glyph('R'),
    ['c', 7, 3, ''], glyph('B'),
  ]);
  assert.deepEqual(ink.map((it) => it.color), [RED, BLUE, RED, BLUE]);
});

// Release verification uses the complete packaged support with RTEX_TEST_BUNDLED=1.
test('real LuaLaTeX revision scopes survive lists, formulas, independent rows and page breaks', {
  skip: !process.env.RTEX_TEST_BUNDLED && 'set RTEX_TEST_BUNDLED=1 to run the real LuaLaTeX regression',
  timeout: 90000,
}, async () => {
  const root = path.resolve(__dirname, '..', '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rtex-color-scopes-'));
  try {
    const { texDir: support } = await prepareTestRuntime(root);
    await fs.copyFile(path.join(root, 'test', 'fixtures', 'color-scopes.tex'), path.join(temporary, 'main.tex'));
    const cache = path.join(temporary, 'texmf-cache');
    await fs.mkdir(cache);
    const bin = process.env.RTEX_TEST_TEXLIVE_BIN;
    const executable = bin ? path.join(bin, process.platform === 'win32' ? 'lualatex.exe' : 'lualatex') : 'lualatex';
    try {
      await exec(executable, [
        '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-jobname=color-scopes',
        '\\RequirePackage{rtex-capture}\\input{main.tex}',
      ], {
        cwd: temporary,
        env: { ...process.env, TEXINPUTS: `${support}//:${temporary}//:`, LUAINPUTS: `${support}//:`,
          TEXMFVAR: cache, TEXMFCACHE: cache, RTEX_CAPTURE_DIR: '.' },
        timeout: 60000,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      const detail = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`LuaLaTeX color fixture failed: ${detail.message}\n${detail.stdout ?? ''}\n${detail.stderr ?? ''}`);
    }
    const names = (await fs.readdir(temporary)).filter((name) => /^color-scopes\.rtex-page\d+\.json$/.test(name))
      .sort((a, b) => Number(a.match(/page(\d+)/)![1]) - Number(b.match(/page(\d+)/)![1]));
    assert.equal(names.length, 2, 'the fixture must exercise a red scope spanning two pages');
    const pages: DisplayList[] = await Promise.all(names.map(async (name) => JSON.parse(await fs.readFile(path.join(temporary, name), 'utf8'))));
    const allInk: Ink[][] = [];
    for (const dl of pages) {
      const { ink, painter } = recorder();
      painter.draw(dl, dl.other);
      const rows: Ink[][] = [];
      for (const line of dl.lines) {
        const before = ink.length;
        painter.draw(dl, line.items);
        rows.push(ink.slice(before));
      }
      allInk.push(ink);
      // A live overlay can draw only selected rows. Start each row in a deliberately wrong
      // color, with no previous row or `other` list, and compare every glyph and fraction rule.
      for (const index of dl.lines.map((_, i) => i).reverse()) {
        const separate = recorder();
        separate.painter.draw(dl, [['c', 0, 0, '0 1 0 rg']]);
        separate.painter.draw(dl, dl.lines[index].items, 65536, 2 * 65536);
        assert.deepEqual(separate.ink, rows[index], `page ${dl.page}, independent row ${index}`);
      }
    }
    const first = allInk[0];
    const second = allInk[1];
    assertWord(first, 'BLACKBEFORE', BLACK);
    for (const word of ['REDFIRST', 'REDPARAGRAPH', 'REDRESTORED', 'REDSECOND', 'REDITEMTAIL', 'REDTAIL']) {
      assertWord(first, word, RED);
    }
    assertWord(first, 'BLUENESTED', BLUE);
    const rules = first.filter((it) => it.kind === 'rule');
    assert.ok(rules.length >= 1, 'the equation must include a real fraction rule');
    assert.ok(rules.every((it) => it.color === RED), 'formula fraction rules must share the text color');
    assertWord(second, 'REDCONTINUED', RED);
    assertWord(second, 'REDLAST', RED);
    assertWord(second, 'BLACKAFTER', BLACK);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
