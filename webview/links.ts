// Internal PDF navigation from real TeX link actions and destinations. No reference-text
// matching and no PDF parsing on the live path. Coordinates follow the rows that are drawn.
import type { DisplayList, Item, Line } from '../src/protocol';
import { SP_PER_PT } from '../src/protocol';
import type { OverlayRow, PreviewModel, Rect } from './model';

export interface LinkRect extends Rect { target: string }
export interface Destination {
  target: string;
  x: number;
  y: number;
  rect: Rect;
  live: boolean;
}
export interface PageNavigation { links: LinkRect[]; destinations: Destination[] }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Rectangles cleared before live rows are drawn; also mask their obsolete background links. */
export function rowBands(rows: readonly OverlayRow[]): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  let prevBottom: number | undefined;
  let prevBase = -Infinity;
  for (const { line, dx, dy } of rows) {
    const base = line.y + dy;
    const ownTop = base - line.h - SP_PER_PT;
    const top = prevBottom !== undefined && base > prevBase && base - prevBase < 4 * (line.h + line.d + 2 * SP_PER_PT) ? Math.min(ownTop, prevBottom) : ownTop;
    const bottom = base + Math.max(line.d, 3 * SP_PER_PT);
    out.push([line.x + dx - SP_PER_PT, top, line.x + dx + line.w + SP_PER_PT, bottom]);
    prevBottom = bottom;
    prevBase = base;
  }
  return out;
}

function link(item: Item, dx: number, dy: number): LinkRect | undefined {
  const [, target, x, y, w, h] = item;
  return item[0] === 'L' && typeof target === 'string' && target.length > 0 &&
    finite(x) && finite(y) && finite(w) && finite(h) && w > 0 && h > 0
    ? { target, x: x + dx, y: y + dy, w, h } : undefined;
}

function point(item: Item): { target: string; x: number; y: number } | undefined {
  const [, target, x, y] = item;
  return item[0] === 'D' && typeof target === 'string' && target.length > 0 && finite(x) && finite(y)
    ? { target, x, y } : undefined;
}

function rowRect(line: Line, dx: number, dy: number): Rect {
  return { x: line.x + dx, y: line.y + dy - line.h, w: Math.max(line.w, 8 * SP_PER_PT), h: Math.max(line.h + line.d, 8 * SP_PER_PT) };
}

function nearestLine(dl: DisplayList, x: number, y: number): Line | undefined {
  let best: Line | undefined;
  let distance = Infinity;
  for (const line of dl.lines) {
    const vertical = Math.max(line.y - line.h - y, y - line.y - line.d, 0);
    const horizontal = Math.max(line.x - x, x - line.x - line.w, 0);
    const score = vertical + horizontal / 100;
    if (score < distance) { best = line; distance = score; }
  }
  return best;
}

function destination(item: Item, owner: Line | undefined, dx: number, dy: number, live: boolean): Destination | undefined {
  const p = point(item);
  if (!p) return undefined;
  return { target: p.target, x: p.x + dx, y: p.y + dy, live,
    rect: owner ? rowRect(owner, dx, dy) : { x: p.x + dx, y: p.y + dy, w: 120 * SP_PER_PT, h: 12 * SP_PER_PT } };
}

function intersects(r: Rect, b: readonly number[]): boolean {
  return r.x < b[2] && r.x + r.w > b[0] && r.y < b[3] && r.y + r.h > b[1];
}

export function pageNavigation(model: PreviewModel, page: number): PageNavigation {
  const out: PageNavigation = { links: [], destinations: [] };
  const pu = model.pages.get(page);
  if (!pu) return out;
  const hidden = model.hiddenLines(page);
  const overlays = model.overlaysOn(page);
  const masks = overlays.flatMap(({ rows }) => rowBands(rows));
  const append = (items: readonly Item[], owner: Line | undefined, dx: number, dy: number, live: boolean) => {
    for (const item of items) {
      if (item[0] === 'L') {
        const r = link(item, dx, dy);
        if (r && (live || !masks.some(b => intersects(r, b)))) out.links.push(r);
      } else if (item[0] === 'D') {
        const d = destination(item, owner, dx, dy, live);
        if (d && (live || !masks.some(b => intersects(d.rect, b)))) out.destinations.push(d);
      }
    }
  };
  pu.dl.lines.forEach((line, i) => { if (!hidden.has(i)) append(line.items, line, 0, 0, false); });
  for (const item of pu.dl.other ?? []) {
    const p = point(item);
    const owner = p && nearestLine(pu.dl, p.x, p.y);
    // Page-level anchors far above the first row stay attached to the page. Anchors beside a
    // replaced row belong to the replacement and must not retain the old layout position.
    const near = owner && p && Math.abs(owner.y - p.y) < 32 * SP_PER_PT;
    if (near && hidden.has(pu.dl.lines.indexOf(owner))) continue;
    append([item], near ? owner : undefined, 0, 0, false);
  }
  for (const { overlay, rows } of overlays) {
    const placed = new Map(rows.map(row => [row.line, row]));
    for (const row of rows) append(row.line.items, row.line, row.dx, row.dy, true);
    // Destinations immediately before a heading/equation can be outside its tagged row.
    // Attach such metadata to its nearest row, then use that row's current page translation.
    for (const item of overlay.dl.other ?? []) {
      if (item[0] !== 'D' && item[0] !== 'L') continue;
      const p = point(item) ?? link(item, 0, 0);
      const owner = p && nearestLine(overlay.dl, p.x, p.y);
      const row = owner && placed.get(owner);
      if (row) append([item], owner, row.dx, row.dy, true);
    }
  }
  return out;
}

export function findDestination(model: PreviewModel, target: string): (Destination & { page: number }) | undefined {
  let background: (Destination & { page: number }) | undefined;
  for (let page = 1; page <= model.pagesTotal; page++) {
    for (const d of pageNavigation(model, page).destinations) {
      if (d.target !== target) continue;
      if (d.live) return { ...d, page };
      background ??= { ...d, page };
    }
  }
  return background;
}
