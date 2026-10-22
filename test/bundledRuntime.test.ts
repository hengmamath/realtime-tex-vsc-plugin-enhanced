import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, TestContext } from 'node:test';
import { getBundledRuntime, RuntimeManifest } from '../src/bundledRuntime';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

async function fixture(t: TestContext) {
  const extensionPath = await fs.mkdtemp(path.join(os.tmpdir(), 'rtex-offline-runtime-'));
  t.after(() => fs.rm(extensionPath, { recursive: true, force: true }));
  const root = path.join(extensionPath, 'resources', 'rtex-runtime');
  const executable = path.join(extensionPath, 'resources', 'rtex-engine', 'darwin-arm64', 'rtex');
  const manifestPath = path.join(root, 'manifest.json');
  const texDir = path.join(root, 'tex');
  const manifest: RuntimeManifest = {
    schemaVersion: 1, platform: 'darwin-arm64', version: 'fixture.1', sourceCommit: 'a'.repeat(40),
    engine: { relativePath: '../rtex-engine/darwin-arm64/rtex', sha256: hash('matched engine') },
    texFiles: {},
  };
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, 'matched engine');
  for (const file of [
    'rtex-bg.lua', 'rtex-capture.lua', 'rtex-dl.lua', 'rtex-dl-bin.lua', 'rtex-json.lua',
    'rtex-pic.lua', 'rtex-serve.lua', 'latex/rtex-capture.sty', 'latex/rtex-pic.tex', 'latex/rtex-serve-patches.tex',
  ]) {
    const contents = `matched support ${file}`;
    manifest.texFiles[file] = hash(contents);
    await fs.mkdir(path.dirname(path.join(texDir, file)), { recursive: true });
    await fs.writeFile(path.join(texDir, file), contents);
  }
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  return { extensionPath, executable, texDir, manifest, manifestPath };
}

test('a clean offline extension contains a complete verified engine/support pair', async (t) => {
  const { extensionPath, executable, texDir } = await fixture(t);
  assert.deepEqual(getBundledRuntime(extensionPath, 'darwin', 'arm64'), {
    path: executable, texDir, version: 'fixture.1', platform: 'darwin-arm64',
  });
  assert.deepEqual(await fs.readdir(extensionPath), ['resources'], 'verification must not install or mutate anything');
});

test('unsupported hosts never select a different or downloaded engine', () => {
  for (const [platform, arch] of [['darwin', 'x64'], ['win32', 'x64'], ['linux', 'arm64']]) {
    assert.equal(getBundledRuntime('/nonexistent-extension', platform, arch), undefined);
  }
});

test('a changed executable or support file fails before selecting a mismatched pair', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.executable, 'newer unrelated engine');
  assert.throws(() => getBundledRuntime(f.extensionPath, 'darwin', 'arm64'), /engine checksum mismatch/);
  await fs.writeFile(f.executable, 'matched engine');
  await fs.writeFile(path.join(f.texDir, 'rtex-serve.lua'), 'unrelated support');
  assert.throws(() => getBundledRuntime(f.extensionPath, 'darwin', 'arm64'), /support checksum mismatch: rtex-serve.lua/);
});

test('incomplete manifests and references outside the support tree are rejected', async (t) => {
  const f = await fixture(t);
  const missing = { ...f.manifest, texFiles: { ...f.manifest.texFiles } };
  delete missing.texFiles['rtex-dl-bin.lua'];
  await fs.writeFile(f.manifestPath, JSON.stringify(missing));
  assert.throws(() => getBundledRuntime(f.extensionPath, 'darwin', 'arm64'), /Invalid bundled runtime manifest/);
  await fs.writeFile(f.manifestPath, JSON.stringify({ ...f.manifest,
    texFiles: { ...f.manifest.texFiles, '../outside.lua': hash('outside') } }));
  assert.throws(() => getBundledRuntime(f.extensionPath, 'darwin', 'arm64'), /Invalid bundled support file manifest/);
  await fs.writeFile(f.manifestPath, JSON.stringify({ ...f.manifest,
    engine: { ...f.manifest.engine, relativePath: '/outside-engine' } }));
  assert.throws(() => getBundledRuntime(f.extensionPath, 'darwin', 'arm64'), /Invalid bundled runtime manifest/);
});

test('the actual shipping runtime is self-contained and byte-verified', () => {
  const extensionPath = path.resolve(__dirname, '..', '..');
  const runtime = getBundledRuntime(extensionPath, 'darwin', 'arm64');
  assert.ok(runtime);
  assert.equal(runtime.version, '0.0.5+live.4');
  assert.equal(runtime.texDir, path.join(extensionPath, 'resources', 'rtex-runtime', 'tex'));
});
