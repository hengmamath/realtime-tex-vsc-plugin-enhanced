// Keystroke replay of math being typed, measured against the real bundled engine and the
// extension's own Session, delivery and preview model (VS Code itself is replaced by
// ./vscodeShim). Synthetic documents only; results go to the ignored live-test/ directory.
//
//   npm run bench:math-typing -- [--label NAME] [--cadence continuous,short,long]
//                                [--scenario id,...] [--rounds N] [--root EXTENSION_DIR]
import { promises as fs, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import * as vscode from 'vscode';
import { PreviewDelivery } from '../../src/preview/delivery';
import type { HostToWebview } from '../../src/messages';
import type { DisplayList, Item, RtexEvent } from '../../src/protocol';
import { RtexProcess } from '../../src/rtexProcess';
import { Session } from '../../src/session';
import { describe } from '../../src/status';
import { PreviewModel } from '../../webview/model';
import { settings } from './vscodeShim';

// ---------------------------------------------------------------------------------------------
// synthetic document

const WORDS = ('the of a series bound holds for each term and therefore the estimate remains valid ' +
  'under these assumptions we obtain a uniform control while the remainder is small enough').split(' ');

function filler(seed: number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(WORDS[(seed * 7 + i * 13 + (i >> 2)) % WORDS.length]);
  return out.join(' ');
}

/** About twenty pages: enough that a full compile costs what it costs in a real paper. */
export function syntheticDocument(): string {
  const parts: string[] = [
    '\\documentclass{article}',
    '\\usepackage{amsmath}',
    '\\usepackage{xcolor}',
    '\\newenvironment{Amend}{\\color{teal}}{\\ignorespacesafterend}',
    '\\newcommand{\\vect}[1]{\\mathbf{#1}}',
    '\\begin{document}',
  ];
  const targets: Record<number, string[]> = {
    12: ['Inline target TARGETA closes this sentence.'],
    13: ['Display target TARGETB closes this sentence.'],
    14: ['Conversion target TARGETC uses $PV+HX$ inline.'],
    15: ['Empty display target TARGETD closes this sentence.'],
    16: ['Equation target TARGETE closes this sentence.'],
    17: ['Body target TARGETF has a display', '\\[ LM+NP \\]', 'and continues after it.'],
    18: ['TARGETG first line has $AB+CD$ inside.', 'Second line of the same paragraph ENDG.'],
    19: ['Blank line target TARGETH has a first half', 'and a second half SECONDH.'],
    20: ['Error target TARGETI keeps its text.'],
    21: ['Other paragraph TARGETJ keeps updating.'],
    22: ['Macro target TARGETK uses $\\vect{v}$ inline.'],
    23: ['\\begin{Amend}', 'Coloured target TARGETL closes this sentence.', '\\end{Amend}'],
    24: ['Removable paragraph TARGETM with $UV+YZ$ inside.'],
    25: ['Merge first MERGEA ends here.', '', 'Merge second MERGEB ends here.'],
  };
  for (let s = 1; s <= 30; s++) {
    parts.push('', `\\section{Section ${s}}`);
    for (let p = 0; p < 3; p++) {
      parts.push('', `${filler(s * 3 + p, 60)} with $a_{${p}}+b_{${s}}$ and ${filler(s + p, 30)}.`);
    }
    parts.push('', `${filler(s, 25)}`, '\\begin{equation}', `f_{${s}}(x)=\\sum_{k=1}^{${s}} c_k x^k`, '\\end{equation}',
      `${filler(s + 9, 20)} and \\[ g_{${s}} = h_{${s}} \\] ${filler(s + 4, 10)}.`);
    if (targets[s]) parts.push('', ...targets[s]);
  }
  parts.push('', '\\end{document}', '');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------------------------
// scenarios

type Step =
  | { op: 'goto'; after?: string; before?: string }
  | { op: 'type'; text: string; close?: 'first' | 'last' }
  | { op: 'pause' }
  | { op: 'delete'; find: string; close?: boolean }
  | { op: 'backspace'; n: number; close?: boolean }
  | { op: 'undo'; close?: boolean };

interface Scenario {
  id: string;
  what: string;
  steps: Step[];
  /** The final picture: glyph text (whitespace removed) that must or must not be visible. */
  has: string[];
  lacks: string[];
  /** Text of other parts that must stay visible throughout. */
  stable: string[];
}

const SCENARIOS: Scenario[] = [
  {
    id: 'inline-dollar', what: 'type $WQ+KZ$ key by key into a paragraph',
    steps: [{ op: 'goto', after: 'TARGETA' }, { op: 'type', text: ' $' }, { op: 'pause' }, { op: 'type', text: 'WQ+KZ' }, { op: 'pause' }, { op: 'type', text: '$', close: 'last' }],
    has: ['TARGETA', 'WQ+KZ'], lacks: [], stable: ['TARGETB', 'TARGETJ'],
  },
  {
    id: 'display-bracket', what: 'type \\[ WQ+KZ=JV \\] on a new line',
    steps: [{ op: 'goto', after: 'TARGETB' }, { op: 'type', text: '\n\\[' }, { op: 'pause' }, { op: 'type', text: ' WQ+KZ=JV ' }, { op: 'pause' }, { op: 'type', text: '\\]', close: 'last' }],
    has: ['TARGETB', 'WQ+KZ=JV'], lacks: [], stable: ['TARGETA', 'TARGETJ'],
  },
  {
    id: 'mismatch-convert', what: 'convert $PV+HX$ to \\[PV+HX\\] opener first (passes through \\[PV+HX$)',
    steps: [{ op: 'goto', after: 'TARGETC uses $' }, { op: 'backspace', n: 1 }, { op: 'type', text: '\\[' }, { op: 'pause' },
      { op: 'goto', after: '\\[PV+HX$' }, { op: 'backspace', n: 1 }, { op: 'type', text: '\\]', close: 'last' }],
    has: ['TARGETC', 'PV+HX'], lacks: [], stable: ['TARGETB', 'TARGETJ'],
  },
  {
    id: 'mismatch-dollar-bracket', what: 'type $ GM+TY \\] then repair the closer to $',
    steps: [{ op: 'goto', after: 'TARGETA' }, { op: 'type', text: ' $ GM+TY \\]' }, { op: 'pause' }, { op: 'backspace', n: 2 }, { op: 'type', text: '$', close: 'last' }],
    has: ['TARGETA', 'GM+TY'], lacks: [], stable: ['TARGETB', 'TARGETJ'],
  },
  {
    id: 'empty-display', what: 'type an empty \\[\\], then its content RS+TU',
    steps: [{ op: 'goto', after: 'TARGETD' }, { op: 'type', text: '\n\\[\\]' }, { op: 'pause' }, { op: 'goto', after: 'TARGETD\n\\[' },
      { op: 'type', text: 'RS+TU', close: 'last' }],
    has: ['TARGETD', 'RS+TU'], lacks: [], stable: ['TARGETC', 'TARGETJ'],
  },
  {
    id: 'empty-equation', what: 'type an empty equation key by key, then its content DF+GH',
    steps: [{ op: 'goto', after: 'TARGETE' }, { op: 'type', text: '\n\\begin{equation}\n\\end{equation}' }, { op: 'pause' },
      { op: 'goto', after: 'TARGETE\n\\begin{equation}\n' }, { op: 'type', text: 'DF+GH', close: 'last' }],
    has: ['TARGETE', 'DF+GH'], lacks: [], stable: ['TARGETF', 'TARGETJ', 'TARGETL'],
  },
  {
    id: 'delete-body', what: 'delete a display body, then the display line, then undo both',
    steps: [{ op: 'delete', find: 'LM+NP' }, { op: 'pause' }, { op: 'delete', find: '\\[  \\]\n' }, { op: 'pause' },
      { op: 'undo' }, { op: 'pause' }, { op: 'undo', close: true }],
    has: ['TARGETF', 'LM+NP'], lacks: [], stable: ['TARGETE', 'TARGETJ'],
  },
  {
    id: 'delete-formula', what: 'delete a display body and leave it deleted (old ink must go)',
    steps: [{ op: 'delete', find: 'LM+NP', close: true }],
    has: ['TARGETF'], lacks: ['LM+NP'], stable: ['TARGETE', 'TARGETJ'],
  },
  {
    id: 'delete-line', what: 'delete a whole line with a formula and leave it deleted',
    steps: [{ op: 'delete', find: 'TARGETG first line has $AB+CD$ inside.\n', close: true }],
    has: ['ENDG'], lacks: ['AB+CD', 'TARGETG'], stable: ['TARGETF', 'TARGETJ'],
  },
  {
    id: 'delete-paragraph', what: 'delete a whole paragraph with its formula and leave it deleted',
    steps: [{ op: 'delete', find: '\n\nRemovable paragraph TARGETM with $UV+YZ$ inside.', close: true }],
    has: ['TARGETL'], lacks: ['TARGETM', 'UV+YZ'], stable: ['TARGETK', 'MERGEA'],
  },
  {
    id: 'merge-paragraphs', what: 'join two paragraphs by deleting the blank line between them',
    steps: [{ op: 'goto', after: 'MERGEA ends here.\n\n' }, { op: 'backspace', n: 1, close: true }],
    has: ['MERGEAendshere.MergesecondMERGEB', 'MERGEB'], lacks: [], stable: ['TARGETM', 'TARGETL'],
  },
  {
    id: 'blank-lines', what: 'split a paragraph with a blank line, merge it back, add and remove a blank line between paragraphs',
    steps: [{ op: 'goto', after: 'has a first half' }, { op: 'type', text: '\n' }, { op: 'pause' }, { op: 'backspace', n: 1 }, { op: 'pause' },
      { op: 'goto', after: 'SECONDH.\n' }, { op: 'type', text: '\n' }, { op: 'pause' }, { op: 'backspace', n: 1, }, { op: 'pause' },
      { op: 'goto', after: 'TARGETH' }, { op: 'type', text: 'Z', close: 'last' }],
    has: ['TARGETHZ', 'SECONDH'], lacks: [], stable: ['TARGETG', 'TARGETJ'],
  },
  {
    id: 'error-elsewhere', what: 'leave $XY^$ broken in one paragraph, keep typing in another',
    steps: [{ op: 'goto', after: 'TARGETI' }, { op: 'type', text: ' $XY^$' }, { op: 'pause' },
      { op: 'goto', after: 'TARGETJ' }, { op: 'type', text: ' more words' }, { op: 'pause' }, { op: 'type', text: ' typed here', close: 'last' }],
    has: ['TARGETJmorewordstypedhere'], lacks: [], stable: ['TARGETI', 'TARGETA'],
  },
  {
    id: 'probe-unit', what: 'type $WZ$ into a paragraph that uses a document macro',
    steps: [{ op: 'goto', after: 'TARGETK' }, { op: 'type', text: ' $WZ' }, { op: 'pause' }, { op: 'type', text: '$', close: 'last' }],
    has: ['TARGETK', 'WZ'], lacks: [], stable: ['TARGETJ', 'TARGETL'],
  },
  {
    id: 'color-env', what: 'type $QR+ST$ inside a custom colour environment (not named REV)',
    steps: [{ op: 'goto', after: 'TARGETL' }, { op: 'type', text: ' $QR' }, { op: 'pause' }, { op: 'type', text: '+ST$', close: 'last' }],
    has: ['TARGETL', 'QR+ST'], lacks: [], stable: ['TARGETK', 'TARGETJ'],
  },
];

const CADENCES: Record<string, { key: number; pause: number; what: string }> = {
  continuous: { key: 70, pause: 70, what: 'every key 70 ms apart, no pauses' },
  short: { key: 70, pause: 500, what: 'keys 70 ms apart, 500 ms pauses (past the 300 ms engine debounce)' },
  long: { key: 70, pause: 1800, what: 'keys 70 ms apart, 1.8 s pauses (past the 1 s error recheck)' },
  idle: { key: 70, pause: 3500, what: 'keys 70 ms apart, 3.5 s pauses (the writer stops; real errors must be reported)' },
};

// ---------------------------------------------------------------------------------------------
// a TextDocument with the parts Session uses

class Doc {
  readonly uri: vscode.Uri;
  readonly languageId = 'latex';
  readonly isClosed = false;
  version = 1;
  isDirty = false;
  private starts: number[] = [0];
  constructor(readonly fileName: string, private text: string) {
    this.uri = vscode.Uri.file(fileName);
    this.index();
  }
  private index(): void {
    this.starts = [0];
    for (let i = 0; i < this.text.length; i++) if (this.text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  getText(): string { return this.text; }
  get lineCount(): number { return this.starts.length; }
  positionAt(off: number): vscode.Position {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= off) lo = mid; else hi = mid - 1;
    }
    return new vscode.Position(lo, off - this.starts[lo]);
  }
  offsetAt(p: vscode.Position): number { return this.starts[p.line] + p.character; }
  lineAt(i: number) {
    const start = this.starts[i];
    const end = i + 1 < this.starts.length ? this.starts[i + 1] - 1 : this.text.length;
    const text = this.text.slice(start, end);
    return { text, range: new vscode.Range(i, 0, i, text.length), firstNonWhitespaceCharacterIndex: text.length - text.trimStart().length };
  }
  /** Replace [offset, offset+length) and return the change event VS Code would fire. */
  edit(offset: number, length: number, text: string) {
    const range = new vscode.Range(this.positionAt(offset), this.positionAt(offset + length));
    this.text = this.text.slice(0, offset) + text + this.text.slice(offset + length);
    this.version++;
    this.isDirty = true;
    this.index();
    return { document: this, contentChanges: [{ range, rangeOffset: offset, rangeLength: length, text }], reason: undefined };
  }
}

// ---------------------------------------------------------------------------------------------
// instrumentation shared by all runs (Session creates its RtexProcess internally)

interface Tap {
  t0: number;
  lines: { t: number; bytes: number; kind: string; data: any }[];
  commands: { t: number; cmd: string; data: any }[];
}
let tap: Tap | undefined;
const proto = RtexProcess.prototype as unknown as Record<string, (...a: any[]) => any>;
const onLine = proto.onLine;
proto.onLine = function (this: unknown, line: string) {
  if (tap && line.trim()) {
    let data: any;
    try { data = JSON.parse(line); } catch { data = {}; }
    const kind = typeof data.event === 'string'
      ? data.event === 'ParagraphUpdate' ? `ParagraphUpdate:${data.status}` : data.event
      : `reply:${data.reply}`;
    tap.lines.push({ t: performance.now() - tap.t0, bytes: Buffer.byteLength(line) + 1, kind, data });
  }
  return onLine.call(this, line);
};
const write = proto.write;
proto.write = function (this: unknown, cmd: { cmd: string }) {
  tap?.commands.push({ t: performance.now() - tap.t0, cmd: cmd.cmd, data: cmd });
  return write.call(this, cmd);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function glyphs(items: Item[]): string {
  let s = '';
  for (const it of items) if (it[0] === 'g' && typeof it[2] === 'number') s += String.fromCodePoint(it[2] as number);
  return s;
}

/** Glyph text of what the preview would draw: background lines not replaced by an overlay,
 * plus the overlay rows. */
function visibleText(view: PreviewModel): string {
  let s = '';
  for (const n of [...view.pages.keys()].sort((a, b) => a - b)) {
    const pu = view.pages.get(n)!;
    const hidden = view.hiddenLines(n);
    pu.dl.lines.forEach((line, i) => { if (!hidden.has(i)) s += glyphs(line.items) + '\n'; });
    s += glyphs(pu.dl.other) + '\n';
  }
  for (const ov of view.overlays.values()) {
    if (!ov.fragments.length) continue;
    for (const line of ov.dl.lines) s += glyphs(line.items) + '\n';
  }
  return s.replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------------------------
// one run: a fresh engine, the scenario's keystrokes, then quiet

interface RunResult {
  scenario: string;
  cadence: string;
  ok: boolean;
  problems: string[];
  durationMs: number;
  liveCompiles: number;
  warmups: number;
  refusals: number;
  updates: Record<string, number>;
  fullCompiles: number;
  provisionalLayouts: number;
  failedLayouts: number;
  texRuns: number;
  fullCompileWallMs: number;
  restarts: number;
  routed: Record<string, number>;
  reasons: Record<string, number>;
  commands: Record<string, number>;
  stdoutBytes: Record<string, number>;
  posts: Record<string, number>;
  postBytes: Record<string, number>;
  pageRepaints: number;
  stableBroken: number;
  duplicated: number;
  closeToCorrectMs: number | null;
  closeToConvergedMs: number | null;
  finalDiagnostics: { errors: number; messages: string[] };
}

async function run(root: string, scenario: Scenario, cadenceName: string, outDir: string): Promise<RunResult> {
  const cadence = CADENCES[cadenceName];
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'rtex-math-typing-'));
  const project = path.join(work, 'project');
  await fs.mkdir(project);
  const mainFile = path.join(project, 'main.tex');
  const source = syntheticDocument();
  await fs.writeFile(mainFile, source);
  const debug = path.join(work, 'debug');
  settings.clear();
  settings.set('texliveBin', process.env.RTEX_TEST_TEXLIVE_BIN ?? '/Library/TeX/texbin');
  settings.set('debug.enabled', true);
  settings.set('debug.directory', debug);
  const doc = new Doc(mainFile, source);
  (vscode.workspace as any).textDocuments = [doc];
  (vscode.window as any).visibleTextEditors = [{ document: doc, setDecorations() { /* gutter marks are not drawn */ } }];
  const ctx: any = {
    extensionUri: vscode.Uri.file(root), extensionPath: root,
    storageUri: vscode.Uri.file(path.join(work, 'storage')), globalStorageUri: vscode.Uri.file(path.join(work, 'global')),
    subscriptions: [],
  };
  const log = { appendLine: (_: string) => undefined, show: () => undefined } as any;
  const diagnostics = new (vscode as any).DiagnosticCollection();
  const session = new Session(ctx, mainFile, log, diagnostics);

  // the panel's wiring, with a webview model standing in for the canvas
  const view = new PreviewModel();
  let watermark = -1;
  let layoutRev = -1;
  let frameStart = -1;
  let frameDirty = new Set<number>();
  let pageRepaints = 0;
  const posts: Record<string, number> = {};
  const postBytes: Record<string, number> = {};
  let measuring = false;
  let closeAt: number | null = null;
  let closeRevision: number | null = null;
  let correctAt: number | null = null;
  let stableBroken = 0;
  let duplicated = 0;
  const count = (text: string, token: string) => text.split(token).length - 1;
  const flushFrame = () => {
    pageRepaints += frameDirty.size;
    frameDirty = new Set();
  };
  const markDirty = (pages: Set<number>) => {
    const now = performance.now();
    if (now - frameStart > 16) { flushFrame(); frameStart = now; }
    for (const p of pages) frameDirty.add(p);
  };
  const check = () => {
    if (!measuring) return;
    const text = visibleText(view);
    if (scenario.stable.some((s) => !text.includes(s))) stableBroken++;
    if ([...scenario.stable, ...scenario.has].some((s) => count(text, s) > 1)) duplicated++;
    if (closeAt !== null && correctAt === null && closeRevision !== null && watermark >= closeRevision &&
        scenario.has.every((s) => text.includes(s)) && scenario.lacks.every((s) => !text.includes(s))) {
      correctAt = performance.now();
    }
  };
  const post = (m: HostToWebview) => {
    if (measuring) {
      posts[m.type] = (posts[m.type] ?? 0) + 1;
      postBytes[m.type] = (postBytes[m.type] ?? 0) + JSON.stringify(m).length;
    }
    if (m.type === 'layout') {
      markDirty(view.applyLayout(m));
      watermark = Math.max(watermark, layoutRev);
    } else if (m.type === 'paragraph') {
      markDirty(view.applyParagraph(m.parId, m.dl, m.fragments, m.revision));
      watermark = Math.max(watermark, m.revision);
    } else if (m.type === 'dropOverlays') markDirty(view.dropOverlays(m.parIds));
    check();
  };
  const delivery = new PreviewDelivery({ prepare: async () => false, readPdf: async () => null, post, error: () => undefined });
  session.onOutput((o) => {
    if (o.kind === 'layout') {
      layoutRev = o.ev.source_revision ?? o.ev.versions.source_revision;
      delivery.layout({ pages: o.ev.pages_changed, pagesTotal: o.ev.pages_total, placements: o.ev.placements,
        keepFromRevision: o.keepFromRevision, layoutVersion: o.ev.versions.layout_version, pdfPath: o.pdfPath });
    } else if (o.kind === 'paragraph') {
      delivery.paragraph({ parId: o.ev.par_id, dl: o.ev.dl, fragments: o.ev.status === 'removed' ? [] : o.ev.fragments,
        revision: o.ev.versions.source_revision });
    } else if (o.kind === 'dropOverlays') delivery.dropOverlays((o as { parIds?: number[] }).parIds);
  });
  session.onStatus((s) => { const d = describe(s); post({ type: 'status', text: d.text, kind: d.kind, tooltip: d.tooltip }); });

  tap = { t0: performance.now(), lines: [], commands: [] };
  const problems: string[] = [];
  const events = () => tap!.lines.filter((l) => !l.kind.startsWith('reply:'));
  const quietFor = async (ms: number, limit: number) => {
    const start = performance.now();
    for (;;) {
      const last = Math.max(tap!.lines.at(-1)?.t ?? 0, tap!.commands.at(-1)?.t ?? 0) + tap!.t0;
      const now = performance.now();
      if (now - last >= ms) return true;
      if (now - start > limit) return false;
      await sleep(50);
    }
  };
  try {
    await session.start();
    // the first converged layout, then nothing pending
    for (const t = performance.now(); ;) {
      if (events().some((l) => l.kind === 'LayoutUpdate' && l.data.convergence?.state === 'Converged')) break;
      if (performance.now() - t > 120000) throw new Error('no converged first layout');
      await sleep(50);
    }
    await quietFor(1500, 30000);
    const baseLine = tap.lines.length;
    const baseCmd = tap.commands.length;
    const generation0 = session.status && (events().filter((l) => l.kind === 'EngineState').at(-1)?.data.engine_generation ?? 0);
    flushFrame();
    pageRepaints = 0;
    measuring = true;
    const tStart = performance.now();

    // replay
    let cursor = 0;
    const history: { offset: number; removed: string; inserted: string }[] = [];
    const change = (offset: number, length: number, text: string) => {
      const removed = doc.getText().slice(offset, offset + length);
      history.push({ offset, removed, inserted: text });
      session.onDidChangeDocument(doc.edit(offset, length, text) as any);
    };
    const markClose = () => {
      closeAt = performance.now();
      const n = tap!.commands.filter((c) => c.cmd === 'edit' || c.cmd === 'set_document').length;
      // the reply to the n-th edit carries the closing revision (replies are in order)
      const waitReply = async () => {
        for (;;) {
          const edits = tap!.commands.filter((c) => c.cmd !== 'quit');
          const replies = tap!.lines.filter((l) => l.kind.startsWith('reply:'));
          let seen = 0;
          for (let i = 0; i < replies.length && i < edits.length; i++) {
            if (edits[i].cmd === 'edit' || edits[i].cmd === 'set_document') {
              seen++;
              if (seen === n) { closeRevision = replies[i].data.result?.source_revision ?? null; check(); return; }
            }
          }
          await sleep(5);
        }
      };
      void waitReply();
    };
    for (const step of scenario.steps) {
      const text = doc.getText();
      switch (step.op) {
        case 'goto': {
          const key = step.after ?? step.before!;
          const at = text.indexOf(key);
          if (at < 0) throw new Error(`${scenario.id}: missing ${JSON.stringify(key)}`);
          cursor = step.after !== undefined ? at + key.length : at;
          break;
        }
        case 'type':
          for (let i = 0; i < step.text.length; i++) {
            change(cursor, 0, step.text[i]);
            cursor++;
            if ((step.close === 'last' && i === step.text.length - 1) || (step.close === 'first' && i === 0)) markClose();
            await sleep(cadence.key);
          }
          break;
        case 'backspace':
          for (let i = 0; i < step.n; i++) {
            change(cursor - 1, 1, '');
            cursor--;
            if (step.close && i === step.n - 1) markClose();
            await sleep(cadence.key);
          }
          break;
        case 'delete': {
          const at = text.indexOf(step.find);
          if (at < 0) throw new Error(`${scenario.id}: missing ${JSON.stringify(step.find)}`);
          change(at, step.find.length, '');
          cursor = at;
          if (step.close) markClose();
          await sleep(cadence.key);
          break;
        }
        case 'undo': {
          const last = [...history].reverse().find((h) => h.removed.length > 0 && h.inserted === '');
          if (!last) throw new Error(`${scenario.id}: nothing to undo`);
          history.splice(history.lastIndexOf(last), 1);
          session.onDidChangeDocument(doc.edit(last.offset, 0, last.removed) as any);
          cursor = last.offset + last.removed.length;
          if (step.close) markClose();
          await sleep(cadence.key);
          break;
        }
        case 'pause':
          await sleep(cadence.pause);
          break;
      }
    }
    // let everything the keystrokes caused finish (a recheck after 1 s, a pass after it)
    if (!(await quietFor(4000, 90000))) problems.push('did not become quiet within 90 s');
    flushFrame();
    measuring = false;
    const durationMs = performance.now() - tStart;

    // metrics over the replay window
    const lines = tap.lines.slice(baseLine);
    const commands = tap.commands.slice(baseCmd);
    const evs = lines.filter((l) => !l.kind.startsWith('reply:'));
    const updates: Record<string, number> = {};
    for (const l of evs) if (l.kind.startsWith('ParagraphUpdate:')) updates[l.kind.slice(16)] = (updates[l.kind.slice(16)] ?? 0) + 1;
    const layouts = evs.filter((l) => l.kind === 'LayoutUpdate');
    const provisional = layouts.filter((l) => l.data.convergence?.state === 'Converging' && (l.data.convergence.reasons ?? []).includes('another pass is running'));
    const generations = new Set(evs.filter((l) => l.kind === 'EngineState').map((l) => l.data.engine_generation));
    generations.delete(generation0);
    const routed: Record<string, number> = {};
    const reasons: Record<string, number> = {};
    for (const l of lines) {
      if (l.kind !== 'reply:edit' && l.kind !== 'reply:set_document') continue;
      const r = l.data.result;
      routed[r.routed] = (routed[r.routed] ?? 0) + 1;
      for (const why of r.reasons ?? []) reasons[why] = (reasons[why] ?? 0) + 1;
    }
    for (const l of evs) if (l.kind === 'BackgroundScheduled') for (const why of l.data.reasons ?? []) reasons[`scheduled: ${why}`] = (reasons[`scheduled: ${why}`] ?? 0) + 1;
    const cmdCount: Record<string, number> = {};
    for (const c of commands) cmdCount[c.cmd] = (cmdCount[c.cmd] ?? 0) + 1;
    const stdoutBytes: Record<string, number> = {};
    for (const l of lines) stdoutBytes[l.kind] = (stdoutBytes[l.kind] ?? 0) + l.bytes;
    // live compiles the server ran (requests.log), discarded and superseded ones included
    let liveCompiles = 0;
    let warmups = 0;
    let refusals = 0;
    try {
      const reqLog = readFileSync(path.join(debug, 'requests.log'), 'utf8').split('\n');
      const startEpoch = Date.now() - (performance.now() - tStart);
      for (const line of reqLog) {
        const m = /^(\d+(?:\.\d+)?)\s+par \d+ (.*)$/.exec(line);
        if (!m) continue;
        const epochMs = Number(m[1]) * (m[1].includes('.') ? 1000 : 1);
        if (epochMs < startEpoch - 50) continue;
        if (/ status /.test(m[2])) { if (/\(warm-up\)/.test(m[2])) warmups++; else liveCompiles++; }
        else if (/refused:/.test(m[2])) refusals++;
      }
    } catch { problems.push('no requests.log'); }
    const closeT = closeAt as number | null;
    const closeRev = closeRevision as number | null;
    const converged = closeT !== null && closeRev !== null
      ? layouts.find((l) => l.t + tap!.t0 >= closeT && (l.data.source_revision ?? l.data.versions.source_revision) >= closeRev &&
          l.data.convergence?.state !== 'Stale')
      : undefined;
    const finalText = visibleText(view);
    for (const s of scenario.has) if (!finalText.includes(s)) problems.push(`final picture lacks ${s}`);
    for (const s of scenario.lacks) if (finalText.includes(s)) problems.push(`final picture still shows ${s}`);
    for (const s of [...scenario.stable, ...scenario.has]) if (count(finalText, s) > 1) problems.push(`final picture shows ${s} twice`);
    const diagMessages: string[] = [];
    let errors = 0;
    for (const list of (diagnostics.entries as Map<string, vscode.Diagnostic[]>).values()) {
      for (const d of list) {
        diagMessages.push(`${d.severity === 0 ? 'error' : 'other'} L${d.range.start.line + 1}: ${d.message.split('\n')[0]}`);
        if (d.severity === 0) errors++;
      }
    }
    const result: RunResult = {
      scenario: scenario.id, cadence: cadenceName, ok: problems.length === 0, problems, durationMs: Math.round(durationMs),
      liveCompiles, warmups, refusals, updates,
      fullCompiles: layouts.length - provisional.length, provisionalLayouts: provisional.length,
      failedLayouts: layouts.filter((l) => l.data.compile?.state === 'Failed').length,
      texRuns: layouts.reduce((n, l) => n + (l.data.passes ?? 0), 0),
      fullCompileWallMs: layouts.reduce((n, l) => n + (l.data.wall_ms ?? 0), 0),
      restarts: generations.size, routed, reasons, commands: cmdCount, stdoutBytes, posts, postBytes, pageRepaints, stableBroken, duplicated,
      closeToCorrectMs: closeT !== null && correctAt !== null ? Math.round((correctAt as number) - closeT) : null,
      closeToConvergedMs: closeT !== null && converged ? Math.round(converged.t + tap.t0 - closeT) : null,
      finalDiagnostics: { errors, messages: diagMessages.slice(0, 6) },
    };
    await fs.writeFile(path.join(outDir, `${scenario.id}.${cadenceName}.events.jsonl`),
      lines.map((l) => JSON.stringify({ t: Math.round(l.t), kind: l.kind, bytes: l.bytes,
        edit_id: l.data.edit_id ?? l.data.result?.edit_id, rev: l.data.versions?.source_revision ?? l.data.result?.source_revision,
        routed: l.data.result?.routed, reasons: l.data.reasons ?? l.data.result?.reasons, state: l.data.state ?? l.data.compile?.state,
        convergence: l.data.convergence?.state, wall_ms: l.data.wall_ms, par: l.data.par_id })).join('\n') + '\n' +
      commands.map((c) => JSON.stringify({ t: Math.round(c.t), command: c.cmd, start: c.data.start, end: c.data.end, text: c.data.text })).join('\n') + '\n');
    await fs.copyFile(path.join(debug, 'requests.log'), path.join(outDir, `${scenario.id}.${cadenceName}.requests.log`)).catch(() => undefined);
    return result;
  } finally {
    tap = undefined;
    session.dispose();
    delivery.dispose();
    await sleep(300);
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const root = path.resolve(opt('root') ?? path.join(__dirname, '..', '..'));
  const label = opt('label') ?? 'run';
  const cadences = (opt('cadence') ?? 'continuous,short,long,idle').split(',');
  const wanted = opt('scenario')?.split(',');
  const rounds = Number(opt('rounds') ?? 1);
  const scenarios = SCENARIOS.filter((s) => !wanted || wanted.includes(s.id));
  const outDir = path.join(path.resolve(__dirname, '..', '..'), 'live-test', 'math-typing', label);
  await fs.mkdir(outDir, { recursive: true });
  // keep LuaTeX's font caches between runs
  const cache = path.join(path.resolve(__dirname, '..', '..'), 'live-test', 'math-typing', '.texmf-cache');
  await fs.mkdir(cache, { recursive: true });
  process.env.TEXMFVAR = cache;
  process.env.TEXMFCACHE = cache;
  const results: RunResult[] = [];
  for (let r = 0; r < rounds; r++) {
    for (const cadence of cadences) {
      for (const s of scenarios) {
        const res = await run(root, s, cadence, outDir).catch((e: Error) => ({ scenario: s.id, cadence, ok: false, problems: [String(e.message ?? e)] }) as unknown as RunResult);
        results.push(res);
        const short = res.ok !== undefined && res.liveCompiles !== undefined
          ? `live ${res.liveCompiles} full ${res.fullCompiles} restarts ${res.restarts} req_layout ${res.commands?.request_layout ?? 0} correct ${res.closeToCorrectMs ?? '-'} ms`
          : '';
        console.log(`[${label}] ${s.id} / ${cadence}: ${res.ok ? 'ok' : 'PROBLEM ' + res.problems.join('; ')} ${short}`);
      }
    }
  }
  await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify({ label, root, rounds, cadences: CADENCES, results }, null, 1));
  console.log(`wrote ${path.join(outDir, 'summary.json')}`);
}

void main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
