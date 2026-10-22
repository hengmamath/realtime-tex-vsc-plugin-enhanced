import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Exercise the real panel resource methods with controlled filesystem reads. Only the
// unused VS Code surface is replaced; no webview or engine is needed for these races.
const root = fileURLToPath(new URL('..', import.meta.url));
const work = await mkdtemp(path.join(os.tmpdir(), 'rtex-panel-test-'));
after(() => rm(work, { recursive: true, force: true }));
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
