import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refineClosingDisplay } from '../src/sourceMathBlock';
import type { MathBlockSelection } from '../src/sourceMathBlock';
import type { RefinementHit } from '../src/sourceRefinement';
import { SourceLineJournal } from '../src/sourceAnchors';

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
