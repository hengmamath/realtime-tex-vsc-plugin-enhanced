#!/usr/bin/env node
// Experiment: check the source anchors the Lua layer records when $RTEX_ANCHORS is set
// (rtex-dl.lua, rtex-capture.lua, rtex-serve.lua) against the source itself (marker words) and
// against SyncTeX for the very same background pass. Nothing is sent to the extension: anchors
// travel only in side files.
//
// The project is only read. Build files, anchors and the engine's in-memory edits stay in a
// temporary directory, which is removed unless --keep is given. Only statistics and line numbers
// are printed, never source text.
//
//   npm run test:anchors
//   node scripts/source-anchors.mjs --project <paper folder> --main paper.tex --probe "unique words=>QZXa"
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createEngineClient, checkpointLiveRecords, freshLiveRecords, matchLiveRecord, decodeLiveDisplayList, timingOrder, stopAllEngines } from './source-anchors-live.mjs';
import { uncommented } from './source-anchors-source.mjs';
import { assertAnchorExperiment } from './source-anchors-assert.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const flag = (name) => args.includes(name);
const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const project = path.resolve(opt('--project'));
const mainFile = opt('--main');
const texDir = path.resolve(opt('--texdir', path.join(repo, 'vendor/engine/tex')));
const engine = path.resolve(opt('--engine', path.join(repo, 'resources/rtex-engine/darwin-arm64/rtex')));
const texBin = opt('--texlive-bin', '/Library/TeX/texbin');
const work = mkdtempSync(path.join(os.tmpdir(), 'rtex-anchors-'));
const PT = 65536, SPBP = 65781.76;
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// ---------------------------------------------------------------------------------------------
// engine

function startEngine(label, anchors) {
  const build = path.join(work, label, 'build');
  const anchorsDir = path.join(work, label, 'anchors');
  mkdirSync(build, { recursive: true }); mkdirSync(anchorsDir, { recursive: true });
  const env = { ...process.env, PATH: `${texBin}:${process.env.PATH}`, RTEX_TEXDIR: texDir,
    TEXMFVAR: path.join(work, 'texmf-var'), TEXMFCACHE: path.join(work, 'texmf-var') };
  // This diagnostic compares raw Lua sidecars. Production normalization and revisions
  // are tested independently by the direct-transport/VS Code suite.
  delete env.RTEX_SOURCE_SYNC;
  if (flag('--production')) {
    // Timing only: exercise the direct mapping used by the installed preview, without
    // diagnostic hex/sidecar overhead. "on" now means the production source-sync flag.
    if (anchors) env.RTEX_SOURCE_SYNC = '1';
    delete env.RTEX_ANCHORS;
  } else if (anchors) env.RTEX_ANCHORS = anchorsDir;
  else delete env.RTEX_ANCHORS;
  const client = createEngineClient(engine, ['serve', '--project', project, '--main', mainFile, '--build', build], { label, cwd: work, env });
  const settled = async (from = 0) => {
    const layout = await client.waitEvent(from, (e) => e.event === 'LayoutUpdate' &&
      (e.compile.state === 'Failed' || e.convergence.state === 'Converged' || e.convergence.state === 'PassLimitReached'), 'a settled layout');
    if (layout.compile.state === 'Failed') throw new Error(`${label}: background compile failed`);
    return layout;
  };
  return { ...client, build, anchorsDir, settled };

}

// ---------------------------------------------------------------------------------------------
// source

const texts = new Map();  // project-relative path -> current text (the engine's buffer)
function text(rel) {
  if (!texts.has(rel)) texts.set(rel, readFileSync(path.join(project, rel), 'utf8'));
  return texts.get(rel);
}
const sourceFiles = () => {
  const out = [];
  const walk = (dir) => { for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { if (!/^(build|\.git|node_modules)$/.test(d.name)) walk(p); } else if (d.name.endsWith('.tex')) out.push(path.relative(project, p)); } };
  walk(project);
  return out;
};
const isCommentLine = (rel, n) => /^\s*%/.test(text(rel).split('\n')[n - 1] ?? '');
const lineOfByte = (s, b) => Buffer.from(s, 'utf8').subarray(0, b).toString('utf8').split('\n').length;
/** A path the engine reported (a snapshot of the source under the build directory) as a project path. */
function projectPath(p) {
  if (!p) return undefined;
  const m = /[\\/](?:src-body-\d+|src)[\\/](.+)$/.exec(p);
  return (m ? m[1] : p).replace(/^\.\//, '');
}

// ---------------------------------------------------------------------------------------------
// rows, words and anchors

const LIG = { 27: 'ff', 28: 'fi', 29: 'fl', 30: 'ffi', 31: 'ffl', 0xfb00: 'ff', 0xfb01: 'fi', 0xfb02: 'fl', 0xfb03: 'ffi', 0xfb04: 'ffl' };
const glyphs = (line) => line.items.filter((i) => i[0] === 'g').map((g) => ({ ch: LIG[g[2]] ?? String.fromCodePoint(g[2]), x: g[4], w: g[6] }));
/** Glyph runs of a row split at its interword glue anchors (the words as TeX spaced them). */
function words(line, anchors) {
  const gs = glyphs(line).sort((a, b) => a.x - b.x);
  const cuts = (anchors ?? []).filter((a) => a[4] === 'g').map((a) => [a[0], a[0] + a[1]]);
  const out = [];
  let cur;
  for (const g of gs) {
    const cut = cur && cuts.some(([a, b]) => a >= cur.x1 - PT / 4 && b <= g.x + PT / 4);
    if (!cur || cut || g.x - cur.x1 > 2 * PT) { cur = { text: '', x0: g.x, x1: g.x + g.w }; out.push(cur); }
    cur.text += g.ch; cur.x1 = Math.max(cur.x1, g.x + g.w);
  }
  return out;
}
/** The (tag, line) a rule picks for a word spanning [x0, x1] in a row: the glue right after the
 * word (the space read with it), the glue right before it, or the nearest glue; interword glue
 * ("g") before math spacing ("mg"), the row box last. */
function pick(row, x0, x1, rule) {
  const sorted = (kind) => (row?.a ?? []).filter((p) => p[4] === kind).sort((p, q) => p[0] - q[0]);
  const box = row && row.box_line > 0 ? [0, 0, row.box_tag, row.box_line, 'box'] : undefined;
  const choose = (a) => {
    const after = a.find((p) => p[0] >= x1 - PT / 2);
    const before = [...a].reverse().find((p) => p[0] + p[1] <= x0 + PT / 2);
    if (rule === 'after') return after ?? before;
    if (rule === 'before') return before ?? after;
    return a.reduce((best, p) => (!best || Math.abs(p[0] - (x0 + x1) / 2) < Math.abs(best[0] - (x0 + x1) / 2) ? p : best), undefined);
  };
  const hit = choose(sorted('g')) ?? choose(sorted('mg')) ?? box;
  return hit && { tag: hit[2], line: hit[3], kind: hit[4] };
}
const RULES = ['after', 'before', 'nearest'];

// ---------------------------------------------------------------------------------------------
// background pass

function lastPass(build, job) {
  const bg = path.join(build, 'bg');
  const dirs = readdirSync(bg).filter((d) => d.startsWith('pass-')).map((d) => path.join(bg, d))
    .filter((d) => existsSync(path.join(d, `${job}.rtex-anchors.json`)));
  dirs.sort((a, b) => statSync(path.join(b, `${job}.rtex-anchors.json`)).mtimeMs - statSync(path.join(a, `${job}.rtex-anchors.json`)).mtimeMs);
  if (!dirs.length) throw new Error('no pass wrote anchors');
  const dir = dirs[0];
  const anchors = JSON.parse(readFileSync(path.join(dir, `${job}.rtex-anchors.json`), 'utf8'));
  const pages = [];
  for (let n = 1; existsSync(path.join(dir, `${job}.rtex-page${n}.json`)); n++) pages.push(JSON.parse(readFileSync(path.join(dir, `${job}.rtex-page${n}.json`), 'utf8')));
  // The pass turned \synctex on at \begin{document}, after the main file was opened, so its
  // SyncTeX file names only the files read later. Copy it with the missing Input records (the
  // tags LuaTeX gave the files read before, as the capture noted them) for the reference lookups.
  const ref = path.join(work, 'synctex-ref', path.basename(dir));
  mkdirSync(ref, { recursive: true });
  const sync = execFileSync('gzip', ['-dc', path.join(dir, `${job}.synctex.gz`)], { encoding: 'utf8', maxBuffer: 1 << 30 });
  const known = new Set([...sync.matchAll(/^Input:(\d+):/gm)].map((m) => m[1]));
  const missing = Object.entries(anchors.tags).filter(([t]) => !known.has(t)).map(([t, f]) => `Input:${t}:${f}`);
  const lines = sync.split('\n');
  lines.splice(1, 0, ...missing);
  writeFileSync(path.join(ref, `${job}.synctex`), lines.join('\n'));
  copyFileSync(path.join(dir, `${job}.pdf`), path.join(ref, `${job}.pdf`));
  return { dir, ref, anchors, pages, pdf: path.join(ref, `${job}.pdf`), patchedInputs: missing.length };
}
function synctexAt(pass, page, x, y) {
  const out = execFileSync('synctex', ['edit', '-o', `${page}:${(x / SPBP).toFixed(2)}:${(y / SPBP).toFixed(2)}:${pass.pdf}`, '-d', pass.ref], { encoding: 'utf8' });
  const m = /Input:(.*)\nLine:(\d+)/.exec(out);
  return m ? { file: projectPath(m[1]), line: Number(m[2]) } : undefined;
}
const pct = (a, b) => `${(100 * a / Math.max(1, b)).toFixed(1)}%`;

function checkRows(pass) {
  let rows = 0, mismatched = Math.abs(pass.pages.length - pass.anchors.pages.length), withAnchors = 0, unknownTags = new Set();
  pass.pages.forEach((page, i) => {
    const ar = pass.anchors.pages[i] ?? [];
    if (ar.length !== page.lines.length) mismatched += Math.abs(ar.length - page.lines.length);
    page.lines.forEach((line, k) => {
      rows++;
      const r = ar[k];
      if (!r || r.y !== line.y || r.x !== line.x || r.w !== line.w) { mismatched++; return; }
      if (r.a.length) withAnchors++;
      const tags = [r.box_line > 0 ? r.box_tag : 0, ...r.a.map((a) => a[2])];
      for (const tag of tags) if (tag > 0 && !pass.anchors.tags[String(tag)]) unknownTags.add(tag);
    });
  });
  return { rows, mismatched, withAnchors, unknownTags: [...unknownTags] };
}

function markerReport(pass, job) {
  const MARK = /MK[a-z]{2}\d+[a-z]?/g;
  const expected = new Map();
  const add = (marker, point) => {
    if (expected.has(marker)) throw new Error(`source marker ${marker} is not unique`);
    expected.set(marker, point);
  };
  for (const rel of sourceFiles()) text(rel).split('\n').forEach((raw, i) => {
    const visible = uncommented(raw);
    for (const m of visible.matchAll(MARK)) add(m[0], { file: rel, line: i + 1 });
    for (const m of raw.slice(visible.length).matchAll(MARK)) add(m[0], { file: rel, line: i + 1, comment: true });
  });
  const seen = new Map();
  pass.pages.forEach((page, pi) => page.lines.forEach((line, k) => {
    const row = pass.anchors.pages[pi]?.[k];
    for (const w of words(line, row?.a)) for (const m of w.text.matchAll(MARK)) {
      const res = {};
      for (const rule of RULES) {
        const p = pick(row, w.x0, w.x1, rule);
        res[rule] = p && { file: projectPath(pass.anchors.tags[String(p.tag)]), line: p.line, kind: p.kind };
      }
      res.synctex = synctexAt(pass, pi + 1, (w.x0 + w.x1) / 2, line.y - 2 * PT);
      if (seen.has(m[0])) throw new Error(`rendered marker ${m[0]} is not unique`);
      seen.set(m[0], { page: pi + 1, ...res });
    }
  }));
  const rows = [];
  let decoys = 0;
  const score = Object.fromEntries([...RULES, 'synctex'].map((r) => [r, 0]));
  for (const [mark, exp] of expected) {
    const got = seen.get(mark);
    if (exp.comment) { if (got) decoys++; continue; }
    if (!got) { rows.push(`${mark.padEnd(8)} expected ${exp.file}:${exp.line}  NOT FOUND IN OUTPUT`); continue; }
    const cell = (r) => { const g = got[r]; const ok = g && g.file === exp.file && g.line === exp.line; if (ok) score[r]++; return `${(g ? `${g.file === exp.file ? '' : g.file + ':'}${g.line}` : '-').padStart(6)}${ok ? ' ' : '*'}`; };
    rows.push(`${mark.padEnd(8)} ${`${exp.file}:${exp.line}`.padEnd(16)} ${RULES.map(cell).join(' ')} ${cell('synctex')}`);
  }
  const total = [...expected.values()].filter((e) => !e.comment).length;
  const checks = [...expected].filter(([, exp]) => !exp.comment).map(([marker, exp]) => ({
    marker, expected: exp, found: seen.has(marker), got: seen.get(marker),
  }));
  return { rows, total, score, decoys, seen, checks, header: `${'marker'.padEnd(8)} ${'source'.padEnd(16)} ${RULES.map((r) => r.padStart(7)).join(' ')} synctex` };
}

const DISPLAY = /^(equation|align|gather|multline|flalign|alignat|eqnarray|displaymath)\*?$/;
/** Source ranges of display environments (\begin..\end outside comments), per file. */
function displayRanges(rel) {
  const stack = [], out = [];
  text(rel).split('\n').forEach((raw, i) => {
    for (const m of uncommented(raw).matchAll(/\\(begin|end)\{([^}]+)\}|\\\[|\\\]/g)) {
      const name = m[0] === '\\[' || m[0] === '\\]' ? 'displaymath' : m[2];
      const begin = m[1] === 'begin' || m[0] === '\\[';
      if (!DISPLAY.test(name)) continue;
      if (begin) stack.push({ name, from: i + 1 });
      else { const k = stack.map((s) => s.name).lastIndexOf(name); if (k >= 0) { out.push({ name, from: stack[k].from, to: i + 1 }); stack.splice(k); } }
    }
  });
  return out;
}

function synctexReport(pass, perRow = 3) {
  const stats = Object.fromEntries(RULES.map((r) => [r, { exact: 0, near: 0, file: 0, comment: 0, none: 0 }]));
  const ranges = new Map();
  const display = { points: 0, exact: 0, same_display: 0, display_end_line: 0, synctex_end_line: 0 };
  // Agreement with SyncTeX is a comparison, not an independent word/column ground truth.
  // Do not infer visible words from TeX source: macro arguments may be invisible, and
  // deleting punctuation/whitespace can join separate words into a false match.
  const disagreements = { file: 0, line: 0 };
  let n = 0;
  pass.pages.forEach((page, pi) => page.lines.forEach((line, k) => {
    if (!line.unit) return;
    const row = pass.anchors.pages[pi]?.[k];
    const ws = words(line, row?.a);
    if (!ws.length) return;
    for (let s = 0; s < perRow; s++) {
      const w = ws[Math.min(ws.length - 1, Math.floor(((s + 0.5) / perRow) * ws.length))];
      const truth = synctexAt(pass, pi + 1, (w.x0 + w.x1) / 2, line.y - 2 * PT);
      if (!truth) continue;
      n++;
      for (const rule of RULES) {
        const p = pick(row, w.x0, w.x1, rule);
        const st = stats[rule];
        if (!p) { st.none++; continue; }
        const file = projectPath(pass.anchors.tags[String(p.tag)]);
        if (file === truth.file) st.file++;
        if (file === truth.file && p.line === truth.line) st.exact++;
        if (file === truth.file && Math.abs(p.line - truth.line) <= 1) st.near++;
        if (file && isCommentLine(file, p.line)) st.comment++;
        if (rule === 'after' && truth.file && existsSync(path.join(project, truth.file))) {
          if (!ranges.has(truth.file)) ranges.set(truth.file, displayRanges(truth.file));
          const env = ranges.get(truth.file).find((r) => r.from <= truth.line && truth.line <= r.to);
          if (env) {
            display.points++;
            if (file === truth.file && p.line === truth.line) display.exact++;
            if (file === truth.file && env.from <= p.line && p.line <= env.to) display.same_display++;
            if (file === truth.file && p.line === env.to) display.display_end_line++;
            if (truth.line === env.to) display.synctex_end_line++;
          }
        }
        if (rule === 'after' && file !== truth.file) disagreements.file++;
        else if (rule === 'after' && p.line !== truth.line) disagreements.line++;
      }
    }
  }));
  return { n, stats, disagreements, display };
}

// ---------------------------------------------------------------------------------------------
// live results: rows of a ParagraphUpdate and the anchors logged for that compile

function liveRecord(eng, checkpoint, event) {
  return matchLiveRecord(freshLiveRecords(eng.anchorsDir, checkpoint), event,
    (record) => decodeLiveDisplayList(record, engine, path.join(work, 'decoded-live')));
}

async function liveEdit(eng, rel, needle, insert, marker) {
  if (eng.editPending) throw new Error('live edits must be serialized to associate their anchor records');
  eng.editPending = true;
  try {
    const before = text(rel);
    const at = before.indexOf(needle);
    if (at < 0) throw new Error(`needle not found in ${rel}`);
    const start = Buffer.byteLength(before.slice(0, at + needle.length));
    const from = eng.events.length;
    const checkpoint = checkpointLiveRecords(eng.anchorsDir);
    const reply = await eng.request({ cmd: 'edit', path: rel, start, end: start, text: insert });
    if (reply.reply !== 'edit') return { marker, routed: reply.reply, error: reply.message };
    texts.set(rel, before.slice(0, at + needle.length) + insert + before.slice(at + needle.length));
    const res = reply.result;
    if (res.routed !== 'fast') return { marker, routed: res.routed, reasons: res.reasons };
    const ev = await eng.waitEvent(from, (e) => (e.event === 'ParagraphUpdate' || e.event === 'BackgroundScheduled') && e.edit_id === res.edit_id, 'the live result', 30000);
    if (ev.event !== 'ParagraphUpdate' || ev.status !== 'ok') return { marker, routed: 'fast', event: ev.event, status: ev.status, reasons: ev.reasons };
    if (eng.events.slice(from).some((e) => e.event === 'EngineState' && e.engine_generation !== ev.versions.engine_generation)) {
      return { marker, routed: 'fast', missing: 'engine generation changed during the edit' };
    }
    let rec;
    try { rec = liveRecord(eng, checkpoint, ev); }
    catch (error) { return { marker, routed: 'fast', missing: error.message }; }
    const spansReply = await eng.request({ cmd: 'spans', path: rel });
    if (spansReply.reply !== 'spans' || !Array.isArray(spansReply.spans)) throw new Error('engine did not return source spans');
    const span = spansReply.spans.find((s) => s.id === ev.par_id);
    if (!span) return { marker, routed: 'fast', missing: 'live paragraph has no current source span' };
    const spanLine = lineOfByte(text(rel), span.range.start);
    const exp = text(rel).split('\n').findIndex((l) => uncommented(l).includes(marker)) + 1;
    const out = { marker, routed: 'fast', event: ev.event, status: ev.status, par: ev.par_id, expected: `${rel}:${exp}`, timing_us: ev.timing.total_us,
      record: { server: rec.log, req: rec.req, ctx: rec.ctx } };
    ev.dl.lines.forEach((line, k) => {
      for (const w of words(line, rec.rows[k]?.a)) {
        if (!w.text.includes(marker)) continue;
        for (const rule of RULES) {
          const p = pick(rec.rows[k], w.x0, w.x1, rule);
          out[rule] = p ? (p.tag === 0 ? spanLine + p.line - 2 : `tag${p.tag}:${p.line}`) : '-';
        }
      }
    });
    return out;
  } finally { eng.editPending = false; }
}

/** Rows whose text matches `rowRe` and the line each rule (and SyncTeX) gives for `word` in them. */
function wordReport(pass, rowRe, word) {
  const out = [];
  pass.pages.forEach((page, pi) => page.lines.forEach((line, k) => {
    const row = pass.anchors.pages[pi]?.[k];
    const ws = words(line, row?.a);
    if (!new RegExp(rowRe).test(ws.map((w) => w.text).join(''))) return;
    for (const w of ws) {
      if (!w.text.startsWith(word)) continue;
      const res = { page: pi + 1, word };
      for (const rule of RULES) { const p = pick(row, w.x0, w.x1, rule); res[rule] = p ? `${projectPath(pass.anchors.tags[String(p.tag)])}:${p.line}` : '-'; }
      const s = synctexAt(pass, pi + 1, (w.x0 + w.x1) / 2, line.y - 2 * PT);
      res.synctex = s ? `${s.file}:${s.line}` : '-';
      out.push(res);
    }
  }));
  return out;
}

/** Medians of background pass time and live compile time, anchors off and on, alternating runs. */
async function timing(rounds, needle) {
  if (!Number.isSafeInteger(rounds) || rounds < 1) throw new Error('--timing requires a positive integer');
  if (!needle) throw new Error('a timing needle is required');
  const base = readFileSync(path.join(project, mainFile), 'utf8');
  if (!base.includes(needle)) throw new Error('timing needle was not found');
  const res = { off: { wall: [], live: [], tex: [], traverse: [], attempts: 0, failures: [] }, on: { wall: [], live: [], tex: [], traverse: [], attempts: 0, failures: [] } };
  const warm = startEngine('warmup', false);
  try { await warm.settled(); } finally { await warm.stop(); }
  // Reverse the pair order on alternate rounds, so neither mode always gets the later run.
  for (let r = 0; r < rounds; r++) for (const mode of timingOrder(r)) {
    const eng = startEngine(`t${r}-${mode}`, mode === 'on');
    try {
      await eng.settled();
      res[mode].wall.push(eng.events.filter((e) => e.event === 'LayoutUpdate').reduce((n, e) => n + e.wall_ms, 0));
      let src = base;
      for (let i = 0; i < 12; i++) {
        const at = src.indexOf(needle) + needle.length;
        const start = Buffer.byteLength(src.slice(0, at));
        const from = eng.events.length;
        res[mode].attempts++;
        const reply = await eng.request({ cmd: 'edit', path: mainFile, start, end: start, text: 'x' });
        if (reply.reply !== 'edit') { res[mode].failures.push({ round: r, edit: i, reply: reply.reply }); continue; }
        src = src.slice(0, at) + 'x' + src.slice(at);
        if (reply.result.routed !== 'fast') { res[mode].failures.push({ round: r, edit: i, routed: reply.result.routed, reasons: reply.result.reasons }); continue; }
        const ev = await eng.waitEvent(from, (e) => (e.event === 'ParagraphUpdate' || e.event === 'BackgroundScheduled') && e.edit_id === reply.result.edit_id, 'a live result', 30000);
        if (ev.event !== 'ParagraphUpdate' || ev.status !== 'ok') res[mode].failures.push({ round: r, edit: i, event: ev.event, status: ev.status, reasons: ev.reasons });
        else if (i >= 2) {
          res[mode].live.push(ev.timing.total_us); res[mode].tex.push(ev.timing.tex_us); res[mode].traverse.push(ev.timing.traverse_us);
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    } finally { await eng.stop(); }
  }
  const med = (v) => { const sorted = [...v].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };
  return Object.fromEntries(Object.entries(res).map(([mode, values]) => [mode, { passes_ms: med(values.wall), live_total_us: med(values.live), live_tex_us: med(values.tex), live_traverse_us: med(values.traverse), live_samples: values.live.length, attempts: values.attempts, warmup_edits: rounds * 2, failures: values.failures }]));
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const job = path.basename(mainFile, '.tex');
  if (flag('--production') && !opt('--timing')) throw new Error('--production is only supported with --timing');
  const policy = opt('--expectations') ? JSON.parse(readFileSync(path.resolve(opt('--expectations')), 'utf8')) : {};
  if (opt('--timing')) {
    const before = Object.fromEntries(sourceFiles().map((f) => [f, sha(path.join(project, f))]));
    const rounds = Number(opt('--timing'));
    const result = await timing(rounds, opt('--timing-needle', 'MKpr2 The paragraph resumes'));
    console.log(JSON.stringify(result));
    const after = Object.fromEntries(sourceFiles().map((f) => [f, sha(path.join(project, f))]));
    const unchanged = JSON.stringify(before) === JSON.stringify(after);
    console.log(`project files unchanged: ${unchanged}`);
    if (!unchanged) throw new Error('timing experiment changed project source files');
    for (const [mode, sample] of Object.entries(result)) {
      if (sample.failures.length || sample.attempts !== rounds * 12 || sample.live_samples !== rounds * 10) {
        throw new Error(`${mode}: incomplete or unsuccessful timing samples`);
      }
    }
    return;
  }
  const before = Object.fromEntries(sourceFiles().map((f) => [f, sha(path.join(project, f))]));
  const report = [];
  let off;
  if (flag('--compare-off')) {
    off = startEngine('off', false);
    off.layout = await off.settled();
  }
  const on = startEngine('on', true);
  on.layout = await on.settled();
  const pass = lastPass(on.build, job);
  const rowsCheck = checkRows(pass);
  const evidence = { rows: rowsCheck };
  report.push(`pages ${pass.pages.length}, rows ${rowsCheck.rows}, rows with anchors ${pct(rowsCheck.withAnchors, rowsCheck.rows)}, rows not matching their anchors ${rowsCheck.mismatched}, unknown SyncTeX tags ${JSON.stringify(rowsCheck.unknownTags)}`);
  report.push(`SyncTeX files behind the tags: ${JSON.stringify(Object.fromEntries(Object.entries(pass.anchors.tags).map(([t, f]) => [t, projectPath(f)])))}; Input records added to the reference copy: ${pass.patchedInputs}`);
  if (off) {
    const pages = (eng) => { const m = new Map(); for (const e of eng.events.filter((e) => e.event === 'LayoutUpdate')) for (const p of e.pages_changed) m.set(p.page, p.dl); return m; };
    const a = pages(off), b = pages(on);
    const same = isDeepStrictEqual(a, b) && a.size === off.layout.pages_total && b.size === on.layout.pages_total;
    evidence.displayLists = { same, pagesOff: a.size, pagesOn: b.size };
    const wall = (eng) => eng.events.filter((e) => e.event === 'LayoutUpdate').map((e) => e.wall_ms);
    report.push(`display lists identical with anchors off/on: ${same} (${a.size} pages); pass wall ms off ${JSON.stringify(wall(off))} on ${JSON.stringify(wall(on))}`);
  }
  let markers;
  if (flag('--markers')) {
    markers = markerReport(pass, job);
    evidence.markers = markers;
    const m = markers;
    report.push(`markers in the source: ${m.total}; exact file:line  ${Object.entries(m.score).map(([r, s]) => `${r} ${s}/${m.total}`).join(', ')}; comment decoys typeset: ${m.decoys}`);
    report.push(m.header, ...m.rows);
  }
  for (const spec of all('--word')) {
    const [rowRe, word] = spec.split('::');
    for (const r of wordReport(pass, rowRe, word)) report.push(`word ${JSON.stringify(r)}`);
  }
  if (!flag('--no-synctex')) {
    const s = synctexReport(pass, Number(opt('--per-row', '3')));
    report.push(`against SyncTeX of the same pass, ${s.n} points:`);
    for (const [rule, st] of Object.entries(s.stats)) report.push(`  ${rule.padEnd(8)} exact ${pct(st.exact, s.n)}  within 1 ${pct(st.near, s.n)}  same file ${pct(st.file, s.n)}  no anchor ${pct(st.none, s.n)}  on a %-line ${pct(st.comment, s.n)}`);
    report.push(`  where "after" and SyncTeX disagree (not word/column truth): ${JSON.stringify(s.disagreements)}`);
    report.push(`  points SyncTeX puts inside display math: ${JSON.stringify(s.display)}`);
  }
  const live = [];
  const files = [...new Set([mainFile, ...sourceFiles()])];
  const original = new Map(files.map((f) => [f, text(f)]));
  const spansOf = async () => {
    const out = new Map();
    for (const f of files) {
      const reply = await on.request({ cmd: 'spans', path: f });
      if (reply.reply !== 'spans' || !Array.isArray(reply.spans)) throw new Error('engine did not return source spans');
      out.set(f, reply.spans);
    }
    return out;
  };
  const spansBefore = await spansOf();
  if (flag('--live')) {
    const plan = [
      ['main.tex', 'MKpr2 The paragraph resumes', ' MKlva', 'MKlva'],
      ['main.tex', 'MKpr4 This completes the proof.', '\nMKlvb on a new source line.', 'MKlvb'],
      // two lines inside an early paragraph: everything after it moves down by two lines
      ['main.tex', 'source lines. MKpa2 sits on the second source line\n', '% two comment lines added\n% inside the paragraph\n', 'MKpa3'],
      ['main.tex', 'and MKpa3 on the third', ' MKlvc', 'MKlvc'],
      ['chapter.tex', 'MKch1 Text from an included file', ' MKlvd', 'MKlvd'],
    ];
    for (const [rel, needle, insert, marker] of plan) {
      live.push(await liveEdit(on, rel, needle, insert, marker));
      await new Promise((res) => setTimeout(res, 400));
    }
  }
  for (const spec of all('--probe')) {
    const [needle, marker] = spec.split('=>');
    live.push(await liveEdit(on, mainFile, needle, ` ${marker}`, marker));
  }
  if (live.length) { report.push('live results (expected file:line, then each rule; tag-0 lines are span start + line - 2):'); for (const r of live) report.push(`  ${JSON.stringify(r)}`); }
  if (flag('--live') || all('--probe').length) evidence.live = live;
  if (markers && live.length) {
    // Background rows keep the lines of their pass until the next layout. A line relative to the
    // start of its span (span ids survive edits elsewhere) gives the current line.
    const spansAfter = await spansOf();
    const edited = new Set(live.map((r) => r.par).filter((p) => p !== undefined));
    let n = 0, naive = 0, rebased = 0;
    for (const [mark, got] of markers.seen) {
      const bg = got.after;
      if (!bg?.file || !original.has(bg.file)) continue;
      const startLine = (txt, s) => lineOfByte(txt, s.range.start);
      const span = (spansBefore.get(bg.file) ?? []).find((s) => startLine(original.get(bg.file), s) <= bg.line &&
        bg.line <= lineOfByte(original.get(bg.file), Math.max(s.range.start, s.range.end - 1)));
      if (!span || edited.has(span.id)) continue;
      const now = (spansAfter.get(bg.file) ?? []).find((s) => s.id === span.id);
      const expected = text(bg.file).split('\n').findIndex((l) => uncommented(l).includes(mark)) + 1;
      if (!now || expected === 0) continue;
      n++;
      if (bg.line === expected) naive++;
      if (startLine(text(bg.file), now) + (bg.line - startLine(original.get(bg.file), span)) === expected) rebased++;
    }
    report.push(`background rows after the edits, before the next layout (${n} markers outside edited spans): pass line exact ${naive}/${n}, span-relative line exact ${rebased}/${n}`);
    evidence.rebase = { total: n, rebased };
  }
  await on.stop();
  if (off) await off.stop();
  const after = Object.fromEntries(sourceFiles().map((f) => [f, sha(path.join(project, f))]));
  evidence.projectFilesUnchanged = JSON.stringify(before) === JSON.stringify(after);
  report.push(`project files unchanged: ${evidence.projectFilesUnchanged}`);
  console.log(report.join('\n'));
  const accepted = assertAnchorExperiment(evidence, policy);
  console.log(`acceptance passed (file:line only; columns not measured); named marker limitations: ${accepted.markerExceptions.join(', ') || 'none'}; named live limitations: ${accepted.liveExceptions.join(', ') || 'none'}`);
}

try { await main(); }
catch (e) { console.error(e); process.exitCode = 1; }
finally {
  let cleanupFailed = false;
  try { await stopAllEngines(); }
  catch (error) { cleanupFailed = true; process.exitCode = 1; console.error(error); }
  if (flag('--keep') || cleanupFailed) console.log(`kept ${work}${cleanupFailed ? ' (engine cleanup failed)' : ''}`);
  else rmSync(work, { recursive: true, force: true });
}
