import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { DisplayList, Item, LayoutUpdateEvent } from '../src/protocol';
import { findDestination, pageNavigation, rowBands } from '../webview/links';
import { PreviewModel } from '../webview/model';
import { realEngineFixture, realEngineUnavailable } from './realEngineFixture';

function allItems(dl: DisplayList): Item[] {
  return [...dl.other, ...dl.lines.flatMap((line) => line.items)];
}

function installLayout(model: PreviewModel, layout: LayoutUpdateEvent): void {
  model.applyLayout({ pages: layout.pages_changed, pagesTotal: layout.pages_total,
    placements: layout.placements, keepFromRevision: null });
}

test('real equation reference hit areas follow live rows and resolve to current cross-page destinations', {
  skip: realEngineUnavailable,
  timeout: 120000,
}, async (t) => {
  const fixture = await realEngineFixture('structural-live.tex');
  const capture = process.env.RTEX_TEST_CAPTURE_LINKS === '1';
  try {
    const initial = await fixture.start();
    const model = new PreviewModel();
    installLayout(model, initial);
    const navigation = () => [...model.pages.keys()].map((page) => ({ page, ...pageNavigation(model, page) }));
    const initialNavigation = navigation();
    const destinations = new Map(initialNavigation.flatMap((entry) => entry.destinations.map((destination) =>
      [destination.target, { ...destination, page: entry.page }] as const)));
    assert.equal(destinations.get('name:equation.1.1')?.page, 1, 'main equation anchor must be on the main page');
    assert.equal(destinations.get('name:equation.A.1')?.page, 2, 'Appendix A equation anchor must have its actual named target');
    assert.equal(destinations.get('name:equation.B.1')?.page, 3, 'Appendix B equation anchor must have its own named target');
    for (const entry of initialNavigation) for (const link of entry.links) {
      assert.ok(link.w > 0 && link.h > 0, 'reference hotspots must have real glyph extents');
      assert.ok(destinations.has(link.target), `reference ${link.target} has no captured destination`);
    }
    const firstPage = initialNavigation.find((entry) => entry.page === 1)!;
    assert.ok(firstPage.links.some((link) => link.target === 'name:equation.A.1'), 'main page must link across pages to Appendix A');
    assert.ok(firstPage.links.some((link) => link.target === 'name:equation.B.1'), 'main page must link across pages to Appendix B');

    // Force actual line reflow before the equation, rather than merely changing a glyph
    // without moving either the reference hit area or the destination it points to.
    const update = await fixture.editMarker('GRAYPROOF', 'X ' + 'a '.repeat(100));
    const liveLinks = allItems(update.dl).filter((item) => item[0] === 'L');
    assert.ok(liveLinks.some((item) => item[1] === 'name:equation.1.1'),
      'the live paragraph must retain the equation target ID through binary decoding');
    model.applyParagraph(update.par_id, update.dl, update.fragments, update.versions.source_revision);
    const moved = findDestination(model, 'name:equation.1.1');
    assert.ok(moved?.live, 'the edited equation must resolve to its live anchor before the background layout');
    assert.ok(moved.y > destinations.get('name:equation.1.1')!.y, 'the anchor must move down with the reflowed proof');
    for (const fragment of update.fragments) {
      const livePage = pageNavigation(model, fragment.page);
      for (const overlay of model.overlaysOn(fragment.page)) for (const row of overlay.rows) {
        for (const item of row.line.items.filter((entry) => entry[0] === 'L')) {
          const expected = { target: item[1], x: Number(item[2]) + row.dx, y: Number(item[3]) + row.dy,
            w: Number(item[4]), h: Number(item[5]) };
          assert.ok(livePage.links.some((link) => link.target === expected.target &&
            link.x === expected.x && link.y === expected.y && link.w === expected.w && link.h === expected.h),
          'the preview hotspot must move with the actual edited paragraph row');
        }
      }
    }
    // Change the reference target itself. The new live hotspot must use the new real action
    // ID immediately while the old equation anchor remains a valid separate destination.
    const oldReference = String.raw`\eqref{eq:main}`;
    const referenceAt = fixture.source.indexOf(oldReference, fixture.source.indexOf('GRAYPROOF'));
    assert.ok(referenceAt >= 0);
    const retargeted = await fixture.editLive(referenceAt, referenceAt + oldReference.length,
      String.raw`\eqref{eq:appendix-b}`, 'reference target replacement');
    const retargetedLinks = allItems(retargeted.dl).filter((item) => item[0] === 'L');
    assert.ok(retargetedLinks.some((item) => item[1] === 'name:equation.B.1'), 'live link must point to the newly chosen equation');
    assert.ok(!retargetedLinks.some((item) => item[1] === 'name:equation.1.1'), 'the obsolete reference hotspot must disappear');
    model.applyParagraph(retargeted.par_id, retargeted.dl, retargeted.fragments, retargeted.versions.source_revision);
    assert.equal(findDestination(model, 'name:equation.B.1')?.page, 3, 'the replacement link must resolve across pages');
    const latest = await fixture.layout(retargeted.versions.source_revision);
    installLayout(model, latest);
    assert.equal(model.overlays.size, 0, 'the matching fresh layout must replace the live overlay');
    for (const entry of navigation()) for (const link of entry.links) {
      const currentTarget = navigation().flatMap((page) => page.destinations)
        .find((destination) => destination.target === link.target);
      assert.ok(currentTarget, `latest layout lost target ${link.target}`);
    }

    if (capture) {
      await fs.writeFile(path.join(os.tmpdir(), 'rtex-hyperlink-browser-layout.json'), JSON.stringify(initial));
      await fs.writeFile(path.join(os.tmpdir(), 'rtex-hyperlink-browser-paragraph.json'), JSON.stringify(update));
      await fs.writeFile(path.join(os.tmpdir(), 'rtex-hyperlink-browser-latest-layout.json'), JSON.stringify(latest));
      await fs.writeFile(path.join(os.tmpdir(), 'rtex-hyperlink-browser-fixture-path.txt'), fixture.temporary);
      t.diagnostic(`Preserved browser QA fixture: ${fixture.temporary}`);
    }
  } finally {
    await fixture.close(capture);
  }
});

test('real previous-page formula destinations survive unrelated live reflow over their anchors', {
  skip: realEngineUnavailable,
  timeout: 120000,
}, async () => {
  const fixture = await realEngineFixture('formula-links-live.tex');
  try {
    const model = new PreviewModel();
    installLayout(model, await fixture.start());
    const references = pageNavigation(model, 2).links;
    assert.equal(references.length, 6, 'the next page must reference equation, align, gather and split formulas');
    for (const reference of references) {
      assert.equal(findDestination(model, reference.target)?.page, 1,
        `${reference.target} must initially resolve to the previous page`);
    }

    for (const [marker, target] of [
      ['BEFORENORMAL', 'name:equation.1.2'],
      ['AFTERGATHER', 'name:equation.1.6'],
    ]) {
      const original = findDestination(model, target)!;
      assert.ok(original && !original.live, 'the neighboring formula must belong to the background layout');
      const update = await fixture.editMarker(marker, 'X ' + 'a '.repeat(120));
      model.applyParagraph(update.par_id, update.dl, update.fragments, update.versions.source_revision);
      const masks = model.overlaysOn(original.page).flatMap(({ rows }) => rowBands(rows));
      assert.ok(masks.some((band) => original.x >= band[0] && original.x < band[2] &&
        original.y >= band[1] && original.y < band[3]),
        'the real live rows must cross the neighboring formula anchor to reproduce the bug');
      const current = findDestination(model, target);
      assert.ok(current, 'an unrelated live overlay must not delete a known formula destination');
      assert.equal(current.page, original.page);
      assert.equal(current.y, original.y, 'the target keeps its known location until its own layout changes');
      for (const reference of references) {
        assert.ok(findDestination(model, reference.target), `live reflow lost ${reference.target}`);
      }

      installLayout(model, await fixture.layout(update.versions.source_revision));
      assert.equal(model.overlays.size, 0);
      assert.ok(findDestination(model, target)!.y > original.y,
        'the fresh layout must move the neighboring formula to its actual reflowed position');
      const latestReferences = pageNavigation(model, 2).links;
      assert.equal(latestReferences.length, 6);
      for (const reference of latestReferences) {
        assert.equal(findDestination(model, reference.target)?.page, 1,
          `the current full layout must restore the precise previous-page target ${reference.target}`);
      }
    }
  } finally {
    await fixture.close();
  }
});
