import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_DISPLAY_CONTEXT_CHARACTERS, MAX_DISPLAY_CONTEXT_LINES, refineClosingDisplay, targetClosingDisplay } from '../src/sourceMathBlock';
import type { MathBlockSelection } from '../src/sourceMathBlock';
import type { RefinementHit } from '../src/sourceRefinement';
import { SourceLineJournal } from '../src/sourceAnchors';
import { PreviewModel } from '../webview/model';
import type { DisplayList } from '../src/protocol';

const PT = 65536;
const ink: RefinementHit = { file: 'main.tex', line: 5, x: 10 * PT, y: 5 * PT, fonts: {},
  row: { x: 0, y: 10 * PT, w: 20 * PT, h: 8 * PT, d: 2 * PT, items: [['r', 0, 5 * PT, 20 * PT, PT]] } };

function selected(before: string, range: MathBlockSelection | undefined): string | undefined {
  if (!range) return undefined;
  const lines = before.split('\n');
  const anchor = lines.length - 1;
  const start = lines.slice(0, anchor + range.startLine).join('\n').length + (anchor + range.startLine > 0 ? 1 : 0) + range.startColumn;
  const end = lines.slice(0, anchor + range.endLine).join('\n').length + (anchor + range.endLine > 0 ? 1 : 0) + range.endColumn;
  return before.slice(start, end);
}

test('a fraction whose anchor is only the closing equation line selects its explicit expression', () => {
  const before = 'Body text.\n\\begin{equation*}\n  \\frac{c+d}{e+f}=g\n';
  const result = refineClosingDisplay('\\end{equation*}', before, ink);
  assert.deepEqual(result, { startLine: -1, startColumn: 2, endLine: -1, endColumn: 19 });
  assert.equal(selected(before, result), '\\frac{c+d}{e+f}=g');
});

test('a multiline bracket display selects the bounded complete expression', () => {
  const before = 'Body text.\n\\[\n  h+k\n  = l\n';
  const result = refineClosingDisplay('  \\] % final delimiter', before, ink);
  assert.deepEqual(result, { startLine: -2, startColumn: 2, endLine: -1, endColumn: 5 });
  assert.equal(selected(before, result), 'h+k\n  = l');
});

test('leading and trailing labels, blank lines and comments do not replace the formula range', () => {
  const before = '\\begin{equation}\\label{eq:one}\n% hidden old formula\n\n  a+b=c \\label{eq:two}\n';
  assert.equal(selected(before, refineClosingDisplay('\\end{equation}', before, ink)), 'a+b=c');
  const symbolic = '\\begin{displaymath}\n  \\alpha+\\beta=\\gamma\n';
  assert.equal(selected(symbolic, refineClosingDisplay('\\end{displaymath}', symbolic, ink)), '\\alpha+\\beta=\\gamma');
});

test('ordinary accurate source lines and mixed closing lines never use the structural fallback', () => {
  const before = '\\begin{equation*}\n a+b=c\n';
  for (const text of ['Then the desired result.', 'a+b=c', 'a+b=c \\end{equation*}', '\\end{equation*} Next sentence.', '$$']) {
    assert.equal(refineClosingDisplay(text, before, ink), undefined, text);
  }
});

test('missing, mismatched, closed, inline or nested openers retain line-level positioning', () => {
  for (const before of [
    'a+b=c\n',
    '\\begin{displaymath}\na+b=c\n',
    '\\begin{equation*}\na+b=c\n\\end{equation*}\n',
    'Before \\begin{equation*}\na+b=c\n',
    '\\begin{equation*}\n\\begin{equation*}\na+b=c\n',
    '\\begin{equation*}\n\\begin{aligned}\na+b=c\n\\end{aligned}\n',
    '\\begin{equation*}\n\\[\na+b=c\n\\]\n',
  ]) assert.equal(refineClosingDisplay('\\end{equation*}', before, ink), undefined, before);
  assert.equal(refineClosingDisplay('\\end{align}', '\\begin{align}\na+b=c\n', ink), undefined);
});

test('a completed earlier display cannot confuse the single current expression', () => {
  const before = '\\begin{equation*}\na=b\n\\end{equation*}\nBody\n\\begin{equation*}\nc=d\n';
  assert.equal(selected(before, refineClosingDisplay('\\end{equation*}', before, ink)), 'c=d');
});

test('unknown macros, unbalanced groups and alignment-dependent content do not select a guessed block', () => {
  for (const content of ['\\MyGeneratedFormula{x}', '\\frac{a}{b', 'a&=b', 'a\\\\b', '$a+b$']) {
    assert.equal(refineClosingDisplay('\\end{equation*}', `\\begin{equation*}\n${content}\n`, ink), undefined, content);
  }
});

test('formula block selection needs verified context and an actual nearby ink hit', () => {
  const before = '\\begin{equation*}\na+b=c\n';
  assert.equal(refineClosingDisplay('\\end{equation*}', undefined, ink), undefined);
  assert.equal(refineClosingDisplay('\\end{equation*}', before, { ...ink, x: 300 * PT }), undefined);
  assert.equal(refineClosingDisplay('\\end{equation*}', before, { ...ink, row: { ...ink.row, items: [] } }), undefined);
  assert.equal(refineClosingDisplay(' '.repeat(16001) + '\\end{equation*}', before, ink), undefined);
  assert.equal(refineClosingDisplay('\\end{equation*}', '\n'.repeat(65) + before, ink), undefined);
  assert.equal(refineClosingDisplay('\\end{equation*}', 'x'.repeat(16385) + before, ink), undefined);
});

test('editing formula context disables the block fallback while the exact closing line remains usable', () => {
  const journal = new SourceLineJournal();
  const initial = '\\begin{equation*}\na+b=c\n\\end{equation*}';
  const changed = initial.replace('a+b', 'a+d');
  journal.acknowledge(journal.replace('main.tex', initial, changed), 2);
  assert.equal(journal.rebase('main.tex', 3, 1), 3);
  assert.equal(journal.refineLine('main.tex', 3, 1), 3, 'the structural closer itself did not change');
  const context = journal.refineContext('main.tex', 1, 2, 1);
  assert.equal(context, undefined, 'the old formula ink no longer matches the current block');
  assert.equal(refineClosingDisplay('\\end{equation*}', context ? changed.slice(0, changed.lastIndexOf('\n') + 1) : undefined, ink), undefined);
  const fresh = journal.refineContext('main.tex', 1, 2, 2);
  assert.ok(fresh);
  assert.equal(selected(changed.slice(0, changed.lastIndexOf('\n') + 1), refineClosingDisplay('\\end{equation*}', changed.slice(0, changed.lastIndexOf('\n') + 1), ink)), 'a+d=c');
});

function forwardDisplay(source: string) {
  const lines = source.split('\n');
  const closingLine = lines.length;
  const dl: DisplayList = { kind: 'page', width: 600 * PT, height: 800 * PT, depth: 0, other: [], flags: [],
    fonts: { 1: { id: 1, name: 'cmmi10', size: 10 * PT } }, source_revision: 1,
    lines: [{ x: 10 * PT, y: 100 * PT, w: 30 * PT, h: 8 * PT, d: 2 * PT,
      items: [['g', 1, 99, null, 10 * PT, 100 * PT, 5 * PT, 0]],
      source_anchors: [{ x: 10 * PT, w: 5 * PT, file: 'main.tex', line: closingLine, kind: 'mg' }] }] };
  const fragments = [{ page: 1, first_line: 1, last_line: 1, x: 10 * PT, xs: [10 * PT], baselines: [100 * PT], approximate: false }];
  const model = new PreviewModel();
  model.applyLayout({ pages: [{ page: 1, exact: true, hash: 1, dl }], pagesTotal: 1,
    placements: [{ par_id: 8, fragments, lines: 1, kind: 'env:proof' }], keepFromRevision: null });
  const journal = new SourceLineJournal();
  const context = (current: string) => (anchor: number) => anchor === current.split('\n').length ? {
    text: current.split('\n').at(-1)!, before: current.slice(0, current.lastIndexOf('\n') + 1), firstLine: 1,
  } : undefined;
  return { model, dl, journal, context, target: (line: number, character = 0, current = source) =>
    targetClosingDisplay(model, 'main.tex', line, character, journal, context(current)) };
}

test('forward display lookup reverses a closing-only anchor for a fraction and both multiline source rows', () => {
  const fraction = forwardDisplay('Body.\n\\begin{equation*}\n\\frac{c+d}{e+f}=g\n\\end{equation*}');
  assert.deepEqual(fraction.target(3, 8), { page: 1, x: 12.5 * PT, y: 100 * PT });
  const multiline = forwardDisplay('Body.\n\\[\nh+k\n% invisible older formula\n= l\n\\]');
  assert.deepEqual(multiline.target(3, 2), { page: 1, x: 12.5 * PT, y: 100 * PT });
  assert.deepEqual(multiline.target(5, 2), { page: 1, x: 12.5 * PT, y: 100 * PT });
  assert.equal(multiline.target(4, 5), undefined, 'a comment inside the expression has no ink');
  assert.equal(multiline.target(1, 2), undefined, 'the preceding prose is outside this expression');
});

test('forward closing-anchor math uses translated visible overlays and refuses hidden old source', () => {
  const source = '\\[\nh+k\n= l\n\\]';
  const display = forwardDisplay(source);
  display.model.applyParagraph(8, display.dl, [{ page: 1, first_line: 1, last_line: 1,
    x: 50 * PT, xs: [50 * PT], baselines: [150 * PT], approximate: false }], 1);
  assert.deepEqual(display.target(2, 2), { page: 1, x: 52.5 * PT, y: 150 * PT });
  display.model.overlays.get(8)!.dl = { ...display.dl, lines: [{ ...display.dl.lines[0], source_anchors: [] }] };
  assert.equal(display.target(2, 2), undefined, 'an unanchored live overlay cannot revive its hidden background row');
});

test('forward closing-anchor math rejects changed context and comment cursor positions', () => {
  const initial = '\\[\nh+k % old x\n= l\n\\]';
  const display = forwardDisplay(initial);
  assert.equal(display.target(2, 8), undefined, 'a trailing source comment cannot borrow formula ink');
  const changed = initial.replace('h+k', 'h+q');
  display.journal.acknowledge(display.journal.replace('main.tex', initial, changed), 2);
  assert.equal(display.target(2, 2, changed), undefined, 'old ink must not stand in for an edited formula');
  const unknown = forwardDisplay('\\[\n\\CustomFormula{x}\n\\]');
  assert.deepEqual(unknown.target(2, 5), { page: 1, x: 12.5 * PT, y: 100 * PT }, 'known block boundaries suffice for forward navigation');
});

test('forward display blocks accept every body column, including indentation and math operators', () => {
  for (const [open, close, content] of [
    ['\\begin{align}', '\\end{align}', '  a&=b\\\\\n  c&=d'],
    ['\\begin{align*}', '\\end{align*}', '  a&=b\\\\\n  c&=d'],
    ['\\begin{equation}', '\\end{equation}', '  \\begin{aligned}\n    a&=b\\\\\n    c&=d\n  \\end{aligned}'],
    ['\\[', '\\]', '  \\begin{aligned}\n    a&=b\\\\\n    c&=d\n  \\end{aligned}'],
    ['\\begin{equation*}', '\\end{equation*}', '  \\begin{split}\n    a&=b\\\\\n    c&=d\n  \\end{split}'],
    ['\\begin{multline}', '\\end{multline}', '  a+b+\\\\\n  c=d'],
    ['\\begin{multline*}', '\\end{multline*}', '  a+b+\\\\\n  c=d'],
    ['\\begin{gather}', '\\end{gather}', '  a=b\\\\\n  c=d'],
    ['\\begin{gather*}', '\\end{gather*}', '  a=b\\\\\n  c=d'],
    ['\\begin{equation}', '\\end{equation}', '  x'],
    ['\\begin{displaymath}', '\\end{displaymath}', '  \\frac{a}{b}'],
    ['$$', '$$', '  \\CustomFormula{x}'],
  ]) {
    const source = ['Body.', open, content, close].join('\n');
    const display = forwardDisplay(source);
    const body = content.split('\n');
    body.forEach((text, index) => {
      for (let column = 0; column <= text.length; column++) {
        assert.deepEqual(display.target(index + 3, column), { page: 1, x: 12.5 * PT, y: 100 * PT }, `${open} at body ${index}:${column}`);
      }
    });
  }
});

test('forward block matching distinguishes previous displays, escaped delimiters, and malformed nesting', () => {
  const source = '\\begin{equation}\na=b\n\\end{equation}\nText.\n\\begin{align}\n  \\text{\\%}a&=b\\\\ % \\end{align}\n  c&=d\n\\end{align} % final';
  const display = forwardDisplay(source);
  assert.equal(display.target(2, 1), undefined, 'an earlier formula cannot borrow this display anchor');
  assert.equal(display.target(4, 1), undefined, 'the intervening prose is not part of the display');
  assert.deepEqual(display.target(6, 0), { page: 1, x: 12.5 * PT, y: 100 * PT });
  assert.equal(display.target(6, 31), undefined, 'a commented-out delimiter is not an endpoint');
  for (const malformed of [
    '\\begin{equation}\na=b\n\\end{align}',
    '\\begin{align}\n\\begin{aligned}\na=b\n\\end{align}',
    '\\begin{proof}\na=b\n\\end{proof}',
    '\\\\begin{align}\na=b\n\\end{align}',
  ]) assert.equal(forwardDisplay(malformed).target(2, 0), undefined, malformed);
});

test('an align display with cell math markers precedes same-line trailing prose and inline math', () => {
  const source = '\\begin{align}\n  a&=b\n\\end{align} where $u$ remains positive.';
  const display = forwardDisplay(source);
  const row = display.model.pages.get(1)!.dl.lines[0];
  row.items.unshift(['m', 'on', 10 * PT]);
  row.items.push(['m', 'off', 15 * PT]);
  row.items.unshift(['g', 1, 49, null, PT, row.y, 5 * PT, 0]);
  display.model.pages.get(1)!.dl.lines.push({ ...row, y: 130 * PT,
    items: [['g', 1, 119, null, 10 * PT, 130 * PT, 5 * PT, 0]],
    source_anchors: [{ x: 10 * PT, w: 5 * PT, file: 'main.tex', line: 3, kind: 'g' }] },
  { ...row, y: 140 * PT,
    items: [['m', 'on', 10 * PT], ['g', 1, 117, null, 10 * PT, 140 * PT, 5 * PT, 0], ['m', 'off', 15 * PT]],
    source_anchors: [{ x: 10 * PT, w: 5 * PT, file: 'main.tex', line: 3, kind: 'mg' }] });
  assert.deepEqual(display.target(2, 0), { page: 1, x: 12.5 * PT, y: 100 * PT }, 'the first visible mathematical row belongs to the display');
  assert.deepEqual(display.target(3, '\\end{align}'.length), { page: 1, x: 12.5 * PT, y: 100 * PT });
  assert.equal(display.target(3, '\\end{align} '.length), undefined, 'the source after the closer belongs to the following prose');
});

test('a display closer can share its source line with enclosing environment ends', () => {
  const source = '\\begin{proof}\n\\begin{align}\n  a&=b\n\\end{align}\\end{proof}';
  const display = forwardDisplay(source);
  assert.deepEqual(display.target(3, 0), { page: 1, x: 12.5 * PT, y: 100 * PT });
  assert.deepEqual(display.target(4, 5), { page: 1, x: 12.5 * PT, y: 100 * PT });
  assert.equal(display.target(4, '\\end{align}'.length + 2), undefined, 'an enclosing proof closer is outside the math block');
});

test('forward math blocks require only their own unchanged context and remain bounded', () => {
  const initial = 'Old prose.\n\\begin{align}\n  a&=b\n\\end{align}';
  const display = forwardDisplay(initial);
  const changed = initial.replace('Old prose.', 'Changed prose.');
  display.journal.acknowledge(display.journal.replace('main.tex', initial, changed), 2);
  assert.deepEqual(display.target(3, 0, changed), { page: 1, x: 12.5 * PT, y: 100 * PT }, 'unrelated preceding prose does not invalidate the formula');
  const long = '\\begin{align}\n' + '  a&=b\\\\\n'.repeat(120) + '\\end{align}';
  assert.deepEqual(forwardDisplay(long).target(2, 0), { page: 1, x: 12.5 * PT, y: 100 * PT });
  const tooManyLines = '\\begin{align}\n' + '  a&=b\\\\\n'.repeat(MAX_DISPLAY_CONTEXT_LINES) + '\\end{align}';
  assert.equal(forwardDisplay(tooManyLines).target(2, 0), undefined);
  const tooManyCharacters = '\\[\n' + 'a'.repeat(MAX_DISPLAY_CONTEXT_CHARACTERS) + '\n\\]';
  assert.equal(forwardDisplay(tooManyCharacters).target(2, 0), undefined);
});

test('repeated closing anchors read and parse each current source context once per lookup', () => {
  for (const source of ['\\begin{proof}\na=b\n\\end{proof}', '\\begin{align}\na=b\n\\end{align}']) {
    const display = forwardDisplay(source);
    const row = display.model.pages.get(1)!.dl.lines[0];
    row.source_anchors = Array.from({ length: 100 }, () => ({ ...row.source_anchors![0] }));
    const changed = source.replace('a=b', 'a=c');
    display.journal.acknowledge(display.journal.replace('main.tex', source, changed), 2);
    let reads = 0;
    const target = targetClosingDisplay(display.model, 'main.tex', 2, 0, display.journal, (closingLine) => {
      reads++;
      return display.context(changed)(closingLine);
    });
    assert.equal(target, undefined);
    assert.equal(reads, 1, 'both rejected blocks and stale parsed blocks are memoized');
  }
});
