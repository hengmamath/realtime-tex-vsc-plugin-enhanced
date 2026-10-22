import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HostToWebview } from '../src/messages';
import type { DisplayList, Fragment, PageUpdate, Placement } from '../src/protocol';
import { PreviewDelivery, type DeliveryLayout, type DeliveryParagraph } from '../src/preview/delivery';
import { PreviewModel } from '../webview/model';
import { findDestination } from '../webview/links';
import { glyphText, realEngineFixture, realEngineUnavailable } from './realEngineFixture';

const U = 65536;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (check()) return;
    await tick();
  }
  assert.ok(check(), message);
}
async function drain(): Promise<void> { for (let i = 0; i < 4; i++) await tick(); }

function displayList(marker: string, baselines = [7]): DisplayList {
  return {
    kind: 'paragraph', fonts: { '1': { id: 1, name: marker, size: 10 * U } },
    lines: baselines.map(y => ({ x: 10 * U, y: y * U, w: 100 * U, h: 7 * U, d: 2 * U,
      items: [['g', 1, 65, null, 10 * U, y * U, 6 * U, 0]] })),
    other: [], flags: [], width: 600 * U, height: 800 * U, depth: 0,
    page_width: 600 * U, page_height: 800 * U,
  };
}
const marker = (dl: DisplayList) => dl.fonts['1'].name!;
function page(n: number, name: string, exact = true, baselines = [100, 300]): PageUpdate {
  return { page: n, exact, hash: n, dl: { ...displayList(name, baselines), kind: 'page' } };
}
function fragment(page: number, y: number): Fragment {
  return { page, first_line: 1, last_line: 1, x: 10 * U, xs: [10 * U], baselines: [y * U], approximate: false };
}
const placements = (first = 100, second = 300): Placement[] => [
  { par_id: 1, fragments: [fragment(1, first)], lines: 1, kind: 'par' },
  { par_id: 2, fragments: [fragment(1, second)], lines: 1, kind: 'par' },
];
function layout(version: number, pages: PageUpdate[], options: Partial<DeliveryLayout> = {}): DeliveryLayout {
  return { pages, pagesTotal: Math.max(1, ...pages.map(p => p.page)), placements: placements(),
    keepFromRevision: null, layoutVersion: version, pdfPath: `layout-${version}.pdf`, ...options };
}
function paragraph(parId: number, revision: number, name: string, y = parId === 1 ? 100 : 300): DeliveryParagraph {
  return { parId, revision, dl: displayList(name), fragments: [fragment(1, y)] };
}

/** Only asynchronous I/O is mocked. Production PreviewDelivery creates every state packet;
 * those actual packets are applied to the same PreviewModel that the webview uses. */
function harness(observe?: (view: PreviewModel, message: HostToWebview) => void) {
  const messages: HostToWebview[] = [];
  const errors: unknown[] = [];
  const view = new PreviewModel();
  const resourceGates = new Map<string, ReturnType<typeof deferred<boolean>>>();
  const pdfGates = new Map<string, ReturnType<typeof deferred<Uint8Array | null>>>();
  const started: string[] = [];
  const reads: { file: string; signal: AbortSignal }[] = [];
  const post = (message: HostToWebview) => {
    messages.push(message);
    if (message.type === 'layout') view.applyLayout(message);
    else if (message.type === 'paragraph') view.applyParagraph(message.parId, message.dl, message.fragments, message.revision);
    else if (message.type === 'dropOverlays') view.dropOverlays(message.parIds);
    else if (message.type === 'reset') view.clear();
    observe?.(view, message);
  };
  const delivery = new PreviewDelivery({
    prepare: async (dls, _validate, current) => {
      const names = [...new Set(dls.map(marker))];
      started.push(...names);
      const missing = await Promise.all(names.map(name => resourceGates.get(name)?.promise ?? false));
      // This is the resource loader's public cancellation contract: stale I/O completion
      // must not publish fonts into a different revision/session.
      if (current() && names.length) post({ type: 'resources', images: [], fonts: names.map(name => [
        `tfm:${name}`, { kind: 'type1', upem: 1000, glyphs: { 65: 'M0 0L600 0L600 700L0 700Z' } },
      ]) });
      return missing.some(Boolean);
    },
    readPdf: async (file, signal) => {
      reads.push({ file, signal });
      // A deliberately uncooperative pending read verifies stale-result guards even when
      // cancellation cannot interrupt the underlying filesystem request immediately.
      return pdfGates.get(file)?.promise ?? new Uint8Array([1]);
    },
    post,
    error: error => errors.push(error),
  });
  return { delivery, view, messages, errors, resourceGates, pdfGates, started, reads,
    paragraphs: () => messages.filter((m): m is Extract<HostToWebview, { type: 'paragraph' }> => m.type === 'paragraph'),
    layouts: () => messages.filter((m): m is Extract<HostToWebview, { type: 'layout' }> => m.type === 'layout'),
    resourceNames: () => messages.flatMap(m => m.type === 'resources' ? m.fonts.map(([key]) => key) : []),
  };
}
test('the layout PDF is read only for a changed page that needs it', async () => {
  // the engine names one PDF for the whole document; unrelated degraded pages keep their own
  const h = harness();
  h.delivery.layout(layout(1, [page(1, 'exact-text')]));
  await until(() => h.layouts().length === 1, 'an exact layout must be delivered');
  assert.equal(h.reads.length, 0);
  assert.equal(h.layouts()[0].pdf, null);
  h.delivery.layout(layout(2, [page(1, 'drawing', false)]));
  await until(() => h.layouts().length === 2, 'a degraded page must be delivered');
  assert.deepEqual(h.reads.map((r) => r.file), ['layout-2.pdf']);
  // a page without `exact` (older protocol) stays conservative
  h.delivery.layout(layout(3, [{ ...page(1, 'unknown'), exact: undefined } as unknown as PageUpdate]));
  await until(() => h.layouts().length === 3, 'a page of unknown exactness must be delivered');
  assert.deepEqual(h.reads.map((r) => r.file), ['layout-2.pdf', 'layout-3.pdf']);
  assert.deepEqual(h.errors, []);
});

async function start(h: ReturnType<typeof harness>, pages = [page(1, 'base')], positions = placements()): Promise<void> {
  h.delivery.layout(layout(1, pages, { placements: positions }));
  await until(() => h.layouts().length === 1, 'initial background must be delivered');
}

test('latest same-paragraph text bypasses an obsolete held font preparation', async () => {
  const h = harness();
  await start(h);
  const old = deferred<boolean>();
  h.resourceGates.set('old-text', old);
  h.delivery.paragraph(paragraph(1, 2, 'old-text'));
  await until(() => h.started.includes('old-text'), 'old preparation must actually be in flight');
  h.delivery.paragraph(paragraph(1, 3, 'latest-text'));
  await until(() => h.view.overlays.get(1)?.revision === 3, 'latest text must not wait for the old font promise');
  assert.equal(marker(h.view.overlays.get(1)!.dl), 'latest-text');
  assert.deepEqual(h.paragraphs().map(p => p.revision), [3]);
  assert.ok(!h.resourceNames().includes('tfm:old-text'));
  old.resolve(false);
  await drain();
  assert.deepEqual(h.paragraphs().map(p => p.revision), [3]);
  assert.ok(!h.resourceNames().includes('tfm:old-text'), 'late stale resources must also stay suppressed');
  h.delivery.dispose();
});

test('a burst coalesces per paragraph while keeping independent paragraph revisions', async () => {
  const h = harness();
  await start(h);
  const slow = deferred<boolean>();
  h.resourceGates.set('held-A', slow);
  h.delivery.paragraph(paragraph(1, 4, 'held-A'));
  await until(() => h.started.includes('held-A'), 'paragraph A must be preparing');
  for (let revision = 5; revision <= 30; revision++) h.delivery.paragraph(paragraph(2, revision, `B-${revision}`));
  await until(() => h.view.overlays.get(2)?.revision === 30, 'paragraph B must bypass unrelated preparation');
  assert.deepEqual(h.paragraphs().filter(p => p.parId === 2).map(p => p.revision), [30]);
  slow.resolve(false);
  await until(() => h.view.overlays.has(1), 'A at an earlier global revision is still independently needed');
  assert.equal(h.view.overlays.get(1)?.revision, 4);
  assert.equal(h.view.overlays.get(2)?.revision, 30);
  for (const packet of h.paragraphs()) {
    const resourceAt = h.messages.findIndex(m => m.type === 'resources' && m.fonts.some(([key]) => key === `tfm:${marker(packet.dl)}`));
    assert.ok(resourceAt >= 0 && resourceAt < h.messages.indexOf(packet), 'resources must precede the paragraph that uses them');
  }
  h.delivery.dispose();
});

test('compatible live text bypasses a PDF read while incremental layout deltas are retained', async () => {
  const h = harness();
  await start(h, [page(1, 'page-1-v1'), page(2, 'page-2-v1')]);
  const oldPdf = deferred<Uint8Array | null>();
  h.pdfGates.set('held-v2.pdf', oldPdf);
  h.delivery.layout(layout(2, [page(1, 'page-1-v2', false)], {
    pagesTotal: 2, keepFromRevision: 2, pdfPath: 'held-v2.pdf',
  }));
  await until(() => h.reads.some(r => r.file === 'held-v2.pdf'), 'old PDF read must actually be in flight');
  h.delivery.paragraph(paragraph(1, 3, 'live-over-old-base'));
  await until(() => h.view.overlays.get(1)?.revision === 3, 'unchanged placements permit live delivery before the PDF');
  h.delivery.layout(layout(3, [page(2, 'page-2-v3', false)], {
    pagesTotal: 2, keepFromRevision: 2, pdfPath: 'latest-v3.pdf',
  }));
  await until(() => marker(h.view.pages.get(2)!.dl) === 'page-2-v3', 'latest layout must bypass the abandoned PDF');
  assert.equal(marker(h.view.pages.get(1)!.dl), 'page-1-v2', 'the earlier page-1 delta must not be lost');
  assert.equal(h.view.overlays.get(1)?.revision, 3, 'late layout delivery must retain newer live text');
  assert.ok(h.reads.find(r => r.file === 'held-v2.pdf')!.signal.aborted);
  const count = h.layouts().length;
  oldPdf.resolve(new Uint8Array([2]));
  await drain();
  assert.equal(h.layouts().length, count, 'a stale PDF completion cannot overwrite the latest layout');
  h.delivery.dispose();
});

test('live rows with changed placement wait for their base then retain only valid overlays', async () => {
  const h = harness();
  await start(h);
  h.delivery.paragraph(paragraph(1, 5, 'old-valid-row'));
  h.delivery.paragraph(paragraph(2, 3, 'old-absorbed-row'));
  await until(() => h.view.overlays.size === 2, 'both earlier live rows must be displayed');
  const pdf = deferred<Uint8Array | null>();
  h.pdfGates.set('moved.pdf', pdf);
  h.delivery.layout(layout(2, [page(1, 'moved-base', false, [200, 400])], {
    placements: placements(200, 400), keepFromRevision: 4, pdfPath: 'moved.pdf',
  }));
  await until(() => h.reads.some(r => r.file === 'moved.pdf'), 'new placement base must be pending');
  h.delivery.paragraph(paragraph(1, 6, 'new-moved-row', 200));
  await until(() => h.started.includes('new-moved-row'), 'new live text should prepare independently');
  await drain();
  assert.equal(h.view.overlays.get(1)?.revision, 5, 'new coordinates cannot be published over incompatible old rows');
  pdf.resolve(new Uint8Array([3]));
  await until(() => h.view.overlays.get(1)?.revision === 6, 'prepared text must flush after the compatible base');
  assert.equal(h.view.overlays.get(1)!.fragments[0].baselines[0], 200 * U);
  assert.ok(!h.view.overlays.has(2), 'the layout absorbed the overlay older than keepFromRevision');
  assert.equal(marker(h.view.pages.get(1)!.dl), 'moved-base');
  h.delivery.dispose();
});

test('converged layout absorbs obsolete pending text without waiting for its resources', async () => {
  const h = harness();
  await start(h);
  const old = deferred<boolean>();
  h.resourceGates.set('absorbed-text', old);
  h.delivery.paragraph(paragraph(1, 2, 'absorbed-text'));
  await until(() => h.started.includes('absorbed-text'), 'pending old text must start');
  h.delivery.layout(layout(2, [page(1, 'converged-base')], { keepFromRevision: null }));
  await until(() => marker(h.view.pages.get(1)!.dl) === 'converged-base', 'new base must not wait for absorbed text');
  old.resolve(false);
  await drain();
  assert.ok(!h.view.overlays.has(1));
  assert.ok(!h.paragraphs().some(p => marker(p.dl) === 'absorbed-text'));
  assert.ok(!h.resourceNames().includes('tfm:absorbed-text'));
  h.delivery.dispose();
});

test('layout cleanup never exposes old split text beside a newer merged overlay', async () => {
  const textList = (name: string, rows: string[], baselines: number[]): DisplayList => {
    const dl = displayList(name, baselines);
    dl.lines.forEach((line, i) => {
      line.items = [...rows[i]].map((char, x) => ['g', 1, char.codePointAt(0)!, null,
        (10 + x) * U, baselines[i] * U, U, 0]);
    });
    return dl;
  };
  let watching = false;
  const counts: number[] = [];
  const h = harness((view) => {
    if (!watching) return;
    let text = '';
    for (const [n, page] of view.pages) {
      const hidden = view.hiddenLines(n);
      for (const [i, line] of page.dl.lines.entries()) if (!hidden.has(i)) {
        text += glyphText({ ...page.dl, lines: [line], other: [] });
      }
      for (const overlay of view.overlaysOn(n)) for (const { line } of overlay.rows) {
        text += glyphText({ ...overlay.overlay.dl, lines: [line], other: [] });
      }
    }
    counts.push(text.split('SECONDH').length - 1);
  });
  const split = { ...page(1, 'split'), dl: { ...textList('split', ['FIRSTH', 'SECONDH'], [100, 300]), kind: 'page' as const } };
  await start(h, [split]);
  h.delivery.paragraph({ parId: 2, revision: 5, dl: displayList('removed', []), fragments: [] });
  await until(() => h.view.overlays.has(2), 'the tombstone must hide the old second paragraph');
  h.delivery.paragraph({ ...paragraph(1, 6, 'merged'), dl: textList('merged', ['FIRSTHSECONDH'], [7]) });
  await until(() => h.view.overlays.get(1)?.revision === 6, 'the merged live text must be visible');
  watching = true;
  const merged = { ...page(1, 'merged-base'), dl: { ...textList('merged-base', ['FIRSTHSECONDH'], [100]), kind: 'page' as const } };
  h.delivery.layout(layout(2, [merged], { placements: placements().slice(0, 1), keepFromRevision: 6 }));
  await until(() => h.layouts().length === 2, 'the stale layout must retain the newer merged overlay');
  assert.ok(h.view.overlays.has(1));
  assert.ok(!h.view.overlays.has(2));
  h.delivery.layout(layout(3, [merged], { placements: placements().slice(0, 1), keepFromRevision: null }));
  await until(() => h.layouts().length === 3, 'the converged layout must absorb the retained overlay');
  assert.equal(h.view.overlays.size, 0);
  assert.ok(counts.length > 0);
  assert.ok(counts.every(n => n === 1), `each delivered snapshot must contain SECONDH exactly once: ${counts}`);
  h.delivery.dispose();
});

test('explicit drops invalidate held text without discarding other paragraph updates', async () => {
  const h = harness();
  await start(h);
  const a = deferred<boolean>();
  const b = deferred<boolean>();
  h.resourceGates.set('old-A', a);
  h.resourceGates.set('independent-B', b);
  h.delivery.paragraph(paragraph(1, 2, 'old-A'));
  h.delivery.paragraph(paragraph(2, 3, 'independent-B'));
  await until(() => h.started.includes('old-A') && h.started.includes('independent-B'), 'both I/O operations must begin');
  h.delivery.dropOverlays([1]);
  h.delivery.paragraph(paragraph(1, 4, 'fresh-A'));
  await until(() => h.view.overlays.get(1)?.revision === 4, 'new text after the drop must remain deliverable');
  a.resolve(false);
  b.resolve(false);
  await until(() => h.view.overlays.has(2), 'dropping A must not cancel B');
  assert.equal(marker(h.view.overlays.get(1)!.dl), 'fresh-A');
  assert.ok(!h.paragraphs().some(p => marker(p.dl) === 'old-A'));
  assert.ok(!h.resourceNames().includes('tfm:old-A'));
  h.delivery.dropOverlays();
  assert.equal(h.view.overlays.size, 0);
  h.delivery.dispose();
});

test('an intermediate page shrink cannot resurrect a stale pending page on later growth', async () => {
  const h = harness();
  await start(h, [page(1, 'one'), page(2, 'two')]);
  const held = deferred<Uint8Array | null>();
  h.pdfGates.set('grow.pdf', held);
  h.delivery.layout(layout(2, [page(3, 'obsolete-three', false)], { pagesTotal: 3, pdfPath: 'grow.pdf' }));
  await until(() => h.reads.some(r => r.file === 'grow.pdf'), 'old growth must be preparing');
  h.delivery.layout(layout(3, [], { pagesTotal: 1 }));
  h.delivery.layout(layout(4, [page(2, 'replacement-two')], { pagesTotal: 2 }));
  await until(() => h.view.pagesTotal === 2 && marker(h.view.pages.get(2)!.dl) === 'replacement-two', 'latest page count and delta must win');
  held.resolve(new Uint8Array([9]));
  await drain();
  assert.deepEqual([...h.view.pages.keys()].sort(), [1, 2]);
  assert.ok(!h.layouts().some(m => m.pages.some(p => marker(p.dl) === 'obsolete-three')));
  h.delivery.dispose();
});

test('session reset cancels old resources and PDFs even if their reads finish later', async () => {
  const h = harness();
  await start(h);
  const font = deferred<boolean>();
  const pdf = deferred<Uint8Array | null>();
  h.resourceGates.set('old-document-text', font);
  h.pdfGates.set('old-document.pdf', pdf);
  h.delivery.paragraph(paragraph(1, 20, 'old-document-text'));
  h.delivery.layout(layout(2, [page(1, 'old-document-base', false)], {
    keepFromRevision: 1, pdfPath: 'old-document.pdf',
  }));
  await until(() => h.started.includes('old-document-text') && h.reads.length > 0, 'old session work must be in flight');
  h.delivery.reset();
  // PreviewPanel owns the reset packet; the production delivery object owns cancellation.
  h.messages.push({ type: 'reset' });
  h.view.clear();
  h.delivery.layout(layout(1, [page(1, 'new-document-base')]));
  h.delivery.paragraph(paragraph(1, 1, 'new-document-text'));
  await until(() => h.view.overlays.get(1)?.revision === 1, 'new session revisions can start again at one');
  assert.ok(h.reads[0].signal.aborted);
  const count = h.messages.length;
  font.resolve(false);
  pdf.resolve(new Uint8Array([2]));
  await drain();
  assert.equal(h.messages.length, count, 'old work cannot send any state or resource packet after reset');
  assert.equal(marker(h.view.pages.get(1)!.dl), 'new-document-base');
  assert.equal(marker(h.view.overlays.get(1)!.dl), 'new-document-text');
  h.delivery.dispose();
});

test('resource failure does not poison independent or later paragraph delivery', async () => {
  const h = harness();
  await start(h);
  const failure = deferred<boolean>();
  h.resourceGates.set('failing-A', failure);
  h.delivery.paragraph(paragraph(1, 2, 'failing-A'));
  await until(() => h.started.includes('failing-A'), 'failing I/O must start');
  h.delivery.paragraph(paragraph(2, 3, 'healthy-B'));
  await until(() => h.view.overlays.has(2), 'unrelated work must not queue behind the failed resource');
  failure.reject(new Error('fixture font read failed'));
  await until(() => h.errors.length === 1, 'the active failure must be reported');
  h.delivery.paragraph(paragraph(1, 4, 'recovered-A'));
  await until(() => h.view.overlays.get(1)?.revision === 4, 'the failed lane must allow a later revision');
  assert.equal(marker(h.view.overlays.get(2)!.dl), 'healthy-B');
  h.delivery.dispose();
});

test('a new borrowed-context paragraph can update immediately on the same displayed base', async () => {
  const h = harness();
  await start(h);
  assert.ok(!h.view.placements.has(77));
  const fresh = paragraph(77, 2, 'new-borrowed-unit', 200);
  h.delivery.paragraph(fresh);
  await until(() => h.view.overlays.has(77), 'valid new-unit fragments must retain the existing live behavior');
  assert.equal(marker(h.view.overlays.get(77)!.dl), 'new-borrowed-unit');
  assert.equal(h.view.overlays.get(77)!.fragments[0].baselines[0], 200 * U);
  h.delivery.dispose();
});

test('a new unit depending on pending layout placements waits even on an existing page', async () => {
  const h = harness();
  await start(h);
  const pdf = deferred<Uint8Array | null>();
  h.pdfGates.set('new-unit-base.pdf', pdf);
  const newerPlacements = [...placements(), { par_id: 77, fragments: [fragment(1, 200)], lines: 1, kind: 'par' }];
  h.delivery.layout(layout(2, [page(1, 'new-unit-base', false, [100, 200, 300])], {
    placements: newerPlacements, keepFromRevision: 2, pdfPath: 'new-unit-base.pdf',
  }));
  await until(() => h.reads.length > 0, 'new base must be awaiting its PDF');
  h.delivery.paragraph(paragraph(77, 3, 'pending-new-unit', 200));
  await until(() => h.started.includes('pending-new-unit'), 'new-unit resources can prepare early');
  await drain();
  assert.ok(!h.view.overlays.has(77), 'an unknown placement cannot overtake its pending base');
  pdf.resolve(new Uint8Array([2]));
  await until(() => h.view.overlays.has(77), 'new-unit text must flush when its base is committed');
  assert.equal(h.view.placements.get(77)![0].baselines[0], 200 * U);
  h.delivery.dispose();
});

test('PDF-dependent live material waits for a pending base even when row placements match', async () => {
  const h = harness();
  await start(h);
  const pdf = deferred<Uint8Array | null>();
  const resources = deferred<boolean>();
  h.pdfGates.set('new-picture-base.pdf', pdf);
  h.resourceGates.set('live-cached-picture', resources);
  h.delivery.layout(layout(2, [page(1, 'new-picture-base', false)], {
    keepFromRevision: 2, pdfPath: 'new-picture-base.pdf',
  }));
  await until(() => h.reads.length > 0, 'matching new picture pixels must be awaiting the PDF');
  h.delivery.paragraph(paragraph(1, 3, 'live-cached-picture'));
  await until(() => h.started.includes('live-cached-picture'), 'live resource preparation must start');
  resources.resolve(true);
  await drain();
  assert.ok(!h.view.overlays.has(1), 'matching row coordinates do not prove that cached picture pixels match');
  pdf.resolve(new Uint8Array([2]));
  await until(() => h.view.overlays.get(1)?.revision === 3, 'the PDF-dependent overlay must flush after its base');
  h.delivery.dispose();
});

test('live fragments on a future page wait until that page exists in the displayed layout', async () => {
  const h = harness();
  await start(h);
  const pdf = deferred<Uint8Array | null>();
  h.pdfGates.set('page-growth.pdf', pdf);
  h.delivery.layout(layout(2, [page(2, 'new-page', false)], {
    pagesTotal: 2, placements: [...placements(), { par_id: 77, fragments: [fragment(2, 100)], lines: 1, kind: 'par' }],
    keepFromRevision: 2, pdfPath: 'page-growth.pdf',
  }));
  await until(() => h.reads.length > 0, 'page growth must be awaiting its PDF');
  h.delivery.paragraph({ ...paragraph(77, 3, 'future-page-unit'), fragments: [fragment(2, 100)] });
  await until(() => h.started.includes('future-page-unit'), 'future-page resources should prepare');
  await drain();
  assert.ok(!h.view.overlays.has(77));
  assert.equal(h.view.pagesTotal, 1);
  pdf.resolve(new Uint8Array([2]));
  await until(() => h.view.overlays.has(77), 'the live row must appear once its actual page is available');
  assert.equal(h.view.overlays.get(77)!.fragments[0].page, 2);
  assert.equal(h.view.pagesTotal, 2);
  h.delivery.dispose();
});

test('a newer compiled base never inherits an obsolete shown revision while its replacement loads', async () => {
  const h = harness();
  await start(h);
  h.delivery.paragraph(paragraph(1, 2, 'obsolete-shown-text'));
  await until(() => h.view.overlays.get(1)?.revision === 2, 'older text must first be displayed');
  const pdf = deferred<Uint8Array | null>();
  const font = deferred<boolean>();
  h.pdfGates.set('replacement-base.pdf', pdf);
  h.resourceGates.set('latest-held-text', font);
  h.delivery.layout(layout(2, [page(1, 'replacement-base', false, [200, 400])], {
    placements: placements(200, 400), keepFromRevision: 3, pdfPath: 'replacement-base.pdf',
  }));
  await until(() => h.reads.length > 0, 'compiled replacement base must be preparing');
  h.delivery.paragraph(paragraph(1, 4, 'latest-held-text', 200));
  await until(() => h.started.includes('latest-held-text'), 'newer revision resources must be in flight');
  pdf.resolve(new Uint8Array([2]));
  await until(() => marker(h.view.pages.get(1)!.dl) === 'replacement-base', 'new compiled base should become visible first');
  assert.ok(!h.view.overlays.has(1), 'keeping only the paragraph ID would repaint obsolete text over the fresh base');
  font.resolve(false);
  await until(() => h.view.overlays.get(1)?.revision === 4, 'the actual current revision appears when ready');
  assert.equal(marker(h.view.overlays.get(1)!.dl), 'latest-held-text');
  h.delivery.dispose();
});

test('dispose prevents any held operation from publishing resources, text, or errors', async () => {
  const h = harness();
  await start(h);
  const work = deferred<boolean>();
  h.resourceGates.set('disposed-text', work);
  h.delivery.paragraph(paragraph(1, 2, 'disposed-text'));
  await until(() => h.started.includes('disposed-text'), 'held preparation must start');
  h.delivery.dispose();
  const count = h.messages.length;
  work.reject(new Error('old disposed operation failed'));
  h.delivery.layout(layout(2, [page(1, 'ignored-after-dispose')]));
  h.delivery.paragraph(paragraph(1, 3, 'ignored-after-dispose'));
  await drain();
  assert.equal(h.messages.length, count);
  assert.equal(h.errors.length, 0);
});

test('real engine rows and link targets stay coherent through supersession and converged delivery', {
  skip: realEngineUnavailable,
  timeout: 120000,
}, async () => {
  const fixture = await realEngineFixture('structural-live.tex');
  const view = new PreviewModel();
  const messages: HostToWebview[] = [];
  const errors: unknown[] = [];
  const held = deferred<void>();
  let heldDl: DisplayList | undefined;
  let heldStarted = false;
  const delivery = new PreviewDelivery({
    prepare: async (dls) => {
      if (heldDl && dls.includes(heldDl)) { heldStarted = true; await held.promise; }
      return false;
    },
    readPdf: async () => null,
    post: (message) => {
      messages.push(message);
      if (message.type === 'layout') view.applyLayout(message);
      else if (message.type === 'paragraph') view.applyParagraph(message.parId, message.dl, message.fragments, message.revision);
      else if (message.type === 'dropOverlays') view.dropOverlays(message.parIds);
    },
    error: error => errors.push(error),
  });
  try {
    const initial = await fixture.start();
    delivery.layout({ pages: initial.pages_changed, pagesTotal: initial.pages_total, placements: initial.placements,
      keepFromRevision: null, layoutVersion: initial.versions.layout_version, pdfPath: 'fixture-initial.pdf' });
    await until(() => view.hasLayout, 'real initial display lists must pass through delivery');
    assert.equal(findDestination(view, 'name:equation.A.1')?.page, 2);
    const older = await fixture.editMarker('GRAYPROOF', 'X');
    heldDl = older.dl;
    delivery.paragraph({ parId: older.par_id, dl: older.dl, fragments: older.fragments, revision: older.versions.source_revision });
    await until(() => heldStarted, 'the older real update must be preparing');
    const newer = await fixture.editMarker('GRAYPROOF', 'Y');
    assert.equal(newer.par_id, older.par_id, 'the fixture must edit the same actual capture unit');
    delivery.paragraph({ parId: newer.par_id, dl: newer.dl, fragments: newer.fragments, revision: newer.versions.source_revision });
    await until(() => view.overlays.get(newer.par_id)?.revision === newer.versions.source_revision,
      'latest actual engine fragments must bypass the older preparation');
    assert.ok(glyphText(view.overlays.get(newer.par_id)!.dl).includes('GRAYPROOFY'));
    assert.ok(!messages.some(m => m.type === 'paragraph' && m.revision === older.versions.source_revision));
    held.resolve();
    await drain();
    assert.equal(view.overlays.get(newer.par_id)?.revision, newer.versions.source_revision);
    assert.ok(findDestination(view, 'name:equation.1.1')?.live, 'real live equation anchors must remain available');
    const latest = await fixture.layout(newer.versions.source_revision);
    const before = messages.filter(m => m.type === 'layout').length;
    delivery.layout({ pages: latest.pages_changed, pagesTotal: latest.pages_total, placements: latest.placements,
      keepFromRevision: null, layoutVersion: latest.versions.layout_version, pdfPath: 'fixture-latest.pdf' });
    await until(() => messages.filter(m => m.type === 'layout').length > before && view.overlays.size === 0,
      'the converged real base must absorb the newer overlay');
    assert.equal(findDestination(view, 'name:equation.A.1')?.page, 2);
    assert.equal(findDestination(view, 'name:equation.B.1')?.page, 3);
    assert.ok(!findDestination(view, 'name:equation.1.1')?.live);
    assert.deepEqual(errors, []);
  } finally {
    held.resolve();
    delivery.dispose();
    await fixture.close();
  }
});
