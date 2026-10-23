import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = await fs.promises.readFile(path.join(root, 'src/extension.ts'), 'utf8');
// Expose the real command helper only in this bundle, without adding a production API.
const { outputFiles } = await build({ absWorkingDir: root,
  stdin: { contents: `${source}\nexport { mainFileFor }; export * as vscode from '../test/bench/vscodeShim';`,
    resolveDir: path.join(root, 'src'), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent',
  alias: { vscode: './test/bench/vscodeShim.ts' } });
const require = createRequire(import.meta.url);

function harness({ disk = {}, buffers = {}, folder = '/p', configured = '' } = {}) {
  const reads = [], scans = [];
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, { module, exports: module.exports, process, Buffer,
    require(id) {
      if (id !== 'fs') return require(id);
      return { ...fs, promises: { ...fs.promises, async readFile(file) {
        reads.push(file);
        if (!(file in disk)) throw new Error(`Missing synthetic file: ${file}`);
        return disk[file];
      } } };
    } });
  const { mainFileFor, vscode } = module.exports;
  vscode.settings.set('mainFile', configured);
  vscode.workspace.getWorkspaceFolder = () => folder ? { uri: vscode.Uri.file(folder) } : undefined;
  vscode.workspace.textDocuments = Object.entries(buffers).map(([fileName, text]) => ({ fileName, getText: () => text }));
  vscode.workspace.findFiles = async (...args) => {
    scans.push(args);
    return Object.keys(disk).map(file => vscode.Uri.file(file));
  };
  return { reads, scans, vscode, resolve: file => mainFileFor(vscode.Uri.file(file)) };
}

test('configured roots retain folder-relative resolution without reads or workspace scans', async () => {
  for (const [folder, configured, expected] of [
    ['/p/book', ' main.tex ', '/p/book/main.tex'],
    [undefined, '../main.tex', '/p/main.tex'],
    ['/p/book', '/elsewhere/main.tex', '/elsewhere/main.tex'],
  ]) {
    const h = harness({ folder: folder ?? '', configured });
    assert.equal(await h.resolve('/p/chapters/chapter.tex'), expected);
    assert.equal(h.scans.length, 0);
    assert.equal(h.reads.length, 0);
  }
});

test('an active main or resolved magic-root chain skips scanning and respects unsaved buffers', async () => {
  const main = '\\documentclass{article}\n';
  for (const options of [
    { disk: { '/p/active.tex': main }, expected: '/p/active.tex' },
    { disk: { '/p/active.tex': 'Saved chapter.' }, buffers: { '/p/active.tex': main }, expected: '/p/active.tex' },
    { disk: { '/p/active.tex': '% !TEX root = bridge\n', '/p/bridge.tex': '% !TEX root = book/main.tex\n', '/p/book/main.tex': main }, expected: '/p/book/main.tex' },
    { disk: { '/p/active.tex': '% !TEX root = wrong.tex\n' },
      buffers: { '/p/active.tex': '% !TEX root = unsaved.tex\n', '/p/unsaved.tex': main }, expected: '/p/unsaved.tex' },
  ]) {
    const h = harness(options);
    h.vscode.workspace.findFiles = async () => { assert.fail('a resolved root must not enumerate the workspace'); };
    assert.equal(await h.resolve('/p/active.tex'), options.expected);
  }
});

test('chapter fallback scans once with the existing scope, exclusions and limit', async () => {
  const h = harness({ disk: {
    '/p/book/chapter.tex': 'A chapter.',
    '/p/book/main.tex': '\\documentclass{book}\n\\input{chapter}',
    '/p/longer-other/main.tex': '\\documentclass{book}\n\\input{chapter}',
  } });
  assert.equal(await h.resolve('/p/book/chapter.tex'), '/p/book/main.tex');
  assert.equal(h.scans.length, 1);
  assert.deepEqual(Array.from(h.scans[0]), ['**/*.tex', '{**/node_modules/**,**/.git/**,**/build/**}', 500]);
});

test('unresolved magic roots retain fallback selection and multi-main ambiguity', async () => {
  for (const active of [undefined, 'Plain chapter.', '% !TEX root = missing.tex', '% !TEX root = active.tex']) {
    for (const ambiguous of [false, true]) {
      const disk = { '/p/main.tex': '\\documentclass{article}' };
      if (active !== undefined) disk['/p/active.tex'] = active;
      if (ambiguous) disk['/p/other.tex'] = '\\documentclass{book}';
      const h = harness({ disk });
      assert.equal(await h.resolve('/p/active.tex'), ambiguous ? undefined : '/p/main.tex');
      assert.equal(h.scans.length, 1);
    }
  }
});

test('an unsaved main removal falls back, and workspace search failures still propagate', async () => {
  const h = harness({ disk: { '/p/active.tex': '\\documentclass{article}', '/p/main.tex': '\\documentclass{book}' },
    buffers: { '/p/active.tex': 'Unsaved chapter.' } });
  assert.equal(await h.resolve('/p/active.tex'), '/p/main.tex');
  assert.equal(h.scans.length, 1);
  const error = new Error('workspace search failed');
  h.vscode.workspace.findFiles = async () => { throw error; };
  await assert.rejects(h.resolve('/p/active.tex'), error);
});
