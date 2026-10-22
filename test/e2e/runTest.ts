// Runs the integration suite in a real VS Code with the real rtex engine.
// Uses only the complete engine shipped in the extension, with fresh VS Code storage.
// RTEX_E2E_TEXLIVE_BIN selects the folder containing lualatex.
import { runTests } from '@vscode/test-electron';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..', '..');
  const extensionPath = process.env.RTEX_E2E_EXTENSION_PATH ?? root;
  const tlbin = process.env.RTEX_E2E_TEXLIVE_BIN ?? '';
  const work = mkdtempSync(path.join(os.tmpdir(), 'rtex-e2e-'));
  const workspace = path.join(work, 'project');
  cpSync(path.join(root, 'test', 'e2e', 'fixture'), workspace, { recursive: true });
  const userData = path.join(work, 'user-data');
  mkdirSync(path.join(userData, 'User'), { recursive: true });
  writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({
      'realtimeTex.texliveBin': tlbin,
      'workbench.startupEditor': 'none',
      'security.workspace.trust.enabled': false,
      'window.zoomLevel': 0,
    }),
  );
  try {
    await runTests({
      vscodeExecutablePath: process.env.RTEX_E2E_VSCODE,
      extensionDevelopmentPath: extensionPath,
      extensionTestsPath: path.join(root, 'out', 'e2e', 'suite.js'),
      launchArgs: [workspace, '--user-data-dir', userData, '--disable-extensions', '--disable-gpu',
        ...(process.env.RTEX_E2E_EXTENSIONS_DIR ? ['--extensions-dir', process.env.RTEX_E2E_EXTENSIONS_DIR] : [])],
    });
  } catch (e) {
    // the extension's output channel (what rtex said) is the first thing to read on a failure
    for (const log of findFiles(path.join(userData, 'logs'), /Realtime TeX(?: Enhanced)?\.log$/)) {
      console.error(`----- ${log}\n${readFileSync(log, 'utf8').split('\n').slice(-150).join('\n')}`);
    }
    throw e;
  }
}

function findFiles(dir: string, re: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? findFiles(p, re) : re.test(d.name) ? [p] : [];
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
