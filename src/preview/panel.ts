// The preview WebviewPanel: forwards a session's output to the webview, with the font, image
// and PDF data it needs, and handles clicks coming back.
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { cfg, followCursorMode, setFollowCursorMode } from '../config';
import { isFollowCursorMode } from '../followCursor';
import { displayListsNeedPdf } from '../resourceUsage';
import type { HostToWebview, WebviewToHost } from '../messages';
import type { DisplayList } from '../protocol';
import type { ImageResource } from '../fontKey';
import type { OutlineViewState } from '../outline';
import { ResourceLoader } from '../resources';
import type { Screen, Session, SessionOutput } from '../session';
import { describe, SessionStatus } from '../status';
import { PreviewDelivery, type DeliveryLayout } from './delivery';
import { documentIdFor, loadCompiledOutline, outlineDestinations, outlineViewState, type CompiledOutline } from './outline';

export const VIEW_TYPE = 'realtimeTex.preview';

export interface PanelHost {
  log: vscode.OutputChannel;
  resources(session: Session): ResourceLoader;
  /** Called when the user closes the preview. */
  onPanelClosed(panel: PreviewPanel): void;
}

export class PreviewPanel implements vscode.Disposable {
  private session: Session | undefined;
  private sessionSubs: vscode.Disposable[] = [];
  private disposables: vscode.Disposable[] = [];
  private sentFonts = new Set<string>();
  private sentImages = new Set<string>();
  private readonly delivery: PreviewDelivery;
  private ready = false;
  private backlog: HostToWebview[] = [];
  private disposed = false;
  private outlineJob: { session: Session; input: DeliveryLayout; abort: AbortController; displayed: boolean; result?: CompiledOutline } | undefined;

  static create(ctx: vscode.ExtensionContext, host: PanelHost, column: vscode.ViewColumn, preserveFocus: boolean): PreviewPanel {
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'Live Preview',
      { viewColumn: column, preserveFocus },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist'), vscode.Uri.joinPath(ctx.extensionUri, 'media')] },
    );
    return new PreviewPanel(ctx, host, panel);
  }

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly host: PanelHost,
    readonly panel: vscode.WebviewPanel,
  ) {
    this.delivery = new PreviewDelivery({
      prepare: (dls, validateGlyphs, current) => {
        const session = this.session;
        return session ? this.sendResources(session, dls, validateGlyphs, () => this.session === session && current()) : Promise.resolve(false);
      },
      readPdf,
      post: (message) => this.post(message),
      didLayout: (input) => {
        const job = this.outlineJob;
        if (job?.input !== input) return;
        job.displayed = true;
        this.publishOutline();
      },
      error: (error) => this.host.log.appendLine(`[preview] ${error instanceof Error ? error.stack ?? error.message : String(error)}`),
    });
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist'), vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    };
    panel.iconPath = {
      light: vscode.Uri.joinPath(ctx.extensionUri, 'media', 'preview-light.svg'),
      dark: vscode.Uri.joinPath(ctx.extensionUri, 'media', 'preview-dark.svg'),
    };
    panel.webview.html = this.html();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: WebviewToHost) => this.onMessage(m)),
      panel.onDidDispose(() => this.dispose()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('realtimeTex.followCursor') || e.affectsConfiguration('realtimeTex.syncCursor') || e.affectsConfiguration('realtimeTex.preview')) this.postConfig();
      }),
    );
  }

  /** Show `session` in this panel (replaying its current state). */
  attach(session: Session): void {
    if (this.session === session) return;
    for (const d of this.sessionSubs) d.dispose();
    this.cancelOutline();
    this.session = session;
    this.sentFonts.clear();
    this.sentImages.clear();
    this.missing.clear();
    this.panel.title = `Preview ${session.mainRel}`;
    this.sessionSubs = [
      session.onOutput((o) => this.onOutput(session, o)),
      session.onStatus((s) => this.postStatus(s)),
      session.onScreen((s) => this.postScreen(s)),
    ];
    if (this.ready) this.replay();
  }

  /** Show a screen without a session (no main file, unsupported platform…). */
  showScreen(s: Screen): void {
    this.post({ type: 'screen', ...s });
  }

  reveal(preserveFocus = true): void {
    this.panel.reveal(undefined, preserveFocus);
  }

  /** Navigation belongs to the active preview, never VS Code's editor history. */
  navigate(direction: 'back' | 'forward'): void {
    if (!this.panel.active) return;
    this.post({ type: 'navigate', direction });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelOutline();
    this.delivery.dispose();
    for (const d of [...this.sessionSubs, ...this.disposables]) d.dispose();
    this.host.onPanelClosed(this);
    this.panel.dispose();
  }

  // -------------------------------------------------------------------------------------------

  private post(m: HostToWebview): void {
    if (this.disposed) return;
    if (!this.ready) {
      this.backlog.push(m);
      return;
    }
    void this.panel.webview.postMessage(m);
  }

  private replay(): void {
    const s = this.session;
    if (!s) return;
    this.delivery.reset();
    this.cancelOutline();
    this.post({ type: 'reset' });
    const documentId = documentIdFor(s.mainFile);
    this.post({ type: 'document', documentId,
      outlineState: outlineViewState(this.ctx.workspaceState.get<OutlineViewState>(`realtimeTex.outline.${documentId}`)) });
    this.sentFonts.clear();
    this.sentImages.clear();
    this.missing.clear();
    this.postConfig();
    this.postStatus(s.status);
    this.postScreen(s.screen);
    if (s.model.hasLayout) {
      const pages = [...s.model.pages.values()];
      const overlays = [...s.model.overlays.values()];
      const placements = [...s.model.placements].map(([par_id, fragments]) => ({ par_id, fragments, lines: 0, kind: '' }));
      this.deliverLayout(s, { pages, pagesTotal: s.model.pagesTotal, placements, keepFromRevision: null, layoutVersion: 0, pdfPath: s.pdfPath });
      for (const o of overlays) this.delivery.paragraph({ parId: o.parId, dl: o.dl, fragments: o.fragments, revision: o.revision });
    }
  }

  private onOutput(s: Session, o: SessionOutput): void {
    if (s !== this.session || this.disposed) return;
    // Before ready, replay will reconstruct the latest drawing state. Keep lightweight
    // controls/banners on their existing backlog rather than silently dropping them.
    if (!this.ready && (o.kind === 'layout' || o.kind === 'paragraph' || o.kind === 'dropOverlays')) return;
    switch (o.kind) {
      case 'layout': {
        const ev = o.ev;
        this.deliverLayout(s, { pages: ev.pages_changed, pagesTotal: ev.pages_total, placements: ev.placements,
          keepFromRevision: o.keepFromRevision, layoutVersion: ev.versions.layout_version, pdfPath: o.pdfPath }, ev.compile.state === 'Ok' && ev.convergence.state !== 'Stale');
        break;
      }
      case 'paragraph': {
        const ev = o.ev;
        this.delivery.paragraph({ parId: ev.par_id, dl: ev.dl, fragments: ev.status === 'removed' ? [] : ev.fragments,
          revision: ev.versions.source_revision });
        break;
      }
      case 'dropOverlays':
        this.delivery.dropOverlays();
        break;
      case 'inputsChanged':
        // before ready, replay sends every image afresh
        if (this.ready) void this.refreshImages(s, o.files);
        break;
      case 'reveal':
        this.post({ type: 'reveal', page: o.target.page, x: o.target.x, y: o.target.y, force: o.force });
        break;
      case 'banner':
        this.post({ type: 'banner', text: o.text, kind: o.level, actions: o.actions });
        break;
    }
  }

  private cancelOutline(): void {
    this.outlineJob?.abort.abort();
    this.outlineJob = undefined;
  }

  private deliverLayout(s: Session, input: DeliveryLayout, successful = true): void {
    this.cancelOutline();
    if (successful) {
      const job = { session: s, input, abort: new AbortController(), displayed: false, result: undefined as CompiledOutline | undefined };
      this.outlineJob = job;
      // Capture physical destination pages before another background pass mutates
      // the session model. Metadata never joins the critical drawing path.
      const destinations = outlineDestinations(s.model.pages.values());
      void loadCompiledOutline(s.pdfPath, destinations, job.abort.signal, input.pdfPath).then(result => {
        if (this.outlineJob !== job || this.disposed || this.session !== s) return;
        job.result = result;
        this.publishOutline();
      }).catch(error => {
        if (this.outlineJob !== job || this.disposed || this.session !== s) return;
        this.host.log.appendLine(`[outline] ${String(error)}`);
        job.result = { entries: [], unavailable: 'The compiled outline could not be read.' };
        this.publishOutline();
      });
    }
    this.delivery.layout(input);
  }

  private publishOutline(): void {
    const job = this.outlineJob;
    if (!job?.displayed || !job.result || job.session !== this.session || this.disposed) return;
    this.post({ type: 'outline', documentId: documentIdFor(job.session.mainFile), ...job.result });
  }

  private async sendResources(s: Session, dls: DisplayList[], validateGlyphs: boolean, current: () => boolean): Promise<boolean> {
    if (!current()) return false;
    const loader = this.host.resources(s);
    const generations = new Map(this.imageGen);
    const [fonts, images] = await Promise.all([loader.fontsFor(dls, this.sentFonts), loader.imagesFor(dls, this.sentImages, s.projectRoot)]);
    if (!current()) return false;
    // A reread can itself overlap another change, including to a different figure.
    // Publish only after every still-unsent image has survived a generation check.
    while (current()) {
      const changed = [...images.keys()].filter((key) => {
        const file = path.resolve(s.projectRoot, key);
        return !this.sentImages.has(key) && (this.imageGen.get(file) ?? 0) !== (generations.get(file) ?? 0);
      });
      if (!changed.length) break;
      await Promise.all(changed.map(async (key) => {
        const file = path.resolve(s.projectRoot, key);
        generations.set(file, this.imageGen.get(file) ?? 0);
        images.set(key, await loader.image(key, s.projectRoot));
      }));
    }
    if (!current()) return false;
    // Another lane may have finished the same shared font/image first. Never rebuild its
    // FontFace or reset an already decoded image just because two loads overlapped.
    for (const key of fonts.keys()) if (this.sentFonts.has(key)) fonts.delete(key);
    for (const key of images.keys()) if (this.sentImages.has(key)) images.delete(key);
    for (const [k, f] of fonts) {
      this.sentFonts.add(k);
      if (f.kind === 'missing') {
        this.missing.add(k);
        this.host.log.appendLine(`[fonts] ${k}: ${f.reason}`);
      } else this.missing.delete(k);
    }
    for (const [k, im] of images) {
      this.sentImages.add(k);
      if (im.kind === 'missing') {
        this.missing.add(`image:${k}`);
        this.host.log.appendLine(`[images] ${im.reason}`);
      } else this.missing.delete(`image:${k}`);
    }
    if (fonts.size || images.size) this.post({ type: 'resources', fonts: [...fonts], images: [...images] });
    // fonts or images this preview cannot draw make the PDF necessary
    if (displayListsNeedPdf(dls, this.missing)) return true;
    if (!validateGlyphs) return false;
    const needsPdf = await loader.glyphsNeedPdf(dls);
    return current() && needsPdf;
  }

  private missing = new Set<string>();

  /** Figure files changed on disk, per absolute path: how many times. */
  private readonly imageGen = new Map<string, number>();

  /** Send figures already shown again when their files changed (they are keyed by name). */
  private async refreshImages(s: Session, files: string[]): Promise<void> {
    const changed = new Set(files.map((f) => path.resolve(f)));
    for (const file of changed) this.imageGen.set(file, (this.imageGen.get(file) ?? 0) + 1);
    // the keys stay in sentImages, so concurrent preparations keep skipping them
    const keys = [...this.sentImages].filter((k) => changed.has(path.resolve(s.projectRoot, k)));
    if (!keys.length) return;
    const generation = new Map(keys.map((k) => [k, this.imageGen.get(path.resolve(s.projectRoot, k))]));
    const loader = this.host.resources(s);
    const loaded = await Promise.all(keys.map(async (k): Promise<[string, ImageResource]> => [k, await loader.image(k, s.projectRoot)]));
    if (this.session !== s || this.disposed) return;
    // a newer change of the same file is sent by its own refresh, never overwritten by this one
    const images = loaded.filter(([k]) => this.imageGen.get(path.resolve(s.projectRoot, k)) === generation.get(k));
    if (!images.length) return;
    for (const [k, im] of images) {
      if (im.kind === 'missing') {
        this.missing.add(`image:${k}`);
        this.host.log.appendLine(`[images] ${im.reason}`);
      } else this.missing.delete(`image:${k}`);
    }
    this.post({ type: 'resources', fonts: [], images });
  }

  private postStatus(s: SessionStatus): void {
    const d = describe(s);
    this.post({ type: 'status', text: d.text, kind: d.kind, tooltip: d.tooltip });
  }

  private postScreen(s: Screen): void {
    this.post({ type: 'screen', ...s });
  }

  private postConfig(): void {
    this.post({
      type: 'config',
      follow: followCursorMode(this.session ? vscode.Uri.file(this.session.mainFile) : undefined),
      invert: cfg().get<boolean>('preview.invertInDarkTheme', false),
    });
  }

  private async onMessage(m: WebviewToHost): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        for (const b of this.backlog.splice(0)) void this.panel.webview.postMessage(b);
        this.replay();
        this.maybeHint();
        break;
      case 'jump': {
        const ok = await this.session?.jumpToSource(m.page, m.x, m.y);
        if (!ok) vscode.window.setStatusBarMessage('$(info) No source paragraph found at that spot of the preview.', 3000);
        break;
      }
      case 'command': {
        const allowed = m.command.startsWith('realtimeTex.') || m.command === 'workbench.actions.view.problems' || m.command === 'workbench.action.openSettings' || m.command === 'vscode.open';
        if (!allowed) return;
        const args = (m.args ?? []).map((a) => (m.command === 'vscode.open' && typeof a === 'string' ? vscode.Uri.parse(a) : a));
        void vscode.commands.executeCommand(m.command, ...args);
        break;
      }
      case 'setFollow':
        if (!isFollowCursorMode(m.value)) return;
        try {
          await setFollowCursorMode(m.value, this.session ? vscode.Uri.file(this.session.mainFile) : undefined);
        } catch (error) {
          this.host.log.appendLine(`[preview] Cannot save Follow cursor: ${String(error)}`);
          void vscode.window.showErrorMessage(`Realtime TeX Enhanced: could not save Follow cursor. ${String(error)}`);
        }
        this.postConfig();
        break;
      case 'outlineState': {
        if (!this.session || m.documentId !== documentIdFor(this.session.mainFile)) return;
        const state = outlineViewState(m.state);
        if (!state) return;
        try {
          await this.ctx.workspaceState.update(`realtimeTex.outline.${m.documentId}`, state);
        } catch (error) {
          this.host.log.appendLine(`[outline] Cannot save sidebar preferences: ${String(error)}`);
        }
        break;
      }
      case 'error':
      case 'log':
        this.host.log.appendLine(`[preview] ${m.message}`);
        break;
    }
  }

  private maybeHint(): void {
    const key = 'realtimeTex.hintShown';
    if (this.ctx.globalState.get<boolean>(key)) return;
    void this.ctx.globalState.update(key, true);
    this.post({ type: 'hint', text: 'Tip: double-click anywhere in the preview to jump to that paragraph in the source.' });
  }

  private html(): string {
    const w = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const script = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'));
    const style = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'preview.css'));
    const worker = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'pdf.worker.mjs'));
    const boot = {
      workerUrl: worker.toString(),
      zoom: cfg().get<string>('preview.zoom', 'fitWidth'),
      follow: followCursorMode(this.session ? vscode.Uri.file(this.session.mainFile) : undefined),
      invert: cfg().get<boolean>('preview.invertInDarkTheme', false),
    };
    const csp = [
      `default-src 'none'`,
      `img-src ${w.cspSource} blob: data:`,
      `style-src ${w.cspSource}`,
      `font-src ${w.cspSource} blob: data:`,
      `script-src 'nonce-${nonce}' ${w.cspSource}`,
      `worker-src blob:`,
      `connect-src ${w.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<script type="application/json" id="rtex-boot">${JSON.stringify(boot).replace(/</g, '\\u003c')}</script>
<title>Live Preview</title>
</head>
<body>
<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

async function readPdf(file: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  try {
    const data = await fs.readFile(file, { signal });
    // a PDF being rewritten by the next pass is incomplete: it must end with %%EOF
    const tail = data.subarray(Math.max(0, data.length - 64)).toString('latin1');
    return tail.includes('%%EOF') ? new Uint8Array(data) : null;
  } catch {
    return null;
  }
}
