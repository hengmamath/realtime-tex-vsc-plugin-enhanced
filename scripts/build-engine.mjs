#!/usr/bin/env node
// Build our preserved engine source; never fetch the upstream repository.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(root, 'vendor', 'engine');
const args = process.argv.slice(2);
if (args.length) throw new Error('This script builds for the current computer only and takes no arguments. Cross-platform releases require a separate tested runtime manifest.');
const run = (command, parameters, cwd) => {
  const result = spawnSync(command, parameters, { cwd, stdio: 'inherit' });
  if (result.error) throw new Error(`Unable to run ${command}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run(process.execPath, [path.join(root, 'scripts', 'verify-engine.mjs'), '--source-only'], root);
run('cargo', ['build', '-p', 'rtex-cli', '--profile', 'dist', '--locked'], sourceRoot);
const executable = path.join(sourceRoot, 'target', 'dist', process.platform === 'win32' ? 'rtex.exe' : 'rtex');
run(executable, ['--version'], sourceRoot);
const source = JSON.parse(await readFile(path.join(sourceRoot, 'SOURCE.json'), 'utf8'));
console.log(`Built preserved engine ${source.enhancedVersion}: ${path.relative(root, executable)}`);
console.log('The released binary and manifests were not changed. Follow vendor/engine/README.enhanced.md before staging a new engine release.');
