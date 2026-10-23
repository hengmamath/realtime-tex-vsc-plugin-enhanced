import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import type { DisplayList, Item } from '../src/protocol';
import { imageInfo } from '../src/resourceUsage';
import { PreviewModel } from '../webview/model';
import { realEngineFixture, realEngineUnavailable } from './realEngineFixture';

import { twoPagePdf } from './pdfFixture';

test('bundled PDF image page metadata stays distinct through live editing and the next layout', {
  skip: realEngineUnavailable, timeout: 90000,
}, async () => {
  const fixture = await realEngineFixture('pdf-images.tex');
  try {
    await fs.writeFile(path.join(fixture.temporary, 'project', 'two-pages.pdf'), twoPagePdf());
    const model = new PreviewModel();
    fixture.engine.on('event', event => {
      if (event.event === 'LayoutUpdate') model.applyLayout({ pages: event.pages_changed, pagesTotal: event.pages_total,
        placements: event.placements, keepFromRevision: null });
      else if (event.event === 'ParagraphUpdate' && event.status === 'ok') {
        model.applyParagraph(event.par_id, event.dl, event.fragments, event.versions.source_revision);
      }
    });
    const assertImages = () => {
      const images: { file: string; page: number | undefined; pages: number | undefined }[] = [];
      const inspect = (dl: DisplayList, items: readonly Item[]) => {
        for (const item of items) if (item[0] === 'i') {
          const info = imageInfo(dl, item[1] as number);
          assert.ok(info, 'every displayed image must resolve its own metadata');
          images.push({ file: info.file, page: info.page, pages: info.pages });
        }
      };
      for (const [page, update] of model.pages) {
        inspect(update.dl, update.dl.other);
        const hidden = model.hiddenLines(page);
        update.dl.lines.forEach((line, index) => { if (!hidden.has(index)) inspect(update.dl, line.items); });
        for (const { overlay, rows } of model.overlaysOn(page)) for (const row of rows) inspect(overlay.dl, row.line.items);
      }
      assert.equal(images.length, 2, 'the current preview must draw exactly the two included pages');
      assert.equal(new Set(images.map(image => image.file)).size, 1, 'both image entries must reuse the same PDF file');
      assert.equal(path.basename(images[0].file), 'two-pages.pdf');
      assert.deepEqual(images.map(image => image.page).sort(), [1, 2], 'PDF page choices must not collapse to page one');
      assert.ok(images.every(image => image.pages === 2));
    };
    await fixture.start();
    assertImages();
    const update = await fixture.editMarker('Pdfbodymarker');
    assert.ok(model.overlays.has(update.par_id), 'the assertion must cover an actual displayed live edit');
    assertImages();
    await fixture.layout(update.versions.source_revision);
    assert.equal(model.overlays.size, 0, 'the fresh layout must replace the live paragraph');
    assertImages();
  } finally { await fixture.close(); }
});
