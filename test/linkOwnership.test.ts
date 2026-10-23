/// <reference lib="dom" />
/// <reference path="../webview/opentype.d.ts" />
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { DisplayList, Item, Line } from '../src/protocol';
import { findDestination, pageNavigation } from '../webview/links';
import { PreviewModel, type OverlayRow, type Rect } from '../webview/model';
import { FontStore, IDENTITY, ImageStore, Painter, type Mat } from '../webview/render';
import { realEngineFixture, realEngineUnavailable } from './realEngineFixture';

const U = 65536;
const row = (y: number, items: Item[]): Line => ({ x: 10 * U, y: y * U, w: 100 * U, h: 7 * U, d: 2 * U, items });
const display = (lines: Line[], other: Item[] = []): DisplayList => ({ kind: 'paragraph', fonts: {}, lines, other,
  flags: [], width: 0, height: 0, depth: 0 });
const transform = (op: string, x = 0, y = 0, data = ''): Item => ['M', op, x * U, y * U, data];
const metadata = (target: string, x: number, y: number, w = 10, h = 5): Item[] => [
  ['r', x * U, y * U, w * U, h * U],
  ['L', target, x * U, y * U, w * U, h * U],
  ['D', target, x * U, y * U],
];
function model(dl: DisplayList): PreviewModel {
  const m = new PreviewModel();
  m.applyLayout({ pages: [{ page: 1, hash: 1, exact: true, dl }], pagesTotal: 1,
    placements: [], keepFromRevision: null });
  return m;
}

/** Compare navigation to real Painter output, independent of its affine helper. */
function paintedRules(dl: DisplayList, rows?: OverlayRow[]): Rect[] {
  let matrix: Mat = IDENTITY;
  const rects: Rect[] = [];
  const context = {
    fillStyle: '',
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number) { matrix = [a, b, c, d, e, f]; },
    fillRect(x: number, y: number, w: number, h: number) {
      const points = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]
        .map(([px, py]) => [matrix[0] * px + matrix[2] * py + matrix[4], matrix[1] * px + matrix[3] * py + matrix[5]]);
      const left = Math.min(...points.map(p => p[0])), top = Math.min(...points.map(p => p[1]));
      rects.push({ x: left, y: top, w: Math.max(...points.map(p => p[0])) - left,
        h: Math.max(...points.map(p => p[1])) - top });
    },
  } as unknown as CanvasRenderingContext2D;
  const painter = new Painter(context, IDENTITY, {} as FontStore, {} as ImageStore);
  painter.draw(dl, dl.other);
  for (const r of rows ?? dl.lines.map(line => ({ line, dx: 0, dy: 0 }))) painter.draw(dl, r.line.items, r.dx, r.dy);
  return rects;
}

test('reference areas share Painter transforms across page items, nested states and rows', () => {
  const dl = display([
    row(100, [transform('save'), transform('set', 20, 100, '0 1 -1 0'), ...metadata('rotated', 30, 90)]),
    row(120, [...metadata('continued', 30, 110), transform('restore'), transform('restore'), ...metadata('plain', 50, 110)]),
  ], [transform('save'), transform('set', 0, 0, '2 0 0 2')]);
  const navigation = pageNavigation(model(dl), 1);
  assert.deepEqual(navigation.links.map(({ target: _, ...rect }) => rect), paintedRules(dl));
  assert.deepEqual(navigation.links[0], { target: 'rotated', x: 20 * U, y: 160 * U, w: 10 * U, h: 20 * U });
  assert.deepEqual(navigation.destinations.map(d => [d.target, d.x, d.y]), [
    ['rotated', 20 * U, 180 * U], ['continued', 60 * U, 180 * U], ['plain', 50 * U, 110 * U],
  ]);
});

test('live transformed references use their row translation for both ink and destination', () => {
  const m = model(display([row(100, [])]));
  m.applyLayout({ pages: [], pagesTotal: 1, keepFromRevision: null, placements: [{ par_id: 5, lines: 1, kind: 'par',
    fragments: [{ page: 1, first_line: 1, last_line: 1, x: 10 * U, xs: [10 * U], baselines: [100 * U], approximate: false }] }] });
  const dl = display([row(7, [transform('save'), transform('set', 10, 7, '2 0 0 2'),
    ...metadata('scaled', 20, 0, 15, 9), transform('restore')])]);
  m.applyParagraph(5, dl, [{ page: 1, first_line: 1, last_line: 1, x: 50 * U, xs: [50 * U],
    baselines: [200 * U], approximate: false }], 2);
  const navigation = pageNavigation(m, 1);
  assert.deepEqual(navigation.links.map(({ target: _, ...rect }) => rect), paintedRules(dl, m.overlaysOn(1)[0].rows));
  assert.deepEqual(navigation.links[0], { target: 'scaled', x: 70 * U, y: 186 * U, w: 30 * U, h: 18 * U });
  const target = findDestination(m, 'scaled')!;
  assert.deepEqual([target.x, target.y, target.live], [70 * U, 186 * U, true]);
  // Line metrics already include TeX's scaled box; transforming that box again would
  // enlarge its highlight twice and move untransformed neighbouring text with it.
  assert.deepEqual(target.rect, { x: 50 * U, y: 193 * U, w: 100 * U, h: 9 * U });
});

test('live masks are checked against the painted extent of transformed background links', () => {
  const m = model(display([row(100, [transform('save'), transform('set', 0, 100, '2 0 0 2'),
    ...metadata('covered', 20, 93, 15, 9), transform('restore')]), row(200, [])]));
  m.applyLayout({ pages: [], pagesTotal: 1, keepFromRevision: null, placements: [{ par_id: 5, lines: 1, kind: 'par',
    fragments: [{ page: 1, first_line: 1, last_line: 1, x: 10 * U, xs: [10 * U], baselines: [200 * U], approximate: false }] }] });
  m.applyParagraph(5, display([{ ...row(7, []), w: 10 * U }]), [{ page: 1, first_line: 1, last_line: 1,
    x: 55 * U, xs: [55 * U], baselines: [90 * U], approximate: false }], 2);
  assert.equal(pageNavigation(m, 1).links.length, 0, 'the cleared scaled glyphs must not leave an invisible hotspot');
  assert.ok(findDestination(m, 'covered'), 'masking ink does not remove destination metadata');
});

test('bundled engine graphicx links and target points follow their actual transformed geometry', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rtex-transform-links-'));
  const source = path.join(temporary, 'synthetic.tex');
  await fs.writeFile(source, String.raw`\documentclass{article}
\usepackage{graphicx,hyperref}
\begin{document}
\hypertarget{anchor}{DESTINATION}

\scalebox{2}{\hyperlink{anchor}{CLICKME}}

\rotatebox{45}{\hyperlink{anchor}{ROTATED}}

\scalebox{2}{LEFT\hypertarget{scaled}{SCALEDDEST}}

\hyperlink{scaled}{TO SCALED}
\end{document}
`);
  const fixtureRoot = path.resolve(__dirname, '..', '..', 'test', 'fixtures');
  const fixture = await realEngineFixture(path.relative(fixtureRoot, source));
  try {
    await fixture.start();
    const m = new PreviewModel();
    // A converged update may reuse pages supplied by its earlier converging pass.
    for (const event of fixture.events) if (event.event === 'LayoutUpdate') m.applyLayout({ pages: event.pages_changed,
      pagesTotal: event.pages_total, placements: event.placements, keepFromRevision: null });
    const page = m.pages.get(1)!;
    assert.ok(page.exact, 'graphicx transforms must exercise the native rendering path');
    const links = pageNavigation(m, 1).links;
    const rawLinks = page.dl.lines.flatMap(l => l.items).filter(i => i[0] === 'L');
    assert.equal(links.length, 3);
    assert.equal(links[0].w, Number(rawLinks[0][4]) * 2, 'scalebox doubles the actual clickable glyph width');
    assert.ok(links[1].h > Number(rawLinks[1][5]) * 3, 'the rotated hotspot covers the rotated reference');
    const raw = page.dl.lines.flatMap(l => l.items).find(i => i[0] === 'D' && i[1] === 'name:scaled')!;
    const target = findDestination(m, 'name:scaled')!;
    assert.ok(target.x > Number(raw[2]), 'the destination after LEFT moves under its enclosing scale');
  } finally {
    await fixture.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
