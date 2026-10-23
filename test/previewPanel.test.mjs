import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Exercise real panel resource and outline delivery with controlled reads and synthetic files.
// Only the unused VS Code surface is replaced; no webview or engine is needed.
const root = fileURLToPath(new URL('..', import.meta.url));
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'rtex-panel-test-'));
after(() => fs.rm(work, { recursive: true, force: true }));
const bundle = path.join(work, 'panel.cjs');
await build({ absWorkingDir: root, entryPoints: ['src/preview/panel.ts'], outfile: bundle,
  bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent',
  alias: { vscode: './test/bench/vscodeShim.ts' } });
const { PreviewPanel } = createRequire(import.meta.url)(bundle);

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check, message) {
  for (let i = 0; i < 40 && !check(); i++) await tick();
  assert.ok(check(), message);
}
const bitmap = version => ({ kind: 'bitmap', mime: 'image/png', data: new Uint8Array([version]) });
const dl = { fonts: {}, lines: [], other: [], flags: [] };

function harness(names = ['figure.png']) {
  const initial = deferred();
  const disk = new Map(names.map(key => [key, 1]));
  const reads = [];
  const posts = [];
  const session = { projectRoot: path.join(work, 'synthetic') };
  const loader = {
    fontsFor: async () => new Map(),
    imagesFor: async (_dls, have) => {
      const keys = names.filter(key => !have.has(key));
      if (!keys.length) return new Map();
      const versions = keys.map(key => [key, bitmap(disk.get(key))]);
      await initial.promise;
      return new Map(versions);
    },
    image: key => {
      const gate = deferred();
      const version = disk.get(key);
      reads.push({ key, version, finish: () => gate.resolve(bitmap(version)) });
      return gate.promise;
    },
    glyphsNeedPdf: async () => false,
  };
  const panel = Object.create(PreviewPanel.prototype);
  Object.assign(panel, { session, disposed: false, imageGen: new Map(), sentImages: new Set(),
    sentFonts: new Set(), missing: new Set(), host: { resources: () => loader, log: { appendLine() {} } },
    post: message => posts.push(message) });
  const change = async (key, version) => {
    disk.set(key, version);
    await panel.refreshImages(session, [path.join(session.projectRoot, key)]);
  };
  const prepare = (current = () => true) => panel.sendResources(session, [dl], false, current);
  const images = () => posts.flatMap(message => message.type === 'resources' ? message.images : []);
  return { initial, panel, session, disk, reads, posts, change, prepare, images };
}

test('an image changed again during its initial reread sends the latest bytes', async () => {
  const h = harness();
  const preparing = h.prepare();
  await h.change('figure.png', 2);
  h.initial.resolve();
  await until(() => h.reads.length === 1, 'the version-2 reread must start');
  await h.change('figure.png', 3);
  h.reads[0].finish();
  await until(() => h.reads.length === 2, 'a second change must trigger another reread');
  h.reads[1].finish();
  await preparing;
  assert.deepEqual(h.images().map(([key, im]) => [key, im.data[0]]), [['figure.png', 3]]);
  await h.prepare();
  assert.equal(h.images().length, 1, 'later layouts reuse the correct registered image');
});

test('all pending images are revalidated after another image finishes loading', async () => {
  const h = harness(['first.png', 'second.png']);
  const preparing = h.prepare();
  await h.change('second.png', 2);
  h.initial.resolve();
  await until(() => h.reads.length === 1, 'the second image reread must start');
  await h.change('first.png', 2);
  h.reads[0].finish();
  await until(() => h.reads.length === 2, 'the first image must be rechecked after the await');
  h.reads[1].finish();
  await preparing;
  assert.deepEqual(h.images().map(([key, im]) => [key, im.data[0]]), [['first.png', 2], ['second.png', 2]]);
});

test('invalidated delivery stops rereading and cannot register stale resources', async () => {
  const h = harness();
  let current = true;
  const preparing = h.prepare(() => current);
  await h.change('figure.png', 2);
  h.initial.resolve();
  await until(() => h.reads.length === 1, 'the reread must be in flight');
  await h.change('figure.png', 3);
  current = false;
  h.reads[0].finish();
  await preparing;
  assert.deepEqual(h.posts, []);
  assert.equal(h.panel.sentImages.size, 0);
  assert.equal(h.reads.length, 1, 'stale work must not start another filesystem read');
});

test('an older refresh cannot overwrite a newer refresh of an already shown image', async () => {
  const h = harness();
  h.initial.resolve();
  await h.prepare();
  const older = h.change('figure.png', 2);
  await until(() => h.reads.length === 1, 'the older refresh must start');
  const newer = h.change('figure.png', 3);
  await until(() => h.reads.length === 2, 'the newer refresh must start');
  h.reads[1].finish();
  await newer;
  h.reads[0].finish();
  await older;
  assert.deepEqual(h.images().map(([, im]) => im.data[0]), [1, 3]);
});

test('another delivery can register a shared image while an older reread is pending', async () => {
  const h = harness();
  const older = h.prepare();
  await h.change('figure.png', 2);
  h.initial.resolve();
  await until(() => h.reads.length === 1, 'the older reread must start');
  const newer = h.prepare();
  // The second preparation captured generation 1 and finishes before the old read.
  await newer;
  assert.equal(h.panel.sentImages.size, 1);
  const refresh = h.change('figure.png', 3);
  await until(() => h.reads.length === 2, 'registered images use their own refresh');
  h.reads[1].finish();
  await refresh;
  h.reads[0].finish();
  await older;
  assert.equal(h.reads.length, 2, 'the older lane must not reread a now-registered key');
  assert.deepEqual(h.images().map(([, im]) => im.data[0]), [2, 3]);
});

const outlineTick = () => new Promise(resolve => setTimeout(resolve, 10));
async function untilOutline(check, message) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await outlineTick();
  assert.ok(check(), message);
}

async function outlineHarness() {
  const directory = await fs.mkdtemp(path.join(work, 'document-'));
  await fs.writeFile(path.join(directory, 'main.out'), String.raw`\BOOKMARK [1][-]{section.1}{A title}{}`);
  const session = { mainFile: path.join(directory, 'main.tex'), pdfPath: path.join(directory, 'main.pdf'),
    model: { pages: new Map([[1, { page: 1, dl: { other: [['D', 'name:section.1', 1, 2]], lines: [] } }]]) } };
  const posts = [], saves = [], layouts = [];
  const panel = Object.create(PreviewPanel.prototype);
  Object.assign(panel, { session, disposed: false, outlineJob: undefined,
    delivery: { layout(input) { layouts.push(input); } }, post: message => posts.push(message),
    ctx: { workspaceState: { update: async (key, state) => saves.push([key, state]) } },
    host: { log: { appendLine() {} } } });
  const layout = version => ({ pages: [...session.model.pages.values()], pagesTotal: 1,
    placements: [], keepFromRevision: null, layoutVersion: version, pdfPath: session.pdfPath });
  return { directory, panel, session, posts, saves, layouts, layout };
}

test('outline metadata waits for its exact displayed layout without delaying delivery', async () => {
  const h = await outlineHarness();
  const input = h.layout(1);
  h.panel.deliverLayout(h.session, input);
  assert.deepEqual(h.layouts, [input], 'drawing begins immediately, before sidecar I/O');
  await untilOutline(() => !!h.panel.outlineJob.result, 'the generated metadata must finish');
  assert.deepEqual(h.posts, [], 'metadata cannot precede the matching layout');
  h.panel.outlineJob.displayed = true;
  h.panel.publishOutline();
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].entries[0].title, 'A title');
});

test('a cancelled or superseded outline read cannot publish into a newer layout', async t => {
  const h = await outlineHarness();
  const gate = deferred();
  const original = fs.readFile;
  let intercepted = false;
  fs.readFile = async (file, options) => {
    if (!intercepted && typeof file === 'string' && file.endsWith(path.join(path.basename(h.directory), 'main.out'))) {
      intercepted = true;
      const value = await original(file, options);
      await gate.promise;
      return value;
    }
    return original(file, options);
  };
  t.after(() => { fs.readFile = original; gate.resolve(); });
  h.panel.deliverLayout(h.session, h.layout(1));
  await untilOutline(() => intercepted, 'the old metadata read must be pending');
  const older = h.panel.outlineJob;
  h.panel.deliverLayout(h.session, h.layout(2));
  const latest = h.panel.outlineJob;
  assert.ok(older.abort.signal.aborted);
  latest.displayed = true;
  await untilOutline(() => h.posts.length === 1, 'the newest metadata should publish');
  gate.resolve();
  for (let i = 0; i < 8; i++) await outlineTick();
  assert.equal(h.posts.length, 1, 'late results must not overwrite the current outline');
  assert.equal(h.panel.outlineJob, latest);
  h.panel.cancelOutline();
  h.panel.publishOutline();
  assert.equal(h.posts.length, 1, 'reset/session changes discard outline work');
});

test('outline preference messages persist only for the active hashed document', async () => {
  const h = await outlineHarness();
  h.panel.deliverLayout(h.session, h.layout(1));
  h.panel.outlineJob.displayed = true;
  await untilOutline(() => h.posts.length === 1, 'outline document identity must be emitted');
  const documentId = h.posts[0].documentId;
  const state = { open: true, width: 300, collapsed: ['name:section.1'] };
  await h.panel.onMessage({ type: 'outlineState', documentId: 'wrong-document', state });
  await h.panel.onMessage({ type: 'outlineState', documentId, state: { ...state, width: Infinity } });
  assert.deepEqual(h.saves, []);
  await h.panel.onMessage({ type: 'outlineState', documentId, state });
  assert.deepEqual(h.saves, [[`realtimeTex.outline.${documentId}`, state]]);
  assert.match(documentId, /^[a-f0-9]{64}$/);
});
