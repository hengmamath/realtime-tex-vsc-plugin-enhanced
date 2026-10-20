#!/usr/bin/env node
// Verify the preserved source and the engine/TeX pair without contacting upstream.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(root, 'vendor', 'engine');
const sourceManifestPath = path.join(sourceRoot, 'SOURCE.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (name) => JSON.parse(await readFile(name, 'utf8'));
const within = (base, relative) => {
  assert(relative && !path.isAbsolute(relative) && !relative.split(/[\\/]/u).includes('..'), `Unsafe relative path: ${relative}`);
  return path.join(base, relative);
};
const args = new Set(process.argv.slice(2));
for (const arg of args) assert(['--refresh-source', '--source-only'].includes(arg), `Unknown argument: ${arg}`);
const source = await readJson(sourceManifestPath);
assert.equal(source.schemaVersion, 1);
assert.equal(source.upstream.commit, 'e0ad11765ec016846b6e07619081f0528621636b');
assert.equal(source.upstream.license, 'MIT');

for (const [name, record] of Object.entries(source.files)) {
  const actual = sha256(await readFile(within(sourceRoot, name)));
  if (args.has('--refresh-source')) record.sha256 = actual;
  else assert.equal(actual, record.sha256, `Preserved source changed: ${name}. Review the change and run --refresh-source deliberately.`);
}
const patchHash = sha256(await readFile(within(root, source.patch.path)));
if (args.has('--refresh-source')) {
  source.patch.sha256 = patchHash;
  await writeFile(sourceManifestPath, `${JSON.stringify(source, null, 2)}\n`);
} else assert.equal(patchHash, source.patch.sha256, 'The preserved patch does not match SOURCE.json');
const cargo = await readFile(path.join(sourceRoot, 'Cargo.toml'), 'utf8');
assert(cargo.includes(`version = "${source.enhancedVersion}"`), 'Cargo version does not match SOURCE.json');
await readFile(path.join(sourceRoot, 'Cargo.lock'));
await readFile(path.join(sourceRoot, 'LICENSE'));

// Only the reviewed manifest, source files and local build outputs may be present.
async function checkSourceTree(directory, relative = '') {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = relative ? `${relative}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw new Error(`Unexpected symbolic link in preserved source: ${name}`);
    if (item.isDirectory()) {
      if (!relative && ['target', 'dist', 'build'].includes(item.name)) continue;
      await checkSourceTree(path.join(directory, item.name), name);
    } else assert(name in source.files || ['SOURCE.json', 'README.enhanced.md'].includes(name), `Unreviewed engine source file: ${name}`);
  }
}
await checkSourceTree(sourceRoot);

if (!args.has('--source-only')) {
  const engine = await readJson(path.join(root, 'resources', 'rtex-engine', 'manifest.json'));
  const runtime = await readJson(path.join(root, 'resources', 'rtex-runtime', 'manifest.json'));
  assert.equal(engine.version, source.enhancedVersion);
  assert.equal(runtime.version, source.enhancedVersion);
  assert.equal(runtime.platform, engine.platform);
  const binary = path.join(root, 'resources', 'rtex-engine', engine.platform, 'rtex');
  assert.equal(sha256(await readFile(binary)), engine.sha256, 'Bundled engine checksum mismatch');
  assert.equal(runtime.engine.sha256, engine.sha256, 'Runtime and engine manifests do not match');
  const runtimeBase = path.join(root, 'resources', 'rtex-runtime');
  assert.equal(path.resolve(runtimeBase, runtime.engine.relativePath), binary, 'Runtime references an unexpected engine binary');
  const expectedTex = Object.keys(source.files).filter((name) => name.startsWith('tex/') && !name.startsWith('tex/experiments/') && !name.startsWith('tex/tests/')).map((name) => name.slice(4)).sort();
  assert.deepEqual(Object.keys(runtime.texFiles).sort(), expectedTex, 'Runtime must include every matching TeX support file');
  for (const name of expectedTex) {
    const preserved = await readFile(within(path.join(sourceRoot, 'tex'), name));
    const bundled = await readFile(within(path.join(runtimeBase, 'tex'), name));
    assert.equal(sha256(bundled), sha256(preserved), `Runtime does not match preserved source: tex/${name}`);
    assert.equal(runtime.texFiles[name], sha256(bundled), `Runtime checksum mismatch: tex/${name}`);
  }
  // Keep the legacy overlay source available for reviewing the original enhancement.
  for (const name of ['rtex-dl.lua', 'rtex-dl-bin.lua', 'rtex-serve.lua']) {
    assert.equal(sha256(await readFile(path.join(root, 'resources', 'rtex-color', name))), sha256(await readFile(path.join(sourceRoot, 'tex', name))), `Preserved overlay differs: ${name}`);
  }
  console.log(`Verified ${Object.keys(source.files).length} engine source files, ${expectedTex.length} matching TeX support files and the bundled ${engine.platform} engine.`);
} else console.log(`Verified ${Object.keys(source.files).length} engine source files and the preserved enhancement patch.`);
