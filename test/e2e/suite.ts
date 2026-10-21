// Integration suite, run inside the VS Code extension host by runTest.ts.
import { execFile } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Api } from '../../src/extension';
import { processEnv, resolveServer } from '../../src/config';
import { getBundledRuntime } from '../../src/bundledRuntime';
import { runTask, sq } from '../../src/setup';

const shots = process.env.RTEX_E2E_OUT ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 60000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function screenshot(name: string): Promise<void> {
  if (!shots || !process.env.DISPLAY) return Promise.resolve();
  mkdirSync(shots, { recursive: true });
  return new Promise((resolve) => execFile('import', ['-window', 'root', path.join(shots, name)], () => resolve()));
}

async function insertAfter(doc: vscode.TextDocument, needle: string, text: string): Promise<void> {
  const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  const at = doc.positionAt(doc.getText().indexOf(needle) + needle.length);
  await editor.edit((e) => e.insert(at, text));
}

export async function run(): Promise<void> {
  try {
    await steps();
  } catch (e) {
    const s = vscode.extensions.getExtension<Api>('hengmamath.realtime-tex-enhanced')?.exports.session();
    console.log('[e2e] status at failure:', JSON.stringify(s?.status));
    await screenshot('failure.png');
    throw e;
  }
}

async function steps(): Promise<void> {
  const ext = vscode.extensions.getExtension<Api>('hengmamath.realtime-tex-enhanced')!;
  const api = await ext.activate();
  const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const steps: string[] = [];
  const step = (s: string) => {
    steps.push(s);
    console.log(`[e2e] ✓ ${s}`);
  };

  // a clean window for the screenshots
  for (const c of ['workbench.action.closeAuxiliaryBar', 'workbench.action.closeSidebar', 'workbench.action.closePanel']) {
    await vscode.commands.executeCommand(c).then(undefined, () => undefined);
  }

  // 1. open an included file and the preview: the main file is found through \input
  const intro = await vscode.workspace.openTextDocument(path.join(folder, 'intro.tex'));
  await vscode.window.showTextDocument(intro, vscode.ViewColumn.One);
  await vscode.commands.executeCommand('realtimeTex.openPreview');
  await waitFor('a session', () => api.session() !== undefined, 10000);
  const s = api.session()!;
  if (path.basename(s.mainFile) !== 'main.tex') throw new Error(`main file ${s.mainFile}`);
  step('main file found through \\input');
  await waitFor('the first layout', () => s.status.phase === 'live' && s.model.hasLayout, 120000);
  step(`first layout: ${s.model.pagesTotal} page(s)`);
  // type once the layout has settled, as a person would (an edit made while the layout is
  // still catching up goes to the full compile)
  await waitFor('the layout to settle', () => s.status.convergence?.state === 'Converged' && !s.status.pending, 120000);
  await sleep(1500);
  await vscode.commands.executeCommand('notifications.clearAll');
  await screenshot('1-preview.png');

  // 2. a keystroke in the main file takes the fast path
  const main = await vscode.workspace.openTextDocument(path.join(folder, 'main.tex'));
  await insertAfter(main, 'This paragraph is typeset', ' live and instantly');
  await waitFor('a fast update', () => s.status.lastFastMs !== undefined && s.model.overlays.size > 0, 30000);
  step(`fast update in ${s.status.lastFastMs!.toFixed(2)} ms`);
  await sleep(800);
  await screenshot('2-fast-edit.png');
  // the gutter marks the edited paragraph live and the preamble as waiting for the full compile
  const marks = await s.liveMarks(main);
  const at = (needle: string) => {
    const b = Buffer.byteLength(main.getText().slice(0, main.getText().indexOf(needle)));
    return marks.find((m) => m.span.range.start <= b && b < m.span.range.end)?.kind;
  };
  if (at('This paragraph is typeset') !== 'live') throw new Error(`edited paragraph marked ${at('This paragraph is typeset')}`);
  if (at('\\documentclass') !== 'full') throw new Error(`preamble marked ${at('\\documentclass')}`);
  step(`gutter: ${marks.filter((m) => m.kind === 'live').length} live part(s), ${marks.filter((m) => m.kind === 'full').length} on the full compile`);

  // 2b. live updates that change no diagnostic do not republish them (one Problems/markers
  // refresh per keystroke otherwise)
  const latestRevision = () => Math.max(0, ...[...s.model.overlays.values()].map((o) => o.revision));
  const diagnosticsNow = () => JSON.stringify(vscode.languages.getDiagnostics().map(([uri, list]) => [uri.toString(), list.map((d) => [d.severity, d.message, d.range.start.line])]));
  let lastDiagnostics = diagnosticsNow();
  let redundantRefreshes = 0;
  const diagnosticWatch = vscode.languages.onDidChangeDiagnostics(() => {
    const now = diagnosticsNow();
    if (now === lastDiagnostics) redundantRefreshes++;
    lastDiagnostics = now;
  });
  for (let i = 0; i < 3; i++) {
    const revision = latestRevision();
    await insertAfter(main, ' live and instantly', ' ok');
    await waitFor('a live update', () => latestRevision() > revision, 30000);
  }
  await sleep(300);
  diagnosticWatch.dispose();
  if (redundantRefreshes) throw new Error(`${redundantRefreshes} diagnostics refresh(es) without a change during live updates`);
  step('live updates leave unchanged diagnostics alone');

  // 2c. a live result TeX reports an error for keeps the part's last good rows on screen
  const hasError = () => vscode.languages.getDiagnostics(main.uri).some((d) => d.severity === vscode.DiagnosticSeverity.Error);
  const spanAt = async (needle: string) => {
    const b = Buffer.byteLength(main.getText().slice(0, main.getText().indexOf(needle)));
    return (await s.liveMarks(main)).find((m) => m.span.range.start <= b && b < m.span.range.end);
  };
  const typedPart = (await spanAt('This paragraph is typeset'))!.span.id;
  const rowsShown = () => (s.placements().get(typedPart) ?? []).reduce((n, frag) => n + frag.baselines.length, 0);
  const rowsBefore = rowsShown();
  await insertAfter(main, ' live and instantly', ' $x^$');
  await waitFor('a live error', hasError, 30000);
  if (rowsShown() !== rowsBefore) throw new Error(`a live error left ${rowsShown()} of ${rowsBefore} rows of the part on screen`);
  if (!(await s.revealInPreview(main, main.positionAt(main.getText().indexOf('This paragraph is typeset') + 3), false))) {
    throw new Error('the part lost its place in the preview during a live error');
  }
  const editor0 = await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
  const badAt = main.getText().indexOf(' $x^$');
  await editor0.edit((e) => e.delete(new vscode.Range(main.positionAt(badAt), main.positionAt(badAt + ' $x^$'.length))));
  await waitFor('the live error to clear', () => !hasError(), 30000);
  step(`a live error kept the part's ${rowsBefore} row(s) on screen`);

  // 2d. math ending inside \left( (on the way to \left( ... \right)) is an error, not a crash
  // that would leave the part on the full compile until the preamble changes
  await insertAfter(main, ' live and instantly', ' $\\left( a$');
  await waitFor('the live \\left error', hasError, 30000);
  const revision = latestRevision();
  const closeAt = main.getText().indexOf('\\left( a$') + '\\left( a'.length;
  await editor0.edit((e) => e.insert(main.positionAt(closeAt), ' \\right)'));
  await waitFor('the completed formula typeset live', () => latestRevision() > revision && !hasError(), 30000);
  const recovered = await spanAt('This paragraph is typeset');
  if (recovered?.kind !== 'live') throw new Error(`after \\left( the part is marked ${recovered?.kind}: ${recovered?.reasons?.join(', ')}`);
  step('an unclosed \\left( stayed a live error and the part stayed live');

  // 3. cursor → preview and preview → source
  const editor = await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
  const pos = main.positionAt(main.getText().indexOf('A second paragraph') + 5);
  editor.selection = new vscode.Selection(pos, pos);
  if (!(await s.revealInPreview(main, pos, true))) throw new Error('revealInPreview failed');
  step('cursor position shown in the preview');
  const placements = s.placements();
  const [parId, frags] = [...placements].find(([, f]) => f.length > 0)!;
  const f = frags[0];
  if (!(await s.jumpToSource(f.page, f.xs[0], f.baselines[0]))) throw new Error('jumpToSource failed');
  const active = vscode.window.activeTextEditor!;
  step(`preview click on unit ${parId} opened ${path.basename(active.document.fileName)}:${active.selection.active.line + 1}`);

  // 4. an error shows up in the Problems panel, and goes away when fixed
  await insertAfter(main, 'A second paragraph refers', ' \\undefinedmacroxyz{}');
  await waitFor('an error diagnostic', () => vscode.languages.getDiagnostics(main.uri).some((d) => d.severity === vscode.DiagnosticSeverity.Error), 60000);
  step('LaTeX error reported as a diagnostic');
  await sleep(500);
  await screenshot('3-error.png');
  const ed2 = await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
  const start = main.getText().indexOf(' \\undefinedmacroxyz{}');
  await ed2.edit((e) => e.delete(new vscode.Range(main.positionAt(start), main.positionAt(start + ' \\undefinedmacroxyz{}'.length))));
  await waitFor('the error to clear', () => !vscode.languages.getDiagnostics(main.uri).some((d) => d.severity === vscode.DiagnosticSeverity.Error), 60000);
  step('diagnostic cleared after the fix');

  // 5. a TikZ page is shown from the PDF (pdf.js under the webview's CSP)
  if (s.model.pagesTotal >= 2) {
    const pageTwo = s.model.pages.get(2);
    if (pageTwo?.exact) throw new Error('the TikZ page should be degraded');
    await api.panel()!.panel.webview.postMessage({ type: 'reveal', page: 2, x: 0, y: 0, force: true });
    await sleep(2500);
    await screenshot('4-pdf-fallback.png');
    step('TikZ page shown from the PDF');
  }

  // 6. export
  const pdf = await s.exportPdf();
  if (!pdf || !existsSync(pdf)) throw new Error(`export produced no PDF (${pdf})`);
  step(`exported ${path.basename(pdf)}`);

  // 7. a full compile that fails after the first layout keeps the pages. RTEX_E2E_SKIP_FAILED_PASS=1
  // skips it: rtex (e5cab6a through b858819) reports the body-only pass after a breaking preamble edit as Ok
  // with the previous pages
  if (!process.env.RTEX_E2E_SKIP_FAILED_PASS) {
    const pagesBefore = s.model.pagesTotal;
    await insertAfter(main, '\\usepackage{tikz}', '\n\\stop');
    await waitFor('a failed full compile', () => s.status.compile?.state === 'Failed', 120000);
    if (s.model.pagesTotal !== pagesBefore) throw new Error(`pages dropped: ${pagesBefore} -> ${s.model.pagesTotal}`);
    step(`failed compile kept the ${pagesBefore} page(s) on screen`);
    await sleep(800);
    await screenshot('4b-failed-pass-banner.png');
    const ed3 = await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
    const bad = main.getText().indexOf('\n\\stop');
    await ed3.edit((e) => e.delete(new vscode.Range(main.positionAt(bad), main.positionAt(bad + '\n\\stop'.length))));
    await waitFor('a good full compile again', () => s.status.compile?.state === 'Ok', 120000);
    step('recovered after the preamble was fixed');
  }

  // 8. closing the preview stops the engine
  api.panel()!.panel.dispose();
  await waitFor('the engine to stop', () => !s.running, 10000);
  step('engine stopped when the preview closed');

  // 9. a document whose first compile fails explains why instead of waiting forever
  const broken = path.join(folder, 'broken.tex');
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(broken),
    // \stop ends the run in the preamble: no page at all
    Buffer.from('\\documentclass{article}\n\\stop\n\\begin{document}\nHello\n\\end{document}\n'),
  );
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(broken), vscode.ViewColumn.One);
  await vscode.commands.executeCommand('realtimeTex.openPreview');
  await waitFor('a session for broken.tex', () => api.session()?.mainFile === broken, 10000);
  const sb = api.session()!;
  await waitFor('the failure screen', () => sb.screen.screen === 'error', 120000);
  if (sb.screen.title !== 'The document produced no pages' || !sb.screen.message) throw new Error(`unexpected screen: ${JSON.stringify(sb.screen)}`);
  step(`failed first compile explained: ${sb.screen.message}`);
  await sleep(800);
  await screenshot('5-first-compile-failed.png');

  // 10. the terminal tasks of Install rtex / Install TeX Live reach bash intact (Git Bash on
  // Windows): quotes, command substitution and a path with a space
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'rtex task ')), "it's here.txt");
  if (!(await runTask('Realtime TeX task check', path.dirname(out), `set -e; v="it's ok"; echo "$v $(echo nested)" > ${sq(out)}`))) throw new Error('the task failed');
  const got = existsSync(out) ? readFileSync(out, 'utf8').trim() : '(no file)';
  if (got !== "it's ok nested") throw new Error(`the task wrote ${got}`);
  step(`setup task ran in ${process.platform === 'win32' ? 'Git Bash' : 'bash'}`);

  // 11. A fresh installation uses the verified executable AND its matching support tree
  // from the extension, without a managed engine checkout, download, or explicit paths.
  await vscode.commands.executeCommand('realtimeTex.stop');
  const state = new Map<string, unknown>();
  const fakeCtx = {
    extensionPath: ext.extensionPath,
    extensionUri: vscode.Uri.file(ext.extensionPath),
    globalStorageUri: vscode.Uri.file(mkdtempSync(path.join(os.tmpdir(), 'rtex storage '))),
    globalState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => void state.set(k, v) },
  } as unknown as vscode.ExtensionContext;
  const cfg = vscode.workspace.getConfiguration('realtimeTex');
  const previousServer = cfg.get<string>('serverPath');
  const previousTexDir = cfg.get<string>('texDir');
  await cfg.update('serverPath', '', vscode.ConfigurationTarget.Global);
  await cfg.update('texDir', '', vscode.ConfigurationTarget.Global);
  try {
    const runtime = getBundledRuntime(ext.extensionPath);
    if (!runtime) throw new Error('this enhanced release has no bundled runtime for this platform');
    const selected = resolveServer(fakeCtx);
    if (selected?.path !== runtime.path) throw new Error('a clean installation did not select the bundled executable');
    if (processEnv(fakeCtx, selected).RTEX_TEXDIR !== runtime.texDir) throw new Error('the bundled executable was not paired with its support tree');
    step(`fresh storage selected the verified bundled engine ${runtime.version}`);
    await cfg.update('serverPath', runtime.path, vscode.ConfigurationTarget.Global);
    await cfg.update('texDir', path.join(fakeCtx.globalStorageUri.fsPath, 'stale-custom-support'), vscode.ConfigurationTarget.Global);
    const explicitBundle = resolveServer(fakeCtx);
    if (explicitBundle?.path !== runtime.path || processEnv(fakeCtx, explicitBundle).RTEX_TEXDIR !== runtime.texDir) {
      throw new Error('an explicitly selected bundled executable was mixed with stale custom support');
    }
    step('explicit bundled executable retains its matching support despite stale settings');
    await cfg.update('serverPath', '', vscode.ConfigurationTarget.Global);
    await cfg.update('texDir', '', vscode.ConfigurationTarget.Global);
    await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('realtimeTex.openPreview');
    await waitFor('a session on the bundled rtex', () => api.session()?.mainFile === main.fileName && api.session()!.running, 20000);
    const sr = api.session()!;
    await waitFor('its first layout', () => sr.status.phase === 'live' && sr.model.hasLayout, 120000);
    await waitFor('the layout to settle', () => sr.status.convergence?.state === 'Converged' && !sr.status.pending, 120000);
    await insertAfter(main, 'A second paragraph refers', ' quickly');
    await waitFor('a fast update from the bundled rtex', () => sr.status.lastFastMs !== undefined, 30000);
    step(`bundled rtex typesets live (${sr.status.lastFastMs!.toFixed(2)} ms)`);
  } finally {
    await cfg.update('serverPath', previousServer, vscode.ConfigurationTarget.Global);
    await cfg.update('texDir', previousTexDir, vscode.ConfigurationTarget.Global);
  }
  console.log(`[e2e] all ${steps.length} steps passed`);
}
