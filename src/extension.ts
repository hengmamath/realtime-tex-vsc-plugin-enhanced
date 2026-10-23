import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { cfg, debugDir, followCursorMode, isTexDocument, platformSupported, processEnv, resolveServer } from './config';
import { cursorGesturePosition } from './cursorGesture';
import { PreviewPanel, VIEW_TYPE } from './preview/panel';
import { ResourceLoader } from './resources';
import { findMainFile, isMainFile } from './root';
import { Session } from './session';
import { buildFromSource, checkSetup, installRtex, selectServerPath, updateRtex } from './setup';
import { StatusBar } from './statusBar';

let ctx: vscode.ExtensionContext;
let log: vscode.OutputChannel;
let diagnostics: vscode.DiagnosticCollection;
let statusBar: StatusBar;
let session: Session | undefined;
let sessionSubs: vscode.Disposable[] = [];
let panel: PreviewPanel | undefined;
let loader: { session: Session; loader: ResourceLoader } | undefined;
let lastTexDoc: vscode.Uri | undefined;
let runningContext: boolean | undefined;

/** Handles for the integration tests. */
export interface Api {
  session(): Session | undefined;
  panel(): PreviewPanel | undefined;
}

export function activate(context: vscode.ExtensionContext): Api {
  // Shared command/settings names preserve existing workflows. Only one variant may run.
  if (vscode.extensions.getExtension('henryxiaoyang.realtime-tex')) {
    void vscode.window.showErrorMessage(
      'Realtime TeX Enhanced: disable the original Realtime TeX extension, then reload VS Code to use the enhanced version.',
      'Show Original Extension',
    ).then((choice) => {
      if (choice) void vscode.commands.executeCommand('workbench.extensions.search', '@id:henryxiaoyang.realtime-tex');
    });
    return { session: () => undefined, panel: () => undefined };
  }
  ctx = context;
  log = vscode.window.createOutputChannel('Realtime TeX Enhanced');
  diagnostics = vscode.languages.createDiagnosticCollection('realtime-tex');
  statusBar = new StatusBar();
  context.subscriptions.push(log, diagnostics, statusBar, { dispose: () => session?.dispose() });

  const reg = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('realtimeTex.openPreview', (uri?: vscode.Uri) => openPreview(uri, true));
  reg('realtimeTex.openPreviewHere', (uri?: vscode.Uri) => openPreview(uri, false));
  reg('realtimeTex.exportPdf', () => withSession((s) => s.exportPdf()));
  reg('realtimeTex.recompile', () => withSession((s) => s.recompile()));
  reg('realtimeTex.restart', () => (session ? session.restart() : openPreview(undefined, true)));
  reg('realtimeTex.stop', async () => {
    await session?.stop();
    updateUi();
  });
  reg('realtimeTex.showLog', () => log.show(true));
  reg('realtimeTex.openLatexLog', () => withSession((s) => s.openLatexLog(), true));
  reg('realtimeTex.openDebugFolder', () => openDebugFolder());
  reg('realtimeTex.checkSetup', () => checkSetup(ctx));
  // a new engine takes effect when the running (or failed) session restarts; a stopped one stays stopped
  const restartAfterBuild = () => void (session && (session.running || session.status.phase === 'failed') ? session.restart().then(updateUi) : undefined);
  reg('realtimeTex.installRtex', () => installRtex(ctx, restartAfterBuild));
  reg('realtimeTex.buildFromSource', () => buildFromSource(ctx, restartAfterBuild));
  reg('realtimeTex.updateRtex', () => updateRtex(ctx, restartAfterBuild));
  reg('realtimeTex.selectServerPath', async () => {
    if ((await selectServerPath(ctx)) && session) await session.restart();
  });
  reg('realtimeTex.selectMainFile', () => selectMainFile());
  reg('realtimeTex.syncToPreview', () => syncToPreview(true));
  reg('realtimeTex.navigateBack', () => panel?.navigate('back'));
  reg('realtimeTex.navigateForward', () => panel?.navigate('forward'));
  reg('realtimeTex.gettingStarted', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${ctx.extension.id}#realtimeTex.welcome`, false));

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => session?.onDidChangeDocument(e)),
    vscode.workspace.onDidOpenTextDocument((d) => session?.onDidOpenDocument(d)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('realtimeTex.followCursor') || e.affectsConfiguration('realtimeTex.syncCursor')) cancelSync();
      const engineSettings = ['realtimeTex.engine', 'realtimeTex.debug', 'realtimeTex.texliveBin', 'realtimeTex.buildDir'];
      if (!session?.running || !engineSettings.some((k) => e.affectsConfiguration(k))) return;
      vscode.window.setStatusBarMessage('$(sync~spin) Restarting the engine with the new settings…', 4000);
      void session.restart().then(updateUi);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => void session?.onDidCloseDocument(d)),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      cancelSync();
      if (ed && isTexDocument(ed.document)) {
        lastTexDoc = ed.document.uri;
        void maybeAutoStart(ed.document);
      }
      updateUi();
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      cancelSync();
      // Source navigation, typing and keyboard movement must not feed back into the preview.
      if (e.kind === vscode.TextEditorSelectionChangeKind.Mouse) scheduleSync(e);
    }),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(webviewPanel) {
        panel = new PreviewPanel(ctx, panelHost, webviewPanel);
        const main = ctx.workspaceState.get<string>('realtimeTex.lastMainFile');
        if (main && (await exists(main))) await startFor(main);
        else panel.showScreen(noFileScreen());
      },
    }),
  );

  const ed = vscode.window.activeTextEditor;
  if (ed && isTexDocument(ed.document)) {
    lastTexDoc = ed.document.uri;
    void maybeAutoStart(ed.document);
  }
  updateUi();
  void welcome();
  // Engine updates are delivered only as a tested, complete enhanced extension.
  return { session: () => session, panel: () => panel };
}

export function deactivate(): Promise<void> | undefined {
  cancelSync();
  return session?.stop();
}

// ---------------------------------------------------------------------------------------------

const panelHost = {
  get log() {
    return log;
  },
  resources(s: Session): ResourceLoader {
    if (loader?.session !== s) loader = { session: s, loader: new ResourceLoader(processEnv(ctx, resolveServer(ctx)), (m) => log.appendLine(m)) };
    return loader.loader;
  },
  onPanelClosed(p: PreviewPanel) {
    if (panel !== p) return;
    cancelSync();
    panel = undefined;
    if (cfg().get<boolean>('stopWhenPreviewCloses', true) && !cfg().get<boolean>('autoStart', false)) {
      void session?.stop().then(updateUi);
    }
  },
};

function updateUi(): void {
  const ed = vscode.window.activeTextEditor;
  statusBar.update(session?.status, !!ed && isTexDocument(ed.document));
  // status changes on every live update; the context only when the engine starts or stops
  const running = !!session?.running;
  if (running !== runningContext) {
    runningContext = running;
    void vscode.commands.executeCommand('setContext', 'realtimeTex.running', running);
  }
}

async function withSession(fn: (s: Session) => unknown, evenIfStopped = false): Promise<void> {
  if (session && evenIfStopped) {
    await fn(session);
    return;
  }
  if (!session?.running) {
    const pick = await vscode.window.showWarningMessage('The live preview is not running.', 'Open Live Preview');
    if (pick) await openPreview(undefined, true);
    return;
  }
  await fn(session);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function noFileScreen() {
  return {
    screen: 'noMain' as const,
    title: 'Open a LaTeX file to preview it',
    message: 'Open a .tex file in an editor, then click the preview button in its title bar or press Cmd+Alt+V.',
    actions: [{ label: 'Choose Main File…', command: 'realtimeTex.selectMainFile', primary: true }],
  };
}

/** Which .tex file the user means: the explorer selection, the active editor, the last one. */
function targetDocument(uri?: vscode.Uri): vscode.Uri | undefined {
  if (uri && uri.scheme === 'file' && /\.tex$/i.test(uri.fsPath)) return uri;
  const ed = vscode.window.activeTextEditor;
  if (ed && isTexDocument(ed.document)) return ed.document.uri;
  return lastTexDoc;
}

async function readText(file: string): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.fileName === file);
  if (open) return open.getText();
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

async function texCandidates(): Promise<string[]> {
  const uris = await vscode.workspace.findFiles('**/*.tex', '{**/node_modules/**,**/.git/**,**/build/**}', 500);
  return uris.map((u) => u.fsPath);
}

async function mainFileFor(doc: vscode.Uri): Promise<string | undefined> {
  const folder = vscode.workspace.getWorkspaceFolder(doc)?.uri.fsPath ?? path.dirname(doc.fsPath);
  const configured = cfg(doc).get<string>('mainFile', '').trim();
  const query = {
    activeFile: doc.fsPath,
    configured: configured ? path.resolve(folder, configured) : undefined,
    readFile: readText,
  };
  const direct = await findMainFile({ ...query, candidates: [] });
  return direct ?? findMainFile({ ...query, candidates: await texCandidates() });
}

async function openPreview(uri: vscode.Uri | undefined, beside: boolean): Promise<void> {
  const column = beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
  if (!panel) panel = PreviewPanel.create(ctx, panelHost, column, true);
  else panel.reveal(true);

  if (!platformSupported()) {
    panel.showScreen({ screen: 'unsupported', message: `This enhanced release supports Apple Silicon Mac (darwin-arm64). Detected ${process.platform}-${process.arch}.` });
    return;
  }
  const doc = targetDocument(uri);
  if (!doc) {
    if (session) panel.attach(session);
    else panel.showScreen(noFileScreen());
    return;
  }
  const main = await mainFileFor(doc);
  if (!main) {
    panel.showScreen({
      screen: 'noMain',
      message: `${path.basename(doc.fsPath)} has no \\documentclass, and no single main file includes it. Choose the main file of this project (you can also add "% !TEX root = main.tex" at the top of ${path.basename(doc.fsPath)}).`,
      actions: [{ label: 'Choose Main File…', command: 'realtimeTex.selectMainFile', primary: true }],
    });
    return;
  }
  await startFor(main);
}

async function startFor(main: string): Promise<void> {
  if (!session || session.mainFile !== main) {
    session?.dispose();
    for (const d of sessionSubs) d.dispose();
    diagnostics.clear();
    session = new Session(ctx, main, log, diagnostics);
    sessionSubs = [session.onStatus(() => updateUi())];
    void ctx.workspaceState.update('realtimeTex.lastMainFile', main);
  }
  panel?.attach(session);
  if (!session.running) await session.start();
  updateUi();
}

async function maybeAutoStart(doc: vscode.TextDocument): Promise<void> {
  if (!cfg(doc.uri).get<boolean>('autoStart', false) || session?.running) return;
  if (!platformSupported()) return;
  const main = await mainFileFor(doc.uri);
  if (main && resolveServer(ctx)) await startFor(main);
}

async function selectMainFile(): Promise<void> {
  const files = await texCandidates();
  const items: (vscode.QuickPickItem & { file: string; main: boolean })[] = [];
  for (const f of files) {
    const main = isMainFile((await readText(f)) ?? '');
    items.push({
      label: path.basename(f),
      description: vscode.workspace.asRelativePath(path.dirname(f)),
      detail: main ? '$(file-text) has \\documentclass' : undefined,
      file: f,
      main,
    });
  }
  items.sort((a, b) => Number(b.main) - Number(a.main) || a.label.localeCompare(b.label));
  if (items.length === 0) {
    void vscode.window.showWarningMessage('There are no .tex files in this workspace.');
    return;
  }
  const pick = await vscode.window.showQuickPick(items, { title: 'Main file of the LaTeX project', placeHolder: 'The file with \\documentclass and \\begin{document}' });
  if (!pick) return;
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(pick.file));
  if (folder) {
    await cfg(folder.uri).update('mainFile', path.relative(folder.uri.fsPath, pick.file), vscode.ConfigurationTarget.WorkspaceFolder);
  }
  await openPreview(vscode.Uri.file(pick.file), true);
}

let syncTimer: ReturnType<typeof setTimeout> | undefined;
function cancelSync(): void {
  clearTimeout(syncTimer);
  syncTimer = undefined;
}

function scheduleSync(event: vscode.TextEditorSelectionChangeEvent): void {
  const editor = event.textEditor;
  if (!session?.running || !panel || !isTexDocument(editor.document)) return;
  const mode = followCursorMode(editor.document.uri);
  const position = cursorGesturePosition(mode, event.selections, (pos) => editor.document.getWordRangeAtPosition(pos));
  if (!position) return;
  const currentSession = session, currentPanel = panel, version = editor.document.version;
  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    if (session !== currentSession || panel !== currentPanel || !currentSession.running
      || vscode.window.activeTextEditor !== editor || editor.document.version !== version
      || followCursorMode(editor.document.uri) !== mode) return;
    // Share the manual command's positioning and highlight behavior, keeping editor focus.
    void currentSession.revealInPreview(editor.document, position, true);
  }, 150);
}

async function syncToPreview(force: boolean): Promise<void> {
  cancelSync();
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isTexDocument(ed.document)) return;
  if (!session?.running || !panel) {
    await openPreview(ed.document.uri, true);
    return;
  }
  panel.reveal(true);
  const ok = await session.revealInPreview(ed.document, ed.selection.active, force);
  if (!ok) vscode.window.setStatusBarMessage('$(info) This part of the source has no position in the preview yet.', 3000);
}

async function openDebugFolder(): Promise<void> {
  const dir = debugDir(ctx);
  if (!dir) {
    const pick = await vscode.window.showInformationMessage(
      'Debugging is off. Turn it on to have rtex save a bundle (source, context, trace, TeX log) whenever the live engine hangs or crashes.',
      'Turn On Debugging',
    );
    if (pick) {
      await cfg().update('debug.enabled', true, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(`Debugging is on. Bundles go to ${debugDir(ctx)}.`);
    }
    return;
  }
  await fs.mkdir(dir, { recursive: true });
  void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
}

async function welcome(): Promise<void> {
  const key = 'realtimeTex.welcomed';
  if (ctx.globalState.get<boolean>(key)) return;
  await ctx.globalState.update(key, true);
  // let a preview that is being opened right now speak for itself
  await new Promise((r) => setTimeout(r, 3000));
  if (panel) return;
  if (!resolveServer(ctx)) {
    void vscode.commands.executeCommand('workbench.action.openWalkthrough', `${ctx.extension.id}#realtimeTex.welcome`, false);
    return;
  }
  const pick = await vscode.window.showInformationMessage(
    'Realtime TeX is ready: open the live preview with the preview button in the editor title or Cmd+Alt+V.',
    'Open Live Preview',
    'Get Started',
  );
  if (pick === 'Open Live Preview') void openPreview(undefined, true);
  if (pick === 'Get Started') void vscode.commands.executeCommand('workbench.action.openWalkthrough', `${ctx.extension.id}#realtimeTex.welcome`, false);
}
