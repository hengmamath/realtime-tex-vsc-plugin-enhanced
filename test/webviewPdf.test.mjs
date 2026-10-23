import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import { build } from 'esbuild';

// Run the real webview orchestration with controlled PDF parsing and painting. The small
// DOM below models its page/canvas and outline surfaces; no user documents or VS Code are needed.
const root = fileURLToPath(new URL('..', import.meta.url));
const bundle = await build({
  absWorkingDir: root, entryPoints: ['webview/main.ts'], bundle: true, write: false,
  platform: 'browser', format: 'iife', logLevel: 'silent',
  plugins: [{ name: 'controlled-pdf', setup(build) {
    build.onResolve({ filter: /^\.\/pdf$/ }, () => ({ path: 'pdf', namespace: 'stub' }));
    build.onResolve({ filter: /^\.\/render$/ }, () => ({ path: 'render', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ loader: 'js', contents: path === 'pdf' ? `
      export const initPdfWorker = async () => {};
      export const openPdf = data => globalThis.testOpenPdf(data);
      export const renderPdfPage = async (doc, page, context) => { await doc.render?.(); context.canvas.pixels = doc.id; };
      export const rasterizePdfImage = async () => {};
    ` : `
      export class FontStore { hasPending() { return false; } clear() {} add() {} }
      export class ImageStore { clear() {} add() {} }
      export const inexactReason = () => undefined;
      export class Painter { draw() {} clearLines() {} clearRects() {} }
    ` }));
  } }],
});

class Element {
  constructor(tag = 'div') {
    this.tag = tag;
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.className = '';
    this.hidden = false;
    this.listeners = new Map();
    this.attributes = new Map();
    this.width = this.height = 10;
    this.classes = new Set();
    this.classList = {
      contains: name => this.classes.has(name),
      add: name => this.classes.add(name),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
      toggle: (name, force) => (force ?? !this.classes.has(name)) ? this.classes.add(name) : this.classes.delete(name),
    };
  }
  appendChild(element) { this.children.push(element); element.parent = this; return element; }
  append(...elements) { elements.forEach(element => this.appendChild(element)); }
  replaceChildren(...elements) { this.children = []; this.append(...elements); }
  replaceChild(next, old) { this.children[this.children.indexOf(old)] = next; next.parent = this; }
  remove() { const i = this.parent?.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); }
  set innerHTML(value) {
    this.children = [];
    if (value.includes('<canvas')) {
      this.appendChild(new Element('canvas'));
      this.appendChild(Object.assign(new Element(), { className: 'badge' }));
    }
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  contains(element) { return this === element || this.children.some(child => child.contains(element)); }
  focus() { this.focused = true; }
  scrollIntoView() {}
  select() { this.selected = true; }
  setCustomValidity(message) { this.validationMessage = message; }
  reportValidity() { return !this.validationMessage; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  querySelector(selector) { return this.children.find(element => selector === 'canvas' ? element.tag === 'canvas' : element.className === selector.slice(1)) ?? null; }
  querySelectorAll(selector) {
    return this.children.flatMap(element => [
      ...(element.className === selector.slice(1) ? [element] : []), ...element.querySelectorAll(selector),
    ]);
  }
  get offsetWidth() { return parseFloat(this.style.width) || 800; }
  get offsetHeight() { return parseFloat(this.style.height) || 1000; }
  get offsetTop() { return 16 + (this.className === 'page' ? this.parent.children.indexOf(this) * (this.offsetHeight + 16) : 0); }
  get offsetLeft() { return 16; }
  get clientWidth() { return 900; }
  get clientHeight() { return 700; }
  getBoundingClientRect() { return { top: 0, bottom: 36, left: 0, width: this.offsetWidth, height: this.offsetHeight }; }
  getContext() {
    return this.context ??= {
      canvas: this,
      fillRect() { this.canvas.pixels = 'native'; },
      drawImage(image) { this.canvas.pixels = image.pixels; },
      reset() {},
    };
  }
  scrollTo({ top }) { this.scrollTop = top; }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const ids = ['viewport', 'pages', 'pill', 'pageNo', 'navBack', 'navForward', 'pageJump', 'pageInput', 'pageTotal',
    'zoomLabel', 'follow', 'followControl', 'screen', 'banner', 'toast', 'more', 'moreMenu',
    'zoomIn', 'zoomOut', 'fit', 'recompile', 'export', 'rtex-boot',
    'outlineSidebar', 'outlineToggle', 'outlineClose', 'outlineTree', 'outlineEmpty', 'outlineResize', 'outlineBackdrop'];
  const elements = new Map(ids.map(id => [id, new Element()]));
  elements.get('pill').appendChild(Object.assign(new Element('span'), { className: 'pill-text' }));
  elements.get('viewport').scrollTop = elements.get('viewport').scrollLeft = 0;
  elements.get('rtex-boot').textContent = JSON.stringify({ workerUrl: '', zoom: '100', follow: 'off', invert: false });
  for (const id of ['banner', 'screen']) {
    for (const className of ['close', 'text', 'actions', 'spinner', 'title', 'message', 'detail']) {
      elements.get(id).appendChild(Object.assign(new Element(), { className }));
    }
  }
  const toolbar = new Element(), frames = [], listeners = new Map(), opens = [], posts = [], destroyed = [];
  const timers = new Map();
  let timerId = 0;
  const matchMedia = () => ({ matches: false, addEventListener() {} });
  let intersection;
  const context = {
    Uint8Array, HTMLElement: Element,
    document: {
      body: new Element(), documentElement: { style: { getPropertyValue() { return ''; }, setProperty() {} } },
      getElementById: id => elements.get(id), querySelector: () => toolbar, createElement: tag => new Element(tag),
    },
    window: { devicePixelRatio: 1, matchMedia, addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    } },
    ResizeObserver: class { observe() {} }, MutationObserver: class { observe() {} },
    IntersectionObserver: class {
      constructor(listener) { this.listener = listener; this.targets = new Set(); this.records = []; intersection = this; }
      observe(target) { this.targets.add(target); this.listener([{ target, isIntersecting: true }]); }
      unobserve(target) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
      takeRecords() { return this.records.splice(0); }
    },
    requestAnimationFrame: callback => frames.push(callback),
    matchMedia,
    acquireVsCodeApi: () => ({ getState() {}, setState() {}, postMessage: message => posts.push(message) }),
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    testOpenPdf(data) {
      const pending = deferred();
      opens.push({ id: data[0], ...pending });
      return pending.promise;
    },
  };
  context.globalThis = context;
  vm.runInNewContext(bundle.outputFiles[0].text, context);
  const send = data => listeners.get('message').forEach(listener => listener({ data }));
  const flushTimers = () => {
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach(callback => callback());
  };
  const flush = async () => {
    for (let i = 0; i < 20; i++) {
      flushTimers();
      for (const frame of frames.splice(0)) frame();
      await Promise.resolve();
    }
  };
  const resolve = (index, render) => {
    const { id } = opens[index];
    opens[index].resolve({ id: `PDF ${id}`, numPages: 1, render, destroy: async () => { destroyed.push(id); } });
  };
  const snapshot = () => {
    const page = elements.get('pages').children[0];
    return page && {
      pixels: page.querySelector('canvas').pixels,
      linkLeft: page.querySelector('.reference-links')?.children[0]?.style.left,
      badge: page.querySelector('.badge').textContent,
    };
  };
  const click = element => element.listeners.get('click')({ stopPropagation() {} });
  const resize = dpr => {
    context.window.devicePixelRatio = dpr;
    listeners.get('resize')?.forEach(listener => listener());
  };
  return { send, flush, flushTimers, elements, timers, click, opens, posts, destroyed, resolve, snapshot, intersection, resize };
}

const SP = 65536;
const page = x => ({ page: 1, exact: false, dl: {
  fonts: {}, lines: [{ x: 0, y: 100 * SP, w: 500 * SP, h: 10 * SP, d: 2 * SP,
    items: [['L', 'name:equation.1', x * SP, 100 * SP, 20 * SP, 10 * SP]] }],
  other: [], flags: [], page_width: 1000 * SP, page_height: 1000 * SP,
} });
const layout = (x, pdf) => ({ type: 'layout', pages: [page(x)], pagesTotal: 1,
  placements: [], keepFromRevision: null, pdf: pdf === null ? null : new Uint8Array([pdf]) });

test('the first page paints when intersection delivery follows the initial animation frame', async () => {
  const h = harness();
  h.intersection.observe = target => h.intersection.targets.add(target);
  h.send(layout(100, null));
  await h.flush();
  assert.equal(h.snapshot().pixels, undefined, 'the first frame must wait for page visibility');
  const target = h.elements.get('pages').children[0];
  h.intersection.listener([{ target, isIntersecting: true }]);
  await h.flush();
  assert.equal(h.snapshot().pixels, 'native');
  assert.ok(parseFloat(h.snapshot().linkLeft) > 130);
});

test('a pending animation frame paints the replacement page after reset and delayed intersection', async () => {
  const h = harness();
  h.intersection.observe = target => h.intersection.targets.add(target);
  h.send(layout(100, null));
  const oldPage = h.elements.get('pages').children[0];
  h.send({ type: 'reset' });
  h.send(layout(300, null));
  const target = h.elements.get('pages').children[0];
  assert.notEqual(target, oldPage);
  h.intersection.listener([{ target, isIntersecting: true }]);
  await h.flush();
  assert.equal(h.snapshot().pixels, 'native');
  assert.ok(parseFloat(h.snapshot().linkLeft) > 390, 'the pending frame must use the replacement layout');
  assert.equal(oldPage.querySelector('canvas').pixels, undefined);
});

async function oldPdf() {
  const h = harness();
  h.send(layout(100, 1));
  await h.flush();
  h.resolve(0);
  await h.flush();
  assert.equal(h.snapshot().pixels, 'PDF 1');
  return h;
}

test('a pending layout PDF preserves the previous canvas and matching link regions', async () => {
  const h = await oldPdf();
  const old = h.snapshot();
  h.send(layout(200, 2));
  await h.flush();
  assert.deepEqual(h.snapshot(), old, 'new hotspots must not be installed over old PDF pixels');
  h.resolve(1);
  await h.flush();
  assert.equal(h.snapshot().pixels, 'PDF 2');
  assert.ok(parseFloat(h.snapshot().linkLeft) > parseFloat(old.linkLeft) + 100);
});

test('a failed PDF open releases waiting pages to native fallback with current hotspots', async () => {
  const h = await oldPdf();
  h.send(layout(200, 2));
  await h.flush();
  h.opens[1].reject(new Error('synthetic invalid PDF'));
  await h.flush();
  assert.equal(h.snapshot().pixels, 'native', 'a previous layout PDF cannot substitute for the failed PDF');
  assert.equal(h.snapshot().badge, 'approximate');
  assert.ok(parseFloat(h.snapshot().linkLeft) > 260);
  assert.ok(h.posts.some(message => message.type === 'log' && message.message.includes('synthetic invalid PDF')));
});

test('a layout without an available PDF cannot repaint using an older PDF', async () => {
  const h = await oldPdf();
  h.send(layout(200, null));
  await h.flush();
  assert.equal(h.snapshot().pixels, 'native');
  assert.equal(h.snapshot().badge, 'approximate');
  assert.ok(parseFloat(h.snapshot().linkLeft) > 260);
});

test('an obsolete PDF completion cannot replace the latest layout or survive reset', async () => {
  const h = await oldPdf();
  h.send(layout(200, 2));
  await h.flush();
  h.send(layout(300, 3));
  await h.flush();
  h.resolve(2);
  await h.flush();
  const latest = h.snapshot();
  assert.equal(latest.pixels, 'PDF 3');
  h.resolve(1);
  await h.flush();
  assert.deepEqual(h.snapshot(), latest);
  assert.ok(h.destroyed.includes(2));
  h.send(layout(400, 4));
  await h.flush();
  h.send({ type: 'reset' });
  h.resolve(3);
  await h.flush();
  assert.equal(h.snapshot(), undefined);
  assert.ok(h.destroyed.includes(4));
});

test('reset releases observed pages and queued visibility changes before loading new pages', async () => {
  const h = await oldPdf();
  const [oldPage] = h.intersection.targets;
  h.intersection.records.push({ target: oldPage, isIntersecting: false });
  h.send({ type: 'reset' });
  assert.equal(h.intersection.targets.size, 0);
  assert.equal(h.intersection.records.length, 0);
  h.send(layout(200, null));
  await h.flush();
  assert.equal(h.intersection.targets.size, 1);
  assert.equal(h.intersection.targets.has(oldPage), false);
  assert.equal(h.snapshot().pixels, 'native');
});

test('offscreen pages release backing pixels and repaint with their geometry and links intact', async () => {
  const h = await oldPdf();
  const [page] = h.intersection.targets;
  const before = h.snapshot(), canvas = page.querySelector('canvas');
  const geometry = { ...page.style }, css = { ...canvas.style };
  h.intersection.listener([{ target: page, isIntersecting: false }]);
  assert.deepEqual([canvas.width, canvas.height], [0, 0]);
  assert.deepEqual(page.style, geometry);
  assert.deepEqual(canvas.style, css);
  assert.equal(h.snapshot().linkLeft, before.linkLeft);
  h.intersection.listener([{ target: page, isIntersecting: true }]);
  await h.flush();
  assert.ok(page.querySelector('canvas').width > 0);
  assert.deepEqual(h.snapshot(), before);
});

test('late PDF open and render completion cannot restore an offscreen canvas', async () => {
  for (const pendingRender of [false, true]) {
    const h = await oldPdf(), gate = deferred();
    h.send(layout(200, 2));
    if (pendingRender) h.resolve(1, () => gate.promise);
    await h.flush();
    const [page] = h.intersection.targets;
    h.intersection.listener([{ target: page, isIntersecting: false }]);
    if (pendingRender) gate.resolve();
    else h.resolve(1);
    await h.flush();
    assert.deepEqual([page.querySelector('canvas').width, page.querySelector('canvas').height], [0, 0]);
    h.intersection.listener([{ target: page, isIntersecting: true }]);
    await h.flush();
    assert.equal(h.snapshot().pixels, 'PDF 2');
    assert.ok(parseFloat(h.snapshot().linkLeft) > 260);
  }
});

test('a page reentered during a pending PDF render receives only the latest layout', async () => {
  const h = await oldPdf(), gate = deferred();
  h.send(layout(200, 2));
  h.resolve(1, () => gate.promise);
  await h.flush();
  const [page] = h.intersection.targets;
  h.intersection.listener([{ target: page, isIntersecting: false }]);
  h.intersection.listener([{ target: page, isIntersecting: true }]);
  h.send(layout(300, 3));
  h.resolve(2);
  await h.flush();
  const current = h.snapshot();
  gate.resolve();
  await h.flush();
  assert.equal(current.pixels, 'PDF 3');
  assert.deepEqual(h.snapshot(), current);
});

test('offscreen updates, zoom and display density are applied when a page returns', async () => {
  const h = await oldPdf();
  const [page] = h.intersection.targets;
  const oldWidth = page.querySelector('canvas').width;
  h.intersection.listener([{ target: page, isIntersecting: false }]);
  h.send(layout(300, null));
  h.click(h.elements.get('zoomIn'));
  h.resize(2);
  await h.flush();
  assert.equal(page.querySelector('canvas').width, 0);
  h.intersection.listener([{ target: page, isIntersecting: true }]);
  await h.flush();
  assert.ok(page.querySelector('canvas').width > oldWidth * 2);
  assert.equal(h.snapshot().pixels, 'native');
  assert.ok(parseFloat(h.snapshot().linkLeft) > 400);
});

test('late observer records from a reset cannot discard the replacement page pixels', async () => {
  const h = await oldPdf();
  const [old] = h.intersection.targets;
  h.send({ type: 'reset' });
  h.send(layout(300, null));
  await h.flush();
  const [page] = h.intersection.targets;
  h.intersection.listener([{ target: old, isIntersecting: false }]);
  h.send(layout(400, null));
  await h.flush();
  assert.ok(page.querySelector('canvas').width > 0);
  assert.ok(parseFloat(h.snapshot().linkLeft) > 520, 'the new page remains visible and updates');
});

const headings = ['section.1', 'section.2', 'subsection.2.1'].map((id, index) => ({
  id, title: `Synthetic heading ${index + 1}`, level: index === 2 ? 2 : 1, target: `name:${id}`,
}));
const outlineLayout = (targets = headings.map(entry => entry.target)) => ({
  type: 'layout', pagesTotal: targets.length, placements: [], keepFromRevision: null, pdf: null,
  pages: targets.map((target, index) => ({ page: index + 1, exact: true,
    dl: { ...page(0).dl, lines: [], other: [['D', target, 40 * SP, 100 * SP]] } })),
});
const outlineLinks = h => h.elements.get('outlineTree').querySelectorAll('.outline-entry');
const activeHeading = h => outlineLinks(h).find(link => link.getAttribute('aria-current') === 'location')?.dataset.id;

test('outline jumps, reopening and reading history highlight the current heading without animation frames', () => {
  const h = harness();
  h.send({ type: 'document', documentId: 'synthetic' });
  h.send(outlineLayout());
  h.send({ type: 'outline', documentId: 'synthetic', entries: headings });
  h.click(h.elements.get('outlineToggle'));
  h.flushTimers(); // No animation frames are delivered, as in a background webview.
  assert.equal(activeHeading(h), 'section.1');
  h.click(outlineLinks(h)[2]);
  assert.equal(h.elements.get('outlineSidebar').hidden, true, 'a narrow-panel jump closes the sidebar');
  h.click(h.elements.get('outlineToggle'));
  h.flushTimers();
  assert.equal(h.elements.get('pageNo').textContent, '3 / 3');
  assert.equal(activeHeading(h), 'subsection.2.1');
  h.send({ type: 'navigate', direction: 'back' });
  assert.equal(activeHeading(h), 'section.1');
});

test('outline refreshes coalesce and use the latest layout after closing and reopening', () => {
  const h = harness();
  h.send({ type: 'document', documentId: 'synthetic', outlineState: { open: true, width: 240, collapsed: [] } });
  h.send(outlineLayout());
  h.send({ type: 'outline', documentId: 'synthetic', entries: headings });
  h.send(outlineLayout([headings[2].target, headings[1].target, headings[0].target]));
  assert.equal(h.timers.size, 1, 'a burst of updates must share one pending refresh');
  h.click(h.elements.get('outlineClose'));
  h.flushTimers();
  assert.equal(activeHeading(h), undefined);
  h.click(h.elements.get('outlineToggle'));
  h.flushTimers();
  assert.deepEqual(outlineLinks(h).map(link => link.querySelector('.outline-page').textContent), ['3', '2', '1']);
  assert.equal(activeHeading(h), 'subsection.2.1');
});

test('a queued outline refresh cannot restore old headings after reset and a document switch', () => {
  const h = harness();
  const outlineState = { open: true, width: 240, collapsed: [] };
  h.send({ type: 'document', documentId: 'old', outlineState });
  h.send(outlineLayout());
  h.send({ type: 'outline', documentId: 'old', entries: headings });
  h.send({ type: 'reset' });
  h.send({ type: 'document', documentId: 'new', outlineState });
  h.send(outlineLayout(['name:new']));
  h.send({ type: 'outline', documentId: 'new', entries: [{ id: 'new', title: 'New synthetic heading', level: 1, target: 'name:new' }] });
  h.send({ type: 'outline', documentId: 'old', entries: headings });
  h.flushTimers();
  assert.deepEqual(outlineLinks(h).map(link => link.dataset.id), ['new']);
  assert.equal(activeHeading(h), 'new');
});

const pdfBundle = await build({
  absWorkingDir: root, entryPoints: ['webview/pdf.ts'], bundle: true, write: false,
  platform: 'browser', format: 'iife', globalName: 'pdf', logLevel: 'silent',
  plugins: [{ name: 'controlled-pdf-document', setup(build) {
    build.onResolve({ filter: /^pdfjs-dist\// }, () => ({ path: 'pdfjs', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `
      export const GlobalWorkerOptions = {};
      export const getDocument = () => ({ promise: Promise.resolve(globalThis.pdfDocument) });
    ` }));
  } }],
});

test('PDF image documents are destroyed after success and page or render failure', async () => {
  for (const failure of [undefined, 'page', 'render']) {
    const error = new Error(`synthetic ${failure} failure`);
    let destroyed = 0;
    const canvas = { getContext() { return {}; } };
    const context = {
      pdfDocument: {
        numPages: 1,
        async getPage() {
          if (failure === 'page') throw error;
          return {
            getViewport: () => ({ width: 100, height: 200 }),
            render: () => ({ promise: failure === 'render' ? Promise.reject(error) : Promise.resolve() }),
          };
        },
        async destroy() { destroyed++; },
      },
      document: { createElement: () => canvas },
    };
    vm.runInNewContext(pdfBundle.outputFiles[0].text, context);
    const result = context.pdf.rasterizePdfImage(new Uint8Array([1]), 1);
    if (failure) await assert.rejects(result, actual => actual === error);
    else assert.equal(await result, canvas);
    assert.equal(destroyed, 1, `${failure ?? 'successful render'} must release its PDF document`);
  }
});
