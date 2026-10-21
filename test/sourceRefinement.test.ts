import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FontDesc, Item } from '../src/protocol';
import { isKnownMathSource, isNearSourceInk, refinePreviewPosition, refineSourceSelection, type RefinementHit } from '../src/sourceRefinement';

const PT = 65536;
const fonts: Record<string, FontDesc> = {
  // These names/formats match the actual bundled LuaTeX display lists, including
  // encoding-slot TFM fonts whose format is merely "unknown".
  1: { id: 1, name: 'ec-lmr10', format: 'unknown', type: 'unknown', size: 10 * PT },
  2: { id: 2, name: 'cmmi10', format: 'unknown', type: 'unknown', size: 10 * PT },
  3: { id: 3, name: 'cmr10', format: 'unknown', type: 'unknown', size: 10 * PT },
  4: { id: 4, name: 'UnicodeText', format: 'opentype', filename: 'text.otf', size: 10 * PT },
  5: { id: 5, name: 'cmsy10', format: 'unknown', type: 'unknown', size: 10 * PT },
};

interface Chunk { text: string; math?: boolean; font?: number; ligatures?: boolean; marker?: 'off' | 'none' }
function render(chunks: Chunk[], clicked: { text: string; occurrence?: number; offset?: number }): RefinementHit {
  const items: Item[] = [];
  const positions: { text: string; x: number; end: number }[] = [];
  const anchors: NonNullable<RefinementHit['row']['source_anchors']> = [];
  let x = 10 * PT;
  for (const chunk of chunks) {
    if (chunk.math && !chunk.marker) items.push(['m', 'on', x]);
    for (let i = 0; i < chunk.text.length;) {
      const ch = String.fromCodePoint(chunk.text.codePointAt(i)!);
      if (ch === ' ') {
        anchors.push({ x, w: 3 * PT, file: 'main.tex', line: 10, kind: chunk.math ? 'mg' : 'g' });
        x += 3 * PT; i++; continue;
      }
      const ligature = chunk.ligatures && chunk.text.startsWith('ff', i);
      const value = ligature ? 'ff' : ch;
      const code = ligature ? 27 : ch.codePointAt(0)!;
      const width = (ligature ? 7 : 5) * PT;
      const font = chunk.font ?? (chunk.math ? /[a-zA-Z]/.test(ch) ? 2 : 3 : 1);
      items.push(['g', font, code, null, x, 100 * PT, width, 0]);
      positions.push({ text: value, x, end: x + width });
      x += width; i += value.length;
    }
    if (chunk.math && chunk.marker !== 'none') items.push(['m', 'off', x]);
  }
  const all = positions.map((p) => p.text).join('');
  let index = -1;
  for (let occurrence = 0; occurrence <= (clicked.occurrence ?? 0); occurrence++) index = all.indexOf(clicked.text, index + 1);
  assert.ok(index >= 0, `test click ${clicked.text} missing in ${all}`);
  index += clicked.offset ?? Math.floor(clicked.text.length / 2);
  let at = 0;
  const selected = positions.find((p) => { const selected = at <= index && index < at + p.text.length; at += p.text.length; return selected; })!;
  return { row: { x: 10 * PT, y: 100 * PT, w: x - 10 * PT, h: 8 * PT, d: 2 * PT, items, source_anchors: anchors },
    fonts, x: (selected.x + selected.end) / 2, y: 97 * PT, file: 'main.tex', line: 10 };
}

function expected(source: string, word: string, kind: 'word' | 'math' = 'word', occurrence = 0) {
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = source.indexOf(word, start + 1);
  assert.ok(start >= 0);
  return { start, end: start + word.length, kind };
}

test('ordinary prose selects an interior word with exact UTF16 source columns', () => {
  const source = '  Then   the desired conclusion follows directly.';
  const hit = render([{ text: 'Then the desired conclusion follows directly.' }], { text: 'conclusion' });
  assert.deepEqual(refineSourceSelection(source, hit, ''), expected(source, 'conclusion'));
});

test('REV and known formatting commands preserve literal word positions', () => {
  const source = '\\begin{REV} A \\textbf{strong} \\emph{conclusion} follows.\\end{REV}';
  const hit = render([{ text: 'A strong conclusion follows.' }], { text: 'conclusion' });
  assert.deepEqual(refineSourceSelection(source, hit, ''), expected(source, 'conclusion'));
});

test('forward refinement locates a source column within REV and a wrapped long source line', () => {
  const source = '\\begin{REV} Opening paragraph continues across a wrapped row. The saffronword target follows.\\end{REV}';
  const first = render([{ text: 'Opening paragraph continues across a wrapped row.' }], { text: 'Opening' });
  const second = render([{ text: 'The saffronword target follows.', ligatures: true }], { text: 'saffronword' });
  const column = source.indexOf('saffronword') + 3;
  const earlier = refinePreviewPosition(source, first, column);
  const exact = refinePreviewPosition(source, second, column);
  assert.ok(earlier && earlier.distance > 0);
  assert.equal(exact?.distance, 0);
  assert.ok(exact!.x < second.x && second.x - exact!.x < 60 * PT, 'target uses the actual word position');
});

test('forward refinement disambiguates repeated words by context and declines opaque macros', () => {
  const source = 'leftbirch harbor middlelinden harbor rightcedar';
  const hit = render([{ text: source }], { text: 'harbor', occurrence: 1 });
  const column = source.lastIndexOf('harbor') + 2;
  const target = refinePreviewPosition(source, hit, column);
  assert.equal(target?.distance, 0);
  assert.ok(target!.x < hit.x && hit.x - target!.x < 30 * PT);
  assert.equal(refinePreviewPosition('\\custom{harbor}', hit, 10), undefined);
  assert.equal(refinePreviewPosition('the result follows. the result follows.', render([{ text: 'the result follows.' }], { text: 'result' }), 5), undefined);
});

test('repeated words use nearby words rather than the first source occurrence', () => {
  const source = 'leftbirch harbor middlelinden harbor rightcedar';
  const hit = render([{ text: source }], { text: 'harbor', occurrence: 1 });
  assert.deepEqual(refineSourceSelection(source, hit, ''), expected(source, 'harbor', 'word', 1));
  const partialRow = render([{ text: 'harbor' }], { text: 'harbor' });
  assert.equal(refineSourceSelection(source, partialRow, ''), undefined, 'no context cannot distinguish duplicate words');
});

test('same repeated word and surrounding phrase remain ambiguous', () => {
  const source = 'the result follows. the result follows.';
  const hit = render([{ text: 'the result follows.' }], { text: 'result' });
  assert.equal(refineSourceSelection(source, hit, ''), undefined);
});

test('T1 low-code ff ligature decodes only with actual ec-lmr font evidence', () => {
  const source = 'The saffronword target is in a different position.';
  const hit = render([{ text: source, ligatures: true }], { text: 'saffronword', offset: 3 });
  assert.deepEqual(refineSourceSelection(source, hit, ''), expected(source, 'saffronword'));
  const noFont = { ...hit, fonts: {} };
  assert.equal(refineSourceSelection(source, noFont, ''), undefined);
});

test('Unicode text and astral prefixes return UTF16 offsets rather than character counts', () => {
  const source = '😀 前文 café conclusion';
  const hit = render([{ text: source, font: 4 }], { text: 'conclusion' });
  assert.deepEqual(refineSourceSelection(source, hit, ''), expected(source, 'conclusion'));
  const unicodeWord = render([{ text: source, font: 4 }], { text: 'café' });
  assert.deepEqual(refineSourceSelection(source, unicodeWord, ''), expected(source, 'café'));
});

test('comments are excluded while escaped percent leaves following prose available', () => {
  const source = 'A 100\\% success follows. % imaginary success is not rendered';
  const hit = render([{ text: 'A 100% success follows.' }], { text: 'success' });
  assert.deepEqual(refineSourceSelection(source, hit, ''), expected(source, 'success'));
  const comment = render([{ text: 'imaginary' }], { text: 'imaginary' });
  assert.equal(refineSourceSelection(source, comment, ''), undefined);
});

test('unknown custom macro output cannot be mistaken for a literal duplicate word', () => {
  const source = '\\myword alpha';
  const first = render([{ text: 'alpha alpha' }], { text: 'alpha' });
  const second = render([{ text: 'alpha alpha' }], { text: 'alpha', occurrence: 1 });
  assert.equal(refineSourceSelection(source, first, ''), undefined);
  assert.equal(refineSourceSelection(source, second, ''), undefined, 'ambiguous macro-containing line keeps existing line anchor');
  assert.equal(refineSourceSelection('\\myword{alpha} literal', first, ''), undefined);
});

test('unknown macro-generated formula cannot select an unrelated literal formula', () => {
  const source = '\\myformula{} and $x$';
  const hit = render([{ text: 'y', math: true }, { text: ' and ' }, { text: 'x', math: true }], { text: 'y' });
  assert.equal(refineSourceSelection(source, hit, ''), undefined);
});

test('reference-generated numbers cannot borrow a separate literal number on the same line', () => {
  const source = '\\ref{previous} and 3';
  const generated = render([{ text: '3 and 3' }], { text: '3' });
  const literal = render([{ text: '3 and 3' }], { text: '3', occurrence: 1 });
  assert.equal(refineSourceSelection(source, generated, ''), undefined);
  assert.deepEqual(refineSourceSelection(source, literal, ''), expected(source, '3'));
  const sentence = 'Applying Lemma \\ref{lemma} gives the desired conclusion.';
  const ordinary = render([{ text: 'Applying Lemma 3 gives the desired conclusion.' }], { text: 'desired' });
  assert.deepEqual(refineSourceSelection(sentence, ordinary, ''), expected(sentence, 'desired'));
});

test('inline formulas select their own delimited source ranges, including a second formula', () => {
  const source = 'Twomath preamble $u+v=w$ middlespacer $p+q=r$ closes the example.';
  const chunks = [{ text: 'Twomath preamble ' }, { text: 'u+v=w', math: true }, { text: ' middlespacer ' },
    { text: 'p+q=r', math: true }, { text: ' closes the example.' }];
  const first = render(chunks, { text: 'u+v=w' });
  const second = render(chunks, { text: 'p+q=r' });
  assert.deepEqual(refineSourceSelection(source, first, ''), expected(source, '$u+v=w$', 'math'));
  assert.deepEqual(refineSourceSelection(source, second, ''), expected(source, '$p+q=r$', 'math'));
});

test('same formula twice needs distinguishing context and never relies on row ordinal', () => {
  const source = 'first $x+y$ middle $x+y$ last';
  const complete = render([{ text: 'first ' }, { text: 'x+y', math: true }, { text: ' middle ' },
    { text: 'x+y', math: true }, { text: ' last' }], { text: 'x+y', occurrence: 1 });
  assert.deepEqual(refineSourceSelection(source, complete, ''), expected(source, '$x+y$', 'math', 1));
  const partial = render([{ text: 'x+y', math: true }], { text: 'x+y' });
  assert.equal(refineSourceSelection(source, partial, ''), undefined);
});

test('wrapped inline math with only an off boundary still identifies its visible formula', () => {
  const source = 'This opening sentence wraps before $a+b=c$ and then ends.';
  const hit = render([{ text: 'a+b=c', math: true, marker: 'off' }, { text: ' and then ends.' }], { text: 'b' });
  assert.deepEqual(refineSourceSelection(source, hit, ''), expected(source, '$a+b=c$', 'math'));
});

test('explicit parenthesized inline math selects the source formula', () => {
  const source = 'Then \\(a+b=c\\) follows.';
  const hit = render([{ text: 'Then ' }, { text: 'a+b=c', math: true }, { text: ' follows.' }], { text: 'b' });
  assert.deepEqual(refineSourceSelection(source, hit, ''), expected(source, '\\(a+b=c\\)', 'math'));
});

test('nested fraction in a confirmed display selects expression rather than source line start', () => {
  const source = '  \\frac{a+\\frac{b}{c}}{d+e}=f \\label{eq:test} % old text';
  const hit = render([{ text: 'a+b/cd+e=f', math: true, marker: 'none' }], { text: 'c' });
  assert.deepEqual(refineSourceSelection(source, hit, '\\begin{equation*}\n'),
    expected(source, '\\frac{a+\\frac{b}{c}}{d+e}=f', 'math'));
  assert.equal(refineSourceSelection(source, hit, undefined), undefined, 'unknown preceding environment must not be invented');
});

test('display formula with only cmmi letters refines without pretending those slots are prose', () => {
  const source = '    a+b=c';
  const hit = render([{ text: 'a+b=c', math: true, marker: 'none' }], { text: 'b' });
  assert.deepEqual(refineSourceSelection(source, hit, '\\[\n'), expected(source, 'a+b=c', 'math'));
  assert.equal(refineSourceSelection('\\end{equation*}', hit, '\\begin{equation*}\na+b=c\n'), undefined,
    'the pure line-local resolver never walks back to a different source line');
});

test('a fraction rule is clickable inside a confirmed display expression', () => {
  const source = '  \\frac{a}{b}';
  const hit = render([{ text: 'a', math: true, marker: 'none' }], { text: 'a' });
  hit.row.items = [['r', 10 * PT, 98 * PT, 10 * PT, PT / 3]];
  hit.x = 15 * PT; hit.y = 98 * PT;
  assert.equal(isNearSourceInk(hit), true);
  assert.deepEqual(refineSourceSelection(source, hit, '\\begin{equation}\n'), expected(source, '\\frac{a}{b}', 'math'));
});

test('known math constructs distinguish symbol-only blocks from opaque macro expansion', () => {
  assert.equal(isKnownMathSource('\\alpha + \\beta \\leq \\infty'), true);
  assert.equal(isKnownMathSource('\\frac{a}{b} % discarded old derivation\n= c \\label{eq:result}'), true);
  assert.equal(isKnownMathSource('\\customresult{x}'), false);
  assert.equal(isKnownMathSource('x'.repeat(16001)), false);
});

test('known math signature mismatch declines refinement even for a sole source formula', () => {
  const hit = render([{ text: 'y+z', math: true }], { text: 'y' });
  assert.equal(refineSourceSelection('Then $a+b$ follows.', hit, ''), undefined);
});

test('unknown font slots or an unknown glyph inside a word cannot create a false literal match', () => {
  const hit = render([{ text: 'alpha', font: 5 }], { text: 'alpha' });
  assert.equal(refineSourceSelection('alpha', hit, ''), undefined);
  const broken = render([{ text: 'color' }], { text: 'lor' });
  const glyph = broken.row.items.find((item) => item[0] === 'g' && item[2] === 'o'.charCodeAt(0))!;
  glyph[2] = 200; // unsupported T1 slot, not Unicode U+00C8
  assert.equal(refineSourceSelection('color lor', broken, ''), undefined);
});

test('transformed or degraded rows retain original line precision', () => {
  const hit = render([{ text: 'target' }], { text: 'target' });
  hit.row.items.unshift(['M', 'set', 0, 0, '2 0 0 2']);
  assert.equal(refineSourceSelection('target', hit, ''), undefined);
  assert.equal(isNearSourceInk(hit), false);
  hit.row.items[0] = ['u', 'cached_picture', '1'];
  assert.equal(refineSourceSelection('target', hit, ''), undefined);
});

test('bounded context does not infer dollar-math parity from its unknown starting point', () => {
  const source = 'The conclusion remains ordinary text.';
  const hit = render([{ text: source }], { text: 'conclusion' });
  assert.deepEqual(refineSourceSelection(source, hit, 'continued math closes here $ then text\n'), expected(source, 'conclusion'));
  assert.deepEqual(refineSourceSelection(source, hit, 'x'.repeat(18000) + '\\begin{equation}\n\\end{equation}\n'), expected(source, 'conclusion'));
});

test('blank space, malformed input, oversized lines and oversized rows avoid expensive guessing', () => {
  const hit = render([{ text: 'target' }], { text: 'target' });
  assert.equal(refineSourceSelection('target\nother', hit, ''), undefined);
  assert.equal(refineSourceSelection('x'.repeat(16001), hit, ''), undefined);
  assert.equal(refineSourceSelection('target', { ...hit, x: Number.NaN }, ''), undefined);
  assert.equal(refineSourceSelection('target', { ...hit, x: 1000 * PT }, ''), undefined);
  assert.equal(refineSourceSelection('target', { ...hit, row: { ...hit.row, items: Array.from({ length: 12001 }, () => ['g', 1, 97, null, 0, 0, PT]) } }, ''), undefined);
});
