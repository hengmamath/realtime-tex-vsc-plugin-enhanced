import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DisplayList, Fragment, Line, SourceAnchor } from '../src/protocol';
import { advanceBackgroundSourceRevision, hitSourceAnchor, sourceFile, SourceLineJournal, sourceLineChanges, targetSourceAnchor } from '../src/sourceAnchors';
import { PreviewModel } from '../webview/model';

const PT = 65536;
const anchor = (x: number, line: number, file = 'main.tex', kind: SourceAnchor['kind'] = 'g'): SourceAnchor => ({
  x: x * PT, w: 3 * PT, file, line, kind,
});
const row = (y: number, anchors?: SourceAnchor[], x = 10): Line => ({
  x: x * PT, y: y * PT, w: 150 * PT, h: 7 * PT, d: 2 * PT, items: [], source_anchors: anchors,
});
const dl = (lines: Line[], revision?: number): DisplayList => ({
  kind: 'page', fonts: {}, lines, other: [], flags: [], width: 600 * PT, height: 800 * PT, depth: 0,
  source_revision: revision,
});
const fragment = (baselines: number[], xs = baselines.map(() => 10), page = 1): Fragment => ({
  page, first_line: 1, last_line: baselines.length, x: xs[0] * PT, xs: xs.map((x) => x * PT),
  baselines: baselines.map((y) => y * PT), approximate: false,
});
function model(lines: Line[], revision?: number): PreviewModel {
  const m = new PreviewModel();
  m.applyLayout({ pages: [{ page: 1, exact: true, hash: 1, dl: dl(lines, revision) }], pagesTotal: 1,
    placements: [{ par_id: 8, fragments: [fragment(lines.map((line) => line.y / PT))], lines: lines.length, kind: 'env:proof' }], keepFromRevision: null });
  return m;
}

test('captured source lines skip an 80-comment proof block instead of interpolating through it', () => {
  const m = model([row(100, [anchor(40, 8)]), row(112, [anchor(40, 91)])], 1);
  assert.deepEqual(hitSourceAnchor(m, 1, 30 * PT, 109 * PT), { file: 'main.tex', line: 91, revision: 1 });
  const paper = ['\\begin{proof}', ...Array.from({ length: 88 }, () => '% A comment is not rendered.'),
    '\\begin{REV}', 'Then the desired result follows directly by letting R tend to infinity.', '\\end{REV}', '\\end{proof}'].join('\n');
  assert.equal(paper.split('\n')[90], 'Then the desired result follows directly by letting R tend to infinity.');
});

test('source to preview uses captured REV/proof rows instead of the fraction of source bytes', () => {
  const m = model([row(100, [anchor(40, 8)]), row(112, [anchor(40, 15)]), row(124, [anchor(40, 99)])], 1);
  const journal = new SourceLineJournal();
  assert.deepEqual(targetSourceAnchor(m, 'main.tex', 15, journal), { page: 1, x: 40 * PT, y: 112 * PT });
  assert.deepEqual(targetSourceAnchor(m, 'main.tex', 99, journal), { page: 1, x: 40 * PT, y: 124 * PT });
  assert.equal(targetSourceAnchor(m, 'main.tex', 90, journal), undefined, 'an invisible source comment has no rendered target');
  assert.equal(targetSourceAnchor(m, 'main.tex', 14, journal), undefined, 'a wrapper command cannot borrow the nearest paragraph');
});

test('forward targets distinguish inline included files and skip unreliable box anchors', () => {
  const m = model([row(100, [anchor(35, 12), anchor(85, 2, 'chapter.tex'), anchor(130, 12)]),
    row(112, [anchor(40, 3, 'chapter.tex', 'box')])], 4);
  const journal = new SourceLineJournal();
  const target = targetSourceAnchor(m, 'chapter.tex', 2, journal)!;
  assert.deepEqual(target, { page: 1, x: 85 * PT, y: 100 * PT });
  assert.deepEqual(hitSourceAnchor(m, target.page, target.x, target.y), { file: 'chapter.tex', line: 2, revision: 4 });
  assert.equal(targetSourceAnchor(m, 'chapter.tex', 3, journal), undefined);
  assert.equal(targetSourceAnchor(m, '../chapter.tex', 2, journal), undefined);
});

test('forward source targets use translated live rows and exclude hidden background rows', () => {
  const m = model([row(100, [anchor(40, 63)]), row(112, [anchor(40, 64)])], 1);
  m.applyParagraph(8, dl([row(7, [anchor(30, 91)], 0), row(19, [anchor(30, 92)], 0)], 8), [fragment([150, 162], [50, 50])], 8);
  const journal = new SourceLineJournal();
  assert.deepEqual(targetSourceAnchor(m, 'main.tex', 92, journal), { page: 1, x: 80 * PT, y: 162 * PT });
  assert.equal(targetSourceAnchor(m, 'main.tex', 64, journal), undefined, 'the old hidden row must not be revealed');
});

test('forward anchors rebase unchanged source lines and refuse ambiguous edits', () => {
  const m = model([row(100, [anchor(40, 2)])], 1);
  const journal = new SourceLineJournal();
  const before = 'Before\nTarget word.\n';
  const entry = journal.submit(sourceLineChanges('main.tex', before, [{ rangeOffset: 0, rangeLength: 0, text: '% comment\n' }])[0]);
  assert.equal(targetSourceAnchor(m, 'main.tex', 2, journal), undefined, 'pending source changes have no known base');
  journal.acknowledge(entry, 2);
  assert.deepEqual(targetSourceAnchor(m, 'main.tex', 3, journal), { page: 1, x: 40 * PT, y: 100 * PT });
  assert.equal(targetSourceAnchor(m, 'main.tex', 2, journal), undefined, 'old line number cannot select a shifted row');
  journal.acknowledge(journal.submit(sourceLineChanges('main.tex', '% comment\n' + before, [{ rangeOffset: 17, rangeLength: 'Target word.\n'.length, text: '' }])[0]), 3);
  assert.equal(targetSourceAnchor(m, 'main.tex', 3, journal), undefined, 'deleting the target line rejects its obsolete frame');
});

test('forward line-level positions remain inside the requested part of a mixed-source row', () => {
  const m = model([row(100, [anchor(35, 90), anchor(85, 91), anchor(130, 92)])], 3);
  const journal = new SourceLineJournal();
  for (const line of [90, 91, 92]) {
    const target = targetSourceAnchor(m, 'main.tex', line, journal)!;
    assert.deepEqual(hitSourceAnchor(m, target.page, target.x, target.y), { file: 'main.tex', line, revision: 3 });
  }
});

test('forward source columns select the wrapped row only while its captured text is unchanged', () => {
  const first = row(100, [anchor(80, 2)]), second = row(112, [anchor(80, 2)]);
  for (const [line, text] of [[first, 'Opening'], [second, 'target']] as const) {
    line.items = [...text].map((character, i) => ['g', 1, character.charCodeAt(0), null, (10 + i * 5) * PT, line.y, 5 * PT, 0]);
  }
  const m = model([first, second], 1);
  m.pages.get(1)!.dl.fonts = { 1: { id: 1, name: 'ec-lmr10', size: 10 * PT } };
  const journal = new SourceLineJournal();
  assert.deepEqual(targetSourceAnchor(m, 'main.tex', 2, journal, { text: 'Opening target', character: 10 }),
    { page: 1, x: 10 * PT, y: 112 * PT });
  journal.acknowledge(journal.replace('main.tex', 'First\nOpening target', 'First\nAdded Opening target'), 2);
  assert.deepEqual(targetSourceAnchor(m, 'main.tex', 2, journal, { text: 'Added Opening target', character: 16 }),
    { page: 1, x: 80 * PT, y: 100 * PT }, 'changed line can retain its coarse target but cannot reuse old word columns');
});

test('horizontal anchors distinguish source newlines within the same rendered row', () => {
  const m = model([row(100, [anchor(35, 90), anchor(85, 91), anchor(130, 92)])], 3);
  assert.equal(hitSourceAnchor(m, 1, 20 * PT, 97 * PT)?.line, 90);
  assert.equal(hitSourceAnchor(m, 1, 60 * PT, 97 * PT)?.line, 91);
  assert.equal(hitSourceAnchor(m, 1, 120 * PT, 97 * PT)?.line, 92);
  assert.equal(hitSourceAnchor(m, 1, 155 * PT, 97 * PT)?.line, 92);
});

test('inline input switches files at the recorded word boundary in one rendered paragraph', () => {
  const m = model([row(100, [anchor(35, 12), anchor(85, 2, 'parts/fragment.tex'), anchor(130, 12)])], 4);
  assert.deepEqual(hitSourceAnchor(m, 1, 60 * PT, 97 * PT), { file: 'parts/fragment.tex', line: 2, revision: 4 });
  assert.equal(hitSourceAnchor(m, 1, 120 * PT, 97 * PT)?.file, 'main.tex');
});

test('translated live rows win and the replaced background source is never hit', () => {
  const m = model([row(100, [anchor(40, 63)]), row(112, [anchor(40, 64)])], 1);
  const overlay = dl([row(7, [anchor(30, 91)], 0), row(19, [anchor(30, 92)], 0)], 8);
  m.applyParagraph(8, overlay, [fragment([150, 162], [50, 50])], 8);
  assert.deepEqual(hitSourceAnchor(m, 1, 65 * PT, 159 * PT), { file: 'main.tex', line: 92, revision: 8 });
  assert.equal(hitSourceAnchor(m, 1, 30 * PT, 97 * PT), undefined);
  const fine = hitSourceAnchor(m, 1, 65 * PT, 159 * PT)!.refinement!;
  assert.equal(fine.row, overlay.lines[1]);
  assert.equal(fine.fonts, overlay.fonts);
  assert.equal(fine.x, 15 * PT, 'refinement x is in the original overlay frame');
  assert.equal(fine.y, 16 * PT, 'refinement y includes the translated baseline');
  assert.equal(fine.file, 'main.tex');
  assert.equal(fine.line, 92);
});

test('retained overlays use their own source revision after a stale layout reanchors their rows', () => {
  const m = model([row(100, [anchor(40, 12)])], 1);
  m.applyParagraph(8, dl([row(7, [anchor(30, 91)], 0)], 8), [fragment([150], [50])], 8);
  m.applyLayout({ pages: [{ page: 1, exact: true, hash: 2, dl: dl([row(180, [anchor(40, 12)])], 4) }],
    pagesTotal: 1, placements: [{ par_id: 8, fragments: [fragment([180], [60])], lines: 1, kind: 'env:proof' }], keepFromRevision: 7 });
  assert.deepEqual(hitSourceAnchor(m, 1, 75 * PT, 177 * PT), { file: 'main.tex', line: 91, revision: 8 });
});

test('a nearest unanchored row cannot borrow another row or an unreliable box source', () => {
  const m = model([row(100, [anchor(40, 5)]), row(112), row(124, [anchor(40, 500, 'main.tex', 'box')])], 1);
  assert.equal(hitSourceAnchor(m, 1, 30 * PT, 109 * PT), undefined);
  assert.equal(hitSourceAnchor(m, 1, 30 * PT, 121 * PT), undefined);
  assert.equal(hitSourceAnchor(m, 2, 30 * PT, 97 * PT), undefined);
  assert.equal(hitSourceAnchor(m, 1, 30 * PT, 300 * PT), undefined);
});

test('missing source revisions and malformed source anchors cannot supply a source hit', () => {
  const missingRevision = model([row(100, [anchor(40, 5)])]);
  assert.equal(hitSourceAnchor(missingRevision, 1, 30 * PT, 97 * PT), undefined);
  const invalid = model([row(100, [anchor(40, -1), anchor(50, 3, '../private.tex')])], 1);
  assert.equal(hitSourceAnchor(invalid, 1, 30 * PT, 97 * PT), undefined);
});

test('a settled identical page advances its source base after deleting a target line and undoing', () => {
  const m = model([row(100, [anchor(40, 2)])], 1);
  const journal = new SourceLineJournal();
  const initial = 'First\nThen the result.\nLast';
  journal.acknowledge(journal.submit(sourceLineChanges('main.tex', initial, [
    { rangeOffset: 6, rangeLength: 'Then the result.\n'.length, text: '' },
  ])[0]), 2);
  journal.acknowledge(journal.submit(sourceLineChanges('main.tex', 'First\nLast', [
    { rangeOffset: 6, rangeLength: 0, text: 'Then the result.\n' },
  ])[0]), 3);
  assert.equal(journal.rebase('main.tex', 2, 1), undefined, 'old line was deleted, so interpolation is unsafe');
  // A pass can restore exactly the initial ink+anchors and send pages_changed: [].
  m.applyLayout({ pages: [], pagesTotal: 1, placements: [], keepFromRevision: null });
  advanceBackgroundSourceRevision(m, 3);
  const hit = hitSourceAnchor(m, 1, 30 * PT, 97 * PT)!;
  assert.equal(hit.revision, 3);
  assert.equal(journal.rebase(hit.file, hit.line, hit.revision), 2);
});

test('background source-base updates leave newer live overlays and legacy pages alone', () => {
  const m = model([row(100, [anchor(40, 10)])], 2);
  m.applyParagraph(8, dl([row(7, [anchor(30, 91)], 0)], 8), [fragment([150], [50])], 8);
  advanceBackgroundSourceRevision(m, 4);
  assert.equal(m.pages.get(1)?.dl.source_revision, 4);
  assert.equal(m.overlays.get(8)?.dl.source_revision, 8);
  advanceBackgroundSourceRevision(m, undefined);
  assert.equal(m.pages.get(1)?.dl.source_revision, 4);
  const legacy = model([row(100)]);
  advanceBackgroundSourceRevision(legacy, 4);
  assert.equal(legacy.pages.get(1)?.dl.source_revision, undefined);
});

test('only project-relative TeX source files can be selected', () => {
  for (const file of ['/etc/secret.tex', '../paper.tex', 'parts/../../paper.tex', 'file:///tmp/paper.tex', 'C:\\paper.tex', 'paper.tex\0.pdf', 'parts/file.pdf']) {
    assert.equal(sourceFile(file), undefined, file);
  }
  assert.equal(sourceFile('./parts/proof.tex'), 'parts/proof.tex');
  assert.equal(sourceFile('parts\\proof.tex'), 'parts/proof.tex');
});

test('old background source lines rebase after inserted and deleted comment lines elsewhere', () => {
  const journal = new SourceLineJournal();
  const before = 'one\n% comment\nthree\nThen the desired result.\n';
  const [insert] = sourceLineChanges('main.tex', before, [{ rangeOffset: 4, rangeLength: 0, text: '% new\n% new again\n' }]);
  const pending = journal.submit(insert);
  assert.equal(journal.rebase('main.tex', 4, 1), undefined, 'unacknowledged edit');
  journal.acknowledge(pending, 2);
  assert.equal(journal.rebase('main.tex', 4, 1), 6);
  assert.equal(journal.rebase('main.tex', 6, 2), 6, 'the live result already includes its edit');
  const [remove] = sourceLineChanges('main.tex', 'one\n% new\n% new again\n% comment\nthree\nThen the desired result.\n', [
    { rangeOffset: 4, rangeLength: 6, text: '' },
  ]);
  journal.acknowledge(journal.submit(remove), 3);
  assert.equal(journal.rebase('main.tex', 4, 1), 5);
  assert.equal(journal.rebase('main.tex', 6, 2), 5);
});

test('ordinary typing preserves line mapping while a split or deletion of the clicked line waits for fresh anchors', () => {
  const journal = new SourceLineJournal();
  let text = 'First\nThen the result.\nLast';
  const add = (offset: number, length: number, replacement: string, revision: number) => {
    journal.acknowledge(journal.submit(sourceLineChanges('main.tex', text, [{ rangeOffset: offset, rangeLength: length, text: replacement }])[0]), revision);
    text = text.slice(0, offset) + replacement + text.slice(offset + length);
  };
  add(text.indexOf('result'), 0, 'desired ', 2);
  assert.equal(journal.rebase('main.tex', 2, 1), 2);
  add(text.indexOf('desired'), 0, '\n', 3);
  assert.equal(journal.rebase('main.tex', 2, 1), undefined);
  assert.equal(journal.rebase('main.tex', 3, 3), 3);
  add(text.indexOf('desired'), 'desired result.\n'.length, '', 4);
  assert.equal(journal.rebase('main.tex', 3, 3), undefined);
});

test('undo line changes and edits in other files preserve the original source target', () => {
  const journal = new SourceLineJournal();
  const entry = journal.submit(sourceLineChanges('chapter.tex', 'Text\nTarget\n', [{ rangeOffset: 5, rangeLength: 0, text: '% comment\n' }])[0]);
  journal.acknowledge(entry, 2);
  assert.equal(journal.rebase('main.tex', 91, 1), 91);
  assert.equal(journal.rebase('chapter.tex', 2, 1), 3);
  journal.acknowledge(journal.submit(sourceLineChanges('chapter.tex', 'Text\n% comment\nTarget\n', [{ rangeOffset: 5, rangeLength: 10, text: '' }])[0]), 3);
  assert.equal(journal.rebase('chapter.tex', 2, 1), 2);
});

test('UTF-16 offsets, multibyte input, CRLF and multiple sequential changes map source lines correctly', () => {
  const journal = new SourceLineJournal();
  const before = '中文😀\r\nThen the result.\r\n';
  const changes = sourceLineChanges('main.tex', before, [
    { rangeOffset: '中文😀\r\n'.length, rangeLength: 0, text: '% 注释😀\r\n' },
    { rangeOffset: '中文😀\r\n% 注释😀\r\nThen'.length, rangeLength: 0, text: ' desired' },
  ]);
  changes.forEach((change, i) => journal.acknowledge(journal.submit(change), i + 2));
  assert.equal(journal.rebase('main.tex', 2, 1), 3);
  assert.equal(journal.rebase('main.tex', 3, 3), 3);
});

test('VS Code range positions avoid deriving lines from UTF-8 byte offsets', () => {
  const changes = sourceLineChanges('main.tex', 'not scanned', [{ rangeOffset: 0, rangeLength: 0, text: '\n',
    range: { start: { line: 90, character: 0 }, end: { line: 90, character: 0 } } }]);
  assert.equal(changes[0].startLine, 91);
  const journal = new SourceLineJournal();
  journal.acknowledge(journal.submit(changes[0]), 2);
  assert.equal(journal.rebase('main.tex', 91, 1), 92);
});

test('same-text whole-document sends and minimal whole-buffer edits retain unaffected locations', () => {
  const journal = new SourceLineJournal();
  const before = 'First\nThen the result.\nLast';
  journal.acknowledge(journal.replace('main.tex', before, before), 2);
  assert.equal(journal.rebase('main.tex', 2, 1), 2);
  journal.acknowledge(journal.replace('main.tex', before, '% new\n' + before), 3);
  assert.equal(journal.rebase('main.tex', 2, 1), 3);
});

test('unknown whole-buffer replacements reject old metadata but accept a fresh compiled snapshot', () => {
  const journal = new SourceLineJournal();
  journal.acknowledge(journal.replace('chapter.tex', undefined, 'Changed text'), 2);
  assert.equal(journal.rebase('chapter.tex', 2, 1), undefined);
  assert.equal(journal.rebase('chapter.tex', 1, 2), 1);
  assert.equal(journal.rebase('main.tex', 91, 1), 91);
  journal.clear();
  assert.equal(journal.rebase('chapter.tex', 2, 1), 2);
});

test('word refinement waits for fresh text after same-line insertion, deletion, replacement and undo', () => {
  for (const replacement of ['desired ', '', 'other']) {
    const journal = new SourceLineJournal();
    const initial = 'First\nThen the result.\nLast';
    const offset = initial.indexOf('result');
    const length = replacement === 'desired ' ? 0 : 'result'.length;
    const changed = initial.slice(0, offset) + replacement + initial.slice(offset + length);
    const entry = journal.submit(sourceLineChanges('main.tex', initial, [{ rangeOffset: offset, rangeLength: length, text: replacement }])[0]);
    assert.equal(journal.refineLine('main.tex', 2, 1), undefined, 'pending edits retain the existing refusal');
    journal.acknowledge(entry, 2);
    assert.equal(journal.rebase('main.tex', 2, 1), 2, 'coarse source line stays correct');
    assert.equal(journal.refineLine('main.tex', 2, 1), undefined, 'old glyph columns cannot refine current changed text');
    assert.equal(journal.refineLine('main.tex', 2, 2), 2, 'fresh frame can refine');
    journal.acknowledge(journal.replace('main.tex', changed, initial), 3);
    assert.equal(journal.rebase('main.tex', 2, 1), 2);
    assert.equal(journal.refineLine('main.tex', 2, 1), undefined, 'undo does not assume an old frame is fresh');
    assert.equal(journal.refineLine('main.tex', 2, 3), 2, 'fresh restored source is safe again');
  }
});

test('fine selection follows complete line insertions/deletions but refuses merged text', () => {
  const initial = 'Before\nTarget word.\nAfter';
  for (const insert of ['% added\n', '% added\nprefix ']) {
    const journal = new SourceLineJournal();
    journal.acknowledge(journal.submit(sourceLineChanges('main.tex', initial, [{ rangeOffset: 7, rangeLength: 0, text: insert }])[0]), 2);
    assert.equal(journal.rebase('main.tex', 2, 1), 3);
    assert.equal(journal.refineLine('main.tex', 2, 1), insert.endsWith('\n') ? 3 : undefined);
  }
  for (const [offset, length, replacement, expected] of [
    [0, 7, '', 1], [0, 7, 'prefix ', undefined], [3, 4, '', undefined], [3, 4, 'new\n', 2],
  ] as const) {
    const journal = new SourceLineJournal();
    journal.acknowledge(journal.submit(sourceLineChanges('main.tex', initial, [{ rangeOffset: offset, rangeLength: length, text: replacement }])[0]), 2);
    assert.notEqual(journal.rebase('main.tex', 2, 1), undefined, 'original coarse algorithm still accepts the surviving line');
    assert.equal(journal.refineLine('main.tex', 2, 1), expected, `${offset}/${length}/${JSON.stringify(replacement)}`);
  }
});

test('unchanged replacements and acknowledged edits elsewhere preserve fine selection', () => {
  const journal = new SourceLineJournal();
  const initial = 'First\nTarget word.\nLast';
  journal.acknowledge(journal.replace('main.tex', initial, initial), 2);
  assert.equal(journal.refineLine('main.tex', 1, 1), 1);
  assert.equal(journal.refineLine('main.tex', 2, 1), 2);
  assert.equal(journal.refineLine('main.tex', 3, 1), 3, 'identical whole buffers do not appear to edit the last line');
  journal.acknowledge(journal.submit(sourceLineChanges('main.tex', initial, [
    { rangeOffset: initial.indexOf('word'), rangeLength: 4, text: 'word' },
  ])[0]), 3);
  assert.equal(journal.refineLine('main.tex', 2, 1), 2, 'confirmed same-text range replacement is a no-op');
  journal.acknowledge(journal.submit(sourceLineChanges('main.tex', initial, [{ rangeOffset: 0, rangeLength: 5, text: 'Opening' }])[0]), 4);
  assert.equal(journal.refineLine('main.tex', 2, 1), 2, 'same-line changes elsewhere do not block the target');
  journal.acknowledge(journal.submit(sourceLineChanges('main.tex', 'Opening\nTarget word.\nLast', [{ rangeOffset: 8, rangeLength: 0, text: '% comment\n' }])[0]), 5);
  assert.equal(journal.refineLine('main.tex', 2, 1), 3, 'a complete new line preserves the target text');
  const foreign = journal.replace('chapter.tex', undefined, 'different');
  journal.acknowledge(foreign, undefined);
  assert.equal(journal.refineLine('main.tex', 2, 1), 3, 'a failed change to another file is irrelevant');
});

test('fine selection rejects unacknowledged, failed and unknown changes consistently with line mapping', () => {
  for (const result of ['pending', 'failed', 'unknown'] as const) {
    const journal = new SourceLineJournal();
    const entry = result === 'unknown'
      ? journal.replace('main.tex', undefined, 'Target')
      : journal.replace('main.tex', 'Before\nTarget', 'Changed\nTarget');
    if (result !== 'pending') journal.acknowledge(entry, result === 'failed' ? undefined : 2);
    assert.equal(journal.rebase('main.tex', 2, 1), undefined);
    assert.equal(journal.refineLine('main.tex', 2, 1), undefined);
    if (result === 'unknown') assert.equal(journal.refineLine('main.tex', 2, 2), 2);
  }
});

test('refinement remains bounded by retained history, including identical sends', () => {
  const journal = new SourceLineJournal();
  for (let revision = 2; revision <= 50002; revision++) {
    journal.acknowledge(journal.replace('main.tex', 'Target', 'Target'), revision);
  }
  assert.equal(journal.rebase('main.tex', 1, 1), undefined);
  assert.equal(journal.refineLine('main.tex', 1, 1), undefined);
  assert.equal(journal.refineLine('main.tex', 1, 2), 1);
  journal.clear();
  assert.equal(journal.refineLine('main.tex', 1, 1), 1);
});

test('math context must remain unchanged even when the clicked source line is untouched', () => {
  const initial = 'Before\n\\[\n  a + b = c\n\\]\nAfter';
  const journal = new SourceLineJournal();
  assert.deepEqual(journal.refineContext('main.tex', 1, 2, 1), { firstLine: 1, lastLine: 2 });
  journal.acknowledge(journal.replace('main.tex', initial, initial.replace('\\[', '%[')), 2);
  assert.equal(journal.refineLine('main.tex', 3, 1), 3, 'the accurate formula source line stays untouched');
  assert.equal(journal.refineContext('main.tex', 1, 2, 1), undefined, 'changed opening delimiter cannot classify old ink');
  assert.deepEqual(journal.refineContext('main.tex', 1, 2, 2), { firstLine: 1, lastLine: 2 });
});

test('bounded context can shift intact but cannot include inserted, deleted or merged lines', () => {
  const initial = 'First\nBefore\n\\[\n  a + b = c\n\\]\nAfter';
  for (const [offset, length, replacement, expected] of [
    [0, 0, '% comment\n', { firstLine: 3, lastLine: 4 }],
    [0, 6, '', { firstLine: 1, lastLine: 2 }],
    [6, 0, '% comment\n', { firstLine: 3, lastLine: 4 }],
    [6, 0, '% comment\nprefix ', undefined],
    [13, 0, '% inserted inside context\n', undefined],
    [6, 7, '', undefined],
  ] as const) {
    const journal = new SourceLineJournal();
    journal.acknowledge(journal.submit(sourceLineChanges('main.tex', initial, [{ rangeOffset: offset, rangeLength: length, text: replacement }])[0]), 2);
    assert.deepEqual(journal.refineContext('main.tex', 2, 3, 1), expected, `${offset}/${length}/${JSON.stringify(replacement)}`);
  }
});
