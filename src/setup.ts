// Verify the offline bundled runtime and help the user locate LuaLaTeX.
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { cfg, exe, platformSupported, processEnv, type ServerLocation } from './config';
import { getBundledRuntime } from './bundledRuntime';

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 15000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
  });
}

type CheckState = 'pass' | 'warn' | 'fail';

interface Check {
  title: string;
  state: CheckState;
  detail: string;
  fix?: { label: string; run: () => unknown };
}

export async function runChecks(ctx: vscode.ExtensionContext): Promise<Check[]> {
  const checks: Check[] = [];
  const supported = platformSupported();
  checks.push({
    title: 'Operating system',
    state: supported ? 'pass' : 'fail',
    detail: supported ? 'Apple Silicon macOS — bundled enhanced runtime' : `This enhanced release supports Apple Silicon macOS (darwin-arm64), not ${process.platform}-${process.arch}.`,
  });

  // one verification (it hashes the engine and every support file)
  let server: ServerLocation | undefined;
  let runtimeError: string | undefined;
  try { server = getBundledRuntime(ctx.extensionUri.fsPath); }
  catch (error) { runtimeError = error instanceof Error ? error.message : String(error); }
  if (!server) {
    checks.push({
      title: 'rtex engine',
      state: 'fail',
      detail: runtimeError ?? 'The bundled runtime is unavailable on this platform. Install a compatible Realtime TeX Enhanced release.',
      fix: { label: 'Verify bundled runtime', run: () => vscode.commands.executeCommand('realtimeTex.installRtex') },
    });
  } else {
    const v = await run(server.path, ['--version']);
    checks.push({
      title: 'rtex engine',
      state: v.ok ? 'pass' : 'fail',
      detail: v.ok
        ? `${v.stdout.trim()} (bundled; updates with the enhanced extension) — ${server.path}`
        : `cannot run ${server.path}: ${v.stderr.trim() || 'unknown error'}`,
      fix: v.ok ? undefined : { label: 'Verify bundled runtime', run: () => vscode.commands.executeCommand('realtimeTex.installRtex') },
    });
  }

  const env = processEnv(ctx, server);
  const lua = await run('lualatex', ['--version'], env);
  if (!lua.ok) {
    checks.push({
      title: 'LuaLaTeX (TeX Live)',
      state: 'fail',
      detail: 'lualatex was not found. Install TeX Live (2026+ recommended; regressions also tested on 2025), or choose its executable folder.',
      fix: { label: 'Fix…', run: () => fixTexLive(ctx) },
    });
  } else {
    const first = lua.stdout.split('\n')[0].trim();
    const year = Number(/TeX Live (\d{4})/.exec(lua.stdout)?.[1] ?? 0);
    checks.push({
      title: 'LuaLaTeX (TeX Live)',
      state: year && year < 2025 ? 'warn' : 'pass',
      detail: year && year < 2025 ? `${first} — this release has regression coverage on TeX Live 2025; TeX Live 2026+ is recommended` : first,
      fix: year && year < 2025 ? { label: 'Fix…', run: () => fixTexLive(ctx) } : undefined,
    });
  }

  if (server) {
    checks.push({
      title: 'rtex TeX files',
      state: 'pass',
      detail: `${server.texDir} — complete matching support verified with the bundled engine`,
    });
  }

  if (lua.ok) {
    const map = await run('kpsewhich', ['pdftex.map'], env);
    checks.push({
      title: 'Type1 font map',
      state: map.ok && map.stdout.trim() ? 'pass' : 'warn',
      detail:
        map.ok && map.stdout.trim()
          ? 'math in Computer Modern renders live'
          : 'pdftex.map not found: pages using classic Computer Modern math are shown from the PDF',
    });
  }
  return checks;
}

const STATE_ICON: Record<CheckState, string> = { pass: '$(pass-filled)', warn: '$(warning)', fail: '$(error)' };

export async function checkSetup(ctx: vscode.ExtensionContext): Promise<void> {
  const checks = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Checking Realtime TeX setup…' }, () => runChecks(ctx));
  const ok = checks.every((c) => c.state !== 'fail');
  type Item = vscode.QuickPickItem & { check?: Check; open?: boolean };
  const items: Item[] = checks.map((c) => ({
    label: `${STATE_ICON[c.state]} ${c.title}`,
    detail: c.detail,
    description: c.fix ? `→ ${c.fix.label}` : undefined,
    check: c,
  }));
  if (ok) items.push({ label: '$(open-preview) Open Live Preview', detail: 'Everything needed is in place.', open: true });
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = ok ? 'Realtime TeX is ready' : 'Realtime TeX setup — select an item to fix it';
  qp.items = items;
  qp.matchOnDetail = true;
  qp.onDidAccept(() => {
    const it = qp.selectedItems[0];
    qp.hide();
    if (it?.open) void vscode.commands.executeCommand('realtimeTex.openPreview');
    else void it?.check?.fix?.run();
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

async function fixTexLive(ctx: vscode.ExtensionContext): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(folder-opened) I have TeX Live — choose its bin folder…', id: 'choose' },
      { label: '$(link-external) Download TeX Live from tug.org', id: 'web' },
    ],
    { title: 'Choose LuaLaTeX (TeX Live 2026+ recommended; 2025 also tested)' },
  );
  if (pick?.id === 'choose') {
    const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, title: 'Folder that contains lualatex (for MacTeX: /Library/TeX/texbin)' });
    if (uri?.[0]) {
      if (!existsSync(path.join(uri[0].fsPath, exe('lualatex')))) {
        void vscode.window.showWarningMessage(`There is no lualatex in ${uri[0].fsPath}.`);
        return;
      }
      await cfg().update('texliveBin', uri[0].fsPath, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage('TeX Live folder saved.');
    }
  } else if (pick?.id === 'web') {
    void vscode.env.openExternal(vscode.Uri.parse('https://tug.org/texlive/'));
  }
}

/** Verify the shipped pair. This command never accesses the network, clones source,
 * updates another installation, or changes an executable outside this extension. */
export async function installRtex(ctx: vscode.ExtensionContext, onDone: () => void): Promise<void> {
  try {
    const runtime = getBundledRuntime(ctx.extensionUri.fsPath);
    if (!runtime) {
      void vscode.window.showErrorMessage(`This enhanced release supports Apple Silicon macOS (darwin-arm64), not ${process.platform}-${process.arch}.`);
      return;
    }
    const version = await run(runtime.path, ['--version']);
    if (!version.ok) throw new Error(`The bundled engine cannot run: ${version.stderr.trim() || 'unknown error'}`);
    const lua = await run('lualatex', ['--version'], processEnv(ctx, runtime));
    if (!lua.ok) {
      const pick = await vscode.window.showWarningMessage(`Bundled enhanced runtime ${runtime.version} is verified. LuaLaTeX is also required (TeX Live 2026+ recommended; regressions also tested on 2025).`, 'Set Up TeX Live');
      if (pick) await fixTexLive(ctx);
      return;
    }
    onDone();
    void vscode.window.showInformationMessage(`Bundled enhanced runtime ${runtime.version} is verified and ready. It updates only with Realtime TeX Enhanced.`);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not verify the bundled runtime: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Compatibility alias for old command links. Rebuilds use the saved, patched source
 * documented in the repository; no upstream checkout is downloaded by the extension. */
export async function buildFromSource(ctx: vscode.ExtensionContext, onDone: () => void): Promise<void> {
  await installRtex(ctx, onDone);
}

/** Compatibility alias: engine and support are upgraded only as part of a new VSIX. */
export async function updateRtex(ctx: vscode.ExtensionContext, _onDone: () => void): Promise<void> {
  try {
    const runtime = getBundledRuntime(ctx.extensionUri.fsPath);
    void vscode.window.showInformationMessage(runtime
      ? `This extension includes enhanced runtime ${runtime.version}. To update it, install a new Realtime TeX Enhanced release; upstream engine updates are disabled.`
      : 'This enhanced release supports Apple Silicon macOS. Install a compatible enhanced extension release.');
  } catch (error) {
    void vscode.window.showErrorMessage(`Bundled runtime verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Old command links now verify the bundled pair instead of choosing another engine. */
export async function selectServerPath(ctx: vscode.ExtensionContext): Promise<boolean> {
  let verified = false;
  await installRtex(ctx, () => { verified = true; });
  return verified;
}
