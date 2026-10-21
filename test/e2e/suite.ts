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
import type { Session, SessionOutput } from '../../src/session';
import type { Line } from '../../src/protocol';
import { hitSourceAnchor } from '../../src/sourceAnchors';

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

/** Locate the rendered ink independently of source-map metadata. An obsolete background
 * row hidden by a live overlay must never be used as the clicked target. */
function renderedWord(s: Session, word: string, target = { start: 0, length: word.length }): { page: number; x: number; y: number; anchored: boolean; live: boolean; revision: number | undefined } {
  const matches: { page: number; x: number; y: number; anchored: boolean; live: boolean; revision: number | undefined }[] = [];
  const inspect = (page: number, row: Line, dx: number, dy: number, live: boolean, revision: number | undefined) => {
    const glyphs = row.items.filter((item) => item[0] === 'g' && typeof item[2] === 'number');
    // This synthetic document explicitly uses T1. Expand its ff/fi/fl ligatures while
    // retaining the real glyph rectangle used to dispatch the click.
    const ligatures: Record<number, string> = { 27: 'ff', 28: 'fi', 29: 'fl', 30: 'ffi', 31: 'ffl' };
    const glyphText = glyphs.map((item) => ligatures[item[2] as number] ?? String.fromCodePoint(item[2] as number));
    const text = glyphText.join('');
    const start = text.indexOf(word);
    if (start < 0) return;
    if (text.indexOf(word, start + 1) >= 0) throw new Error(`ambiguous rendered word ${word}`);
    const targetStart = start + target.start, targetEnd = targetStart + target.length - 1;
    let offset = 0, first = glyphs[0], last = glyphs[0];
    for (let i = 0; i < glyphs.length; i++) {
      const end = offset + glyphText[i].length;
      if (offset <= targetStart && targetStart < end) first = glyphs[i];
      if (offset <= targetEnd && targetEnd < end) last = glyphs[i];
      offset = end;
    }
    matches.push({ page, x: ((first[4] as number) + (last[4] as number) + (last[6] as number)) / 2 + dx,
      y: (first[5] as number) + dy, anchored: (row.source_anchors?.length ?? 0) > 0, live, revision });
  };
  for (const [page, pu] of s.model.pages) {
    const hidden = s.model.hiddenLines(page);
    pu.dl.lines.forEach((row, i) => { if (!hidden.has(i)) inspect(page, row, 0, 0, false, pu.dl.source_revision); });
    for (const overlay of s.model.overlaysOn(page)) for (const row of overlay.rows) inspect(page, row.line, row.dx, row.dy, true, overlay.overlay.revision);
  }
  if (matches.length !== 1) throw new Error(`${word}: expected one visible rendered occurrence, found ${matches.length}`);
  return matches[0];
}

async function sourceSyncSteps(api: Api, folder: string, step: (description: string) => void): Promise<void> {
  await vscode.commands.executeCommand('realtimeTex.stop');
  const main = await vscode.workspace.openTextDocument(path.join(folder, 'source-sync', 'main.tex'));
  const chapter = await vscode.workspace.openTextDocument(path.join(folder, 'source-sync', 'chapter.tex'));
  const original = main.getText();
  await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
  await vscode.commands.executeCommand('realtimeTex.openPreview');
  await waitFor('source-sync session', () => api.session()?.mainFile === main.fileName && !!api.session()?.running, 20000);
  const s = api.session()!;
  await waitFor('source-sync converged layout', () => s.model.hasLayout && s.status.phase === 'live' &&
    s.status.convergence?.state === 'Converged' && !s.status.pending, 120000);
  const outputs: SessionOutput[] = [];
  const watch = s.onOutput((output) => outputs.push(output));
  const expected = (doc: vscode.TextDocument, word: string) => {
    const at = doc.getText().indexOf(word);
    if (at < 0 || doc.getText().indexOf(word, at + 1) >= 0) throw new Error(`source marker ${word} is missing or ambiguous`);
    return doc.positionAt(at).line;
  };
  const assertSource = async (word: string, doc = main, requireLive = false, hit = renderedWord(s, word)) => {
    if (!hit.anchored) throw new Error(`${word}: rendered row has no source anchors`);
    if (!Number.isSafeInteger(hit.revision)) throw new Error(`${word}: source anchors have no compiled source revision`);
    if (requireLive && !hit.live) throw new Error(`${word}: expected a live overlay, got the background layout`);
    if (!(await s.jumpToSource(hit.page, hit.x, hit.y))) throw new Error(`${word}: source jump failed`);
    const active = vscode.window.activeTextEditor!;
    const line = expected(doc, word);
    if (active.document.uri.fsPath !== doc.uri.fsPath || active.selection.active.line !== line) {
      throw new Error(`${word}: expected ${path.basename(doc.fileName)}:${line + 1}, got ${path.basename(active.document.fileName)}:${active.selection.active.line + 1}`);
    }
    const column = doc.positionAt(doc.getText().indexOf(word)).character;
    if (!active.selection.isEmpty || active.selection.active.character !== column) {
      throw new Error(`${word}: expected word caret at ${line + 1}:${column}, got ${JSON.stringify(active.selection)}`);
    }
  };
  const assertMath = async (rendered: string, source: string, clicked: string, hit = renderedWord(s, rendered, {
    start: rendered.indexOf(clicked), length: clicked.length,
  })) => {
    if (!(await s.jumpToSource(hit.page, hit.x, hit.y))) throw new Error(`${source}: math source jump failed`);
    const active = vscode.window.activeTextEditor!;
    const sourceStart = main.getText().indexOf(source), sourceEnd = sourceStart + source.length;
    const selectedStart = main.offsetAt(active.selection.start), selectedEnd = main.offsetAt(active.selection.end);
    const clickedAt = sourceStart + source.indexOf(clicked);
    if (sourceStart < 0 || active.document.uri.fsPath !== main.uri.fsPath || active.selection.isEmpty ||
      selectedStart < sourceStart || selectedEnd > sourceEnd || selectedStart > clickedAt || selectedEnd <= clickedAt) {
      const anchor = hitSourceAnchor(s.model, hit.page, hit.x, hit.y);
      console.log(`[e2e] math selection diagnostic ${JSON.stringify({ hit, anchor, refinement: anchor?.refinement,
        sourceLine: active.document.lineAt(active.selection.active.line).text })}`);
      throw new Error(`${source}: expected selection of its clicked formula/fragment, got ${JSON.stringify(active.selection)}: ${active.document.getText(active.selection)}`);
    }
    return active.selection;
  };
  const edit = async (at: number, length: number, text: string, description: string) => {
    const after = outputs.length;
    const editor = await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
    await editor.edit((builder) => builder.replace(new vscode.Range(main.positionAt(at), main.positionAt(at + length)), text));
    await waitFor(description, () => outputs.slice(after).some((output) => output.kind === 'paragraph' && output.ev.status === 'ok'), 30000);
  };
  const undo = async (description: string) => {
    const after = outputs.length;
    await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('undo');
    await waitFor(description, () => outputs.slice(after).some((output) => output.kind === 'paragraph' && output.ev.status === 'ok'), 30000);
  };
  try {
    for (const word of ['Openingquartz', 'Revisionviolet', 'Desiredcobalt', 'Finalsaffron']) await assertSource(word);
    await assertSource('Chapterumber', chapter);
    step('source anchors select exact source lines in REV, an 80-comment proof, and an inline included file');

    for (const word of ['invisible', 'revisegold', 'saffronword']) await assertSource(word);
    const repeatedHit = renderedWord(s, 'middlelindenharborrightcedar', { start: 'middlelinden'.length, length: 'harbor'.length });
    if (!(await s.jumpToSource(repeatedHit.page, repeatedHit.x, repeatedHit.y))) throw new Error('repeated contextual word jump failed');
    const repeatedAt = main.positionAt(main.getText().indexOf('middlelinden harbor') + 'middlelinden '.length);
    if (!vscode.window.activeTextEditor!.selection.isEmpty || !vscode.window.activeTextEditor!.selection.active.isEqual(repeatedAt)) {
      throw new Error(`repeated harbor chose the wrong occurrence: ${JSON.stringify(vscode.window.activeTextEditor!.selection)}`);
    }
    step('interior prose, REV, a T1 ligature and repeated words select exact source word columns');

    await assertMath('u+v=w', '$u+v=w$', 'v');
    await assertMath('p+q=r', '$p+q=r$', 'q');
    await assertMath('c+d', '\\frac{c+d}{e+f}=g', 'd');
    await assertMath('h+k=l', 'h+k\n= l', 'k');
    step('two inline formulas, a displayed fraction and a display spanning source lines select the corresponding formula or fragment');

    // Real TeX errors deliberately keep the previous good ink visible. Its line remains
    // useful, but a same-line source change invalidates that old ink's precise columns.
    const staleHit = renderedWord(s, 'invisible');
    const staleEditor = await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
    await staleEditor.edit((builder) => builder.insert(main.positionAt(main.getText().indexOf('invisible')), '$x^$ '));
    await waitFor('a same-line live error with old source ink retained', () => vscode.languages.getDiagnostics(main.uri).some((d) =>
      d.severity === vscode.DiagnosticSeverity.Error), 30000);
    if (renderedWord(s, 'invisible').revision !== staleHit.revision) throw new Error('stale-column test lost its old rendered frame');
    if (!(await s.jumpToSource(staleHit.page, staleHit.x, staleHit.y))) throw new Error('stale ink lost its still-correct source line');
    const staleSelection = vscode.window.activeTextEditor!.selection;
    if (staleSelection.active.line !== expected(main, 'invisible') || !staleSelection.isEmpty ||
      staleSelection.active.character !== main.lineAt(expected(main, 'invisible')).firstNonWhitespaceCharacterIndex) {
      throw new Error(`same-line edit reused a stale word column: ${JSON.stringify(staleSelection)}`);
    }
    await undo('undoing the invalid same-line edit');
    await assertSource('invisible', main, true);
    if (main.getText() !== original) throw new Error('stale-column undo did not restore the synthetic source');
    step('old ink after a same-line error keeps the correct line without a stale column; undo restores exact word positioning');

    const markerEnd = main.getText().indexOf('Desiredcobalt') + 'Desiredcobalt'.length;
    await edit(markerEnd, 0, ' promptly', 'a live proof edit with source anchors');
    await assertSource('Desiredcobalt', main, true);
    await assertSource('invisible', main, true);
    await assertSource('Revisionviolet', main, true);
    await assertMath('p+q=r', '$p+q=r$', 'q');
    await undo('undoing the live proof edit');
    await assertSource('Desiredcobalt', main, true);
    await assertSource('invisible', main, true);
    if (main.getText() !== original) throw new Error('undo did not restore the original synthetic proof');
    step('live proof rows and their source positions update together, including undo');

    const added = '% Newly inserted comment one.\n% Newly inserted comment two.\n';
    await edit(main.getText().indexOf('Desiredcobalt'), 0, added, 'inserting source lines inside the proof');
    await assertSource('Desiredcobalt', main, true);
    const commentAt = main.getText().indexOf('% Comment 40:');
    const commentEnd = main.getText().indexOf('\n', commentAt) + 1;
    await edit(commentAt, commentEnd - commentAt, '', 'deleting an invisible source line inside the proof');
    await assertSource('Desiredcobalt', main, true);
    await undo('undoing a deleted source line');
    await assertSource('Desiredcobalt', main, true);
    await undo('undoing inserted source lines');
    await assertSource('Desiredcobalt', main, true);
    if (main.getText() !== original) throw new Error('source-line undo did not restore the original synthetic proof');
    step('inserted and deleted source lines inside the proof preserve exact jumps through undo');

    // The proof ink is unchanged: this exercises source rebasing, rather than a fresh
    // capture of the clicked proof. Newline edits in a different live unit shift its line.
    const outsideEnd = main.getText().indexOf('independent live update') + 'independent live update'.length;
    const proofRevision = renderedWord(s, 'Desiredcobalt').revision;
    await edit(outsideEnd, 0, '\n% Another unit changed its source line count.\n', 'editing lines in another live unit');
    if (renderedWord(s, 'Desiredcobalt').revision !== proofRevision) {
      throw new Error('outside-unit test did not preserve old proof anchors, so it cannot verify their rebasing');
    }
    await assertSource('Desiredcobalt');
    await assertSource('Revisionviolet');
    await undo('undoing line changes in another live unit');
    await assertSource('Desiredcobalt');
    if (main.getText() !== original) throw new Error('outside-unit undo did not restore the synthetic source');
    step('unchanged proof source anchors rebase after line edits in another unit and undo');

    // Undo can restore byte-identical drawing from the page cache. Its old source
    // revision must not retain the intervening deletion of the clicked source line.
    const targetLine = main.lineAt(expected(main, 'Desiredcobalt'));
    const targetAt = main.offsetAt(targetLine.rangeIncludingLineBreak.start);
    const targetLength = main.offsetAt(targetLine.rangeIncludingLineBreak.end) - targetAt;
    await edit(targetAt, targetLength, '', 'deleting the clicked source line');
    await undo('undoing the deleted clicked line');
    await assertSource('Desiredcobalt', main, true);
    const beforeCompile = outputs.length;
    s.recompile();
    await waitFor('a fresh converged layout after source-line undo', () => outputs.slice(beforeCompile).some((output) =>
      output.kind === 'layout' && output.ev.compile.state === 'Ok' && output.ev.convergence.state === 'Converged'), 120000);
    const settled = outputs.slice(beforeCompile).find((output) => output.kind === 'layout' &&
      output.ev.compile.state === 'Ok' && output.ev.convergence.state === 'Converged');
    if (settled?.kind !== 'layout' || !Number.isSafeInteger(settled.ev.source_revision) ||
      renderedWord(s, 'Desiredcobalt').revision !== settled.ev.source_revision) {
      throw new Error('restored background anchors did not use the exact compiled layout source revision');
    }
    if (renderedWord(s, 'Desiredcobalt').live) throw new Error('source-line undo cache check still used a live overlay');
    await assertSource('Desiredcobalt');
    if (main.getText() !== original) throw new Error('clicked-line undo did not restore the synthetic source');
    step('deleting a clicked line, undoing it, and restoring cached background ink preserves the source jump');

    // Add automation only to this test webview, with its existing CSP nonce. The actual
    // production dblclick listener computes coordinates and sends the normal jump message;
    // the extension then opens the source. No production-only test command is needed.
    const panel = api.panel()!.panel;
    const html = panel.webview.html;
    const nonce = /<script[^>]+nonce="([^"]+)"/.exec(html)?.[1];
    if (!nonce) throw new Error('preview CSP nonce was not found');
    let hit = renderedWord(s, 'invisible');
    let receivedJump = false, reloadedReady = false;
    const receive = panel.webview.onDidReceiveMessage((message) => {
      if (message.type === 'ready') reloadedReady = true;
      if (message.type === 'jump') console.log(`[e2e] webview jump ${JSON.stringify(message)}; expected ${JSON.stringify(hit)}`);
      // Crisp page sizes round to device pixels, and MouseEvent client coordinates
      // quantize CSS pixels. Allow one point here; the opened source file/line below
      // still has to match the independent source word/formula exactly.
      if (message.type === 'jump' && message.page === hit.page && Math.abs(message.x - hit.x) < 65536 && Math.abs(message.y - hit.y) < 65536) receivedJump = true;
    });
    const automation = `<script nonce="${nonce}">window.addEventListener('message', function(e) {
      if (e.data.type !== 'e2eDoubleClick') return;
      const m = e.data; let tries = 0;
      // At narrow fit-width sizes, integer MouseEvent CSS coordinates can quantize
      // beyond one TeX point. Use the real toolbar's deterministic 100% zoom first.
      document.querySelector('#zoomLabel').click();
      function click() {
        const el = document.querySelector('.page[data-page="' + m.page + '"]');
        if (!el || !el.querySelector('canvas') || !el.getBoundingClientRect().width) {
          if (++tries < 200) setTimeout(click, 50); return;
        }
        const rect = el.getBoundingClientRect(), k = parseFloat(el.style.width) / m.pageWidth;
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: rect.left + m.x * k, clientY: rect.top + m.y * k }));
      }
      requestAnimationFrame(function() { requestAnimationFrame(click); });
    });</script>`;
    try {
      panel.webview.html = html.replace('</body>', `${automation}</body>`);
      await waitFor('the reloaded test webview to become ready', () => reloadedReady, 30000);
      await vscode.window.showTextDocument(chapter, vscode.ViewColumn.One);
      await panel.webview.postMessage({ type: 'e2eDoubleClick', ...hit, pageWidth: s.model.pages.get(hit.page)!.dl.page_width! });
      const wordAt = main.positionAt(main.getText().indexOf('invisible'));
      await waitFor('the real webview double-click jump', () => receivedJump &&
        vscode.window.activeTextEditor?.document.uri.fsPath === main.uri.fsPath &&
        vscode.window.activeTextEditor.selection.isEmpty && vscode.window.activeTextEditor.selection.active.isEqual(wordAt), 30000);
      step('the real webview double-click opens the exact source word at its nonzero column');

      hit = renderedWord(s, 'p+q=r', { start: 2, length: 1 });
      receivedJump = false;
      await vscode.window.showTextDocument(chapter, vscode.ViewColumn.One);
      await panel.webview.postMessage({ type: 'e2eDoubleClick', ...hit, pageWidth: s.model.pages.get(hit.page)!.dl.page_width! });
      const formulaAt = main.getText().indexOf('$p+q=r$');
      await waitFor('the real webview formula double-click selection', () => {
        const active = vscode.window.activeTextEditor;
        if (!receivedJump || active?.document.uri.fsPath !== main.uri.fsPath || active.selection.isEmpty) return false;
        const start = main.offsetAt(active.selection.start), end = main.offsetAt(active.selection.end);
        return start >= formulaAt && end <= formulaAt + '$p+q=r$'.length && start <= formulaAt + 3 && end > formulaAt + 3;
      }, 30000);
      step('the real webview double-click selects the clicked inline formula on a line containing two formulas');
    } finally {
      receive.dispose();
      panel.webview.html = html;
    }
  } finally {
    watch.dispose();
    api.panel()?.panel.dispose();
    await waitFor('source-sync engine stopped', () => !s.running, 10000);
  }
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

  // Local diagnostic shortcut. Release/source/package validation still runs the full
  // suite; this only shortens iteration while investigating a source-navigation failure.
  if (process.env.RTEX_E2E_SOURCE_SYNC_ONLY === '1') {
    await sourceSyncSteps(api, folder, step);
    console.log(`[e2e] all ${steps.length} source-sync steps passed`);
    return;
  }

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
  await sourceSyncSteps(api, folder, step);
  console.log(`[e2e] all ${steps.length} steps passed`);
}
