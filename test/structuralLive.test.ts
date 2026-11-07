/// <reference lib="dom" />
/// <reference path="../webview/opentype.d.ts" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DisplayList } from '../src/protocol';
import { FontStore, IDENTITY, ImageStore, Painter } from '../webview/render';
import { PreviewModel } from '../webview/model';
import { hitSourceAnchor, SourceLineJournal, targetSourceAnchor } from '../src/sourceAnchors';
import { glyphText, realEngineFixture, realEngineUnavailable } from './realEngineFixture';

type Ink = { text: string; color: string };
function renderInk(dl: DisplayList): Ink[] {
  const ink: Ink[] = [];
  const context = {
    fillStyle: '', setTransform() {}, fillRect() {},
    fillText(this: { fillStyle: string }, text: string) { ink.push({ text, color: this.fillStyle }); },
  } as unknown as CanvasRenderingContext2D;
  const painter = new Painter(context, IDENTITY,
    { get: () => undefined } as unknown as FontStore,
    { get: () => undefined } as unknown as ImageStore, { nativeText: true });
  painter.draw(dl, dl.other);
  for (const line of dl.lines) painter.draw(dl, line.items);
  return ink;
}

function assertMarkerColor(dl: DisplayList, marker: string, color: string): void {
  const ink = renderInk(dl);
  const at = ink.map((glyph) => glyph.text).join('').indexOf(marker);
  assert.ok(at >= 0, `missing marker ${marker}`);
  for (const glyph of ink.slice(at, at + marker.length)) {
    assert.equal(glyph.color, color, `${marker}: ${glyph.text} used the wrong color`);
  }
}

function subsectionDocument(): string {
  const parts = ['\\documentclass{article}', '\\usepackage[T1]{fontenc}',
    '\\usepackage{amsmath,amsthm,hyperref}', '\\begin{document}'];
  for (let section = 1; section <= 8; section++) {
    parts.push(`\\section{Section ${section}}`);
    for (let subsection = 1; subsection <= 5; subsection++) {
      parts.push(`\\subsection{Detail ${section} ${subsection}}`);
      for (let paragraph = 1; paragraph <= 3; paragraph++) {
        parts.push(`MARK${section}X${subsection}P${paragraph} ` +
          'The estimate holds uniformly for each positive parameter with $x+y=z$.\n' +
          `CONTINUE${section}X${subsection}P${paragraph} ` +
          'The bound follows from the preceding argument with $x+y=z$. '.repeat(8));
      }
    }
  }
  return [...parts, '\\end{document}', ''].join('\n\n');
}

test('a heading edit publishes its first pass before references finish converging', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const f = await realEngineFixture({ source: String.raw`\documentclass{article}
\begin{document}
REFERENCE[\ref{target}]

\section{Original}\label{target}
ORIGINALBODY
\end{document}
` }, true);
  try {
    await f.start();
    const after = f.events.length;
    const at = f.source.indexOf('\\section{Original}');
    const edit = await f.edit(at, at, '\\section{Inserted}\nINSERTEDBODY remains locatable.\n\n');
    const first = await f.waitFor(after, event => event.event === 'LayoutUpdate' &&
      event.source_revision === edit.source_revision, 'the first heading layout');
    assert.equal(first.event, 'LayoutUpdate');
    if (first.event !== 'LayoutUpdate') throw new Error('Unexpected heading event');
    assert.equal(first.passes, 1, 'a fast first pass must not wait for the reference rerun');
    assert.equal(first.compile.state, 'Ok');
    assert.deepEqual(first.convergence, { state: 'Converging', pass: 1, reasons: ['another pass is running'] });
    const firstText = first.pages_changed.map(page => glyphText(page.dl)).join('').replace(/\s/g, '');
    assert.ok(firstText.includes('INSERTEDBODY') && firstText.includes('2Original'));
    assert.ok(firstText.includes('REFERENCE[1]'), 'the first pass must not claim settled references');
    const model = new PreviewModel();
    model.applyLayout({ pages: first.pages_changed, pagesTotal: first.pages_total,
      placements: first.placements, keepFromRevision: null });
    const line = f.source.slice(0, f.source.indexOf('INSERTEDBODY')).split('\n').length;
    const target = targetSourceAnchor(model, 'main.tex', line, new SourceLineJournal());
    assert.ok(target, 'the intermediate preview must already support source navigation');
    const hit = hitSourceAnchor(model, target.page, target.x, target.y);
    assert.equal(hit?.file, 'main.tex');
    assert.equal(hit?.line, line);
    assert.equal(hit?.revision, edit.source_revision);
    const final = await f.waitFor(after, event => event.event === 'LayoutUpdate' &&
      event.source_revision === edit.source_revision && event.convergence.state === 'Converged', 'converged heading references');
    assert.equal(final.event, 'LayoutUpdate');
    if (final.event !== 'LayoutUpdate') throw new Error('Unexpected convergence event');
    assert.equal(final.compile.state, 'Ok');
    assert.equal(final.passes, 2);
    assert.ok(final.pages_changed.map(page => glyphText(page.dl)).join('').replace(/\s/g, '').includes('REFERENCE[2]'));
  } finally { await f.close(); }
});

test('same-line prose after a newly inserted subsection resumes live in a long article', {
  skip: realEngineUnavailable, timeout: 120000,
}, async (t) => {
  const f = await realEngineFixture({ source: subsectionDocument() }, true);
  try {
    const initial = await f.start();
    assert.ok(initial.pages_total >= 20, 'exercise a long document with many existing subsections');
    const inserted = await f.edit(f.source.indexOf('MARK4X3P2'), f.source.indexOf('MARK4X3P2'),
      '\\subsection{Inserted detail} asdada ');
    await f.layout(inserted.source_revision);
    const update = await f.editMarker('asdada');
    const text = glyphText(update.dl).replace(/\s/g, '');
    assert.ok(text.includes('Inserteddetail'), 'the live box must retain its heading');
    assert.ok(text.includes('MARK4X3P2'), 'the live box must retain the following prose');
    assert.ok(text.includes('CONTINUE4X3P2'), 'the live box must retain prose continued on the next source line');
    assert.equal(update.versions.engine_generation, initial.versions.engine_generation);
    assert.equal(update.diagnostics.length, 0);
    t.diagnostic(`same-line subsection: ${(update.timing.total_us / 1000).toFixed(1)} ms`);
  } finally { await f.close(); }
});

test('new prose waits for its inserted subsection placement then resumes live', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const f = await realEngineFixture('structural-live.tex');
  try {
    await f.start();
    const at = f.source.indexOf('BLACKRESTORED');
    await f.edit(at, at, '\\subsection{Inserted detail}\nNEWBODY ');
    const textAt = f.source.indexOf('NEWBODY') + 'NEWBODY'.length;
    const result = await f.edit(textAt, textAt, 'X');
    assert.equal(result.routed, 'background', 'an uncaptured heading has no safe body placement yet');
    await f.layout(result.source_revision);
    await f.editMarker('NEWBODYX');
  } finally { await f.close(); }
});

test('nested OLD and REV scopes retain colors while both appendix bodies update live', {
  skip: realEngineUnavailable,
  timeout: 120000,
}, async (t) => {
  const fixture = await realEngineFixture('structural-live.tex');
  try {
    const initial = await fixture.start();
    assert.equal(initial.pages_total, 3, 'fixture separates the main text and both appendices');
    const cases: [string, string][] = [
      ['GRAYPROOF', 'rgb(140,140,140)'],
      ['REDNESTED', 'rgb(156,0,0)'],
      ['REDTAIL', 'rgb(156,0,0)'],
      ['GRAYRESTORED', 'rgb(140,140,140)'],
      ['REDWHOLEPROOF', 'rgb(156,0,0)'],
      ['GRAYNESTED', 'rgb(140,140,140)'],
      ['REDPROOFRESTORED', 'rgb(156,0,0)'],
      ['BLACKRESTORED', 'rgb(0,0,0)'],
      ['REDSTANDALONE', 'rgb(156,0,0)'],
      ['REDSTANDALONENEXT', 'rgb(156,0,0)'],
      ['BLACKAFTERDISPLAY', 'rgb(0,0,0)'],
      ['APPENDIXA', 'rgb(0,0,0)'],
      ['REDAPPENDIXA', 'rgb(156,0,0)'],
      ['APPENDIXB', 'rgb(0,0,0)'],
      ['GRAYAPPENDIXB', 'rgb(140,140,140)'],
      ['REDAPPENDIXB', 'rgb(156,0,0)'],
      ['GRAYAPPENDIXBTAIL', 'rgb(140,140,140)'],
      ['BLACKEND', 'rgb(0,0,0)'],
    ];
    let revision = initial.versions.source_revision;
    for (const [marker, color] of cases) {
      const update = await fixture.editMarker(marker);
      assert.ok(update.versions.source_revision > revision, 'live edits must advance monotonically');
      assert.equal(update.versions.engine_generation, initial.versions.engine_generation,
        'ordinary nested-wrapper and appendix edits must not restart the live engine');
      revision = update.versions.source_revision;
      assertMarkerColor(update.dl, marker + 'X', color);
      t.diagnostic(`${marker}: ${(update.timing.total_us / 1000).toFixed(1)} ms`);
    }
    const latest = await fixture.layout(revision);
    assert.equal(latest.versions.source_revision, revision);
    const pages = new Map(initial.pages_changed.map((page) => [page.page, page.dl]));
    for (const event of fixture.events) {
      if (event.event === 'LayoutUpdate' && event.versions.source_revision === revision) {
        for (const page of event.pages_changed) pages.set(page.page, page.dl);
      }
    }
    for (const [marker, color] of cases) {
      const page = [...pages.values()].find((dl) => renderInk(dl).map((glyph) => glyph.text).join('').includes(marker + 'X'));
      assert.ok(page, `${marker}: latest layout omitted the unsaved edit`);
      assertMarkerColor(page!, marker + 'X', color);
    }
  } finally {
    await fixture.close();
  }
});
