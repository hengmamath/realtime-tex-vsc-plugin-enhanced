import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SP_PER_PT as PT, type DisplayList, type FontDesc, type Line } from '../src/protocol';
import { pageWords } from '../webview/textLayer';

const textFont: FontDesc = { id: 1, name: 'ec-lmr10', size: 10 * PT };

function display(lines: Line[], font = textFont): DisplayList {
  return { kind: 'page', width: 400 * PT, height: 600 * PT, depth: 0,
    flags: {}, lines, fonts: { 1: font }, other: [] };
}

function line(codes: number[], y: number, index: number | null = null, left = 10): Line {
  const start = left * PT;
  let x = start;
  const items: Line['items'] = [];
  for (const code of codes) {
    if (code === 32) x += 3 * PT;
    else {
      items.push(['g', 1, code, index, x, y * PT, 5 * PT, 0]);
      x += 5 * PT;
    }
  }
  return { x: start, y: y * PT, w: x - start, h: 7 * PT, d: 2 * PT, items };
}

const codes = (s: string) => [...s].map(c => c.codePointAt(0)!);
const plain = (words: ReturnType<typeof pageWords>) =>
  words.map(word => word.text + (word.eol ? '\n' : '')).join('');

test('selectable text decodes T1, OT1 and Unicode without changing case or compatibility symbols', () => {
  const t1 = display([line([67, 97, 102, 233, 32, 28, 120, 21, 89, 127], 20)]);
  assert.equal(plain(pageWords(t1, t1.lines, [])), 'Café fix–Y-\n');
  const ot1 = display([line([92, 12, 34], 20)], { ...textFont, name: 'cmr10' });
  assert.equal(plain(pageWords(ot1, ot1.lines, [])), '“fi”\n');
  const unicode = display([line(codes('数学 ﬁ x²'), 20, 1)], { ...textFont, format: 'opentype' });
  assert.equal(plain(pageWords(unicode, unicode.lines, [])), '数学 fi x²\n');
});

test('standard Times, TeX Gyre and OT1 typewriter text use their own encodings', () => {
  const terms = line(codes('Cafe'), 20);
  const accent = [...terms.items[3]] as Line['items'][number];
  accent[2] = 19;
  terms.items.splice(3, 0, accent);
  const termes = display([terms], { ...textFont, name: 'rm-qtmr' });
  assert.equal(plain(pageWords(termes, termes.lines, [])), 'Café\n');
  const times = display([line([147, 67, 97, 102, 233, 148, 32, 2, 120], 20)], { ...textFont, name: 'ptmr8r' });
  assert.equal(plain(pageWords(times, times.lines, [])), '“Café” fix\n');
  const code = String.raw`"{x}\_"`;
  const mono = display([line(codes(code), 20)], { ...textFont, name: 'rm-lmtt10' });
  assert.equal(plain(pageWords(mono, mono.lines, [])), code + '\n');
});

test('live rows use their drawn positions and covered background glyphs cannot be copied', () => {
  const before = line(codes('Earlier words'), 20);
  const obsolete = line(codes('Old'), 40);
  const after = line(codes('Later words'), 60);
  const page = display([before, obsolete, after]);
  const row = line(codes('Fresh words'), 0);
  const dl = display([row]);
  const words = pageWords(page, page.lines, [{
    overlay: { parId: 7, dl, fragments: [], revision: 2 },
    rows: [{ line: row, dx: 2 * PT, dy: 40 * PT }],
  }]);
  assert.equal(plain(words), 'Earlier words\nFresh words\nLater words\n');
  assert.equal(words.find(word => word.text === 'Fresh ')?.x, 12 * PT);
  assert.equal(words.find(word => word.text === 'Fresh ')?.y, 40 * PT);
});

test('right-column live text replaces its captured row without interrupting the left column', () => {
  const left = [line(codes('Left one'), 20), line(codes('Left two'), 60)];
  const right = [line(codes('Right one'), 20, null, 100), line(codes('Old'), 40, null, 100), line(codes('Right three'), 60, null, 100)];
  const page = display([...left, ...right]);
  page.other = [...line(codes('Header'), 5).items, ...line(codes('1'), 100).items];
  const row = line(codes('Fresh right'), 0);
  const overlay = { parId: 7, dl: display([row]), fragments: [], revision: 2 };
  const words = pageWords(page, [...left, right[0], right[2]], [{ overlay, rows: [{ line: row, dx: 90 * PT, dy: 40 * PT }] }],
    id => id === 7 ? 3 : undefined);
  assert.equal(plain(words), 'Header\nLeft one\nLeft two\nRight one\nFresh right\nRight three\n1\n');
});
