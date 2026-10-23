import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const result = await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  stdin: { contents: "export { buildDirFor } from './src/config'; export { settings } from './test/bench/vscodeShim';", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
  alias: { vscode: './test/bench/vscodeShim.ts' },
});
const module = { exports: {} };
vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), process });
const { buildDirFor, settings } = module.exports;
const context = { storageUri: { fsPath: '/storage/workspace' }, globalStorageUri: { fsPath: '/storage/global' } };

test('default build directories distinguish complete paths with identical long suffixes', () => {
  const suffix = '/shared/' + 'long-directory-name/'.repeat(5) + 'main.tex';
  const first = '/projects/first' + suffix;
  const second = '/projects/other' + suffix;
  assert.equal(Buffer.from(first).toString('base64url').slice(-48), Buffer.from(second).toString('base64url').slice(-48));
  assert.notEqual(buildDirFor(context, first), buildDirFor(context, second));
  assert.equal(buildDirFor(context, first), buildDirFor(context, first));
  assert.equal(buildDirFor(context, first), buildDirFor(context, `${path.dirname(first)}/./main.tex`));
  assert.equal(path.dirname(buildDirFor(context, first)), '/storage/workspace/build');
  assert.equal(path.dirname(buildDirFor({ ...context, storageUri: undefined }, first)), '/storage/global/build');
});

test('configured build directories keep their absolute and main-relative meanings', () => {
  try {
    settings.set('buildDir', '/custom/build');
    assert.equal(buildDirFor(context, '/project/main.tex'), '/custom/build');
    settings.set('buildDir', 'local-build');
    assert.equal(buildDirFor(context, '/project/main.tex'), '/project/local-build');
  } finally {
    settings.delete('buildDir');
  }
});
