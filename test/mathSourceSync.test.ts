import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DisplayList, LayoutUpdateEvent, Line } from '../src/protocol';
import { advanceBackgroundSourceRevision, SourceLineJournal, targetMathRowAnchor, targetSourceAnchor } from '../src/sourceAnchors';
import { MAX_DISPLAY_CONTEXT_LINES, targetClosingDisplay } from '../src/sourceMathBlock';
import { PreviewModel } from '../webview/model';
import { glyphText, realEngineFixture, realEngineUnavailable } from './realEngineFixture';
import { expectedMathRow, mathRowGlyphY } from './mathSourceSyncExpected';

const PT = 65536;
const cases = ['ALIGN', 'ALIGNSTAR', 'ALIGNED', 'BRACKET', 'SPLIT', 'MULTLINE',
  'MULTLINESTAR', 'GATHER', 'GATHERSTAR', 'SINGLE', 'FRACTION', 'DOLLARS', 'MACRO'];

function formulaLines(source: string, name: string): number[] {
  const lines = source.split('\n');
  const first = lines.indexOf(`START${name}`), last = lines.indexOf(`END${name}`);
  assert.ok(first >= 0 && last > first, `missing synthetic formula ${name}`);
  return lines.flatMap((text, i) => i > first && i < last && text.trim() && !/^\s*%/.test(text) ? [i + 1] : []);
}

function target(model: PreviewModel, journal: SourceLineJournal, source: string, line: number, character: number) {
  const lines = source.split('\n');
  const exact = targetMathRowAnchor(model, 'main.tex', line, journal, { text: lines[line - 1], character });
  if (exact) return exact;
  const direct = targetSourceAnchor(model, 'main.tex', line, journal, { text: lines[line - 1], character });
  return ((!direct || /\\end\s*\{|\\\]|\$\$/.test(lines[line - 1]))
    ? targetClosingDisplay(model, 'main.tex', line, character, journal, (anchor) => {
      if (direct && anchor !== line) return undefined;
      if (anchor > lines.length) return undefined;
      const firstLine = Math.max(1, anchor - MAX_DISPLAY_CONTEXT_LINES);
      return { text: lines[anchor - 1], before: lines.slice(firstLine - 1, anchor - 1).join('\n') + '\n', firstLine };
    }) : undefined) ?? direct;
}

function applyLayout(model: PreviewModel, event: LayoutUpdateEvent): void {
  model.applyLayout({ pages: event.pages_changed, pagesTotal: event.pages_total,
    placements: event.placements, keepFromRevision: null });
  advanceBackgroundSourceRevision(model, event.source_revision);
}

type VisibleRow = { row: Line; dl: DisplayList; dx: number; dy: number };
function visibleRows(model: PreviewModel, page: number): VisibleRow[] {
  const rows: VisibleRow[] = [];
  for (const overlay of model.overlaysOn(page)) for (const row of overlay.rows) {
    rows.push({ row: row.line, dl: overlay.overlay.dl, dx: row.dx, dy: row.dy });
  }
  const dl = model.pages.get(page)?.dl;
  if (dl) {
    const hidden = model.hiddenLines(page);
    dl.lines.forEach((row, i) => { if (!hidden.has(i)) rows.push({ row, dl, dx: 0, dy: 0 }); });
  }
  return rows;
}

// Bounds come from drawn glyphs between two prose markers, independently of all source anchors.
function formulaBounds(model: PreviewModel, name: string) {
  const page = cases.indexOf(name) + 1;
  const rows = visibleRows(model, page);
  const text = ({ row, dl }: VisibleRow) => glyphText({ ...dl, lines: [row], other: [] }).replace(/\s/g, '');
  const start = rows.find(row => text(row) === `START${name}`);
  const end = rows.find(row => text(row).endsWith(`END${name}`));
  assert.ok(start && end, `missing rendered markers for ${name}: ${rows.map(({ row, dl }) =>
    glyphText({ ...dl, lines: [row], other: [] })).join(' / ')}`);
  const math = rows.filter(({ row, dy }) => row.y + dy > start.row.y + start.dy
    && row.y + dy < end.row.y + end.dy);
  const glyphs = math.flatMap(({ row, dx, dy }) => row.items.filter((item) => item[0] === 'g')
    .map((item) => ({ x: (item[4] as number) + dx, right: (item[4] as number) + (item[6] as number) + dx,
      y: (item[5] as number) + dy })));
  assert.ok(glyphs.length, `${name} must render formula ink`);
  return { page, followingY: end.row.y + end.dy, math,
    text: math.map(({ row, dl }) => glyphText({ ...dl, lines: [row], other: [] })).join(''),
    left: Math.min(...glyphs.map((g) => g.x)) - 3 * PT,
    right: Math.max(...glyphs.map((g) => g.right)) + 3 * PT,
    top: Math.min(...glyphs.map((g) => g.y)) - PT, bottom: Math.max(...glyphs.map((g) => g.y)) + PT };
}

function assertFormula(model: PreviewModel, journal: SourceLineJournal, source: string, name: string): void {
  const bounds = formulaBounds(model, name);
  const lines = source.split('\n');
  const body = formulaLines(source, name);
  assert.ok(body.length);
  for (const line of body) {
    const text = lines[line - 1];
    const end = text.includes('\\end{proof}') ? text.indexOf('\\end{proof}') : text.length;
    for (let column = 0; column <= end; column++) {
      const hit = target(model, journal, source, line, column);
      const at = `${name}, source ${line}:${column}`;
      assert.ok(hit, `${at}: formula source has no preview target`);
      assert.equal(hit.page, bounds.page, `${at}: jumped to another formula`);
      assert.ok(hit.x >= bounds.left && hit.x <= bounds.right && hit.y >= bounds.top && hit.y <= bounds.bottom,
        `${at}: target ${JSON.stringify(hit)} lies outside rendered formula ${JSON.stringify(bounds)}`);
      const expected = expectedMathRow(text, column)
        ?? (name === 'MACRO' && text.includes('\\SyntheticRows') ? 'z10' : undefined);
      if (expected) {
        const baselines = [...new Set(bounds.math.flatMap(({ row, dy }) => {
          const y = mathRowGlyphY(row, expected);
          return y === undefined ? [] : [y + dy];
        }))];
        assert.equal(baselines.length, 1, `${at}: expected unique rendered glyph row ${expected}`);
        assert.equal(hit.y, baselines[0], `${at}: target must match rendered row ${expected}`);
      }
    }
    if (text.includes('where constants')) {
      const prose = target(model, journal, source, line, text.indexOf('constants') + 3);
      assert.ok(prose && prose.page === bounds.page && prose.y === bounds.followingY,
        'prose following the math and proof closers must retain its own rendered target');
    }
  }
}

test('bundled math anchors locate each logical formula row, including live edits and undo', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const fixture = await realEngineFixture('math-source-sync.tex', true);
  try {
    const model = new PreviewModel(), journal = new SourceLineJournal();
    const initial = await fixture.start();
    assert.equal(initial.pages_total, cases.length);
    for (const event of fixture.events) {
      if (event.event === 'LayoutUpdate' && event.compile.state === 'Ok') applyLayout(model, event);
    }
    for (const name of cases) assertFormula(model, journal, fixture.source, name);

    // Both replacement and undo must retain navigation on the actual live overlay.
    for (const [oldText, text] of [['c+d', 'c+q'], ['c+q', 'c+d']]) {
      const after = fixture.events.length;
      const before = fixture.source;
      const at = before.indexOf(oldText);
      assert.ok(at >= 0);
      const changed = before.slice(0, at) + text + before.slice(at + oldText.length);
      const recorded = journal.replace('main.tex', before, changed);
      const line = formulaLines(changed, 'FRACTION')[0];
      assert.equal(target(model, journal, changed, line, 2), undefined,
        'an unacknowledged edit must not navigate using old formula ink');
      const update = await fixture.editLive(at, at + oldText.length, text, 'formula source sync');
      journal.acknowledge(recorded, update.versions.source_revision);
      assert.equal(update.versions.engine_generation, initial.versions.engine_generation);
      model.applyParagraph(update.par_id, update.dl, update.fragments, update.versions.source_revision);
      assert.equal(formulaBounds(model, 'FRACTION').text.includes('q'), text.includes('q'),
        'the live overlay must contain the edited formula');
      assertFormula(model, journal, fixture.source, 'FRACTION');
      await fixture.layout(update.versions.source_revision);
      for (const event of fixture.events.slice(after)) {
        if (event.event === 'LayoutUpdate' && event.compile.state === 'Ok') applyLayout(model, event);
      }
      for (const name of cases) assertFormula(model, journal, fixture.source, name);
    }

    const lastRow = 'd_2 &= e_2 + f_2';
    const extraRow = `${lastRow} \\\\\n  j_2 &= k_2 + l_2`;
    // Add, delete and undo a row in the same live paragraph; the glyph oracle moves with its ink.
    for (const [oldText, text] of [[lastRow, extraRow], [extraRow, lastRow], [lastRow, extraRow], [extraRow, lastRow]]) {
      const after = fixture.events.length;
      const before = fixture.source;
      const at = before.indexOf(oldText);
      assert.ok(at >= 0);
      const changed = before.slice(0, at) + text + before.slice(at + oldText.length);
      const recorded = journal.replace('main.tex', before, changed);
      const line = changed.slice(0, at).split('\n').length;
      assert.equal(target(model, journal, changed, line, changed.split('\n')[line - 1].indexOf('d_2')), undefined,
        'unacknowledged row changes must not navigate using old formula ink');
      const update = await fixture.editLive(at, at + oldText.length, text, 'formula row insertion/deletion/undo');
      journal.acknowledge(recorded, update.versions.source_revision);
      assert.equal(update.versions.engine_generation, initial.versions.engine_generation);
      model.applyParagraph(update.par_id, update.dl, update.fragments, update.versions.source_revision);
      assertFormula(model, journal, fixture.source, 'ALIGNSTAR');
      await fixture.layout(update.versions.source_revision);
      for (const event of fixture.events.slice(after)) {
        if (event.event === 'LayoutUpdate' && event.compile.state === 'Ok') applyLayout(model, event);
      }
      for (const name of cases) assertFormula(model, journal, fixture.source, name);
    }
  } finally {
    await fixture.close();
  }
});
