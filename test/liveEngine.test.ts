import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, TestContext } from 'node:test';
import { LiveEngineOptions, prepareLiveEngine } from '../src/liveEngine';

const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');
const original = 'original engine fixture';
const patched = 'patched engine fixture';
const executable = process.platform === 'win32' ? 'rtex.exe' : 'rtex';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rtex-live-engine-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options: LiveEngineOptions = {
    serverPath: path.join(root, 'original-rtex'),
    buildDir: path.join(root, 'build'),
    extensionPath: path.join(root, 'extension'),
  };
  const resourceDir = path.join(options.extensionPath, 'resources', 'rtex-engine');
  const platform = `${process.platform}-${process.arch}`;
  const manifest = { platform, originalSha256: sha256(original), sha256: sha256(patched), version: '0.0.5+refs.test' };
  const manifestPath = path.join(resourceDir, 'manifest.json');
  const bundlePath = path.join(resourceDir, platform, executable);
  await fs.mkdir(path.dirname(bundlePath), { recursive: true });
  await fs.writeFile(options.serverPath, original);
  await fs.writeFile(bundlePath, patched);
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  return { root, options, manifest, manifestPath, bundlePath };
}

test('recognized engine is copied and executable without changing the original or bundle', async (t) => {
  const { options, bundlePath } = await fixture(t);
  const destination = await prepareLiveEngine(options);
  assert.equal(destination, path.join(options.buildDir, 'enhanced-engine', executable));
  assert.equal(await fs.readFile(destination!, 'utf8'), patched);
  assert.equal(await fs.readFile(options.serverPath, 'utf8'), original);
  assert.equal(await fs.readFile(bundlePath, 'utf8'), patched);
  if (process.platform !== 'win32') assert.equal((await fs.stat(destination!)).mode & 0o777, 0o755);

  await fs.writeFile(path.join(path.dirname(destination!), 'stale.tmp'), 'stale');
  assert.equal(await prepareLiveEngine(options), destination);
  await assert.rejects(fs.access(path.join(path.dirname(destination!), 'stale.tmp')));
  assert.deepEqual(await fs.readdir(options.buildDir), ['enhanced-engine']);
});

test('other platforms never copy or require an installed executable', async (t) => {
  const { options, manifest, manifestPath } = await fixture(t);
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, platform: 'unsupported-platform' }));
  await fs.rm(options.serverPath);
  assert.equal(await prepareLiveEngine(options), undefined);
  await assert.rejects(fs.access(options.buildDir));
});

test('custom or newer installed engines are not replaced', async (t) => {
  const { options } = await fixture(t);
  await fs.writeFile(options.serverPath, 'custom engine');
  assert.equal(await prepareLiveEngine(options), undefined);
  assert.equal(await fs.readFile(options.serverPath, 'utf8'), 'custom engine');
  await assert.rejects(fs.access(options.buildDir));
});

test('corrupt bundled engine is rejected before creating a local executable', async (t) => {
  const { options, bundlePath } = await fixture(t);
  await fs.writeFile(bundlePath, 'corrupted bundle');
  await assert.rejects(prepareLiveEngine(options), /checksum mismatch/);
  await assert.rejects(fs.access(options.buildDir));
  assert.equal(await fs.readFile(options.serverPath, 'utf8'), original);
});

test('missing bundles and invalid manifest hashes do not silently bypass verification', async (t) => {
  const { options, manifest, manifestPath, bundlePath } = await fixture(t);
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, sha256: 'not-a-checksum' }));
  await assert.rejects(prepareLiveEngine(options), /Invalid enhanced engine manifest/);
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.rm(bundlePath);
  await assert.rejects(prepareLiveEngine(options), { code: 'ENOENT' });
  await assert.rejects(fs.access(options.buildDir));
});

test('no bundled manifest leaves ordinary engine startup available', async (t) => {
  const { options, manifestPath } = await fixture(t);
  await fs.rm(manifestPath);
  assert.equal(await prepareLiveEngine(options), undefined);
});

test('a stale executable symlink is replaced without writing through it', { skip: process.platform === 'win32' }, async (t) => {
  const { root, options } = await fixture(t);
  const protectedFile = path.join(root, 'do-not-change');
  const destinationDir = path.join(options.buildDir, 'enhanced-engine');
  await fs.writeFile(protectedFile, 'protected');
  await fs.mkdir(destinationDir, { recursive: true });
  await fs.symlink(protectedFile, path.join(destinationDir, executable));
  const destination = await prepareLiveEngine(options);
  assert.equal(await fs.readFile(protectedFile, 'utf8'), 'protected');
  assert.equal((await fs.lstat(destination!)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(destination!, 'utf8'), patched);
});
