import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DisplayList, Fragment, Item, Line, PageUpdate } from '../src/protocol';
import { findDestination, pageNavigation } from '../webview/links';
import { PreviewModel } from '../webview/model';

const U = 65536;
const line = (y: number, items: Item[] = []): Line => ({ x: 10 * U, y: y * U, w: 100 * U, h: 7 * U, d: 2 * U, items });
const dl = (lines: Line[], other: Item[] = []): DisplayList => ({ kind: 'paragraph', fonts: {}, lines, other, flags: [], width: 0, height: 0, depth: 0 });
const page = (n: number, lines: Line[], other: Item[] = []): PageUpdate => ({ page: n, hash: n, exact: true, dl: dl(lines, other) });
const hit = (target: string, x: number, y: number): Item => ['L', target, x * U, (y - 7) * U, 15 * U, 9 * U];
const dest = (target: string, x: number, y: number): Item => ['D', target, x * U, y * U];
const frag = (page: number, ys: number[], first = 1): Fragment => ({ page, first_line: first, last_line: first + ys.length - 1,
  x: 10 * U, xs: ys.map(() => 10 * U), baselines: ys.map(y => y * U), approximate: false });
const model = (pages: PageUpdate[]) => {
  const m = new PreviewModel();
  m.applyLayout({ pages, pagesTotal: pages.length, placements: [], keepFromRevision: null });
  return m;
};

test('internal references follow explicit PDF destination IDs rather than printed numbers', () => {
  const m = model([
    page(1, [line(100, [hit('name:equation.A.1', 30, 100), hit('name:equation.B.1', 60, 100)])]),
    page(2, [line(200, [dest('name:equation.A.1', 100, 200)])]),
    page(3, [line(300, [dest('name:equation.B.1', 100, 300)])]),
  ]);
  assert.equal(pageNavigation(m, 1).links.length, 2);
  assert.equal(findDestination(m, 'name:equation.A.1')?.page, 2);
  assert.equal(findDestination(m, 'name:equation.B.1')?.page, 3);
  assert.equal(findDestination(m, 'name:equation.1'), undefined);
});

test('wrapped and paginated links retain separate tight row rectangles', () => {
  const m = model([
    page(1, [line(100, [hit('name:target', 30, 100)]), line(112, [hit('name:target', 10, 112)])]),
    page(2, [line(100, [hit('name:target', 10, 100)]), line(200, [dest('name:target', 10, 200)])]),
  ]);
  const links = pageNavigation(m, 1).links;
  assert.equal(links.length, 2);
  assert.ok(links.every(r => r.h === 9 * U));
  assert.ok(links[0].y + links[0].h < links[1].y);
  assert.equal(pageNavigation(m, 2).links.length, 1);
});

test('live links and targets move with their own fragment rows and replace old hotspots', () => {
  const m = model([
    page(1, [line(100, [hit('name:target', 30, 100), dest('name:target', 10, 100)])]),
    page(2, [line(400)]),
  ]);
  m.applyLayout({ pages: [], pagesTotal: 2, placements: [{ par_id: 5, fragments: [frag(1, [100])], lines: 1, kind: 'par' }], keepFromRevision: null });
  const live = dl([line(7, [hit('name:target', 30, 7), dest('name:target', 10, 7)]), line(19, [hit('name:target', 10, 19)])]);
  m.applyParagraph(5, live, [frag(2, [200, 212])], 4);
  assert.equal(pageNavigation(m, 1).links.length, 0);
  assert.equal(pageNavigation(m, 1).destinations.length, 0);
  assert.equal(pageNavigation(m, 2).links.length, 2);
  const target = findDestination(m, 'name:target')!;
  assert.deepEqual([target.page, target.y, target.live], [2, 200 * U, true]);
  assert.equal(pageNavigation(m, 2).links[0].y, 193 * U);
  m.dropOverlays([5]);
  assert.equal(pageNavigation(m, 2).links.length, 0);
  assert.deepEqual([findDestination(m, 'name:target')?.page, findDestination(m, 'name:target')?.live], [1, false]);
});

test('destinations outside tagged rows follow current live placement and latest layout', () => {
  const m = model([page(1, [line(100)], [dest('name:section.1', 10, 90)]), page(2, [line(300)])]);
  m.applyLayout({ pages: [], pagesTotal: 2, placements: [{ par_id: 7, fragments: [frag(1, [100])], lines: 1, kind: 'heading' }], keepFromRevision: null });
  m.applyParagraph(7, dl([line(10)], [dest('name:section.1', 10, 0)]), [frag(2, [200])], 5);
  assert.deepEqual([findDestination(m, 'name:section.1')?.page, findDestination(m, 'name:section.1')?.y], [2, 190 * U]);
  m.applyLayout({ pages: [], pagesTotal: 2, placements: [{ par_id: 7, fragments: [frag(2, [400])], lines: 1, kind: 'heading' }], keepFromRevision: 5 });
  assert.deepEqual([findDestination(m, 'name:section.1')?.page, findDestination(m, 'name:section.1')?.y], [2, 390 * U]);
  m.applyLayout({ pages: [page(2, [line(500)], [dest('name:section.1', 10, 490)])], pagesTotal: 2, placements: [], keepFromRevision: null });
  assert.equal(m.overlays.size, 0);
  // A real page replacement also removes the old destination from its previous page.
  m.applyLayout({ pages: [page(1, [line(100)])], pagesTotal: 2, placements: [], keepFromRevision: null });
  assert.deepEqual([findDestination(m, 'name:section.1')?.page, findDestination(m, 'name:section.1')?.y], [2, 490 * U]);
});

test('live row masks remove hotspots belonging to background ink they clear', () => {
  const m = model([page(1, [line(100), line(112, [hit('name:obscured', 30, 112)]), line(160, [hit('name:visible', 30, 160)])])]);
  m.applyLayout({ pages: [], pagesTotal: 1, placements: [{ par_id: 5, fragments: [frag(1, [100])], lines: 1, kind: 'par' }], keepFromRevision: null });
  m.applyParagraph(5, dl([line(7), line(19)]), [frag(1, [100, 112])], 2);
  assert.deepEqual(pageNavigation(m, 1).links.map(r => r.target), ['name:visible']);
});

test('malformed metadata cannot create oversized or non-finite hit targets', () => {
  const m = model([page(1, [line(100, [['L', 'name:bad', 0, 0, -1, 10], ['L', 'name:bad', 0, Infinity, 10, 10], ['D', 'name:bad', NaN, 0]])])]);
  assert.deepEqual(pageNavigation(m, 1), { links: [], destinations: [] });
});
