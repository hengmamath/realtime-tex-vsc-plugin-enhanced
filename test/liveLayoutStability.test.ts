import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fontKey } from '../src/fontKey';
import type { DisplayList, ParagraphUpdateEvent } from '../src/protocol';
import { PreviewModel, type OverlayRow } from '../webview/model';
import { glyphText, realEngineFixture, realEngineUnavailable } from './realEngineFixture';

function glyphs(dl: DisplayList, rows: OverlayRow[]) {
  return rows.flatMap(({ line, dx, dy }) => line.items.filter(item => item[0] === 'g').map(item => [
    fontKey(dl.fonts[String(item[1])]), dl.fonts[String(item[1])].size, item[2],
    Number(item[4]) + dx, Number(item[5]) + dy, item[6], item[7],
  ]));
}

test('stretched-page character edits keep live baselines and full correction remains authoritative', {
  skip: realEngineUnavailable, timeout: 120000,
}, async (t) => {
  const f = await realEngineFixture({ source: String.raw`\documentclass{article}
\usepackage{amsmath}
\setlength{\textheight}{360pt}
\flushbottom
\begin{document}
Opening text is kept in place. The display below is a simple synthetic calculation.
\begin{align*}
x+y&=z\\
a+b&=c
\end{align*}

TARGET text is kept in place. We change only one letter inside the following display.
\begin{align*}
x&\le aaaa\\
y&\le c
\end{align*}

FOLLOWING text is unchanged. Its location should not depend on the width of that letter.
\begin{align*}
u+v&=w\\
p+q&=r
\end{align*}

The next page contains an independent sentence.
\pagebreak
This is the second page.
\end{document}
` });
  const model = new PreviewModel();
  let applied = 0;
  const applyLayouts = () => {
    for (const event of f.events.slice(applied)) if (event.event === 'LayoutUpdate') {
      model.applyLayout({ pages: event.pages_changed, pagesTotal: event.pages_total,
        placements: event.placements, keepFromRevision: null });
    }
    applied = f.events.length;
  };
  const settled = async (after: number, update: ParagraphUpdateEvent) => {
    const full = await f.waitFor(after, event => event.event === 'LayoutUpdate' &&
      event.versions.source_revision >= update.versions.source_revision &&
      event.convergence.state === 'Converged', 'automatic full correction');
    assert.equal(full.event, 'LayoutUpdate');
    if (full.event === 'LayoutUpdate') assert.equal(full.compile.state, 'Ok');
    applyLayouts();
  };
  try {
    await f.start();
    applyLayouts();
    for (const [from, to] of [['aaaa', 'aaac'], ['aaac', 'aaaa']]) {
      const after = f.events.length;
      const at = f.source.indexOf(from);
      const update = await f.editLive(at, at + from.length, to, 'same-size character replacement');
      assert.ok(glyphText(update.dl).includes(to), 'new characters must be delivered live');
      assert.deepEqual(update.fragments, model.placements.get(update.par_id), 'live rows must not collapse stretched page spacing');
      assert.equal(update.pagination_stale, true, 'the conservative geometry check must still request full correction');
      assert.equal(update.pass_pending, true);
      const baselines = update.fragments.flatMap(fragment => fragment.baselines);
      const local = update.dl.lines.map(line => line.y);
      assert.ok(baselines.some((y, i) => i && Math.abs((y - baselines[i - 1]) - (local[i] - local[i - 1])) > 65536),
        'fixture must actually stretch spacing beyond the live box');
      model.applyParagraph(update.par_id, update.dl, update.fragments, update.versions.source_revision);
      const liveInk = update.fragments.flatMap(fragment => model.overlaysOn(fragment.page)
        .filter(({ overlay }) => overlay.parId === update.par_id).flatMap(({ overlay, rows }) => glyphs(overlay.dl, rows)));
      await settled(after, update);
      assert.deepEqual(model.placements.get(update.par_id)!.flatMap(fragment => fragment.baselines), baselines);
      const fullInk = [...new Set(update.fragments.map(fragment => fragment.page))].flatMap(page => {
        const dl = model.pages.get(page)!.dl;
        return glyphs(dl, [...model.ownLines(page, update.par_id)].map(i => ({ line: dl.lines[i], dx: 0, dy: 0 })));
      });
      assert.deepEqual(liveInk, fullInk, 'live glyphs and positions must agree with the authoritative full compile');
      t.diagnostic(`same-size live edit: ${(update.timing.total_us / 1000).toFixed(1)} ms; no baseline movement`);
    }
    for (const [from, to] of [
      [String.raw`aaaa\\`, String.raw`aaaa\\[4pt]`],
      [String.raw`aaaa\\[4pt]`, String.raw`aaaa\\`],
      ['aaaa', String.raw`\frac{aaaa}{c}`],
      ['y&\\le c', 'y&\\le c\\\\\nz&\\le d'],
    ]) {
      const after = f.events.length;
      const at = f.source.indexOf(from);
      assert.ok(at >= 0);
      const update = await f.editLive(at, at + from.length, to, 'changed formula geometry');
      assert.equal(update.pagination_stale, true, 'taller or additional rows must still invalidate pagination');
      assert.equal(update.pass_pending, true);
      await settled(after, update);
      assert.equal(model.placements.get(update.par_id)!.flatMap(fragment => fragment.baselines).length, update.dl.lines.length,
        'the full layout must include every current formula row');
    }
  } finally { await f.close(); }
});
