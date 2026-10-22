// One rtex session for one main file: keeps rtex's buffers in sync with VS Code, turns events
// into diagnostics and status, and forwards display lists to the preview.
import { execFile } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PreviewModel } from '../webview/model';
import { buildDirFor, debugDir, engineArgs, exportPathFor, processEnv, resolveServer, ServerLocation } from './config';
import { ShadowText } from './edits';
import { LiveGutter } from './gutter';
import type { LiveMark } from './liveMarks';
import type { Action, ScreenKind } from './messages';
import type {
  Diagnostic as RtexDiagnostic,
  EditResult,
  Fragment,
  LayoutUpdateEvent,
  ParagraphUpdateEvent,
  PdfExportedEvent,
  Reply,
  RtexEvent,
  Span,
} from './protocol';
import { ExitInfo, RtexProcess } from './rtexProcess';
import type { PreviewTarget } from './sourceMap';
import { advanceBackgroundSourceRevision, hitSourceAnchor, SourceLineJournal, sourceLineChanges, targetSourceAnchor } from './sourceAnchors';
import { refineSourceSelection } from './sourceRefinement';
import { refineClosingDisplay, targetClosingDisplay } from './sourceMathBlock';
import { shiftSpans } from './spanShift';
import { explainReasons, Phase, SessionStatus } from './status';

export interface Screen {
  screen: ScreenKind | null;
  title?: string;
  message?: string;
  detail?: string;
  actions?: Action[];
}

/** What the preview needs to hear about. */
export type SessionOutput =
  | { kind: 'layout'; ev: LayoutUpdateEvent; keepFromRevision: number | null; pdfPath: string }
  | { kind: 'paragraph'; ev: ParagraphUpdateEvent }
  | { kind: 'dropOverlays' }
  /** Document inputs (figures, bibliographies…) changed on disk: absolute paths. */
  | { kind: 'inputsChanged'; files: string[] }
  | { kind: 'reveal'; target: PreviewTarget; force: boolean }
  | { kind: 'banner'; text: string | null; level?: 'info' | 'warn' | 'error'; actions?: Action[] };

const ACTIONS = {
  showLog: { label: 'Show Log', command: 'realtimeTex.showLog' },
  restart: { label: 'Restart', command: 'realtimeTex.restart', primary: true },
  checkSetup: { label: 'Check Setup', command: 'realtimeTex.checkSetup' },
  problems: { label: 'Show Problems', command: 'workbench.actions.view.problems', primary: true },
  recompile: { label: 'Recompile', command: 'realtimeTex.recompile' },
} satisfies Record<string, Action>;

export class Session implements vscode.Disposable {
  readonly projectRoot: string;
  readonly mainRel: string;
  readonly buildDir: string;
  /** Pages, placements and overlays (same rules as the webview; used to replay and to sync). */
  readonly model = new PreviewModel();

  private proc: RtexProcess | undefined;
  private server: ServerLocation | undefined;
  private shadows = new Map<string, ShadowText>();
  private readonly sourceLines = new SourceLineJournal();
  /** A captured file is already an engine input. Opening it for a source click must not
   * replace that buffer (and invalidate the click) just because it was previously closed. */
  private readonly openingSourceFiles = new Set<string>();
  /** Text the engine holds for each closed .tex file (sent by the watcher or settled on close). */
  private diskTexts = new Map<string, string>();
  /** Spans per file as the engine reported them, shifted by later acknowledged edits that kept
   * every boundary (`shiftSpans`); a fetch is made only when they are unknown. */
  private spansKnown = new Map<string, Span[]>();
  /** The latest spans request per file, and how many edits had been sent before it. */
  private spansFetch = new Map<string, { promise: Promise<Span[]>; sent: number }>();
  /** Edits sent and not acknowledged yet, per file: until they are, only a fetch (queued after
   * them) gives the current spans. */
  private editsInFlight = new Map<string, number>();
  private editsSent = new Map<string, number>();
  /** The host asked for a full compile (Recompile, a changed input, a preamble edit, a new
   * file), which always delivers a layout: a live result computed before the engine saw the
   * request must not clear the pending state meanwhile. */
  private hostPass = false;
  /** Revision of the latest edit routed to the background: only results of that revision or
   * later know whether its pass is still pending. */
  private pendingFromRevision = 0;
  private generation = -1;
  private bgDiagnosticsThisPass = false;
  private diags = new Map<string, RtexDiagnostic[]>();
  private exports = new Map<number, (ev: PdfExportedEvent) => void>();
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  private startedAt = 0;
  private autoRestarted = false;
  private disposed = false;
  /** Gutter markers: which parts of the source update live. */
  private readonly gutter: LiveGutter;

  private statusValue: SessionStatus = { phase: 'idle', pending: false, errorCount: 0 };
  private screenValue: Screen = { screen: null };

  private readonly outputEmitter = new vscode.EventEmitter<SessionOutput>();
  readonly onOutput = this.outputEmitter.event;
  private readonly statusEmitter = new vscode.EventEmitter<SessionStatus>();
  readonly onStatus = this.statusEmitter.event;
  private readonly screenEmitter = new vscode.EventEmitter<Screen>();
  readonly onScreen = this.screenEmitter.event;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    readonly mainFile: string,
    private readonly log: vscode.OutputChannel,
    private readonly diagnostics: vscode.DiagnosticCollection,
  ) {
    this.projectRoot = path.dirname(mainFile);
    this.mainRel = path.basename(mainFile);
    this.buildDir = buildDirFor(ctx, mainFile);
    this.statusValue.mainName = this.mainRel;
    this.gutter = new LiveGutter(vscode.Uri.joinPath(ctx.extensionUri, 'media'), {
      relPath: (doc) => this.relPath(doc),
      spans: (rel) => this.spans(rel),
      shadow: (rel) => this.shadows.get(rel),
      running: () => this.running,
    });
  }

  get status(): SessionStatus {
    return this.statusValue;
  }

  get screen(): Screen {
    return this.screenValue;
  }

  get running(): boolean {
    return this.proc?.running ?? false;
  }

  get pdfPath(): string {
    return path.join(this.buildDir, 'bg', path.basename(this.mainRel, path.extname(this.mainRel)) + '.pdf');
  }

  /** rtex wrote a debug bundle for an engine failure (watchdog, state mismatch, crash). */
  private announceDebugBundle(dir: string, reason: string): void {
    const what = firstLine(reason.replace(/\s*\(debug bundle: .+\)\s*$/, ''));
    void vscode.window
      .showWarningMessage(`The live engine was restarted (${what}). A debug bundle was saved.`, 'Reveal Bundle', 'Copy Path')
      .then((pick) => {
        if (pick === 'Reveal Bundle') void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
        if (pick === 'Copy Path') void vscode.env.clipboard.writeText(dir);
      });
  }

  /** The log of the background compile (LuaLaTeX's own .log). */
  get latexLogPath(): string {
    return path.join(this.buildDir, 'bg', path.basename(this.mainRel, path.extname(this.mainRel)) + '.log');
  }

  async openLatexLog(): Promise<void> {
    if (!existsSync(this.latexLogPath)) {
      void vscode.window.showInformationMessage('LuaLaTeX has not written a log yet. The extension log has what rtex reported so far.', 'Show Log').then((p) => {
        if (p) this.log.show(true);
      });
      return;
    }
    const doc = await vscode.workspace.openTextDocument(this.latexLogPath);
    const ed = await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
    // the end of the log is where a run stops
    const end = new vscode.Position(doc.lineCount - 1, 0);
    ed.revealRange(new vscode.Range(end, end), vscode.TextEditorRevealType.InCenter);
  }

  // -------------------------------------------------------------------------------------------
  // lifecycle

  async start(): Promise<void> {
    if (this.running || this.disposed) return;
    // A new engine session cannot retain diagnostics from the previous process.
    this.diags.clear();
    this.diagnostics.clear();
    this.statusValue.errorCount = 0;
    this.bgDiagnosticsThisPass = false;
    this.server = resolveServer(this.ctx);
    if (!this.server) {
      this.setPhase('failed');
      this.setScreen({
        screen: 'notInstalled',
        message:
          'This enhanced release requires its verified engine and matching support files for Apple Silicon macOS. Run Check Setup to inspect the bundle, or reinstall Realtime TeX Enhanced if files are missing or damaged.',
        actions: [
          { label: 'Verify Bundled Runtime', command: 'realtimeTex.installRtex', primary: true },
          ACTIONS.checkSetup,
        ],
      });
      return;
    }
    await fs.mkdir(this.buildDir, { recursive: true });
    const env = processEnv(this.ctx, this.server);
    this.log.appendLine(`[start] bundled enhanced runtime ${this.server.version}: ${env.RTEX_TEXDIR}`);
    this.log.appendLine(`[start] ${this.server.path} serve --project ${this.projectRoot} --main ${this.mainRel} --build ${this.buildDir}${engineArgs(vscode.Uri.file(this.mainFile)).map((a) => ' ' + a).join('')}`);
    if (env.RTEX_TEXLIVE_BIN) this.log.appendLine(`[start] TeX Live: ${env.RTEX_TEXLIVE_BIN}`);
    const dbg = debugDir(this.ctx);
    if (dbg) {
      await fs.mkdir(dbg, { recursive: true }).catch(() => undefined);
      env.RTEX_DEBUG_DIR = dbg;
      this.log.appendLine(`[start] debug: engine failure bundles and requests.log go to ${dbg}`);
    } else {
      delete env.RTEX_DEBUG_DIR;
    }
    execFile('lualatex', ['--version'], { env, timeout: 10000 }, (err, stdout) => {
      this.log.appendLine(`[start] ${err ? `lualatex --version failed: ${err.message}` : String(stdout).split('\n')[0]}`);
    });
    const extraArgs = engineArgs(vscode.Uri.file(this.mainFile));
    const proc = new RtexProcess({ serverPath: this.server.path, projectRoot: this.projectRoot, mainFile: this.mainRel, buildDir: this.buildDir, extraArgs, env });
    this.proc = proc;
    proc.on('event', (ev: RtexEvent) => this.onEvent(ev));
    proc.on('stderr', (line: string) => this.log.appendLine(line));
    proc.on('exit', (info: ExitInfo) => this.onExit(proc, info));
    this.startedAt = Date.now();
    this.generation = -1;
    this.model.clear();
    this.sourceLines.clear();
    this.gutter.state.clear();
    this.gutter.clear();
    this.outputEmitter.fire({ kind: 'dropOverlays' });
    this.setPhase('starting');
    this.setScreen({
      screen: 'starting',
      message: `Loading LuaLaTeX and the packages in the preamble of ${this.mainRel}. The first start takes a few seconds.`,
    });
    proc.start();
    // rtex reads the files from disk; give it the editor's unsaved text
    this.shadows.clear();
    this.spansKnown.clear();
    this.spansFetch.clear();
    this.editsInFlight.clear();
    this.editsSent.clear();
    this.hostPass = false;
    this.pendingFromRevision = 0;
    for (const doc of vscode.workspace.textDocuments) {
      const rel = this.relPath(doc);
      if (!rel) continue;
      this.shadows.set(rel, new ShadowText(doc.getText()));
      // the main file is loaded from disk by rtex; other files only when they are edited
      if (doc.isDirty || rel !== this.mainRel) this.sendDocument(proc, rel, doc.getText());
    }
    this.diskTexts.clear();
    this.watchFiles();
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    if (proc) await proc.stop();
    this.disposeWatchers();
    this.gutter.clear();
    this.setPhase('stopped');
    this.setScreen({
      screen: 'stopped',
      message: 'The engine is stopped. Start it again to keep the preview updating as you type.',
      actions: [{ label: 'Start Again', command: 'realtimeTex.restart', primary: true }],
    });
  }

  async restart(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    if (proc) await proc.stop();
    this.disposeWatchers();
    this.autoRestarted = false;
    await this.start();
  }

  dispose(): void {
    this.disposed = true;
    void this.proc?.stop();
    this.proc = undefined;
    this.disposeWatchers();
    this.gutter.dispose();
    this.diagnostics.clear();
    clearTimeout(this.pendingTimer);
    // the first-compile watch stops itself on a phase change, which a disposed session never has
    clearInterval(this.compileTimer);
    this.outputEmitter.dispose();
    this.statusEmitter.dispose();
    this.screenEmitter.dispose();
  }

  private onExit(proc: RtexProcess, info: ExitInfo): void {
    if (proc !== this.proc) return;
    this.proc = undefined;
    this.disposeWatchers();
    if (info.requested || this.disposed) return;
    this.gutter.clear();
    const tail = info.stderrTail.join('\n');
    this.log.appendLine(`[exit] code ${info.code} signal ${info.signal}${info.error ? ` error ${info.error.message}` : ''}`);
    if (info.error?.code === 'ENOENT' || info.error?.code === 'EACCES') {
      this.setPhase('failed');
      this.setScreen({
        screen: 'notInstalled',
        message: `The bundled rtex executable could not be started (${info.error.code}): ${this.server?.path}. Verify the bundled runtime or reinstall Realtime TeX Enhanced.`,
        actions: [{ label: 'Verify Bundled Runtime', command: 'realtimeTex.installRtex', primary: true }, ACTIONS.checkSetup],
      });
      return;
    }
    // a crash after a good while: restart once by itself
    if (Date.now() - this.startedAt > 20000 && !this.autoRestarted) {
      this.autoRestarted = true;
      this.log.appendLine('[exit] restarting the engine');
      void this.start();
      return;
    }
    const hint = explainStartupFailure(tail);
    this.setPhase('failed');
    this.setScreen({
      screen: 'error',
      title: 'The engine stopped',
      message: hint.message,
      detail: tail || undefined,
      actions: [...hint.actions, ACTIONS.restart, ACTIONS.showLog, ACTIONS.checkSetup],
    });
  }

  // -------------------------------------------------------------------------------------------
  // editor → rtex

  /** Path of `doc` relative to the project root when the session tracks it. */
  relPath(doc: vscode.TextDocument): string | undefined {
    if (doc.uri.scheme !== 'file' || !/\.tex$/i.test(doc.fileName)) return undefined;
    const rel = path.relative(this.projectRoot, doc.fileName);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    if (doc.fileName.startsWith(this.buildDir)) return undefined;
    return rel.split(path.sep).join('/');
  }

  onDidChangeDocument(e: vscode.TextDocumentChangeEvent): void {
    const proc = this.proc;
    const rel = this.relPath(e.document);
    if (!proc || !rel || e.contentChanges.length === 0) return;
    this.gutter.refresh();
    const shadow = this.shadows.get(rel);
    if (!shadow) {
      this.shadows.set(rel, new ShadowText(e.document.getText()));
      this.sendDocument(proc, rel, e.document.getText());
      return;
    }
    const before = shadow.text;
    const lineChanges = sourceLineChanges(rel, before, e.contentChanges);
    const edits = shadow.apply(e.contentChanges);
    if (shadow.length !== documentLength(e.document)) {
      // out of step (should not happen): resend the whole buffer
      this.log.appendLine(`[sync] ${rel}: resynchronizing`);
      shadow.reset(e.document.getText());
      this.sendDocument(proc, rel, shadow.text, before);
      return;
    }
    for (let i = 0; i < edits.length; i++) {
      const ed = edits[i];
      const recorded = this.sourceLines.submit(lineChanges[i]);
      this.editsInFlight.set(rel, (this.editsInFlight.get(rel) ?? 0) + 1);
      this.editsSent.set(rel, (this.editsSent.get(rel) ?? 0) + 1);
      proc.send({ cmd: 'edit', path: rel, start: ed.start, end: ed.end, text: ed.text }, (r) => {
        this.sourceLines.acknowledge(recorded, r.reply === 'edit' ? r.result.source_revision : undefined);
        this.editsInFlight.set(rel, (this.editsInFlight.get(rel) ?? 1) - 1);
        const known = this.spansKnown.get(rel);
        const shifted = known && r.reply === 'edit'
          ? shiftSpans(known, ed.start, ed.end, Buffer.byteLength(ed.text), r.result.outcome) : undefined;
        if (shifted) this.spansKnown.set(rel, shifted);
        else this.spansKnown.delete(rel);
        this.onEditReply(r);
      });
    }
  }

  /** Register the same source change as the command sent to the engine. Recording the
   * acknowledgement revision keeps old background pages aligned with current buffers. */
  private sendDocument(proc: RtexProcess, rel: string, text: string, before?: string): void {
    const recorded = this.sourceLines.replace(rel, before, text);
    this.spansKnown.delete(rel);
    this.editsInFlight.set(rel, (this.editsInFlight.get(rel) ?? 0) + 1);
    this.editsSent.set(rel, (this.editsSent.get(rel) ?? 0) + 1);
    proc.send({ cmd: 'set_document', path: rel, text }, (r) => {
      this.sourceLines.acknowledge(recorded, r.reply === 'set_document' ? r.result.source_revision : undefined);
      this.editsInFlight.set(rel, (this.editsInFlight.get(rel) ?? 1) - 1);
      // spans fetched before the replacement were installed meanwhile: they are gone now
      this.spansKnown.delete(rel);
      this.onEditReply(r);
    });
  }

  /** Track a newly opened document so its edits can be sent incrementally. */
  onDidOpenDocument(doc: vscode.TextDocument): void {
    const rel = this.relPath(doc);
    if (!rel || !this.proc || this.shadows.has(rel)) return;
    this.shadows.set(rel, new ShadowText(doc.getText()));
    // rtex loaded the main file from disk; other files only when they are sent
    if (doc.isDirty || (rel !== this.mainRel && !this.openingSourceFiles.has(rel))) this.sendDocument(this.proc, rel, doc.getText(), this.diskTexts.get(rel));
  }

  /** A document closed without saving goes back to its text on disk. */
  async onDidCloseDocument(doc: vscode.TextDocument): Promise<void> {
    const rel = this.relPath(doc);
    if (!rel || !this.proc || !this.shadows.has(rel)) return;
    try {
      const disk = await fs.readFile(doc.fileName, 'utf8');
      // the engine holds this text once the editor is closed: a later external change back to
      // an older text must not be taken for one already sent
      this.diskTexts.set(rel, disk);
      if (disk !== this.shadows.get(rel)!.text) {
        const before = this.shadows.get(rel)!.text;
        this.shadows.get(rel)!.reset(disk);
        this.sendDocument(this.proc, rel, disk, before);
      }
    } catch {
      // deleted or unreadable: the next watcher event goes through
      this.diskTexts.delete(rel);
    }
    this.shadows.delete(rel);
    this.spansKnown.delete(rel);
  }

  private lastLoggedRoute = '';
  private fastLog = { n: 0, totalMs: 0, at: 0 };

  private onEditReply(r: Reply): void {
    if (r.reply === 'error') {
      this.log.appendLine(`[rtex] ${r.message}`);
      return;
    }
    if (r.reply !== 'edit' && r.reply !== 'set_document') return;
    const res: EditResult = r.result;
    // Spans the edit removed were announced before this reply ("removed" updates hide their
    // rows); a preamble change restarts the engine, which drops every overlay. Errors a full
    // compile reported are rechecked by the engine itself once their part compiles cleanly.
    if (res.routed !== 'fast') {
      this.statusValue.lastBackgroundReason = res.routed === 'preamble' ? 'the preamble changed' : explainReasons(res.reasons);
      // say once per reason why typing here waits for the full compile
      const key = res.reasons.join(',');
      if (key !== this.lastLoggedRoute) {
        this.lastLoggedRoute = key;
        this.log.appendLine(`[edit] full compile, not live: ${this.statusValue.lastBackgroundReason} (${res.reasons.join(', ') || res.routed})`);
      }
      this.pendingFromRevision = Math.max(this.pendingFromRevision, res.source_revision);
      // an edit routed to the background comes with a BackgroundScheduled event, which sets it;
      // a preamble change and a new file start a pass without one
      if (res.routed === 'preamble' || res.reasons.includes('new file')) {
        this.hostPass = true;
        this.setPending(true);
      }
      // a preamble change can renumber the units of every file
      if (res.routed === 'preamble') this.spansKnown.clear();
    }
  }

  private watchers: vscode.Disposable[] = [];
  private watchFiles(): void {
    this.disposeWatchers();
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.projectRoot, '**/*'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changedInputs = new Set<string>();
    const changed = async (uri: vscode.Uri) => {
      const file = uri.fsPath;
      if (file.startsWith(this.buildDir) || /[\\/](build|\.git|node_modules)[\\/]/.test(path.relative(this.projectRoot, file))) return;
      if ((await fs.stat(file).catch(() => undefined))?.isDirectory()) return;
      if (/\.(aux|log|pdf|synctex\.gz|fls|fdb_latexmk|out|toc|bbl|blg|bcf|run\.xml)$/i.test(file)) return;
      const rel = path.relative(this.projectRoot, file).split(path.sep).join('/');
      const open = vscode.workspace.textDocuments.find((d) => d.fileName === file);
      if (/\.tex$/i.test(file)) {
        if (open) return; // the editor's buffer is authoritative
        try {
          const [text, st] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
          // rtex read the file when it started: an event for an older write (macOS reports
          // recent writes when a watcher starts) or one that left the text as it was changes
          // nothing, and a set_document of the main file would restart the live engine
          if (st.mtimeMs <= this.startedAt || this.diskTexts.get(rel) === text) return;
          const before = this.diskTexts.get(rel);
          this.diskTexts.set(rel, text);
          if (this.proc) this.sendDocument(this.proc, rel, text, before);
        } catch {
          /* deleted */
        }
        return;
      }
      // inputs of the document (bibliographies, images, packages): recompile (debounced).
      // Anything else — e.g. another LaTeX tool's output next to the source — is ignored.
      if (!isDocumentInput(file)) return;
      changedInputs.add(file);
      clearTimeout(timer);
      timer = setTimeout(() => {
        // the preview draws figures from their files: a regenerated one is sent again
        const files = [...changedInputs];
        changedInputs.clear();
        this.outputEmitter.fire({ kind: 'inputsChanged', files });
        this.recompile();
      }, 400);
    };
    this.watchers.push(w, w.onDidChange(changed), w.onDidCreate(changed), w.onDidDelete(changed));
  }

  private disposeWatchers(): void {
    for (const d of this.watchers) d.dispose();
    this.watchers = [];
  }

  recompile(): void {
    if (!this.proc) return;
    this.statusValue.lastBackgroundReason = undefined;
    this.hostPass = true;
    this.setPending(true);
    this.proc.send({ cmd: 'request_layout' });
  }

  // -------------------------------------------------------------------------------------------
  // rtex → editor

  private onEvent(ev: RtexEvent): void {
    switch (ev.event) {
      case 'EngineState': {
        this.log.appendLine(`[engine] ${ev.state} (generation ${ev.engine_generation})${ev.reason ? `: ${ev.reason}` : ''}`);
        const bundle = /\(debug bundle: (.+)\)\s*$/.exec(ev.reason ?? '')?.[1];
        if (bundle) this.announceDebugBundle(bundle, ev.reason ?? '');
        if (ev.engine_generation !== this.generation && this.generation >= 0) {
          this.spansKnown.clear();
          this.gutter.state.restarted();
          this.gutter.refresh();
          this.model.dropOverlays();
          this.outputEmitter.fire({ kind: 'dropOverlays' });
        }
        this.generation = ev.engine_generation;
        if (ev.state === 'Ready') {
          if (this.statusValue.phase === 'starting') {
            this.setPhase('compiling');
            this.setScreen({
              screen: 'compiling',
              message: `Running the first full compile of ${this.mainRel}. After that, the preview updates as you type.`,
            });
          }
          this.outputEmitter.fire({ kind: 'banner', text: null });
        } else if (ev.state === 'Failed') {
          this.outputEmitter.fire({
            kind: 'banner',
            level: 'warn',
            text: `Live typing is paused: the engine could not load the preamble${ev.reason ? ` (${firstLine(ev.reason)})` : ''}. The preview still updates after each full compile.`,
            actions: [ACTIONS.showLog],
          });
        } else if (ev.state === 'Starting' && this.model.hasLayout) {
          this.statusValue.lastBackgroundReason = 'the preamble changed';
          this.setPending(true);
        }
        break;
      }
      case 'LayoutUpdate':
        this.onLayout(ev);
        break;
      case 'ParagraphUpdate': {
        if (ev.status === 'removed') {
          // the span is gone (merged into its neighbour): hide its rows until the next layout
          this.model.applyParagraph(ev.par_id, ev.dl, [], ev.versions.source_revision);
          this.outputEmitter.fire({ kind: 'paragraph', ev });
          this.setDiagnostics(`live:${ev.par_id}`, []);
          break;
        }
        this.statusValue.lastFastMs = ev.timing.total_us / 1000;
        this.lastLoggedRoute = '';
        // a summary line at most every 5 s while typing
        this.fastLog.n++;
        this.fastLog.totalMs += ev.timing.total_us / 1000;
        if (Date.now() - this.fastLog.at > 5000) {
          this.log.appendLine(`[edit] live: ${this.fastLog.n} update(s), ${(this.fastLog.totalMs / this.fastLog.n).toFixed(1)} ms average`);
          this.fastLog = { n: 0, totalMs: 0, at: Date.now() };
        }
        // TeX reported an error: the rows are not to be trusted and come without a place, so
        // drawing them would hide the part. Keep showing its last good result; the error is listed.
        if (ev.status !== 'error') {
          this.model.applyParagraph(ev.par_id, ev.dl, ev.fragments, ev.versions.source_revision);
          this.outputEmitter.fire({ kind: 'paragraph', ev });
        }
        this.gutter.state.observed([ev.par_id], true);
        this.gutter.refresh();
        // per part: another part's clean result must not hide this part's error
        this.setDiagnostics(`live:${ev.par_id}`, ev.diagnostics, false);
        if (ev.pagination_stale || ev.reasons.length) {
          this.statusValue.lastBackgroundReason = ev.reasons.includes('inserts') ? 'footnote text is placed with the page' : 'the paragraph changed its number of lines';
          this.setPending(true);
        } else if (ev.pass_pending === false && !this.hostPass && ev.versions.source_revision >= this.pendingFromRevision) {
          // nothing more follows (a formula left open was closed live): no full compile runs
          this.statusValue.lastBackgroundReason = undefined;
          this.setPending(false);
        } else this.emitStatus();
        break;
      }
      case 'Diagnostics':
        for (const d of ev.items) {
          this.log.appendLine(`[${ev.source}] ${d.severity}${d.file ? ` ${d.file}${d.line ? `:${d.line}` : ''}` : ''}: ${d.message}`);
        }
        if (ev.source === 'background') this.bgDiagnosticsThisPass = true;
        this.setDiagnostics(ev.source, ev.items);
        break;
      case 'BackgroundScheduled':
        // the edited part (or the engine after typesetting it) went to the full compile
        if (ev.par_id !== null) {
          this.gutter.state.observed([ev.par_id], false, ev.reasons);
          this.gutter.refresh();
        }
        this.statusValue.lastBackgroundReason = explainReasons(ev.reasons);
        this.setPending(true);
        break;
      case 'PdfExported': {
        const done = this.exports.get(ev.job_id);
        this.exports.delete(ev.job_id);
        done?.(ev);
        break;
      }
    }
  }

  private onLayout(ev: LayoutUpdateEvent): void {
    this.log.appendLine(
      `[layout] v${ev.versions.layout_version}: ${ev.pages_total} pages (${ev.pages_changed.length} changed), ${ev.compile.state}, ${ev.convergence.state}, ${ev.wall_ms} ms`,
    );
    if (ev.compile.state === 'Failed') {
      this.onFailedPass(ev);
      return;
    }
    if (!this.bgDiagnosticsThisPass) this.setDiagnostics('background', [], false);
    this.bgDiagnosticsThisPass = false;
    // A current full compile supersedes failures reported by individual live units.
    // A stale layout must not hide errors from edits newer than that layout.
    if (ev.convergence.state !== 'Stale') {
      for (const source of [...this.diags.keys()]) {
        if (source.startsWith('fast:') || source.startsWith('live:')) this.setDiagnostics(source, [], false);
      }
    }
    const keepFromRevision = ev.convergence.state === 'Stale' ? ev.convergence.pending_since : null;
    this.model.applyLayout({ pages: ev.pages_changed, pagesTotal: ev.pages_total, placements: ev.placements, keepFromRevision });
    advanceBackgroundSourceRevision(this.model, ev.source_revision);
    this.statusValue.convergence = ev.convergence;
    this.statusValue.compile = ev.compile;
    this.hostPass = false;
    // a catch-all for spans renumbered by the engine without an edit outcome saying so
    this.spansKnown.clear();
    const settled = ev.convergence.state === 'Converged' || ev.convergence.state === 'PassLimitReached';
    if (settled || (ev.convergence.state === 'Converging' && ev.compile.state !== 'Ok')) this.setPending(false, false);
    // edits arrived during the pass: busy until the engine catches up, or says (pass_pending)
    // that nothing is left to compile
    else if (ev.convergence.state === 'Stale') this.setPending(true, false);
    this.gutter.state.layout(ev.eligible_paragraphs, ev.placements.map((p) => p.par_id));
    this.gutter.refresh(0);
    this.setPhase('live');
    this.setScreen({ screen: null });
    this.outputEmitter.fire({ kind: 'banner', text: null });
    this.emitStatus();
    this.outputEmitter.fire({ kind: 'layout', ev, keepFromRevision, pdfPath: ev.pdf_fallback ?? this.pdfPath });
  }

  /**
   * A full compile that produced no pages (`compile: Failed`). rtex keeps the previous layout
   * current, so the preview keeps its pages and says what went wrong; before the first layout
   * it shows the failure instead of the pages. A pass that could not run at all (passes = 0)
   * names the cause in its convergence reasons; otherwise LaTeX stopped with an error.
   */
  private onFailedPass(ev: LayoutUpdateEvent): void {
    this.hostPass = false;
    if (!this.bgDiagnosticsThisPass) this.setDiagnostics('background', [], false);
    this.bgDiagnosticsThisPass = false;
    this.statusValue.compile = ev.compile;
    this.statusValue.convergence = ev.convergence;
    this.setPending(false, false);
    const reason = ev.convergence.state === 'PassLimitReached' && ev.passes === 0 ? ev.convergence.reasons.join('\n') : '';
    const first = this.firstError();
    let advice: string;
    let detail: string | undefined;
    if (reason) {
      // the pass could not run (e.g. LuaLaTeX could not start, the capture did not load)
      detail = reason.length > 3000 ? '…' + reason.slice(-3000) : reason;
      const texError = reason.split('\n').find((l) => /^! /.test(l.trim()) || /:\d+: /.test(l));
      if (texError) advice = `LaTeX stopped: ${texError.trim()}`;
      else if (/produced no .*rtex\.json/i.test(reason)) {
        advice =
          "LuaLaTeX ran but rtex's capture did not. This usually means LuaLaTeX is older than TeX Live 2026, or LaTeX stopped before \\begin{document}.";
      } else if (/spawning lualatex/i.test(reason)) advice = 'LuaLaTeX could not be started.';
      else advice = `The full compile could not run: ${firstLine(reason)}`;
    } else if (first) {
      advice = `LaTeX stopped with an error${first.line ? ` on line ${first.line}` : ''}${first.file ? ` of ${first.file}` : ''}:\n${first.message}`;
    } else {
      advice = 'The full compile did not produce any page. The LaTeX log has the details.';
    }
    const actions: Action[] = [
      { label: 'Open LaTeX Log', command: 'realtimeTex.openLatexLog', primary: true },
      ACTIONS.problems,
      ACTIONS.showLog,
      ACTIONS.recompile,
    ];
    this.setPhase('live');
    if (!this.model.hasLayout) {
      this.setScreen({ screen: 'error', title: 'The document produced no pages', message: advice, detail, actions });
    } else {
      this.outputEmitter.fire({ kind: 'banner', level: 'error', text: `The last full compile failed. ${firstLine(advice)} The preview shows the previous result.`, actions });
    }
    this.emitStatus();
  }

  private firstError(): RtexDiagnostic | undefined {
    for (const items of this.diags.values()) {
      const e = items.find((d) => d.severity === 'error');
      if (e) return e;
    }
    return undefined;
  }

  /** `emit: false` when the caller emits the status itself right after. */
  private setDiagnostics(source: string, items: RtexDiagnostic[], emit = true): void {
    // every live update reports its diagnostics, nearly always unchanged: publishing them again
    // would refresh the Problems panel and the markers of every editor on each keystroke
    if (sameDiagnostics(this.diags.get(source) ?? [], items)) return;
    if (items.length) this.diags.set(source, items);
    else this.diags.delete(source);
    const byFile = new Map<string, vscode.Diagnostic[]>();
    let errors = 0;
    for (const list of this.diags.values()) {
      for (const d of list) {
        const file = d.file ? path.resolve(this.projectRoot, d.file) : this.mainFile;
        const line = Math.max(0, (d.line ?? 1) - 1);
        const sev =
          d.severity === 'error'
            ? vscode.DiagnosticSeverity.Error
            : d.severity === 'warning'
              ? vscode.DiagnosticSeverity.Warning
              : vscode.DiagnosticSeverity.Information;
        if (sev === vscode.DiagnosticSeverity.Error) errors++;
        const diag = new vscode.Diagnostic(new vscode.Range(line, 0, line, 1000), d.message + (d.context ? `\n${d.context}` : ''), sev);
        diag.source = 'LaTeX';
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file)!.push(diag);
      }
    }
    this.diagnostics.clear();
    for (const [file, list] of byFile) this.diagnostics.set(vscode.Uri.file(file), list);
    if (errors !== this.statusValue.errorCount) {
      this.statusValue.errorCount = errors;
      if (emit) this.emitStatus();
    }
  }

  // -------------------------------------------------------------------------------------------
  // export

  /** Export the PDF; resolves to its path (undefined when it failed). */
  async exportPdf(): Promise<string | undefined> {
    const proc = this.proc;
    if (!proc) {
      void vscode.window.showWarningMessage('Start the live preview first: the PDF is produced by its engine.');
      return undefined;
    }
    const out = exportPathFor(this.mainFile);
    await fs.mkdir(path.dirname(out), { recursive: true });
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Exporting ${path.basename(out)}…`, cancellable: false },
      async () => {
        const reply = await proc.request({ cmd: 'export_pdf', out });
        if (reply.reply !== 'export_pdf') throw new Error(reply.reply === 'error' ? reply.message : 'unexpected reply');
        // settled by the PdfExported event, or by the engine stopping first
        return new Promise<PdfExportedEvent | undefined>((resolve) => {
          const id = reply.job_id;
          const gone = () => {
            if (this.exports.get(id) === done) this.exports.delete(id);
            resolve(undefined);
          };
          const done = (ev: PdfExportedEvent) => {
            proc.off('exit', gone);
            resolve(ev);
          };
          this.exports.set(id, done);
          proc.once('exit', gone);
          if (!proc.running) gone();
        });
      },
    );
    if (!result) {
      void vscode.window.showWarningMessage('The engine stopped before the export finished. Start the preview and export again.');
      return undefined;
    }
    const where = path.relative(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(out))?.uri.fsPath ?? path.dirname(out), out) || out;
    if (result.status.state === 'Failed' || !result.path) {
      void vscode.window.showErrorMessage('Export failed: LaTeX did not produce a PDF.', 'Show Problems', 'Show Log').then((pick) => {
        if (pick === 'Show Problems') void vscode.commands.executeCommand('workbench.actions.view.problems');
        if (pick === 'Show Log') this.log.show(true);
      });
      return undefined;
    }
    const pdf = result.path;
    const msg = result.converged
      ? `Exported ${where}.`
      : result.status.state === 'CompiledWithErrors'
        ? `Exported ${where}, but LaTeX reported ${result.status.count} error(s).`
        : `Exported ${where}, but references or page numbers had not settled after ${result.passes} passes.`;
    const show = result.converged ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    void show(msg, 'Open PDF', 'Reveal in Folder').then((pick) => {
      if (pick === 'Open PDF') void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(pdf), vscode.ViewColumn.Beside);
      if (pick === 'Reveal in Folder') void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(pdf));
    });
    return pdf;
  }

  // -------------------------------------------------------------------------------------------
  // sync

  private spans(rel: string): Promise<Span[]> {
    const known = this.spansKnown.get(rel);
    if (known && !this.editsInFlight.get(rel)) return Promise.resolve(known);
    const sent = this.editsSent.get(rel) ?? 0;
    // a request sent before a later edit answers for the text before it
    const pending = this.spansFetch.get(rel);
    if (pending?.sent === sent) return pending.promise;
    const proc = this.proc;
    if (!proc) return Promise.resolve([]);
    // the reply follows every edit sent before it: edits sent after it shift it in turn
    const entry = {
      sent,
      promise: proc.request({ cmd: 'spans', path: rel }).then((r) => {
        if (r.reply !== 'spans') return [];
        this.spansKnown.set(rel, r.spans);
        return r.spans;
      }, () => [] as Span[]).finally(() => {
        if (this.spansFetch.get(rel) === entry) this.spansFetch.delete(rel);
      }),
    };
    this.spansFetch.set(rel, entry);
    return entry.promise;
  }

  /** Scroll the preview to the text at `pos` in `doc`. */
  async revealInPreview(doc: vscode.TextDocument, pos: vscode.Position, force: boolean): Promise<boolean> {
    const rel = this.relPath(doc);
    if (!rel || !this.model.hasLayout) return false;
    const anchored = targetSourceAnchor(this.model, rel, pos.line + 1, this.sourceLines, {
      text: doc.lineAt(pos.line).text, character: pos.character,
    }) ?? targetClosingDisplay(this.model, rel, pos.line + 1, pos.character, this.sourceLines, (closingLine) => {
      if (closingLine > doc.lineCount) return undefined;
      const text = doc.lineAt(closingLine - 1).text;
      if (!/^\s*\\(?:end\s*\{(?:equation\*?|displaymath)\}|\])\s*(?:%.*)?$/.test(text)) return undefined;
      const preceding: string[] = [];
      let size = 0;
      for (let i = closingLine - 2; i >= Math.max(0, closingLine - 65); i--) {
        const previous = doc.lineAt(i).text + '\n';
        if (size + previous.length > 16384) break;
        preceding.unshift(previous);
        size += previous.length;
      }
      return { text, before: preceding.join(''), firstLine: closingLine - preceding.length };
    });
    if (anchored) {
      this.outputEmitter.fire({ kind: 'reveal', target: anchored, force });
      return true;
    }
    // Comments, preamble and stale/deleted source lines have no confirmed visible ink.
    // A whole-proof byte ratio must not turn that absence into a misleading location.
    return false;
  }

  /** Open the source of the unit at (page, y) in the preview. */
  async jumpToSource(page: number, x: number, y: number): Promise<boolean> {
    const source = hitSourceAnchor(this.model, page, x, y);
    if (source) {
      const line = this.sourceLines.rebase(source.file, source.line, source.revision);
      // A displayed line was deleted, split or has an unacknowledged edit. Do not silently
      // substitute the old byte-ratio estimate; the next live result supplies fresh anchors.
      if (line === undefined) return false;
      const uri = vscode.Uri.file(path.join(this.projectRoot, source.file));
      let doc: vscode.TextDocument;
      this.openingSourceFiles.add(source.file);
      try { doc = await vscode.workspace.openTextDocument(uri); } catch { return false; }
      finally { this.openingSourceFiles.delete(source.file); }
      // Opening an included file can send set_document. Recheck after that asynchronous
      // boundary so a click cannot reuse a location invalidated by a simultaneous edit.
      if (this.sourceLines.rebase(source.file, source.line, source.revision) !== line || line > doc.lineCount) return false;
      const index = line - 1;
      if (doc.lineAt(index).text.trimStart().startsWith('%')) return false;
      const openedVersion = doc.version;
      const visibleEditor = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === uri.fsPath);
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: visibleEditor?.viewColumn ?? vscode.ViewColumn.One,
        preserveFocus: false,
      });
      if (this.sourceLines.rebase(source.file, source.line, source.revision) !== line || line > doc.lineCount) return false;
      // Read after both awaits. An edit while the editor was opening may preserve its line
      // number but invalidate every word position from the displayed snapshot.
      const version = doc.version;
      const textLine = doc.lineAt(index);
      if (textLine.text.trimStart().startsWith('%')) return false;
      let refined;
      let mathBlock;
      if (doc.version === openedVersion && source.refinement && this.sourceLines.refineLine(source.file, source.line, source.revision) === line) {
        // Only a double-click reads nearby source context. Bound both lines and characters,
        // including for papers with unusually long source lines; never copy the whole paper.
        const preceding: string[] = [];
        let size = 0;
        for (let i = index - 1; i >= Math.max(0, index - 64); i--) {
          const previous = doc.lineAt(i).text + '\n';
          if (size + previous.length > 16384) break;
          preceding.unshift(previous);
          size += previous.length;
        }
        let before: string | undefined;
        if (preceding.length) {
          const originalFirst = source.line - preceding.length;
          const context = this.sourceLines.refineContext(source.file, originalFirst, source.line - 1, source.revision);
          if (context?.firstLine === line - preceding.length && context.lastLine === line - 1) before = preceding.join('');
        } else if (index === 0) before = '';
        refined = refineSourceSelection(textLine.text, source.refinement, before);
        // Some TeX display glues carry only the explicit closing delimiter's line. In
        // that narrow case select its unchanged, balanced expression as one math range.
        if (!refined) mathBlock = refineClosingDisplay(textLine.text, before, source.refinement);
      }
      // Matching is synchronous, but keep this guard next to applying its UTF-16 columns
      // so future asynchronous refinements cannot accidentally reuse a stale selection.
      if (doc.version !== version) return false;
      const start = new vscode.Position(index + (mathBlock?.startLine ?? 0), mathBlock?.startColumn ?? refined?.start ?? textLine.firstNonWhitespaceCharacterIndex);
      const end = new vscode.Position(index + (mathBlock?.endLine ?? 0), mathBlock?.endColumn ?? refined?.end ?? start.character);
      editor.selection = new vscode.Selection(start, mathBlock || refined?.kind === 'math' ? end : start);
      const range = new vscode.Range(start, end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      flashRange(editor, refined || mathBlock ? range : textLine.range);
      return true;
    }
    return false;
  }

  /** The gutter marks of `doc` (for tests). */
  async liveMarks(doc: vscode.TextDocument): Promise<LiveMark[]> {
    const rel = this.relPath(doc);
    return rel ? this.gutter.state.marks(await this.spans(rel)) : [];
  }

  /** Where each unit is shown (for tests and the panel). */
  placements(): Map<number, Fragment[]> {
    return this.model.currentPlacements();
  }

  // -------------------------------------------------------------------------------------------
  // status

  private compileTimer: ReturnType<typeof setInterval> | undefined;

  /** While the first compile runs, say how long it has been and what may be slow. */
  private watchFirstCompile(): void {
    clearInterval(this.compileTimer);
    const t0 = Date.now();
    this.compileTimer = setInterval(() => {
      if (this.statusValue.phase !== 'compiling') {
        clearInterval(this.compileTimer);
        return;
      }
      const secs = Math.round((Date.now() - t0) / 1000);
      if (secs < 15) return;
      this.setScreen({
        screen: 'compiling',
        title: `Still typesetting… (${secs} s)`,
        message:
          `The first full compile of ${this.mainRel} is still running. Large documents take a while, and the very first LuaLaTeX run on a computer builds its font cache, which can take a few minutes.\n` +
          'The LaTeX log shows how far it got.',
        actions: [{ label: 'Open LaTeX Log', command: 'realtimeTex.openLatexLog', primary: true }, ACTIONS.showLog, ACTIONS.restart],
      });
    }, 5000);
  }

  private setPhase(phase: Phase): void {
    if (this.statusValue.phase === phase) return;
    if (phase === 'compiling') this.watchFirstCompile();
    this.statusValue.phase = phase;
    if (phase !== 'live') this.statusValue.pending = false;
    this.emitStatus();
  }

  private setPending(pending: boolean, emit = true): void {
    clearTimeout(this.pendingTimer);
    this.statusValue.pending = pending;
    // a pass that never reports back must not leave "Updating…" on screen forever
    if (pending) this.pendingTimer = setTimeout(() => {
      this.hostPass = false;
      this.setPending(false);
    }, 120000);
    if (emit) this.emitStatus();
  }

  private emitStatus(): void {
    this.statusEmitter.fire(this.statusValue);
  }

  private setScreen(s: Screen): void {
    this.screenValue = s;
    this.screenEmitter.fire(s);
  }
}

const INPUT_EXTS = /\.(bib|sty|cls|bst|bbx|cbx|lbx|cfg|def|clo|ldf|png|jpe?g|gif|eps|pdf|svg|csv|dat|lua)$/i;

/** Whether a changed file can affect the compiled document. A PDF with the same name as a
 * .tex file next to it is another tool's output, not an \includegraphics input. */
function isDocumentInput(file: string): boolean {
  if (!INPUT_EXTS.test(file)) return false;
  if (/\.pdf$/i.test(file) && existsSync(file.replace(/\.pdf$/i, '.tex'))) return false;
  return true;
}

function sameDiagnostics(a: readonly RtexDiagnostic[], b: readonly RtexDiagnostic[]): boolean {
  return a.length === b.length && a.every((d, i) => {
    const e = b[i];
    return d.severity === e.severity && d.message === e.message && (d.file ?? null) === (e.file ?? null) &&
      (d.line ?? null) === (e.line ?? null) && (d.context ?? null) === (e.context ?? null);
  });
}

function documentLength(doc: vscode.TextDocument): number {
  const last = doc.lineAt(doc.lineCount - 1);
  return doc.offsetAt(last.range.end);
}

function firstLine(s: string): string {
  const l = s.split('\n').find((x) => x.trim()) ?? s;
  return l.length > 160 ? l.slice(0, 157) + '…' : l;
}

/** Turn the engine's last words into advice. */
export function explainStartupFailure(stderr: string): { message: string; actions: Action[] } {
  if (/lualatex not found/i.test(stderr)) {
    return {
      message:
        'LuaLaTeX was not found. Install TeX Live 2026 (or newer), or set the "Texlive Bin" setting of Realtime TeX Enhanced to the folder that contains lualatex.',
      actions: [{ label: 'Set TeX Live Folder', command: 'workbench.action.openSettings', args: ['realtimeTex.texliveBin'], primary: true }],
    };
  }
  if (/cannot locate rtex tex\/ directory/i.test(stderr)) {
    return {
      message: 'The bundled rtex support files could not be loaded. Verify the bundled runtime or reinstall Realtime TeX Enhanced.',
      actions: [{ label: 'Verify Bundled Runtime', command: 'realtimeTex.installRtex', primary: true }],
    };
  }
  if (/No such file|not found/i.test(stderr) && /main/i.test(stderr)) {
    return { message: 'The main file could not be read. Check that it exists and is saved at least once.', actions: [] };
  }
  return { message: 'The rtex engine exited unexpectedly. The log below and the output panel have the details.', actions: [] };
}

const flashDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  isWholeLine: false,
});

function flashRange(editor: vscode.TextEditor, range: vscode.Range): void {
  editor.setDecorations(flashDecoration, [range]);
  setTimeout(() => editor.setDecorations(flashDecoration, []), 1200);
}
