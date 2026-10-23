import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

test('E2E runner removes only its successful work and preserves setup or launch failures', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rtex-e2e-runner-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = await build({
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)), entryPoints: ['test/e2e/runTest.ts'],
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent',
    plugins: [{ name: 'synthetic-vscode', setup(b) {
      b.onResolve({ filter: /^net$/ }, () => ({ path: 'net', namespace: 'synthetic-net' }));
      b.onLoad({ filter: /.*/, namespace: 'synthetic-net' }, () => ({ contents: `
        export const createServer = () => ({
          on() {}, listen(port, address, ready) { ready(); },
          address() { return { port: 12345 }; }, close(done) { done(); }
        });
      ` }));
      b.onResolve({ filter: /^@vscode\/test-electron$/ }, () => ({ path: 'test-electron', namespace: 'synthetic' }));
      b.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({ contents: `
        import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
        import path from 'node:path';
        export async function runTests(options) {
          const userData = options.launchArgs[options.launchArgs.indexOf('--user-data-dir') + 1];
          const logs = path.join(userData, 'logs', 'synthetic');
          mkdirSync(logs, { recursive: true });
          const log = path.join(logs, 'Realtime TeX Enhanced.log');
          if (process.env.RTEX_RUNNER_FAILURE === 'bad-log') symlinkSync(path.join(logs, 'missing.log'), log);
          else writeFileSync(log, 'synthetic engine diagnostic');
          writeFileSync(process.env.RTEX_RUNNER_REPORT, JSON.stringify(options));
          if (['launch', 'bad-log'].includes(process.env.RTEX_RUNNER_FAILURE)) throw new Error('synthetic launch failure');
        }
      ` }));
    } }],
  });
  for (const outcome of ['success', 'launch', 'setup', 'bad-log']) await t.test(outcome, async () => {
    const root = path.join(directory, outcome), scratch = path.join(root, 'scratch');
    const runner = path.join(root, 'out', 'e2e', 'runTest.cjs');
    const fixture = path.join(root, 'test', 'e2e', 'fixture');
    const original = path.join(fixture, 'main.tex');
    const extension = path.join(root, 'external-extension'), extensions = path.join(root, 'external-extensions');
    const previous = path.join(scratch, 'rtex-e2e-previous');
    for (const folder of [path.dirname(runner), extension, extensions, previous]) await mkdir(folder, { recursive: true });
    await writeFile(runner, bundle.outputFiles[0].text);
    for (const folder of [extension, extensions, previous]) await writeFile(path.join(folder, 'keep.txt'), 'keep');
    if (outcome !== 'setup') {
      await mkdir(fixture, { recursive: true });
      await writeFile(original, 'synthetic original source');
    }
    const report = path.join(root, 'launch.json');
    const result = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, TMPDIR: scratch, RTEX_RUNNER_FAILURE: outcome, RTEX_RUNNER_REPORT: report,
        RTEX_E2E_EXTENSION_PATH: extension, RTEX_E2E_EXTENSIONS_DIR: extensions } });
    assert.equal(result.error, undefined);
    assert.equal(result.status, outcome === 'success' ? 0 : 1, result.stderr);
    const remaining = (await readdir(scratch)).filter(name => name !== path.basename(previous));
    if (outcome === 'success') {
      assert.deepEqual(remaining, [], 'the successful profile and copied project must be deleted');
      assert.doesNotMatch(result.stderr, /kept for diagnosis/);
    } else {
      assert.equal(remaining.length, 1, 'the failed run must retain its own work directory');
      assert.ok(result.stderr.includes(`E2E test files kept for diagnosis: ${path.join(scratch, remaining[0])}`));
      if (outcome === 'launch' || outcome === 'bad-log') {
        assert.match(result.stderr, /synthetic launch failure/);
        if (outcome === 'launch') assert.match(result.stderr, /synthetic engine diagnostic/);
        else assert.match(result.stderr, /ENOENT/);
        assert.equal(await readFile(path.join(scratch, remaining[0], 'project', 'main.tex'), 'utf8'), 'synthetic original source');
      } else assert.match(result.stderr, /ENOENT/);
    }
    for (const folder of [extension, extensions, previous]) assert.equal(await readFile(path.join(folder, 'keep.txt'), 'utf8'), 'keep');
    if (outcome !== 'setup') {
      assert.equal(await readFile(original, 'utf8'), 'synthetic original source');
      const launch = JSON.parse(await readFile(report, 'utf8'));
      assert.equal(launch.extensionDevelopmentPath, extension);
      assert.equal(launch.extensionTestsEnv.RTEX_E2E_CDP_PORT, '12345');
      assert.ok(launch.launchArgs.includes('--remote-debugging-port=12345'));
      assert.ok(launch.launchArgs.includes(extensions));
      assert.equal(launch.launchArgs.filter(arg => arg === '--disable-backgrounding-occluded-windows').length, 1,
        'covered test windows must still deliver real animation frames and intersection notifications');
    }
  });
});
