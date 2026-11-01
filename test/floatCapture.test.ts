import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { prepareTestRuntime, realEngineUnavailable } from './runtimeFixture';

const exec = promisify(execFile);

for (const fixture of [
  { name: 'kernel', documentClass: 'article', float: false, inject: true },
  { name: 'float loaded after capture', documentClass: 'article', float: true, inject: true },
  { name: 'float loaded before capture', documentClass: 'article', float: true, inject: false },
  { name: 'IEEEtran class resets', documentClass: 'IEEEtran', float: false, inject: true },
]) {
  test(`float capture preserves placement arguments and box resets: ${fixture.name}`, {
    skip: realEngineUnavailable, timeout: 90000,
  }, async () => {
    const root = path.resolve(__dirname, '..', '..');
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rtex-float-capture-'));
    try {
      const { texDir } = await prepareTestRuntime(root);
      const cache = path.join(temporary, 'texmf-cache');
      await fs.mkdir(cache);
      const floats = [
        ['figure', '[tbp]'], ['table', '[!htbp]'],
        ['figure*', '[t]'], ['table*', '[t]'], ['figure', ''],
        ...(fixture.float ? [['figure', '[H]'], ['table', '[H]']] : []),
      ];
      await fs.writeFile(path.join(temporary, 'main.tex'), [
        `\\documentclass{${fixture.documentClass}}`,
        ...(fixture.float ? ['\\usepackage{float}'] : []),
        ...(!fixture.inject ? ['\\usepackage{rtex-capture}'] : []),
        '\\begin{document}', 'Text before.\\par',
        ...floats.flatMap(([name, placement]) => [
          `\\begin{${name}}${placement}`, '\\centering Float content.',
          '\\caption{A synthetic float}', `\\end{${name}}`,
        ]),
        'Text after.\\end{document}',
      ].join('\n'));
      const bin = process.env.RTEX_TEST_TEXLIVE_BIN;
      const executable = bin ? path.join(bin, 'lualatex') : 'lualatex';
      const { stdout } = await exec(executable, [
        '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-jobname=main',
        ...(fixture.inject ? ['\\RequirePackage{rtex-capture}\\input{main.tex}'] : ['main.tex']),
      ], {
        cwd: temporary, timeout: 60000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, TEXINPUTS: `${texDir}//:`, LUAINPUTS: `${texDir}//:`,
          TEXMFVAR: cache, TEXMFCACHE: cache, RTEX_CAPTURE_DIR: '.' },
      });
      assert.doesNotMatch(stdout, /Unknown float option/);
      const capture = JSON.parse(await fs.readFile(path.join(temporary, 'main.rtex.json'), 'utf8'));
      const units = capture.units.filter((unit: { name?: string }) => /^(figure|table)\*?$/.test(unit.name ?? ''));
      assert.deepEqual(units.map((unit: { name: string }) => unit.name), floats.map(([name]) => name));
      assert.ok(units.every((unit: { rows: number }) => unit.rows > 0), 'each float must retain captured drawing rows');
      if (fixture.documentClass === 'IEEEtran') {
        const resets: Record<string, string> = {};
        for (const unit of capture.units) {
          Object.assign(resets, unit.macros);
          if (unit.name === 'table' || unit.name === 'table*') {
            assert.match(resets['@floatboxreset'], /\\footnotesize/, 'tables must retain the class-local reset');
          } else if (unit.name === 'figure' || unit.name === 'figure*') {
            assert.match(resets['@floatboxreset'], /\\@IEEEfiguretopskipspace/, 'figures must retain the class-local reset');
          }
        }
      }
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });
}
