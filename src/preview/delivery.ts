// Resource preparation may run concurrently; only coherent, current results reach the view.
import type { HostToWebview } from '../messages';
import type { DisplayList, Fragment, PageUpdate, Placement } from '../protocol';
import { PreviewModel } from '../../webview/model';

export interface DeliveryLayout {
  pages: PageUpdate[];
  pagesTotal: number;
  placements: Placement[];
  keepFromRevision: number | null;
  layoutVersion: number;
  pdfPath: string;
}

export interface DeliveryParagraph {
  parId: number;
  dl: DisplayList;
  fragments: Fragment[];
  revision: number;
}

export interface DeliveryHooks {
  /** Post resources only while current(), including after every asynchronous load. */
  prepare(dls: DisplayList[], validateGlyphs: boolean, current: () => boolean): Promise<boolean>;
  readPdf(file: string, signal: AbortSignal): Promise<Uint8Array | null>;
  post(message: HostToWebview): void;
  /** Lightweight sidecars may follow this exact layout without delaying its pixels. */
  didLayout?(input: DeliveryLayout): void;
  error(error: unknown): void;
}

interface ParagraphJob {
  input: DeliveryParagraph;
  epoch: number;
  ready: boolean;
  requiresPdf: boolean;
}

interface LayoutJob {
  input: DeliveryLayout;
  epoch: number;
  abort: AbortController;
}

export class PreviewDelivery {
  private readonly desired = new PreviewModel();
  private readonly displayed = new PreviewModel();
  private readonly pendingPages = new Map<number, PageUpdate>();
  private readonly paragraphs = new Map<number, ParagraphJob>();
  private latestLayout: LayoutJob | undefined;
  private layoutVersion = -1;
  private displayedVersion = -1;
  private epoch = 0;
  private disposed = false;

  constructor(private readonly hooks: DeliveryHooks) {}

  layout(input: DeliveryLayout): void {
    if (this.disposed) return;
    this.desired.applyLayout(input);
    this.layoutVersion = input.layoutVersion;
    for (const page of input.pages) this.pendingPages.set(page.page, page);
    // A later growth must never resurrect a page removed by an intermediate shrink.
    for (const page of this.pendingPages.keys()) if (page > input.pagesTotal) this.pendingPages.delete(page);
    for (const [id, job] of this.paragraphs) if (!this.isDesired(job)) this.paragraphs.delete(id);
    this.latestLayout?.abort.abort();
    const job: LayoutJob = { input, epoch: this.epoch, abort: new AbortController() };
    this.latestLayout = job;
    void Promise.resolve().then(() => this.prepareLayout(job)).catch((error) => {
      if (this.isCurrentLayout(job)) this.report(error, job.epoch);
    });
  }

  paragraph(input: DeliveryParagraph): void {
    if (this.disposed) return;
    this.desired.applyParagraph(input.parId, input.dl, input.fragments, input.revision);
    const job: ParagraphJob = { input, epoch: this.epoch, ready: false, requiresPdf: false };
    this.paragraphs.set(input.parId, job);
    void Promise.resolve().then(async () => {
      if (!this.isCurrentParagraph(job)) return;
      const requiresPdf = await this.hooks.prepare([input.dl], false, () => this.isCurrentParagraph(job));
      if (!this.isCurrentParagraph(job)) return;
      job.ready = true;
      job.requiresPdf = requiresPdf;
      this.flushParagraph(job);
    }).catch((error) => {
      if (this.isCurrentParagraph(job)) this.report(error, job.epoch);
    });
  }

  dropOverlays(ids?: number[]): void {
    if (this.disposed) return;
    this.desired.dropOverlays(ids);
    if (ids === undefined) this.paragraphs.clear();
    else for (const id of ids) this.paragraphs.delete(id);
    this.displayed.dropOverlays(ids);
    this.hooks.post({ type: 'dropOverlays', parIds: ids });
  }

  reset(): void {
    this.epoch++;
    this.latestLayout?.abort.abort();
    this.latestLayout = undefined;
    this.paragraphs.clear();
    this.pendingPages.clear();
    this.desired.clear();
    this.displayed.clear();
    this.layoutVersion = this.displayedVersion = -1;
  }

  dispose(): void {
    this.reset();
    this.disposed = true;
  }

  private isDesired(job: ParagraphJob): boolean {
    const overlay = this.desired.overlays.get(job.input.parId);
    return overlay?.dl === job.input.dl && overlay.revision === job.input.revision;
  }

  private isCurrentParagraph(job: ParagraphJob): boolean {
    return !this.disposed && job.epoch === this.epoch &&
      this.paragraphs.get(job.input.parId) === job && this.isDesired(job);
  }

  private isCurrentLayout(job: LayoutJob): boolean {
    return !this.disposed && job.epoch === this.epoch && this.latestLayout === job;
  }

  private async prepareLayout(job: LayoutJob): Promise<void> {
    const current = () => this.isCurrentLayout(job);
    if (!current()) return;
    const pages = [...this.pendingPages.values()];
    const needsPdf = await this.hooks.prepare(pages.map((page) => page.dl), true, current);
    if (!current()) return;
    const pdf = needsPdf || pages.some((page) => !page.exact)
      ? await this.hooks.readPdf(job.input.pdfPath, job.abort.signal) : null;
    if (!current()) return;

    // The engine's model has already decided which overlays remain valid. A newer live
    // result may have overtaken this background job, so retain those IDs through its layout.
    const removed = [...this.displayed.overlays].filter(([id, shown]) => {
      const wanted = this.desired.overlays.get(id);
      return !wanted || wanted.dl !== shown.dl || wanted.revision !== shown.revision;
    }).map(([id]) => id);
    // Dropping a deletion tombstone before replacing its background can expose old ink
    // beside a newer merged overlay. Apply the removals in the same layout packet.
    const keepFromRevision = this.desired.overlays.size ? 0 : null;
    const message: Extract<HostToWebview, { type: 'layout' }> = {
      type: 'layout', pages, pagesTotal: job.input.pagesTotal,
      placements: job.input.placements, keepFromRevision, dropOverlayIds: removed, pdf,
    };
    this.displayed.applyLayout(message);
    this.displayedVersion = job.input.layoutVersion;
    this.pendingPages.clear();
    this.hooks.post(message);
    this.hooks.didLayout?.(job.input);
    // Jobs dependent on new placements can now use the engine's current fragments.
    for (const paragraph of this.paragraphs.values()) this.flushParagraph(paragraph);
  }

  private flushParagraph(job: ParagraphJob): void {
    if (!job.ready || !this.isCurrentParagraph(job) || !this.displayed.hasLayout) return;
    const { parId, dl, revision } = job.input;
    const overlay = this.desired.overlays.get(parId)!;
    const old = this.displayed.overlays.get(parId);
    if (old?.dl === dl && old.revision === revision) return;
    // Early delivery is safe only against an existing compatible base. New units or a
    // changed page/row placement wait for that layout instead of flashing in a wrong spot.
    if (this.displayedVersion !== this.layoutVersion &&
      (job.requiresPdf || !samePlacements(this.displayed.placements.get(parId), this.desired.placements.get(parId)))) return;
    if (overlay.fragments.some((fragment) => !this.displayed.pages.has(fragment.page))) return;
    this.displayed.applyParagraph(parId, dl, overlay.fragments, revision);
    this.hooks.post({ type: 'paragraph', parId, dl, fragments: overlay.fragments, revision });
  }

  private report(error: unknown, epoch: number): void {
    if (!this.disposed && epoch === this.epoch) this.hooks.error(error);
  }
}

function samePlacements(a: readonly Fragment[] | undefined, b: readonly Fragment[] | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((f, i) => {
    const g = b[i];
    return f.page === g.page && f.x === g.x && f.first_line === g.first_line && f.last_line === g.last_line &&
      f.xs.length === g.xs.length && f.baselines.length === g.baselines.length &&
      f.xs.every((x, j) => x === g.xs[j]) && f.baselines.every((y, j) => y === g.baselines[j]);
  });
}
