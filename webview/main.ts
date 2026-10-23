// The live preview webview: toolbar, guided state screens, lazily rendered pages.
import type { Action, HostToWebview, PillKind, ScreenKind, WebviewToHost } from '../src/messages';
import { FollowCursorMode, isFollowCursorMode } from '../src/followCursor';
import { SP_PER_BP } from '../src/protocol';
import { usedResources } from '../src/resourceUsage';
import { cachedPictureMoves, PreviewModel, Rect } from './model';
import { findDestination, pageNavigation, rowBands } from './links';
import { navigationKey, NavigationDirection, parsePageNumber, ReadingHistory, ReadingPosition } from './navigation';
import { pageBox, pageGeometryKey } from './pageBox';
import { initPdfWorker, openPdf, PdfDoc, rasterizePdfImage, renderPdfPage } from './pdf';
import { FontStore, ImageStore, inexactReason, Mat, Painter } from './render';
import { BoundedRasterCache } from './rasterCache';
import type { OutlineEntry, OutlineViewState } from '../src/outline';
import { OutlineSidebar } from './outline';

interface VsCodeApi {
  postMessage(m: WebviewToHost): void;
  getState(): SavedState | undefined;
  setState(s: SavedState): void;
}
interface SavedState {
  zoom: string;
  outline?: { documentId: string; state: OutlineViewState };
}
interface Boot {
  workerUrl: string;
  zoom: string;
  follow: FollowCursorMode;
  invert: boolean;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const boot: Boot = JSON.parse(document.getElementById('rtex-boot')!.textContent!);
void initPdfWorker(boot.workerUrl);

const model = new PreviewModel();
const readingHistory = new ReadingHistory();
const fonts = new FontStore();
const images = new ImageStore(rasterizePdfImage);
let pdfDoc: PdfDoc | undefined;
let pdfPages = 0;
/** Opening the latest layout PDF. A rejected open resolves after logging so pages can fall back. */
let pdfOpening: Promise<void> | undefined;
/** Serial of the loaded PDF, and per page the serial of the PDF that matches its current
 * display list (Infinity: no PDF came with the layout that last changed the page). */
let pdfSerialLoaded = 0;
const pagePdfSerial = new Map<number, number>();
let documentId: string | undefined;
let outlineEntries: OutlineEntry[] = [];
let outlineSidebar: OutlineSidebar | undefined;
const outlineStates = new Map<string, OutlineViewState>();
let outlinePositions = new Map<string, { page: number; y: number }>();
let outlineRefreshNeeded = false;
let outlineTimer: ReturnType<typeof setTimeout> | undefined;
let outlineUnavailable: string | undefined;

// ---------------------------------------------------------------------------------------------
// DOM

const ICONS = {
  refresh:
    '<svg viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M12.6 1.5v3.4H9.2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  export:
    '<svg viewBox="0 0 16 16"><path d="M8 1.5v8.5M4.5 6.8 8 10.3l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 11v3h11v-3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  minus: '<svg viewBox="0 0 16 16"><path d="M3 8h10" stroke="currentColor" stroke-width="1.5"/></svg>',
  plus: '<svg viewBox="0 0 16 16"><path d="M3 8h10M8 3v10" stroke="currentColor" stroke-width="1.5"/></svg>',
  fit: '<svg viewBox="0 0 16 16"><path d="M1.5 8h13M4 5.5 1.5 8 4 10.5M12 5.5 14.5 8 12 10.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  follow:
    '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.8" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5"/></svg>',
  back: '<svg viewBox="0 0 16 16"><path d="M13 8H3m4-4L3 8l4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  forward: '<svg viewBox="0 0 16 16"><path d="M3 8h10m-4-4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  more: '<svg viewBox="0 0 16 16"><g fill="currentColor"><circle cx="3" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="13" cy="8" r="1.3"/></g></svg>',
  outline: '<svg viewBox="0 0 16 16"><path d="M1.5 2.5h13v11h-13zM5.5 2.5v11M8 5h4M8 8h4M8 11h3" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
};

document.body.innerHTML = `
<header class="toolbar" role="toolbar" aria-label="Preview toolbar">
  <button id="outlineToggle" class="icon" title="Document outline" aria-label="Document outline" aria-controls="outlineSidebar" aria-expanded="false">${ICONS.outline}</button>
  <button id="pill" class="pill idle" title="" hidden><span class="pill-text"></span></button>
  <div class="reading-controls group" role="group" aria-label="Reading navigation">
    <button id="navBack" class="icon" title="Go back in preview (Cmd+[)" aria-label="Go back in preview" disabled>${ICONS.back}</button>
    <button id="navForward" class="icon" title="Go forward in preview (Cmd+])" aria-label="Go forward in preview" disabled>${ICONS.forward}</button>
    <button id="pageNo" class="page-no" title="Go to page" aria-label="Go to page" aria-controls="pageJump" aria-expanded="false"></button>
    <form id="pageJump" class="page-jump" aria-label="Go to page" hidden>
      <input id="pageInput" type="text" inputmode="numeric" autocomplete="off" aria-label="Page number">
      <span id="pageTotal"></span><button type="submit">Go</button>
    </form>
  </div>
  <span class="spacer"></span>
  <div class="group zoom-controls" role="group" aria-label="Zoom">
    <button id="zoomOut" class="icon" title="Zoom out (Ctrl+−)" aria-label="Zoom out">${ICONS.minus}</button>
    <button id="zoomLabel" class="zoom-label" title="Reset zoom to 100 % (Ctrl+0)">100 %</button>
    <button id="zoomIn" class="icon" title="Zoom in (Ctrl+=)" aria-label="Zoom in">${ICONS.plus}</button>
    <button id="fit" class="labeled" title="Fit the page width to the panel">${ICONS.fit}<span>Fit width</span></button>
  </div>
  <label id="followControl" class="follow-control" title="Source to preview: double-click">
    ${ICONS.follow}<span class="caret" aria-hidden="true">▾</span>
    <select id="follow" aria-label="Source to preview">
      <option value="singleClick">Single click</option>
      <option value="doubleClick">Double click</option>
      <option value="off">Off</option>
    </select>
  </label>
  <button id="recompile" class="icon" title="Recompile the whole document (references and page layout)" aria-label="Recompile whole document">${ICONS.refresh}</button>
  <button id="export" class="labeled primary" title="Export a PDF of the document (Cmd+Alt+E)">${ICONS.export}<span>Export PDF</span></button>
  <div class="menu-control">
    <button id="more" class="icon" title="More preview actions" aria-label="More preview actions" aria-haspopup="menu" aria-controls="moreMenu" aria-expanded="false">${ICONS.more}</button>
    <div id="moreMenu" class="toolbar-menu" role="menu" aria-label="More preview actions" hidden>
      <button type="button" role="menuitem" data-command="realtimeTex.restart">Restart engine</button>
      <button type="button" role="menuitem" data-command="realtimeTex.openLatexLog">Open LaTeX log</button>
      <button type="button" role="menuitem" data-command="realtimeTex.selectMainFile">Choose main file…</button>
    </div>
  </div>
</header>
<button id="outlineBackdrop" class="outline-backdrop" tabindex="-1" aria-label="Close document outline" hidden></button>
<aside id="outlineSidebar" class="outline-sidebar" aria-label="Document outline" hidden>
  <div class="outline-heading"><h2>Contents</h2><button id="outlineClose" class="icon" title="Close document outline" aria-label="Close document outline">${ICONS.close}</button></div>
  <p id="outlineEmpty" class="outline-empty" role="status">Contents will appear after a full compile.</p>
  <div id="outlineTree" class="outline-tree" role="tree" aria-label="Document outline"></div>
  <div id="outlineResize" class="outline-resize" role="separator" aria-label="Resize document outline" aria-orientation="vertical" tabindex="0"></div>
</aside>
<div id="banner" class="banner" hidden><span class="text"></span><span class="actions"></span><button class="icon close" title="Dismiss" aria-label="Dismiss">${ICONS.close}</button></div>
<main id="viewport" tabindex="0" aria-label="Document pages"><div id="pages"></div></main>
<section id="screen" class="screen" hidden>
  <div class="card">
    <div class="spinner" aria-hidden="true"></div>
    <h2 class="title"></h2>
    <p class="message"></p>
    <pre class="detail" hidden></pre>
    <div class="actions"></div>
  </div>
</section>
<div id="toast" class="toast" hidden role="status"></div>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const viewport = $<HTMLElement>('viewport');
const pagesEl = $<HTMLElement>('pages');
const pill = $<HTMLButtonElement>('pill');
const pageNo = $<HTMLButtonElement>('pageNo');
const navBack = $<HTMLButtonElement>('navBack');
const navForward = $<HTMLButtonElement>('navForward');
const pageJump = $<HTMLFormElement>('pageJump');
const pageInput = $<HTMLInputElement>('pageInput');
const pageTotal = $('pageTotal');
const moreButton = $<HTMLButtonElement>('more');
const moreMenu = $('moreMenu');
const zoomLabel = $<HTMLButtonElement>('zoomLabel');
const followSelect = $<HTMLSelectElement>('follow');
const screen = $<HTMLElement>('screen');
const banner = $<HTMLElement>('banner');
const toast = $<HTMLElement>('toast');

// Toolbar: drop button labels, then secondary items, when the panel is too narrow for one row
const toolbar = document.querySelector<HTMLElement>('.toolbar')!;
let toolbarFrame: number | undefined;

/** Controls in one flex row share a vertical band, even at a larger UI font size. */
function toolbarIsOneRow(): boolean {
  const rects = [...toolbar.children]
    .filter((child) => !child.classList.contains('spacer'))
    .map((child) => child.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  return rects.length < 2 || Math.max(...rects.map((r) => r.top)) + 0.5 < Math.min(...rects.map((r) => r.bottom));
}

function fitToolbar(): void {
  if (toolbarFrame !== undefined) return;
  toolbarFrame = requestAnimationFrame(() => {
    toolbarFrame = undefined;
    toolbar.classList.remove('compact', 'tiny');
    if (!toolbarIsOneRow()) toolbar.classList.add('compact');
    if (!toolbarIsOneRow()) toolbar.classList.add('tiny');
    const height = `${toolbar.offsetHeight}px`;
    const style = document.documentElement.style;
    if (style.getPropertyValue('--toolbar-h') !== height) style.setProperty('--toolbar-h', height);
  });
}
// Defer mutations out of ResizeObserver delivery, and measure at most once per frame.
const toolbarObserver = new ResizeObserver(fitToolbar);
toolbarObserver.observe(toolbar);
for (const child of toolbar.children) if (!child.classList.contains('spacer')) toolbarObserver.observe(child);
// Hidden labels and status text may change without resizing the header itself.
new MutationObserver(fitToolbar).observe(toolbar, {
  childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden'],
});
window.addEventListener('resize', fitToolbar);
fitToolbar();

function setToolbarText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

const post = (m: WebviewToHost) => vscode.postMessage(m);
const runCommand = (command: string, args?: unknown[]) => post({ type: 'command', command, args });

// ---------------------------------------------------------------------------------------------
// Zoom and geometry

const saved = vscode.getState();
let zoom: string = saved?.zoom ?? boot.zoom; // 'fitWidth' or a percentage
const ZOOM_STEPS = [25, 33, 50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400];
const PAGE_GAP = 16;
const PX_PER_BP = 96 / 72;

function maxPageWidth(): number {
  let w = 0;
  for (const p of model.pages.values()) w = Math.max(w, p.dl.page_width ?? 0);
  return w || 597.5 * SP_PER_BP; // A4
}

/** CSS px per sp. */
function cssScale(): number {
  if (zoom === 'fitWidth') {
    const avail = Math.max(120, viewport.clientWidth - 2 * PAGE_GAP);
    return avail / maxPageWidth();
  }
  return ((Number(zoom) || 100) / 100) * (PX_PER_BP / SP_PER_BP);
}

function zoomPercent(): number {
  return Math.round((cssScale() * SP_PER_BP * 100) / PX_PER_BP);
}

function setZoom(z: string): void {
  const anchor = scrollAnchor();
  zoom = z;
  saveState();
  layoutPages();
  restoreAnchor(anchor);
}

function saveState(): void {
  const state = documentId && outlineSidebar ? { documentId, state: outlineSidebar.getState() } : undefined;
  vscode.setState({ zoom, outline: state });
}

function saveOutlineState(state: OutlineViewState): void {
  if (!documentId) return;
  outlineStates.set(documentId, state);
  // Keep a bounded local cache while the host persists these preferences per document.
  if (outlineStates.size > 20) outlineStates.delete(outlineStates.keys().next().value!);
  vscode.setState({ zoom, outline: { documentId, state } });
  post({ type: 'outlineState', documentId, state });
}

/** Scan navigation once per visible outline update, never once per row or heading. */
function scheduleOutlineRefresh(): void {
  outlineRefreshNeeded = true;
  if (!outlineSidebar?.getState().open || outlineTimer !== undefined) return;
  // Background webviews can suspend animation frames while navigation still runs.
  outlineTimer = setTimeout(() => {
    outlineTimer = undefined;
    if (!outlineRefreshNeeded || !outlineSidebar?.getState().open) return;
    outlineRefreshNeeded = false;
    const targets = new Set(outlineEntries.map(entry => entry.target));
    const positions = new Map<string, { page: number; y: number; live: boolean }>();
    for (const page of targets.size ? model.pages.keys() : []) {
      for (const destination of pageNavigation(model, page).destinations) {
        if (!targets.has(destination.target)) continue;
        const previous = positions.get(destination.target);
        if (!previous || (!previous.live && destination.live)) positions.set(destination.target,
          { page, y: destination.y, live: destination.live });
      }
    }
    outlinePositions = positions;
    outlineSidebar.updateEntries(outlineEntries.map(entry => ({ ...entry, page: positions.get(entry.target)?.page })), outlineUnavailable);
    updateOutlineActive();
  }, 16);
}

function updateOutlineActive(): void {
  if (!outlineSidebar?.getState().open) return;
  // At the end of the document scrolling is clamped, so the final heading may
  // remain below reveal()'s usual reading band even after a successful jump.
  const atEnd = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2;
  const line = viewport.scrollTop + viewport.clientHeight * (atEnd ? 1 : 0.35) + 2;
  const scale = cssScale();
  const pages = pageEls();
  let active: string | undefined;
  for (const entry of outlineEntries) {
    const position = outlinePositions.get(entry.target);
    const page = position && pages[position.page - 1];
    if (position && page && page.offsetTop + position.y * scale <= line) active = entry.id;
  }
  outlineSidebar.setActive(active);
}

function stepZoom(dir: 1 | -1): void {
  const cur = zoomPercent();
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > cur + 0.5) : [...ZOOM_STEPS].reverse().find((s) => s < cur - 0.5);
  setZoom(String(next ?? (dir > 0 ? ZOOM_STEPS[ZOOM_STEPS.length - 1] : ZOOM_STEPS[0])));
}

function scrollAnchor(): { page: number; frac: number } {
  const els = pageEls();
  const top = viewport.scrollTop;
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    if (el.offsetTop + el.offsetHeight > top) return { page: i, frac: (top - el.offsetTop) / Math.max(1, el.offsetHeight) };
  }
  return { page: 0, frac: 0 };
}

function restoreAnchor(a: { page: number; frac: number }): void {
  const el = pageEls()[a.page];
  if (el) viewport.scrollTop = el.offsetTop + a.frac * el.offsetHeight;
}

// ---------------------------------------------------------------------------------------------
// Pages

const dirty = new Set<number>();
const visible = new Set<number>();
const renderToken = new Map<number, number>();
const pageGeometry = new Map<number, string>();
const pageResources = new Map<number, number>();
// Cache pixels at their original device resolution. Never resize a cached bitmap to fit.
const backgrounds = new BoundedRasterCache<HTMLCanvasElement>();
const objectIds = new WeakMap<object, number>();
let nextObjectId = 0;
let documentGeneration = 0;
let spareCanvas: HTMLCanvasElement | undefined;
let renderScheduled = false;

function objectId(value: object): number {
  let id = objectIds.get(value);
  if (id === undefined) objectIds.set(value, (id = ++nextObjectId));
  return id;
}

function takeCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = spareCanvas ?? document.createElement('canvas');
  spareCanvas = undefined;
  // Reset drawing state without reallocating an identically sized backing buffer.
  const context = canvas.getContext('2d')!;
  if (canvas.width === w && canvas.height === h && typeof context.reset === 'function') context.reset();
  else { canvas.width = w; canvas.height = h; }
  return canvas;
}

function releaseCanvas(canvas: HTMLCanvasElement): void {
  if (spareCanvas) { spareCanvas.width = 0; spareCanvas.height = 0; }
  // One spare buffer, bounded independently of the background cache.
  if (canvas.width * canvas.height * 4 <= 32 * 1024 * 1024) spareCanvas = canvas;
  else { canvas.width = 0; canvas.height = 0; spareCanvas = undefined; }
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const n = Number((e.target as HTMLElement).dataset.page);
      if (pagesEl.children[n - 1] !== e.target) continue;
      if (e.isIntersecting) visible.add(n);
      else {
        visible.delete(n);
        invalidatePage(n);
        // Keep layout and links, but release pixels outside the preload area.
        const canvas = e.target.querySelector('canvas')!;
        canvas.width = canvas.height = 0;
      }
    }
    scheduleRender();
    updatePageNo();
  },
  { root: viewport, rootMargin: '100% 0px' },
);

function pageEls(): HTMLElement[] {
  return Array.from(pagesEl.children) as HTMLElement[];
}

function pageSizeSp(n: number): [number, number] {
  const p = model.pages.get(n) ?? model.pages.get(1) ?? [...model.pages.values()][0];
  return [p?.dl.page_width ?? 597.5 * SP_PER_BP, p?.dl.page_height ?? 845 * SP_PER_BP];
}

/** Create/remove page elements to match the model and size them for the current zoom. */
function layoutPages(): void {
  const els = pageEls();
  for (let i = els.length; i < model.pagesTotal; i++) {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.page = String(i + 1);
    el.innerHTML = '<canvas></canvas><span class="badge" hidden></span>';
    el.title = '';
    pagesEl.appendChild(el);
    observer.observe(el);
  }
  for (let i = els.length - 1; i >= model.pagesTotal; i--) {
    observer.unobserve(els[i]);
    els[i].remove();
    visible.delete(i + 1);
    dirty.delete(i + 1);
    renderToken.set(i + 1, (renderToken.get(i + 1) ?? 0) + 1);
    pageGeometry.delete(i + 1);
    pageResources.delete(i + 1);
  }
  const k = cssScale();
  const dpr = window.devicePixelRatio || 1;
  pageEls().forEach((el, i) => {
    const [w, h] = pageSizeSp(i + 1);
    const box = pageBox(w, h, k, dpr);
    // compared by value: the browser normalizes fractional style strings
    const geometry = pageGeometryKey(box, k, dpr);
    if (pageGeometry.get(i + 1) !== geometry) {
      el.style.width = `${box.cssWidth}px`;
      el.style.height = `${box.cssHeight}px`;
      pageGeometry.set(i + 1, geometry);
      invalidatePage(i + 1);
    }
  });
  setToolbarText(zoomLabel, zoom === 'fitWidth' ? `${zoomPercent()} %` : `${zoom} %`);
  $<HTMLButtonElement>('fit').classList.toggle('active', zoom === 'fitWidth');
  scheduleRender();
}

function markDirty(pages: Iterable<number>): void {
  for (const n of pages) invalidatePage(n);
  scheduleRender();
}

function invalidatePage(n: number): void {
  dirty.add(n);
  // Cancel a PDF-backed render as soon as newer rows arrive, before the next animation frame
  // starts its replacement. Otherwise an older canvas could briefly acquire newer hotspots.
  renderToken.set(n, (renderToken.get(n) ?? 0) + 1);
}

function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    for (const n of [...dirty]) {
      if (!visible.has(n)) continue;
      dirty.delete(n);
      void renderPage(n);
    }
  });
}

async function renderPage(n: number): Promise<void> {
  const el = pageEls()[n - 1];
  const pu = model.pages.get(n);
  if (!el || !pu) return;
  const token = (renderToken.get(n) ?? 0) + 1;
  const generation = documentGeneration;
  renderToken.set(n, token);
  const k = cssScale();
  const dpr = window.devicePixelRatio || 1;
  const [wSp, hSp] = pageSizeSp(n);
  const box = pageBox(wSp, hSp, k, dpr);
  const w = box.pixelWidth;
  const h = box.pixelHeight;
  const base: Mat = [k * dpr, 0, 0, k * dpr, 0, 0];
  const paintOptions = { nativeText: true };

  const hidden = model.hiddenLines(n);
  const lines = pu.dl.lines.filter((_, i) => !hidden.has(i));
  const overlays = model.overlaysOn(n);
  const requiredFonts = new Set(usedResources({ ...pu.dl, lines }).fonts.keys());
  for (const { overlay } of overlays) for (const key of usedResources(overlay.dl).fonts.keys()) requiredFonts.add(key);
  if (fonts.hasPending(requiredFonts)) {
    // Only this page's fonts gate its first correct frame. Keep the previous canvas
    // while loading; unrelated or obsolete font work must not delay new live ink.
    await fonts.whenReady(requiredFonts);
    if (generation !== documentGeneration || renderToken.get(n) !== token) return;
  }
  const reason = pu.exact ? inexactReason(pu.dl, fonts, images, lines) : 'contains material the live renderer cannot draw (e.g. TikZ)';
  const requiredPdf = pagePdfSerial.get(n) ?? 0;
  if (reason !== undefined && pdfSerialLoaded < requiredPdf && Number.isFinite(requiredPdf) && pdfOpening) {
    // Keep the previous pixels and their hotspots together until this layout's PDF is ready.
    // A PDF from an older layout can put entirely different ink under the new link regions.
    await pdfOpening;
    if (generation !== documentGeneration || renderToken.get(n) !== token) return;
  }
  const usePdf = reason !== undefined && pdfDoc !== undefined && n <= pdfPages && pdfSerialLoaded >= requiredPdf;
  const doc = pdfDoc;
  const drawDisplayList = (ctx: CanvasRenderingContext2D) => {
    const p = new Painter(ctx, base, fonts, images, paintOptions);
    p.draw(pu.dl, pu.dl.other ?? []);
    for (const line of lines) p.draw(pu.dl, line.items);
  };
  let pdfFailed = false;
  // Native pages omit the hidden rows exactly as before. Clearing them from a full-page
  // bitmap instead could erase ink from a neighbouring row, so include membership in the key.
  const nativeKey = `native:${objectId(pu)}:${w}:${h}:${k * dpr}:${pageResources.get(n) ?? 0}:${[...hidden].sort((a, b) => a - b).join(',')}`;
  const nativeBackground = () => backgrounds.getOrCreate(nativeKey, w * h * 4, async () => {
    const image = document.createElement('canvas');
    image.width = w; image.height = h;
    const context = image.getContext('2d')!;
    context.fillStyle = '#fff'; context.fillRect(0, 0, w, h);
    drawDisplayList(context);
    return image;
  });
  let background: HTMLCanvasElement;
  if (usePdf && doc) {
    try {
      background = await backgrounds.getOrCreate(`pdf:${objectId(doc)}:${n}:${w}:${h}`, w * h * 4, async () => {
        const image = document.createElement('canvas');
        image.width = w; image.height = h;
        const context = image.getContext('2d')!;
        context.fillStyle = '#fff'; context.fillRect(0, 0, w, h);
        await renderPdfPage(doc, n, context, w, h);
        return image;
      });
    } catch (e) {
      if (generation !== documentGeneration || renderToken.get(n) !== token) return;
      pdfFailed = true;
      post({ type: 'log', message: `pdf page ${n}: ${String(e)}` });
      background = await nativeBackground();
    }
  } else background = await nativeBackground();
  if (generation !== documentGeneration || renderToken.get(n) !== token) return;
  // A cheap 1:1 pixel copy replaces re-drawing every unchanged glyph. Compose off-screen,
  // then swap, so live text and link regions always become visible together.
  const canvas = takeCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(background, 0, 0);
  // cached TikZ pictures inside live units: their pixels as the page shows them, taken before
  // anything is cleared and put back where the live rows place them. Only from the PDF of this
  // page's current layout: an older PDF has other content at the picture's rectangle.
  let pictureSnaps: { img: ImageData; dst: Rect }[] = [];
  if (usePdf && !pdfFailed) {
    if (pdfSerialLoaded >= (pagePdfSerial.get(n) ?? 0)) {
      pictureSnaps = overlays.flatMap(({ overlay, rows }) =>
        cachedPictureMoves(pu.dl, rows, model.ownLines(n, overlay.parId)).flatMap(({ src, dst }) => {
          const img = grabRect(ctx, base, src);
          return img ? [{ img, dst }] : [];
        }),
      );
    }
    new Painter(ctx, base, fonts, images).clearLines(
      pu.dl.lines.filter((_, i) => hidden.has(i)).map((line) => ({ line, dx: 0, dy: 0 })),
      '#fff',
    );
  }
  // live units: clear the bands their rows occupy now (they may reach into following material
  // until the next layout), put their cached pictures back, then draw their rows, so a picture
  // never covers live text and no clear erases a picture already placed
  const painters = overlays.map(() => new Painter(ctx, base, fonts, images, paintOptions));
  overlays.forEach(({ rows }, i) => painters[i].clearRects(rowBands(rows), '#fff'));
  for (const { img, dst } of pictureSnaps) putRect(ctx, base, img, dst);
  overlays.forEach(({ overlay, rows }, i) => {
    painters[i].draw(overlay.dl, overlay.dl.other ?? []);
    for (const r of rows) painters[i].draw(overlay.dl, r.line.items, r.dx, r.dy);
  });
  if (renderToken.get(n) !== token) return;
  const old = el.querySelector('canvas')!;
  canvas.style.width = `${box.cssWidth}px`;
  canvas.style.height = `${box.cssHeight}px`;
  el.replaceChild(canvas, old);
  releaseCanvas(old);
  renderReferenceLinks(el, n, k);
  const badge = el.querySelector<HTMLElement>('.badge')!;
  if (usePdf && !pdfFailed) {
    badge.hidden = false;
    badge.textContent = 'from PDF';
    badge.title = `This page is shown from the last full compile because it ${reason}. Edits on it appear after the next full compile (a second or two).`;
  } else if (reason && reason !== 'fonts are loading' && reason !== 'images are loading') {
    badge.hidden = false;
    badge.textContent = 'approximate';
    badge.title = `Parts of this page are approximated: ${reason}.`;
  } else {
    badge.hidden = true;
  }
}

/** Device-pixel rectangle of an sp rectangle under the page's base matrix (scale only). */
function deviceRect(base: Mat, r: Rect): [number, number, number, number] {
  const x = Math.round(r.x * base[0] + base[4]);
  const y = Math.round(r.y * base[3] + base[5]);
  return [x, y, Math.max(0, Math.round((r.x + r.w) * base[0] + base[4]) - x), Math.max(0, Math.round((r.y + r.h) * base[3] + base[5]) - y)];
}

/** The pixels of `r` (sp) on the canvas, or undefined when it is empty or off the canvas. */
function grabRect(ctx: CanvasRenderingContext2D, base: Mat, r: Rect): ImageData | undefined {
  const [x, y, w, h] = deviceRect(base, r);
  if (w < 1 || h < 1 || x >= ctx.canvas.width || y >= ctx.canvas.height || x + w <= 0 || y + h <= 0) return undefined;
  return ctx.getImageData(x, y, w, h);
}

/** Put pixels taken by grabRect at the top-left of `r` (sp); putImageData ignores the transform. */
function putRect(ctx: CanvasRenderingContext2D, base: Mat, img: ImageData, r: Rect): void {
  const [x, y] = deviceRect(base, r);
  ctx.putImageData(img, x, y);
}

function currentPageNumber(): number {
  const mid = viewport.scrollTop + viewport.clientHeight / 2;
  const els = pageEls();
  let cur = 1;
  for (let i = 0; i < els.length; i++) {
    if (els[i].offsetTop <= mid) cur = i + 1;
  }
  return cur;
}

function updateReadingButtons(): void {
  navBack.disabled = !model.hasLayout || !readingHistory.canMove('back');
  navForward.disabled = !model.hasLayout || !readingHistory.canMove('forward');
}

function updatePageNo(): void {
  updateReadingButtons();
  updateOutlineActive();
  if (!model.pagesTotal) {
    setToolbarText(pageNo, '');
    closePageJump();
    return;
  }
  const cur = currentPageNumber();
  setToolbarText(pageNo, `${cur} / ${model.pagesTotal}`);
  pageNo.setAttribute('aria-label', `Page ${cur} of ${model.pagesTotal}. Go to page`);
  setToolbarText(pageTotal, `/ ${model.pagesTotal}`);
  pageInput.title = `Enter a page number from 1 to ${model.pagesTotal}`;
}

// ---------------------------------------------------------------------------------------------
// Screens, banner, status, toast

const SCREEN_DEFAULT_TITLES: Record<ScreenKind, string> = {
  starting: 'Starting the LaTeX engine…',
  compiling: 'Typesetting your document…',
  error: 'Something went wrong',
  noMain: 'Which file is the main document?',
  notInstalled: 'The bundled rtex engine could not be used',
  stopped: 'The live preview is paused',
  unsupported: 'This platform is not supported',
};

function renderActions(container: HTMLElement, actions: Action[] | undefined): void {
  container.innerHTML = '';
  for (const a of actions ?? []) {
    const b = document.createElement('button');
    b.textContent = a.label;
    if (a.primary) b.className = 'primary';
    b.addEventListener('click', () => runCommand(a.command, a.args));
    container.appendChild(b);
  }
}

function showScreen(m: Extract<HostToWebview, { type: 'screen' }>): void {
  if (!m.screen) {
    screen.hidden = true;
    setHasDocument(model.hasLayout);
    return;
  }
  // with pages on screen, problems are shown as a banner instead of hiding the document
  if (model.hasLayout && (m.screen === 'error' || m.screen === 'compiling' || m.screen === 'starting')) {
    screen.hidden = true;
    if (m.screen === 'error') showBanner({ type: 'banner', text: `${m.title ?? 'Error'}: ${m.message ?? ''}`, kind: 'error', actions: m.actions });
    return;
  }
  screen.hidden = false;
  setHasDocument(false);
  screen.dataset.kind = m.screen;
  screen.querySelector('.spinner')!.toggleAttribute('hidden', !(m.screen === 'starting' || m.screen === 'compiling'));
  screen.querySelector('.title')!.textContent = m.title ?? SCREEN_DEFAULT_TITLES[m.screen];
  screen.querySelector('.message')!.textContent = m.message ?? '';
  const detail = screen.querySelector<HTMLElement>('.detail')!;
  detail.hidden = !m.detail;
  detail.textContent = m.detail ?? '';
  renderActions(screen.querySelector('.actions')!, m.actions);
}

/** Zoom, follow, recompile and export only mean something once pages are shown. */
function setHasDocument(v: boolean): void {
  if (!v) { closePageJump(); closeMoreMenu(); }
  if (document.body.classList.contains('has-doc') === v) return;
  document.body.classList.toggle('has-doc', v);
  fitToolbar();
}

function showBanner(m: Extract<HostToWebview, { type: 'banner' }>): void {
  if (!m.text) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.className = `banner ${m.kind ?? 'info'}`;
  banner.querySelector('.text')!.textContent = m.text;
  renderActions(banner.querySelector('.actions')!, m.actions);
}
banner.querySelector('.close')!.addEventListener('click', () => (banner.hidden = true));

let pillKind: PillKind = 'idle';
function showStatus(text: string, kind: PillKind, tooltip: string): void {
  pill.hidden = false;
  setToolbarText(pill.querySelector<HTMLElement>('.pill-text')!, text);
  pill.className = `pill ${kind}`;
  pill.title = tooltip;
  pill.setAttribute('aria-label', `${text}. ${tooltip}`);
  pillKind = kind;
}
pill.addEventListener('click', () => runCommand(pillKind === 'error' || pillKind === 'warn' ? 'workbench.actions.view.problems' : 'realtimeTex.showLog'));

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(text: string, ms = 6000): void {
  toast.textContent = text;
  toast.hidden = false;
  toast.style.top = `${toolbar.offsetHeight + (banner.hidden ? 0 : banner.offsetHeight + 8) + 10}px`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), ms);
}
toast.addEventListener('click', () => (toast.hidden = true));

// ---------------------------------------------------------------------------------------------
// Sync

let follow = boot.follow;
function setFollowUi(v: FollowCursorMode): void {
  follow = v;
  followSelect.value = v;
  followSelect.title = v === 'singleClick' ? 'Single-click the source to reveal and highlight it in the preview'
    : v === 'doubleClick' ? 'Double-click source text or a formula to reveal and highlight it in the preview'
    : 'Automatic source clicks are off. Use Show Cursor Position in Preview to jump on demand.';
  const control = $('followControl');
  control.title = `Source to preview: ${v === 'singleClick' ? 'single click' : v === 'doubleClick' ? 'double click' : 'off'}`;
  control.classList.toggle('active', v !== 'off');
}
setFollowUi(follow);

function reveal(page: number, x: number, y: number, force: boolean, targetRect?: Rect): void {
  const el = pageEls()[page - 1];
  if (!el) return;
  const k = cssScale();
  const top = el.offsetTop + y * k;
  const vTop = viewport.scrollTop;
  const vh = viewport.clientHeight;
  const inView = top > vTop + vh * 0.15 && top < vTop + vh * 0.85;
  if (!force && follow === 'off') return;
  if (force || !inView) viewport.scrollTo({ top: top - vh * 0.35, behavior: 'instant' });
  const left = el.offsetLeft + x * k;
  if (left < viewport.scrollLeft || left > viewport.scrollLeft + viewport.clientWidth) viewport.scrollLeft = left - 40;
  if (force) {
    const marker = document.createElement('div');
    marker.className = 'marker';
    const [wSp] = pageSizeSp(page);
    marker.style.left = `${(targetRect?.x ?? x) * k - 6}px`;
    marker.style.width = `${Math.max(40, targetRect ? targetRect.w * k + 12 : (wSp - 2 * x) * k + 12)}px`;
    marker.style.top = `${targetRect ? targetRect.y * k - 4 : (y - 9 * 65536) * k}px`;
    marker.style.height = `${targetRect ? targetRect.h * k + 8 : 12 * 65536 * k}px`;
    el.appendChild(marker);
    setTimeout(() => marker.remove(), 1600);
  }
}

/** Transparent controls use the extractor's real link rectangles; text stays on the native canvas. */
function renderReferenceLinks(el: HTMLElement, page: number, k: number): void {
  el.querySelector('.reference-links')?.remove();
  const links = pageNavigation(model, page).links;
  if (!links.length) return;
  const layer = document.createElement('div');
  layer.className = 'reference-links';
  for (const link of links) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reference-link';
    button.dataset.target = link.target;
    button.setAttribute('role', 'link');
    button.setAttribute('aria-label', 'Go to referenced location');
    button.title = 'Go to referenced location · Cmd/Ctrl-click to show source';
    button.style.left = `${link.x * k - 2}px`;
    button.style.top = `${link.y * k - 2}px`;
    button.style.width = `${link.w * k + 4}px`;
    button.style.height = `${link.h * k + 4}px`;
    layer.appendChild(button);
  }
  el.appendChild(layer);
}

function followReference(target: string): boolean {
  const destination = findDestination(model, target);
  if (destination) {
    readingHistory.remember(readingPosition());
    reveal(destination.page, destination.x, destination.y, true, destination.rect);
    updatePageNo();
    return true;
  }
  else showToast('The referenced location is not available in this preview. Recompile to refresh the links.', 3500);
  return false;
}

function readingPosition(): ReadingPosition {
  const anchor = scrollAnchor();
  return { page: anchor.page + 1, fraction: anchor.frac, left: viewport.scrollLeft / cssScale() };
}

function navigateReading(direction: NavigationDirection): void {
  lastReferenceClick = undefined;
  if (!model.pagesTotal) return;
  closePageJump();
  closeMoreMenu();
  const position = readingHistory.move(direction, readingPosition());
  updateReadingButtons();
  if (!position) return;
  const page = Math.max(1, Math.min(position.page, model.pagesTotal));
  restoreAnchor({ page: page - 1, frac: position.fraction });
  viewport.scrollLeft = position.left * cssScale();
  pagesEl.querySelectorAll('.marker').forEach(marker => marker.remove());
  updatePageNo();
}

let lastReferenceClick: { time: number; x: number; y: number } | undefined;
function followsReferenceClick(e: MouseEvent): boolean {
  return lastReferenceClick !== undefined && e.timeStamp >= lastReferenceClick.time &&
    e.timeStamp - lastReferenceClick.time < 650 &&
    Math.abs(e.clientX - lastReferenceClick.x) <= 8 && Math.abs(e.clientY - lastReferenceClick.y) <= 8;
}

function jumpFromEvent(e: MouseEvent): void {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.page');
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const k = cssScale();
  post({ type: 'jump', page: Number(el.dataset.page), x: (e.clientX - rect.left) / k, y: (e.clientY - rect.top) / k });
}
pagesEl.addEventListener('dblclick', (e) => {
  if (followsReferenceClick(e) || (e.target as Element).closest('.reference-link')) return;
  window.getSelection()?.removeAllRanges();
  jumpFromEvent(e);
});
pagesEl.addEventListener('click', (e) => {
  if (e.ctrlKey || e.metaKey) {
    lastReferenceClick = undefined;
    jumpFromEvent(e);
    return;
  }
  // The first click jumps immediately. A rapid second click can now land on different
  // content at the same screen position, so consume that double-click continuation.
  if (e.detail > 0 && followsReferenceClick(e)) return;
  lastReferenceClick = undefined;
  const link = (e.target as HTMLElement).closest<HTMLElement>('.reference-link');
  if (!link?.dataset.target || e.altKey || e.shiftKey || e.detail > 1) return;
  if (e.detail > 0) lastReferenceClick = { time: e.timeStamp, x: e.clientX, y: e.clientY };
  followReference(link.dataset.target);
});

// ---------------------------------------------------------------------------------------------
// Toolbar and keys

function closePageJump(restoreFocus = false): void {
  const wasOpen = !pageJump.hidden;
  pageJump.hidden = true;
  pageNo.hidden = false;
  pageNo.setAttribute('aria-expanded', 'false');
  pageInput.setCustomValidity('');
  if (restoreFocus && wasOpen) pageNo.focus();
}

pageNo.addEventListener('click', () => {
  if (!model.pagesTotal) return;
  closeMoreMenu();
  pageInput.value = String(currentPageNumber());
  pageInput.setCustomValidity('');
  pageNo.hidden = true;
  pageNo.setAttribute('aria-expanded', 'true');
  pageJump.hidden = false;
  pageInput.focus();
  pageInput.select();
});
pageInput.addEventListener('input', () => pageInput.setCustomValidity(''));
pageJump.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  closePageJump(true);
});
pageJump.addEventListener('focusout', e => {
  if (!pageJump.contains(e.relatedTarget as Node | null)) closePageJump();
});
pageJump.addEventListener('submit', e => {
  e.preventDefault();
  const page = parsePageNumber(pageInput.value, model.pagesTotal);
  if (page === undefined) {
    pageInput.setCustomValidity(`Enter a whole page number from 1 to ${model.pagesTotal}.`);
    pageInput.reportValidity();
    return;
  }
  readingHistory.remember(readingPosition());
  lastReferenceClick = undefined;
  closePageJump(true);
  restoreAnchor({ page: page - 1, frac: 0 });
  pagesEl.querySelectorAll('.marker').forEach(marker => marker.remove());
  updatePageNo();
});
navBack.addEventListener('click', () => navigateReading('back'));
navForward.addEventListener('click', () => navigateReading('forward'));

function closeMoreMenu(restoreFocus = false): void {
  const wasOpen = !moreMenu.hidden;
  moreMenu.hidden = true;
  moreButton.setAttribute('aria-expanded', 'false');
  if (restoreFocus && wasOpen) moreButton.focus();
}

function openMoreMenu(last = false): void {
  closePageJump();
  moreMenu.hidden = false;
  moreButton.setAttribute('aria-expanded', 'true');
  const items = moreMenu.querySelectorAll<HTMLButtonElement>('button');
  items[last ? items.length - 1 : 0]?.focus();
}
moreButton.addEventListener('click', () => moreMenu.hidden ? openMoreMenu() : closeMoreMenu(true));
moreButton.addEventListener('keydown', e => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  openMoreMenu(e.key === 'ArrowUp');
});
for (const button of moreMenu.querySelectorAll<HTMLButtonElement>('button')) {
  button.addEventListener('click', () => {
    closeMoreMenu(true);
    if (button.dataset.command) runCommand(button.dataset.command);
  });
}
moreMenu.addEventListener('keydown', e => {
  const items = [...moreMenu.querySelectorAll<HTMLButtonElement>('button')];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  let next: number;
  if (e.key === 'ArrowDown') next = (index + 1) % items.length;
  else if (e.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  else return;
  e.preventDefault();
  items[next]?.focus();
});
window.addEventListener('click', e => {
  const target = e.target as Node | null;
  if (!moreMenu.hidden && !moreMenu.contains(target) && !moreButton.contains(target)) closeMoreMenu();
});
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !moreMenu.hidden) {
    e.preventDefault();
    e.stopPropagation();
    closeMoreMenu(true);
  } else if (e.key === 'Tab' && !moreMenu.hidden) closeMoreMenu(true);
});

// VS Code forwards bubbling webview key events to its editor history even when the
// browser default was prevented. Capture our reading keys first; the scoped host
// commands cover shortcuts handled by VS Code before they reach this frame.
window.addEventListener('keydown', (e) => {
  const direction = navigationKey(e);
  if (!direction || e.isComposing) return;
  const target = e.target instanceof HTMLElement ? e.target : null;
  if (target?.isContentEditable || target?.closest('input, textarea, select, [role="textbox"]')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  navigateReading(direction);
}, { capture: true });

$('zoomIn').addEventListener('click', () => stepZoom(1));
$('zoomOut').addEventListener('click', () => stepZoom(-1));
zoomLabel.addEventListener('click', () => setZoom('100'));
$('fit').addEventListener('click', () => setZoom('fitWidth'));
followSelect.addEventListener('change', () => {
  if (!isFollowCursorMode(followSelect.value)) return;
  setFollowUi(followSelect.value);
  post({ type: 'setFollow', value: follow });
  showToast(follow === 'singleClick' ? 'Single-click in the source to reveal and highlight it in the preview.'
    : follow === 'doubleClick' ? 'Double-click source text or a formula to reveal and highlight it in the preview.'
    : 'Source clicks no longer move the preview. Use Show Cursor Position in Preview to jump on demand.', 3500);
});
$('recompile').addEventListener('click', () => runCommand('realtimeTex.recompile'));
$('export').addEventListener('click', () => runCommand('realtimeTex.exportPdf'));

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === '=' || e.key === '+') stepZoom(1);
  else if (e.key === '-') stepZoom(-1);
  else if (e.key === '0') setZoom('100');
  else return;
  e.preventDefault();
});
viewport.addEventListener(
  'wheel',
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    stepZoom(e.deltaY < 0 ? 1 : -1);
  },
  { passive: false },
);
viewport.addEventListener('scroll', () => updatePageNo(), { passive: true });
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
new ResizeObserver(() => {
  if (zoom !== 'fitWidth') return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const a = scrollAnchor();
    layoutPages();
    restoreAnchor(a);
  }, 80);
}).observe(viewport);

// Moving the editor between screens changes backing pixels even at a fixed zoom.
let lastDpr = window.devicePixelRatio || 1;
function repaintForDpr(): void {
  const nextDpr = window.devicePixelRatio || 1;
  if (nextDpr === lastDpr) return;
  lastDpr = nextDpr;
  // page boxes follow whole device pixels, so they are sized again (pageBox)
  const anchor = scrollAnchor();
  layoutPages();
  restoreAnchor(anchor);
}
function watchDpr(): void {
  const query = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  query.addEventListener('change', () => {
    repaintForDpr();
    watchDpr();
  }, { once: true });
}
watchDpr();
window.addEventListener('resize', repaintForDpr);

function applyConfig(m: Extract<HostToWebview, { type: 'config' }>): void {
  setFollowUi(m.follow);
  document.body.classList.toggle('invert', m.invert);
}
applyConfig({ type: 'config', follow: boot.follow, invert: boot.invert });

outlineSidebar = new OutlineSidebar({
  navigate: target => {
    closePageJump();
    closeMoreMenu();
    return followReference(target);
  },
  layout: change => {
    const anchor = scrollAnchor();
    const left = viewport.scrollLeft / cssScale();
    change();
    if (model.hasLayout) {
      layoutPages();
      restoreAnchor(anchor);
      viewport.scrollLeft = left * cssScale();
      updatePageNo();
    }
    scheduleOutlineRefresh();
  },
  save: saveOutlineState,
});

/** Resource completion affects only pages that actually draw that font/image. */
function resourcesChanged(fontKeys: ReadonlySet<string>, imageFiles: ReadonlySet<string>): void {
  const uses = (dl: Parameters<typeof usedResources>[0]) => {
    const usage = usedResources(dl);
    return [...usage.fonts.keys()].some((key) => fontKeys.has(key)) || [...usage.images.keys()].some((file) => imageFiles.has(file));
  };
  const changed = new Set<number>();
  for (const [n, p] of model.pages) {
    if (!uses(p.dl)) continue;
    pageResources.set(n, (pageResources.get(n) ?? 0) + 1);
    changed.add(n);
  }
  for (const o of model.overlays.values()) if (uses(o.dl)) for (const f of o.fragments) changed.add(f.page);
  markDirty(changed);
}

images.onLoaded = (file) => resourcesChanged(new Set(), new Set([file]));
fonts.onLoaded = (key) => resourcesChanged(new Set([key]), new Set());

// ---------------------------------------------------------------------------------------------
// Host messages

let pdfSerial = 0;
window.addEventListener('message', (ev: MessageEvent<HostToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case 'document': {
      if (documentId && outlineSidebar) outlineStates.set(documentId, outlineSidebar.getState());
      const changed = documentId !== m.documentId;
      documentId = m.documentId;
      if (changed) { outlineEntries = []; outlinePositions.clear(); }
      const state = m.outlineState ?? outlineStates.get(documentId)
        ?? (saved?.outline?.documentId === documentId ? saved.outline.state : undefined);
      outlineSidebar?.setDocument(outlineEntries, state, 'Contents will appear after a full compile.');
      scheduleOutlineRefresh();
      break;
    }
    case 'outline':
      if (m.documentId !== documentId) break;
      outlineEntries = m.entries;
      outlineUnavailable = m.unavailable;
      outlineSidebar?.updateEntries(outlineEntries, m.unavailable);
      scheduleOutlineRefresh();
      break;
    case 'screen':
      showScreen(m);
      break;
    case 'banner':
      showBanner(m);
      break;
    case 'status':
      showStatus(m.text, m.kind, m.tooltip);
      break;
    case 'resources':
      for (const [key, res] of m.fonts) fonts.add(key, res);
      for (const [file, res] of m.images) images.add(file, res);
      resourcesChanged(new Set(m.fonts.map(([key]) => key)), new Set(m.images.map(([file]) => file)));
      break;
    case 'layout': {
      const first = !model.hasLayout;
      const dirtyPages = model.applyLayout({
        pages: m.pages,
        pagesTotal: m.pagesTotal,
        placements: m.placements,
        keepFromRevision: m.keepFromRevision,
        dropOverlayIds: m.dropOverlayIds,
      });
      for (const p of m.pages) pagePdfSerial.set(p.page, m.pdf ? pdfSerial + 1 : Infinity);
      if (m.pdf) {
        const serial = ++pdfSerial;
        pdfOpening = openPdf(m.pdf).then(
          (doc) => {
            if (serial !== pdfSerial) {
              void doc.destroy();
              return;
            }
            const old = pdfDoc;
            pdfDoc = doc;
            pdfPages = doc.numPages;
            pdfSerialLoaded = serial;
            void old?.destroy();
            markDirty([...model.pages].filter(([n, p]) => !p.exact || inexactReason(p.dl, fonts, images,
              p.dl.lines.filter((_, i) => !model.hiddenLines(n).has(i))) !== undefined).map(([n]) => n));
          },
          (e) => {
            if (serial !== pdfSerial) return;
            post({ type: 'log', message: `pdf: cannot open the full-compile PDF: ${String(e)}` });
            // Release pages waiting for this PDF; an older PDF is never a valid substitute.
            markDirty([...model.pages.keys()].filter(n => pagePdfSerial.get(n) === serial));
          },
        );
      }
      setHasDocument(true);
      layoutPages();
      markDirty(dirtyPages);
      if (first) screen.hidden = true;
      updatePageNo();
      scheduleOutlineRefresh();
      break;
    }
    case 'paragraph':
      markDirty(model.applyParagraph(m.parId, m.dl, m.fragments, m.revision));
      scheduleOutlineRefresh();
      break;
    case 'dropOverlays':
      markDirty(model.dropOverlays(m.parIds));
      scheduleOutlineRefresh();
      break;
    case 'reveal':
      reveal(m.page, m.x, m.y, m.force);
      break;
    case 'navigate':
      navigateReading(m.direction);
      break;
    case 'config':
      applyConfig(m);
      break;
    case 'hint':
      showToast(m.text, 9000);
      break;
    case 'reset':
      documentGeneration++;
      pdfSerial++;
      backgrounds.clear();
      fonts.clear();
      images.clear();
      if (spareCanvas) { spareCanvas.width = 0; spareCanvas.height = 0; spareCanvas = undefined; }
      pageGeometry.clear();
      pageResources.clear();
      lastReferenceClick = undefined;
      readingHistory.clear();
      setHasDocument(false);
      model.clear();
      observer.disconnect();
      observer.takeRecords();
      pagesEl.innerHTML = '';
      visible.clear();
      dirty.clear();
      void pdfDoc?.destroy();
      pdfDoc = undefined;
      pdfOpening = undefined;
      pdfPages = 0;
      pdfSerialLoaded = 0;
      pagePdfSerial.clear();
      if (documentId && outlineSidebar) outlineStates.set(documentId, outlineSidebar.getState());
      documentId = undefined;
      outlineEntries = [];
      outlinePositions.clear();
      outlineUnavailable = undefined;
      outlineSidebar?.setDocument([], undefined, 'Contents will appear after a full compile.');
      banner.hidden = true;
      updatePageNo();
      break;
  }
});

window.addEventListener('error', (e) => post({ type: 'error', message: String(e.message) }));
post({ type: 'ready' });
