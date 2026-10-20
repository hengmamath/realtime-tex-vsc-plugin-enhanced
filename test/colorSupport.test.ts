import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, TestContext } from 'node:test';
import { prepareColorSupport } from '../src/colorSupport';

async function fixture(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rtex-color-support-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'extension', 'resources', 'rtex-color'), { recursive: true });
  await fs.writeFile(path.join(root, 'extension', 'resources', 'rtex-color', 'rtex-dl.lua'), '-- patched traversal\n');
  await fs.writeFile(path.join(root, 'extension', 'resources', 'rtex-color', 'rtex-serve.lua'), '-- patched serve\n');
  await fs.writeFile(path.join(root, 'extension', 'resources', 'rtex-color', 'rtex-dl-bin.lua'), '-- patched binary writer\n');
  return root;
}

test('unknown custom support files stay untouched and are not overlaid', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'custom-tex');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'rtex-dl.lua'), '-- customized engine traversal\n');
  const result = await prepareColorSupport({
    serverPath: path.join(root, 'release', 'bin', 'rtex'),
    texDir: source,
    buildDir: path.join(root, 'build'),
    extensionPath: path.join(root, 'extension'),
  });
  assert.equal(result, undefined);
  assert.equal(await fs.readFile(path.join(source, 'rtex-dl.lua'), 'utf8'), '-- customized engine traversal\n');
  await assert.rejects(fs.access(path.join(root, 'build')));
});

test('missing support files leave engine startup available', async (t) => {
  const root = await fixture(t);
  assert.equal(await prepareColorSupport({
    serverPath: path.join(root, 'release', 'bin', 'rtex'),
    buildDir: path.join(root, 'build'),
    extensionPath: path.join(root, 'extension'),
  }), undefined);
});

// Optional integration fixture: the original rtex v0.0.5 support folder. This exercises
// the real checksum guard without maintaining another copy of the upstream traversal.
const originalTexDir = process.env.RTEX_TEST_TEXDIR;
for (const layout of ['release', 'checkout', 'custom'] as const) {
  test(`recognized ${layout} support is copied with its paired traversal and serve fixes`, { skip: !originalTexDir }, async (t) => {
    const root = await fixture(t);
    const source = layout === 'release' ? path.join(root, 'engine', 'share', 'rtex', 'tex') :
      layout === 'checkout' ? path.join(root, 'engine', 'tex') : path.join(root, 'custom-tex');
    await fs.cp(originalTexDir!, source, { recursive: true });
    await fs.mkdir(path.join(source, 'nested'), { recursive: true });
    await fs.writeFile(path.join(source, 'nested', 'keep.txt'), 'original support file');
    const original = await fs.readFile(path.join(source, 'rtex-dl.lua'));
    const originalServe = await fs.readFile(path.join(source, 'rtex-serve.lua'));
    const originalBinary = await fs.readFile(path.join(source, 'rtex-dl-bin.lua'));
    const buildDir = path.join(root, 'build');
    const options = {
      serverPath: layout === 'checkout' ? path.join(root, 'engine', 'target', 'release', 'rtex') :
        path.join(root, 'engine', 'bin', 'rtex'),
      texDir: layout === 'custom' ? source : undefined,
      buildDir,
      extensionPath: path.join(root, 'extension'),
    };
    const destination = await prepareColorSupport(options);
    assert.equal(destination, path.join(buildDir, 'tex-color-support'));
    assert.equal(await fs.readFile(path.join(destination!, 'rtex-dl.lua'), 'utf8'), '-- patched traversal\n');
    assert.equal(await fs.readFile(path.join(destination!, 'rtex-serve.lua'), 'utf8'), '-- patched serve\n');
    assert.equal(await fs.readFile(path.join(destination!, 'rtex-dl-bin.lua'), 'utf8'), '-- patched binary writer\n');
    assert.equal(await fs.readFile(path.join(destination!, 'nested', 'keep.txt'), 'utf8'), 'original support file');
    assert.deepEqual(await fs.readFile(path.join(source, 'rtex-dl.lua')), original);
    assert.deepEqual(await fs.readFile(path.join(source, 'rtex-serve.lua')), originalServe);
    assert.deepEqual(await fs.readFile(path.join(source, 'rtex-dl-bin.lua')), originalBinary);
    assert.equal(createHash('sha256').update(original).digest('hex'), 'bfe5ab8833cfe54f63bb8bb85b5f4243d4e4d30c8c8d550bcc2804d448169239');

    // Repeated starts replace the disposable overlay rather than retaining stale files.
    await fs.writeFile(path.join(destination!, 'stale.tmp'), 'old support');
    assert.equal(await prepareColorSupport(options), destination);
    await assert.rejects(fs.access(path.join(destination!, 'stale.tmp')));
    assert.deepEqual(await fs.readdir(buildDir), ['tex-color-support']);
  });
}

test('explicit unknown texDir does not fall back to an inferred release tree', { skip: !originalTexDir }, async (t) => {
  const root = await fixture(t);
  await fs.cp(originalTexDir!, path.join(root, 'engine', 'share', 'rtex', 'tex'), { recursive: true });
  const custom = path.join(root, 'custom-tex');
  await fs.mkdir(custom);
  await fs.writeFile(path.join(custom, 'rtex-dl.lua'), '-- custom engine\n');
  assert.equal(await prepareColorSupport({
    serverPath: path.join(root, 'engine', 'bin', 'rtex'),
    texDir: custom,
    buildDir: path.join(root, 'build'),
    extensionPath: path.join(root, 'extension'),
  }), undefined);
  await assert.rejects(fs.access(path.join(root, 'build')));
});

test('a symlinked original traversal is replaced without writing through it', { skip: !originalTexDir || process.platform === 'win32' }, async (t) => {
  const root = await fixture(t);
  const original = await fs.readFile(path.join(originalTexDir!, 'rtex-dl.lua'));
  const originalFile = path.join(root, 'original.lua');
  await fs.writeFile(originalFile, original);
  const source = path.join(root, 'custom-tex');
  await fs.mkdir(source);
  await fs.symlink(originalFile, path.join(source, 'rtex-dl.lua'));
  await fs.copyFile(path.join(originalTexDir!, 'rtex-serve.lua'), path.join(source, 'rtex-serve.lua'));
  await fs.copyFile(path.join(originalTexDir!, 'rtex-dl-bin.lua'), path.join(source, 'rtex-dl-bin.lua'));
  const destination = await prepareColorSupport({
    serverPath: path.join(root, 'rtex'),
    texDir: source,
    buildDir: path.join(root, 'build'),
    extensionPath: path.join(root, 'extension'),
  });
  assert.equal(await fs.readFile(path.join(destination!, 'rtex-dl.lua'), 'utf8'), '-- patched traversal\n');
  assert.deepEqual(await fs.readFile(originalFile), original);
  assert.equal((await fs.lstat(path.join(destination!, 'rtex-dl.lua'))).isSymbolicLink(), false);
});

test('customized serve support cannot be mixed with the enhanced engine', { skip: !originalTexDir }, async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'custom-tex');
  await fs.cp(originalTexDir!, source, { recursive: true });
  const original = await fs.readFile(path.join(source, 'rtex-dl.lua'));
  await fs.writeFile(path.join(source, 'rtex-serve.lua'), '-- custom serve\n');
  await assert.rejects(prepareColorSupport({
    serverPath: path.join(root, 'rtex'),
    texDir: source,
    buildDir: path.join(root, 'build'),
    extensionPath: path.join(root, 'extension'),
  }), /Unrecognized rtex-serve.lua/);
  assert.deepEqual(await fs.readFile(path.join(source, 'rtex-dl.lua')), original);
  assert.equal(await fs.readFile(path.join(source, 'rtex-serve.lua'), 'utf8'), '-- custom serve\n');
  await assert.rejects(fs.access(path.join(root, 'build')));
});

test('a symlinked serve file is replaced without changing its target', { skip: !originalTexDir || process.platform === 'win32' }, async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'custom-tex');
  await fs.cp(originalTexDir!, source, { recursive: true });
  const original = await fs.readFile(path.join(source, 'rtex-serve.lua'));
  const originalFile = path.join(root, 'original-serve.lua');
  await fs.writeFile(originalFile, original);
  await fs.rm(path.join(source, 'rtex-serve.lua'));
  await fs.symlink(originalFile, path.join(source, 'rtex-serve.lua'));
  const destination = await prepareColorSupport({
    serverPath: path.join(root, 'rtex'),
    texDir: source,
    buildDir: path.join(root, 'build'),
    extensionPath: path.join(root, 'extension'),
  });
  assert.equal(await fs.readFile(path.join(destination!, 'rtex-serve.lua'), 'utf8'), '-- patched serve\n');
  assert.deepEqual(await fs.readFile(originalFile), original);
  assert.equal((await fs.lstat(path.join(destination!, 'rtex-serve.lua'))).isSymbolicLink(), false);
});

test('customized binary transport cannot be mixed with the enhanced engine', { skip: !originalTexDir }, async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'custom-tex');
  await fs.cp(originalTexDir!, source, { recursive: true });
  await fs.writeFile(path.join(source, 'rtex-dl-bin.lua'), '-- custom transport\n');
  await assert.rejects(prepareColorSupport({
    serverPath: path.join(root, 'rtex'), texDir: source, buildDir: path.join(root, 'build'),
    extensionPath: path.join(root, 'extension'),
  }), /Unrecognized rtex-dl-bin.lua/);
  assert.equal(await fs.readFile(path.join(source, 'rtex-dl-bin.lua'), 'utf8'), '-- custom transport\n');
  await assert.rejects(fs.access(path.join(root, 'build')));
});

test('a symlinked binary writer is replaced without changing its target', { skip: !originalTexDir || process.platform === 'win32' }, async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'custom-tex');
  await fs.cp(originalTexDir!, source, { recursive: true });
  const originalFile = path.join(root, 'original-binary.lua');
  const original = await fs.readFile(path.join(source, 'rtex-dl-bin.lua'));
  await fs.writeFile(originalFile, original);
  await fs.rm(path.join(source, 'rtex-dl-bin.lua'));
  await fs.symlink(originalFile, path.join(source, 'rtex-dl-bin.lua'));
  const destination = await prepareColorSupport({
    serverPath: path.join(root, 'rtex'), texDir: source, buildDir: path.join(root, 'build'),
    extensionPath: path.join(root, 'extension'),
  });
  assert.equal(await fs.readFile(path.join(destination!, 'rtex-dl-bin.lua'), 'utf8'), '-- patched binary writer\n');
  assert.deepEqual(await fs.readFile(originalFile), original);
  assert.equal((await fs.lstat(path.join(destination!, 'rtex-dl-bin.lua'))).isSymbolicLink(), false);
});
