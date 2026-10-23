// Types of the `rtex serve` JSON-lines protocol (vendor/engine/crates/rtex-cli/src/serve.rs and
// vendor/engine/crates/rtex-core/src/session/mod.rs). Display lists use the JSON form of
// vendor/engine/docs/display-list.md.

export type Sp = number;

export interface Versions {
  source_revision: number;
  context_revision: number;
  engine_generation: number;
  layout_version: number;
}

export interface FontDesc {
  id: number;
  name?: string | null;
  fullname?: string | null;
  psname?: string | null;
  filename?: string | null;
  format?: string | null;
  type?: string | null;
  size?: number | null;
  designsize?: number | null;
  slant?: number | null;
  extend?: number | null;
  squeeze?: number | null;
  subfont?: number | null;
}

/** Items: ["g",font,char,index,x,y,w,ef] ["r",x,y_top,w,h] ["c",stack,cmd,data] ["l",mode,data]
 * ["u",kind,detail] ["m","on"|"off",x] ["i",index,x,y_top,w,h] ["M","save"|"set"|"restore",x,y,data]
 * ["L",target,x,y_top,w,h] internal link rectangle; ["D",target,x,y] destination (neither draws ink). */
export type Item = [string, ...unknown[]];

/** Source location recorded by LuaTeX for the space following a word. Coordinates use
 * the enclosing display list's frame; `line` is one-based in `file`. */
export interface SourceAnchor {
  x: Sp;
  w: Sp;
  file: string;
  line: number;
  kind: 'g' | 'mg' | 'mr' | 'box';
  /** Exact math-row source range; lines are one-based, columns are UTF-16 and end-exclusive. */
  end_line?: number;
  start_column?: number;
  end_column?: number;
  /** Math-row baseline in this display list, including nested aligned rows. */
  y?: Sp;
}

export interface Line {
  par?: number;
  i?: number;
  unit?: number;
  row?: number;
  x: Sp;
  y: Sp;
  w: Sp;
  h: Sp;
  d: Sp;
  items: Item[];
  source_anchors?: SourceAnchor[];
}

export interface ImageInfo {
  file: string;
  page?: number;
  pages?: number;
  /** A TikZ picture the background pass reused from an earlier pass's PDF (the page is
   * degraded and drawn from the PDF); `bbox` is its region there. */
  cached_picture?: boolean;
  bbox?: [number, number, number, number];
}

export interface DisplayList {
  kind: string;
  fonts: Record<string, FontDesc>;
  lines: Line[];
  other: Item[];
  flags: unknown;
  glyphs?: number;
  inserts?: number;
  images_info?: Record<string, ImageInfo>;
  width: Sp;
  height: Sp;
  depth: Sp;
  page?: number | null;
  page_width?: Sp;
  page_height?: Sp;
  /** Revision of the source snapshot that produced these anchors. Unlike the layout
   * event revision, this stays with an unchanged page across later background passes. */
  source_revision?: number;
}

export interface Fragment {
  page: number;
  first_line: number;
  last_line: number;
  x: Sp;
  xs: Sp[];
  baselines: Sp[];
  approximate: boolean;
}

export interface Placement {
  par_id: number;
  fragments: Fragment[];
  lines: number;
  kind: string;
}

export interface PageUpdate {
  page: number;
  exact: boolean;
  hash: number;
  dl: DisplayList;
}

export type Convergence =
  | { state: 'Converged' }
  | { state: 'Converging'; pass: number; reasons: string[] }
  | { state: 'PassLimitReached'; passes: number; reasons: string[] }
  | { state: 'Stale'; pending_since: number };

export type CompileStatus = { state: 'Ok' } | { state: 'CompiledWithErrors'; count: number } | { state: 'Failed' };

export interface Diagnostic {
  severity: string;
  file?: string | null;
  line?: number | null;
  message: string;
  context?: string | null;
}

export interface Timing {
  total_us: number;
  tex_us: number;
  traverse_us: number;
  pack_us: number;
}

export interface ParagraphUpdateEvent {
  event: 'ParagraphUpdate';
  par_id: number;
  edit_id: number;
  versions: Versions;
  status: string;
  reasons: string[];
  fragments: Fragment[];
  pagination_stale: boolean;
  context_stale: boolean;
  /** A background pass is running or still asked for; false: nothing more follows this result. */
  pass_pending?: boolean;
  /** Empty for `status: 'error'` (TeX's recovery is not drawn). */
  dl: DisplayList;
  diagnostics: Diagnostic[];
  timing: Timing;
}

export interface LayoutUpdateEvent {
  event: 'LayoutUpdate';
  versions: Versions;
  /** Source snapshot used for this compile. versions.source_revision can already refer
   * to later edits; unchanged pages nevertheless share this snapshot's source anchors. */
  source_revision?: number;
  compile: CompileStatus;
  convergence: Convergence;
  passes: number;
  pages_changed: PageUpdate[];
  pages_total: number;
  placements: Placement[];
  eligible_paragraphs: number[];
  pdf_fallback: string | null;
  wall_ms: number;
}

export interface DiagnosticsEvent {
  event: 'Diagnostics';
  source: string;
  items: Diagnostic[];
}

export interface EngineStateEvent {
  event: 'EngineState';
  engine_generation: number;
  state: string;
  reason: string | null;
}

export interface BackgroundScheduledEvent {
  event: 'BackgroundScheduled';
  par_id: number | null;
  reasons: string[];
  edit_id: number;
}

export interface PdfExportedEvent {
  event: 'PdfExported';
  job_id: number;
  path: string | null;
  status: CompileStatus;
  converged: boolean;
  passes: number;
}

export type RtexEvent =
  | ParagraphUpdateEvent
  | LayoutUpdateEvent
  | DiagnosticsEvent
  | EngineStateEvent
  | BackgroundScheduledEvent
  | PdfExportedEvent;

export interface EditOutcome {
  touched: number[];
  added: number[];
  removed: number[];
}

export interface EditResult {
  edit_id: number;
  source_revision: number;
  outcome: EditOutcome;
  routed: 'fast' | 'background' | 'preamble' | string;
  reasons: string[];
}

export interface Span {
  id: number;
  range: { start: number; end: number };
  kind: 'Preamble' | 'Body' | 'Env' | 'Heading' | 'Trailer';
  hash: number;
  last_revision: number;
}

export type Reply =
  | { reply: 'edit'; result: EditResult }
  | { reply: 'set_document'; result: EditResult }
  | { reply: 'spans'; spans: Span[] }
  | { reply: 'status'; versions: Versions; convergence: Convergence | null }
  | { reply: 'request_layout' }
  | { reply: 'export_pdf'; job_id: number }
  | { reply: 'error'; message: string };

export type Command =
  | { cmd: 'edit'; path: string; start: number; end: number; text: string }
  | { cmd: 'set_document'; path: string; text: string }
  | { cmd: 'spans'; path: string }
  | { cmd: 'status' }
  | { cmd: 'request_layout' }
  | { cmd: 'export_pdf'; out: string }
  | { cmd: 'quit' };

/** 1 pt = 65536 sp; 1 bp = 65781.76 sp. */
export const SP_PER_PT = 65536;
export const SP_PER_BP = 65781.76;
