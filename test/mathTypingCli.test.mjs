import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

test('math benchmark CLI rejects invalid options and failed scenarios', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rtex-benchmark-cli-'));
  const label = `cli-regression-${path.basename(dir)}`;
  const report = path.join(dir, 'live-test', 'math-typing', label);
  try {
    const cli = path.join(dir, 'out', 'bench', 'mathTyping.cjs');
    await build({
      entryPoints: ['test/bench/mathTyping.ts'], outfile: cli,
      bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent',
      alias: { vscode: './test/bench/vscodeShim.ts' },
      plugins: [{
        name: 'synthetic-startup-failure',
        setup(b) {
          b.onResolve({ filter: /^\.\.\/\.\.\/src\/session$/ }, () => ({ path: 'session', namespace: 'failed-session' }));
          b.onLoad({ filter: /.*/, namespace: 'failed-session' }, () => ({ contents: `
            export class Session {
              onOutput() {} onStatus() {} dispose() {}
              async start() { throw new Error('synthetic scenario failure'); }
            }
          ` }));
        },
      }],
    });
    const invoke = (args) => spawnSync(process.execPath, [cli, '--label', label, ...args], { encoding: 'utf8', timeout: 10000 });
    for (const [args, message] of [
      [['--cadence', 'invalid'], /unknown cadence/],
      [['--cadence', 'short,'], /unknown cadence/],
      [['--scenario', 'no-such-scenario'], /unknown scenario/],
      [['--scenario', 'inline-dollar,no-such-scenario'], /unknown scenario/],
      [['--rounds', '0'], /positive integer/],
      [['--rounds', 'NaN'], /positive integer/],
      [['--rounds', '1.5'], /positive integer/],
      [['--scenario'], /requires a value/],
      [['--cadence', '--rounds', '1'], /requires a value/],
      [['--unknown', 'value'], /unknown option/],
      [['--rounds', '1', '--rounds', '2'], /specified twice/],
    ]) {
      const result = invoke(args);
      assert.equal(result.status, 1, `${args}: ${result.stderr}`);
      assert.match(result.stderr, message);
      assert.doesNotMatch(result.stdout, /wrote|PROBLEM/);
    }
    const failed = invoke(['--scenario', 'inline-dollar', '--cadence', 'short']);
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stdout, /PROBLEM synthetic scenario failure/);
    const summary = JSON.parse(await readFile(path.join(report, 'summary.json'), 'utf8'));
    assert.equal(summary.results.length, 1);
    assert.equal(summary.results[0].ok, false);
    assert.deepEqual(summary.results[0].problems, ['synthetic scenario failure']);
  } finally {
    await rm(report, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
