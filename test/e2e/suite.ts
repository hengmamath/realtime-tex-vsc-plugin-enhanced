// Integration suite, run inside the VS Code extension host by runTest.ts.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Api } from '../../src/extension';
import { processEnv, resolveServer } from '../../src/config';
import { getBundledRuntime } from '../../src/bundledRuntime';
import type { Session, SessionOutput } from '../../src/session';
import type { Line } from '../../src/protocol';
import { hitSourceAnchor } from '../../src/sourceAnchors';
import { testFollowConfig } from './followConfig';
import { twoPagePdf } from '../pdfFixture';

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

async function insertAfter(doc: vscode.TextDocument, needle: string, text: string): Promise<void> {
  const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  const at = doc.positionAt(doc.getText().indexOf(needle) + needle.length);
  await editor.edit((e) => e.insert(at, text));
}

/** Locate the rendered ink independently of source-map metadata. An obsolete background
 * row hidden by a live overlay must never be used as the clicked target. */
function renderedWord(s: Session, word: string, target = { start: 0, length: word.length }): { page: number; x: number; y: number; baseline: number; anchored: boolean; live: boolean; revision: number | undefined } {
  const matches: { page: number; x: number; y: number; baseline: number; anchored: boolean; live: boolean; revision: number | undefined }[] = [];
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
      y: (first[5] as number) + dy, baseline: row.y + dy, anchored: (row.source_anchors?.length ?? 0) > 0, live, revision });
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
  const assertPreview = async (word: string, doc = main, requireLive = false, hit = renderedWord(s, word)) => {
    if (requireLive && !hit.live) throw new Error(`${word}: forward sync did not use live ink`);
    const pos = doc.positionAt(doc.getText().indexOf(word));
    const after = outputs.length;
    if (!(await s.revealInPreview(doc, pos, true))) throw new Error(`${word}: forward source jump failed`);
    const reveal = outputs.slice(after).find((output) => output.kind === 'reveal');
    if (reveal?.kind !== 'reveal' || !reveal.force || reveal.target.page !== hit.page || Math.abs(reveal.target.y - hit.y) > 65536) {
      throw new Error(`${word}: expected forward jump to rendered row ${JSON.stringify(hit)}, got ${JSON.stringify(reveal)}`);
    }
    // Use the public reverse path so captured source lines are rebased through edits,
    // rather than comparing a stale frame's raw line number to the current document.
    if (!(await s.jumpToSource(reveal.target.page, reveal.target.x, reveal.target.y))) {
      throw new Error(`${word}: forward target did not round-trip to source`);
    }
    const active = vscode.window.activeTextEditor!;
    if (active.document.uri.fsPath !== doc.uri.fsPath || active.selection.active.line !== expected(doc, word)) {
      throw new Error(`${word}: forward target returned to ${active.document.fileName}:${active.selection.active.line + 1}`);
    }
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
    if (['Openingquartz', 'Revisionviolet', 'Desiredcobalt', 'Finalsaffron', 'Chapterumber', 'invisible', 'revisegold'].includes(word)) {
      await assertPreview(word, doc, requireLive, hit);
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
  const assertForwardMath = async (rendered: string, source: string, clicked: string) => {
    const hit = renderedWord(s, rendered);
    const sourceAt = main.getText().indexOf(source) + source.indexOf(clicked);
    const before = outputs.length;
    if (!(await s.revealInPreview(main, main.positionAt(sourceAt), true))) throw new Error(`${source}/${clicked}: forward math jump failed`);
    const reveal = outputs.slice(before).find((output) => output.kind === 'reveal');
    // A fraction numerator/denominator has a different glyph baseline; compare the
    // actual containing rendered row rather than an arbitrary symbol's vertical offset.
    if (reveal?.kind !== 'reveal' || !reveal.force || reveal.target.page !== hit.page || Math.abs(reveal.target.y - hit.baseline) > 65536) {
      throw new Error(`${source}/${clicked}: forward math selected the wrong rendered row: ${JSON.stringify({ hit, reveal })}`);
    }
    await assertMath(rendered, source, clicked, { ...hit, ...reveal.target });
  };
  const edit = async (at: number, length: number, text: string, description: string) => {
    const after = outputs.length;
    const editor = await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
    await editor.edit((builder) => builder.replace(new vscode.Range(main.positionAt(at), main.positionAt(at + length)), text));
    await waitFor(description, () => outputs.slice(after).some((output) => output.kind === 'paragraph' && output.ev.status === 'ok'), 30000);
  };
  const undo = async (description: string) => {
    const after = outputs.length;
    const previousText = main.getText(), previousVersion = main.version;
    await vscode.commands.executeCommand('workbench.action.focusWindow');
    await waitFor(description + ': native window focused', () => vscode.window.state.focused, 5000);
    await vscode.window.showTextDocument(main, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
    // Reverse source jumps can leave the preview as the workbench's last focused widget.
    // The global undo command must reach the source editor, and change its buffer, before
    // waiting for the corresponding engine result.
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    if (vscode.window.activeTextEditor?.document.uri.fsPath !== main.uri.fsPath) {
      throw new Error(description + ': the source editor did not receive focus');
    }
    await vscode.commands.executeCommand('undo');
    await waitFor(description + ': source buffer changed', () =>
      main.version > previousVersion && main.getText() !== previousText, 5000);
    await waitFor(description, () => outputs.slice(after).some((output) => output.kind === 'paragraph' && output.ev.status === 'ok'), 30000);
  };
  try {
    for (const word of ['Openingquartz', 'Revisionviolet', 'Desiredcobalt', 'Finalsaffron']) await assertSource(word);
    await assertSource('Chapterumber', chapter);
    step('source anchors select exact source and preview rows in REV, an 80-comment proof, and an inline included file');

    const commentOutputs = outputs.length;
    if (await s.revealInPreview(main, main.positionAt(main.getText().indexOf('% Comment 40:')), true)) {
      throw new Error('an invisible comment borrowed a guessed preview location');
    }
    if (outputs.slice(commentOutputs).some((output) => output.kind === 'reveal')) throw new Error('comment navigation emitted a guessed reveal');
    step('an invisible source comment does not guess a position through the whole proof');

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

    await assertForwardMath('u+v=w', '$u+v=w$', 'v');
    await assertForwardMath('p+q=r', '$p+q=r$', 'q');
    await assertForwardMath('c+d', '\\frac{c+d}{e+f}=g', 'd');
    await assertForwardMath('e+f', '\\frac{c+d}{e+f}=g', 'e');
    await assertForwardMath('h+k=l', 'h+k\n= l', 'k');
    await assertForwardMath('h+k=l', 'h+k\n= l', 'l');
    step('source positions in two inline formulas, a fraction and both display source lines reveal the exact formula row');

    // Real TeX errors deliberately keep the previous good ink visible. Its line remains
    // useful, but a same-line source change invalidates that old ink's precise columns.
    const staleHit = renderedWord(s, 'invisible');
    const staleEditor = await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
    await staleEditor.edit((builder) => builder.insert(main.positionAt(main.getText().indexOf('invisible')), '$x^2^3$ '));
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
    await assertForwardMath('c+d', '\\frac{c+d}{e+f}=g', 'd');
    await assertForwardMath('h+k=l', 'h+k\n= l', 'l');
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

    // A reverse jump, another extension or a keyboard navigation command can set the
    // same selection shape as a click. Only genuine mouse selection events may follow.
    const previousEventMode = vscode.workspace.getConfiguration('realtimeTex', main.uri).inspect('followCursor')?.workspaceValue;
    const selectionEditor = await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
    const wordRange = main.getWordRangeAtPosition(main.positionAt(main.getText().indexOf('Revisionviolet')))!;
    let editorSelectionEvents = 0;
    const selectionWatch = vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor === selectionEditor) editorSelectionEvents++;
    });
    try {
      for (const mode of ['doubleClick', 'singleClick', 'off']) {
        await vscode.workspace.getConfiguration('realtimeTex', main.uri).update('followCursor', mode, vscode.ConfigurationTarget.Workspace);
        const beforeSelections = editorSelectionEvents, beforeProgrammatic = outputs.length;
        selectionEditor.selection = new vscode.Selection(wordRange.start, wordRange.end);
        await waitFor(`${mode} programmatic selection event`, () => editorSelectionEvents > beforeSelections, 10000);
        await sleep(350);
        if (outputs.slice(beforeProgrammatic).some((output) => output.kind === 'reveal')) {
          throw new Error(`${mode}: a programmatic word selection triggered cursor follow`);
        }
        const beforeKeyboard = outputs.length;
        await vscode.commands.executeCommand('cursorMove', { to: 'right', by: 'character', value: 1 });
        await waitFor(`${mode} keyboard navigation`, () => selectionEditor.selection.isEmpty &&
          selectionEditor.selection.active.isAfterOrEqual(wordRange.end), 10000);
        await sleep(350);
        if (outputs.slice(beforeKeyboard).some((output) => output.kind === 'reveal')) {
          throw new Error(`${mode}: keyboard cursor navigation triggered cursor follow`);
        }
      }
      step('programmatic word selections and keyboard cursor navigation do not move the preview in any follow mode');
    } finally {
      selectionWatch.dispose();
      await vscode.workspace.getConfiguration('realtimeTex', main.uri).update('followCursor', previousEventMode, vscode.ConfigurationTarget.Workspace);
    }

    // Add automation only to this test webview, with its existing CSP nonce. The actual
    // production dblclick listener computes coordinates and sends the normal jump message;
    // the extension then opens the source. No production-only test command is needed.
    const panel = api.panel()!.panel;
    const html = panel.webview.html;
    const nonce = /<script[^>]+nonce="([^"]+)"/.exec(html)?.[1];
    if (!nonce) throw new Error('preview CSP nonce was not found');
    let hit = renderedWord(s, 'invisible');
    let receivedJump = false, automationReady = false;
    const automationContext = `source-sync-${Date.now()}`;
    interface UiState {
      follow: string; choices: string[]; hasCanvas: boolean; markers: number;
      followText: string; followWidth: number; followIcon: boolean; followActive: boolean; followTitle: string;
      recompileText: string; recompileLabel: string; pageText: string; pageCount: number;
      backDisabled: boolean; forwardDisabled: boolean; pageJumpOpen: boolean; pageValue: string;
      pageTotal: string; pageInvalid: boolean; menuOpen: boolean; menuRole: string;
      menuCommands: string[]; commands: string[]; activeId: string;
      documentId: string; outlineOpen: boolean; outlineRole: string; outlineWidth: number;
      outlineRows: { id: string; title: string; expanded: string | null; current: boolean }[];
      outlineEmpty: string; outlineBackdrop: boolean; outlineSaved?: { open: boolean; width: number; collapsed: string[] };
      animationFramesHeld: boolean; visibilityState: string;
      paintedPages: number[]; canvasBytes: number; firstCanvasWidth: number; dpr: number; imagePixels: number[][];
      outlineGeometry: { scrollTop: number; width: number; height: number; scrollHeight: number; pages: { top: number; width: number; height: number }[] };
    }
    const uiStates = new Map<number, UiState>();
    const followMessages: string[] = [];
    const receive = panel.webview.onDidReceiveMessage((message) => {
      if (message.type === 'e2eAutomationReady' && message.context === automationContext) automationReady = true;
      if (message.type === 'e2eUiState' && message.context === automationContext) uiStates.set(message.token, message);
      if (message.type === 'setFollow') followMessages.push(message.value);
      if (message.type === 'jump') console.log(`[e2e] webview jump ${JSON.stringify(message)}; expected ${JSON.stringify(hit)}`);
      // Crisp page sizes round to device pixels, and MouseEvent client coordinates
      // quantize CSS pixels. Allow one point here; the opened source file/line below
      // still has to match the independent source word/formula exactly.
      if (message.type === 'jump' && message.page === hit.page && Math.abs(message.x - hit.x) < 65536 && Math.abs(message.y - hit.y) < 65536) receivedJump = true;
    });
    const automation = `<script nonce="${nonce}">{
    // The classic script runs before the deferred production module, so both use
    // the one public webview API instance. This hook exists only in this test HTML.
    const e2eRealApi = acquireVsCodeApi(), e2eCommands = [], e2eOutlineStates = [];
    const e2eRequestFrame = window.requestAnimationFrame, e2eHeldFrames = [];
    let e2eDocumentId = '';
    // Exercise real menu listeners without restarting the live engine or opening a
    // file picker. All other messages still travel through the normal host path.
    const e2eSafeCommands = new Set(['realtimeTex.restart', 'realtimeTex.openLatexLog', 'realtimeTex.selectMainFile', 'realtimeTex.recompile']);
    const e2eApi = {
      postMessage: function(m) {
        if (m.type === 'command' && e2eSafeCommands.has(m.command)) { e2eCommands.push(m.command); return; }
        if (m.type === 'outlineState') e2eOutlineStates.push(m.state);
        e2eRealApi.postMessage(m);
      },
      getState: function() { return e2eRealApi.getState(); },
      setState: function(state) { return e2eRealApi.setState(state); }
    };
    const e2eContext = ${JSON.stringify(automationContext)};
    window.acquireVsCodeApi = function() { return e2eApi; };
    function ready() {
      const follow = document.querySelector('#follow'), page = document.querySelector('.page');
      if (!follow || !page || !page.querySelector('canvas') || !page.getBoundingClientRect().width) {
        setTimeout(ready, 50); return;
      }
      e2eApi.postMessage({ type: 'e2eAutomationReady', context: e2eContext });
    }
    setTimeout(ready, 0);
    window.addEventListener('message', function(e) {
      if (e.data.type === 'document') e2eDocumentId = e.data.documentId;
      if (e.data.context !== e2eContext) return;
      if (e.data.type === 'e2eInspectUi') {
        const m = e.data, follow = document.querySelector('#follow');
        if (m.value !== undefined) {
          follow.value = m.value;
          follow.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const actions = {
          holdFrames: function() {
            window.requestAnimationFrame = function(callback) { e2eHeldFrames.push(callback); return -e2eHeldFrames.length; };
          },
          releaseFrames: function() {
            window.requestAnimationFrame = e2eRequestFrame;
            e2eHeldFrames.splice(0).forEach(function(callback) { e2eRequestFrame.call(window, callback); });
          },
          openPage: function() { document.querySelector('#pageNo').click(); },
          submitPage: function() {
            const input = document.querySelector('#pageInput');
            input.value = m.argument;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('#pageJump').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          },
          escapePage: function() { document.querySelector('#pageInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); },
          escapePageFromGo: function() {
            const button = document.querySelector('#pageJump button[type="submit"]');
            button.focus();
            button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
          },
          back: function() { document.querySelector('#navBack').click(); },
          forward: function() { document.querySelector('#navForward').click(); },
          more: function() { document.querySelector('#more').click(); },
          escapeMenu: function() { document.querySelector('#moreMenu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); },
          outsideMenu: function() {
            document.querySelector('#viewport').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            document.querySelector('#viewport').click();
          },
          menuCommand: function() { document.querySelector('#moreMenu [data-command="' + m.argument + '"]').click(); },
          recompile: function() { document.querySelector('#recompile').click(); },
          zoomIn: function() { document.querySelector('#zoomIn').click(); },
          zoom100: function() { document.querySelector('#zoomLabel').click(); },
          outlineToggle: function() { document.querySelector('#outlineToggle').click(); },
          outlineClose: function() { document.querySelector('#outlineClose').click(); },
          outlineEntry: function() { document.querySelector('[data-outline-entry="' + m.argument + '"]').click(); },
          outlineBranch: function() { document.querySelector('[data-outline-toggle="' + m.argument + '"]').click(); },
          outlineEscape: function() { document.querySelector('#outlineTree').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); },
          outlineResize: function() {
            const handle = document.querySelector('#outlineResize');
            for (let i = 0; i < 6; i++) handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
          }
        };
        if (m.action) actions[m.action]();
        const label = follow.closest('.follow-control'), labelCopy = label.cloneNode(true);
        labelCopy.querySelector('select').remove();
        const pageInput = document.querySelector('#pageInput'), menu = document.querySelector('#moreMenu');
        const canvases = Array.from(document.querySelectorAll('#pages .page canvas'));
        const firstCanvas = canvases[0];
        const imagePixels = firstCanvas && firstCanvas.width && firstCanvas.height && firstCanvas.style.width
          ? [100, 250].map(function(x) { return Array.from(firstCanvas.getContext('2d').getImageData(
            Math.floor(firstCanvas.width * x / 600), Math.floor(firstCanvas.height * 130 / 800), 1, 1).data).slice(0, 3); }) : [];
        // Inspection is synchronous DOM state. A background editor can throttle
        // animation frames indefinitely, so do not wait for one to acknowledge it.
        e2eApi.postMessage({ type: 'e2eUiState', context: e2eContext, token: m.token,
          follow: follow.value, choices: Array.from(follow.options, function(o) { return o.value; }),
          hasCanvas: !!document.querySelector('.page canvas'), markers: document.querySelectorAll('.marker').length,
          followText: labelCopy.textContent.trim(), followWidth: label.getBoundingClientRect().width,
          followIcon: !!label.querySelector('svg'), followActive: label.classList.contains('active'), followTitle: label.title,
          recompileText: document.querySelector('#recompile').textContent.trim(),
          recompileLabel: document.querySelector('#recompile').getAttribute('aria-label'),
          pageText: document.querySelector('#pageNo').textContent.trim(), pageCount: document.querySelectorAll('#pages .page').length,
          backDisabled: document.querySelector('#navBack').disabled, forwardDisabled: document.querySelector('#navForward').disabled,
          pageJumpOpen: !document.querySelector('#pageJump').hidden, pageValue: pageInput.value,
          pageTotal: document.querySelector('#pageTotal').textContent.trim(),
          pageInvalid: pageInput.getAttribute('aria-invalid') === 'true' || !pageInput.validity.valid,
          menuOpen: !menu.hidden, menuRole: menu.getAttribute('role'),
          menuCommands: Array.from(menu.querySelectorAll('[data-command]'), function(button) { return button.dataset.command; }),
          commands: e2eCommands.slice(), activeId: document.activeElement.id,
          documentId: e2eDocumentId, outlineOpen: !document.querySelector('#outlineSidebar').hidden,
          outlineRole: document.querySelector('#outlineTree').getAttribute('role'),
          outlineWidth: document.querySelector('#outlineSidebar').getBoundingClientRect().width,
          outlineRows: Array.from(document.querySelectorAll('#outlineTree [role="treeitem"]')).filter(function(row) { return row.getClientRects().length; }).map(function(row) {
            return { id: row.dataset.id, title: row.querySelector('[data-outline-entry]').textContent.trim(),
              expanded: row.getAttribute('aria-expanded'), current: row.getAttribute('aria-current') === 'location' || !!row.querySelector('[aria-current="location"]') };
          }),
          outlineEmpty: document.querySelector('#outlineEmpty').hidden ? '' : document.querySelector('#outlineEmpty').textContent.trim(),
          outlineBackdrop: !document.querySelector('#outlineBackdrop').hidden,
          outlineSaved: e2eOutlineStates[e2eOutlineStates.length - 1],
          animationFramesHeld: window.requestAnimationFrame !== e2eRequestFrame,
          visibilityState: document.visibilityState,
          paintedPages: canvases.filter(function(canvas) { return canvas.width && canvas.height && canvas.style.width; })
            .map(function(canvas) { return Number(canvas.parentElement.dataset.page); }),
          canvasBytes: canvases.reduce(function(bytes, canvas) { return bytes + canvas.width * canvas.height * 4; }, 0),
          firstCanvasWidth: firstCanvas?.width ?? 0,
          dpr: window.devicePixelRatio,
          imagePixels: imagePixels,
          outlineGeometry: { scrollTop: document.querySelector('#viewport').scrollTop,
            width: document.querySelector('#viewport').clientWidth, height: document.querySelector('#viewport').clientHeight,
            scrollHeight: document.querySelector('#viewport').scrollHeight,
            pages: Array.from(document.querySelectorAll('#pages .page')).map(function(page) { return { top: page.offsetTop, width: page.offsetWidth, height: page.offsetHeight }; }) } });
        return;
      }
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
      // Zoom updates page geometry synchronously; the timer also works while the
      // preview is unfocused after the source-editor navigation checks above.
      setTimeout(click, 0);
    });}</script>`;
    let uiToken = 0;
    const inspectUi = async (value?: string, action?: string, argument?: string) => {
      const token = ++uiToken;
      await panel.webview.postMessage({ type: 'e2eInspectUi', context: automationContext, token, value, action, argument });
      await waitFor('the real preview UI state', () => uiStates.has(token), 10000);
      return uiStates.get(token)!;
    };
    const waitForUi = async (what: string, condition: (state: UiState) => boolean) => {
      const started = Date.now();
      let state: UiState;
      do {
        state = await inspectUi();
        if (condition(state)) return state;
        await sleep(100);
      } while (Date.now() - started < 10000);
      throw new Error(`${what}: ${JSON.stringify(state)}`);
    };
    const followConfig = vscode.workspace.getConfiguration('realtimeTex', main.uri);
    const previousFollow = followConfig.inspect('followCursor');
    try {
      panel.webview.html = html.replace('</body>', `${automation}</body>`);
      await waitFor('the reloaded preview automation and page geometry to become ready', () => automationReady, 30000);
      const initialUi = await inspectUi();
      if (initialUi.follow !== 'doubleClick' || initialUi.choices.join(',') !== 'singleClick,doubleClick,off') {
        throw new Error(`unexpected follow choices/default: ${JSON.stringify(initialUi)}`);
      }
      if (!initialUi.followIcon || !/^▾?$/.test(initialUi.followText) || initialUi.followWidth > 80 ||
        initialUi.recompileText || initialUi.recompileLabel !== 'Recompile whole document') {
        throw new Error(`the compact source-location/recompile controls are not accessible icon controls: ${JSON.stringify(initialUi)}`);
      }
      if (initialUi.outlineOpen || initialUi.outlineRole !== 'tree' || !initialUi.documentId) {
        throw new Error(`the document outline should start closed with an accessible tree and document identity: ${JSON.stringify(initialUi)}`);
      }
      for (const mode of ['singleClick', 'off', 'doubleClick']) {
        const state = await inspectUi(mode);
        await waitFor(`the ${mode} follow setting`, () => vscode.workspace.getConfiguration('realtimeTex', main.uri).get('followCursor') === mode, 10000);
        if (state.follow !== mode || !followMessages.includes(mode)) throw new Error(`${mode}: the toolbar did not send the normal follow message`);
        const settled = await waitForUi(`${mode} compact source-location state`, (ui) => ui.followActive === (mode !== 'off'));
        if (!settled.followTitle) throw new Error(`${mode}: the icon-only follow control has no explanatory tooltip`);
      }
      step('the compact source-location menu keeps native choices, persists all modes and reflects enabled/off state');

      const menuCommands = ['realtimeTex.restart', 'realtimeTex.openLatexLog', 'realtimeTex.selectMainFile'];
      let toolbarUi = await inspectUi(undefined, 'more');
      if (!toolbarUi.menuOpen || toolbarUi.menuRole !== 'menu' || toolbarUi.menuCommands.join(',') !== menuCommands.join(',')) {
        throw new Error(`unexpected more menu: ${JSON.stringify(toolbarUi)}`);
      }
      toolbarUi = await inspectUi(undefined, 'escapeMenu');
      if (toolbarUi.menuOpen || toolbarUi.activeId !== 'more') throw new Error('Escape did not close the more menu and restore its button focus');
      await inspectUi(undefined, 'more');
      if ((await inspectUi(undefined, 'outsideMenu')).menuOpen) throw new Error('an outside click did not close the more menu');
      for (const command of menuCommands) {
        await inspectUi(undefined, 'more');
        toolbarUi = await inspectUi(undefined, 'menuCommand', command);
        if (toolbarUi.menuOpen || toolbarUi.commands.at(-1) !== command) throw new Error(`${command}: more menu did not dispatch and close`);
      }
      toolbarUi = await inspectUi(undefined, 'recompile');
      if (toolbarUi.commands.at(-1) !== 'realtimeTex.recompile') throw new Error('the icon-only recompile button lost its command');
      step('the more menu closes with Escape/outside clicks and its three actions plus the recompile icon dispatch their normal commands');

      // A small synthetic display-list document makes page navigation independent
      // of the number of pages in the source-sync fixture. The real page model is
      // replayed after reloading this test webview before source navigation resumes.
      const samplePage = [...s.model.pages.values()][0];
      await panel.webview.postMessage({ type: 'reset' });
      await panel.webview.postMessage({ type: 'document', documentId: initialUi.documentId });
      await panel.webview.postMessage({ type: 'layout', pagesTotal: 3, placements: [], keepFromRevision: null, pdf: null,
        pages: [1, 2, 3].map((page) => ({ page, exact: true, hash: page, dl: { ...samplePage.dl,
          page, fonts: {}, lines: [], other: [['D', ['name:section.1', 'name:section.2', 'name:subsection.2.1'][page - 1], 40 * 65536, 100 * 65536]],
          images_info: {}, glyphs: 0, inserts: 0 } })) });
      await waitForUi('the synthetic three-page preview', (ui) => ui.pageText === '1 / 3' && ui.pageCount === 3);
      toolbarUi = await inspectUi();
      if (!toolbarUi.backDisabled || !toolbarUi.forwardDisabled) throw new Error('reading-history buttons should initially be disabled');
      toolbarUi = await inspectUi(undefined, 'openPage');
      if (!toolbarUi.pageJumpOpen || toolbarUi.pageValue !== '1' || !toolbarUi.pageTotal.includes('3') || toolbarUi.activeId !== 'pageInput') {
        throw new Error(`page-number click did not open/focus the current-page form: ${JSON.stringify(toolbarUi)}`);
      }
      for (const invalid of ['0', '4', '1.5']) {
        toolbarUi = await inspectUi(undefined, 'submitPage', invalid);
        if (!toolbarUi.pageJumpOpen || !toolbarUi.pageInvalid || toolbarUi.pageText !== '1 / 3' || !toolbarUi.backDisabled) {
          throw new Error(`invalid page ${invalid} unexpectedly navigated: ${JSON.stringify(toolbarUi)}`);
        }
      }
      toolbarUi = await inspectUi(undefined, 'escapePage');
      if (toolbarUi.pageJumpOpen || toolbarUi.activeId !== 'pageNo') throw new Error('Escape did not cancel page entry and restore page-button focus');
      await inspectUi(undefined, 'openPage');
      toolbarUi = await inspectUi(undefined, 'escapePageFromGo');
      if (toolbarUi.pageJumpOpen || toolbarUi.activeId !== 'pageNo') throw new Error('Escape from the Go button did not cancel page entry and restore page-button focus');
      step('clicking the page number opens a focused jump form; invalid pages stay put and Escape cancels from the input or Go button');

      await inspectUi(undefined, 'openPage');
      await inspectUi(undefined, 'submitPage', '3');
      toolbarUi = await waitForUi('page jump to page three', (ui) => ui.pageText === '3 / 3');
      if (toolbarUi.pageJumpOpen || toolbarUi.backDisabled || !toolbarUi.forwardDisabled) throw new Error('page jump did not create backward history');
      await inspectUi(undefined, 'back');
      toolbarUi = await waitForUi('back to page one', (ui) => ui.pageText === '1 / 3');
      if (!toolbarUi.backDisabled || toolbarUi.forwardDisabled) throw new Error('back did not expose forward history');
      await inspectUi(undefined, 'forward');
      toolbarUi = await waitForUi('forward to page three', (ui) => ui.pageText === '3 / 3');
      if (toolbarUi.backDisabled || !toolbarUi.forwardDisabled) throw new Error('forward did not restore backward history');
      await inspectUi(undefined, 'back');
      await inspectUi(undefined, 'openPage');
      await inspectUi(undefined, 'submitPage', '2');
      toolbarUi = await waitForUi('a new page jump clears the forward branch', (ui) => ui.pageText === '2 / 3');
      if (toolbarUi.backDisabled || !toolbarUi.forwardDisabled) throw new Error('a new page jump retained the obsolete forward branch');
      step('valid page jumps move the real viewport; back/forward restore reading pages and a new jump clears forward history');

      const outlineEntries = [
        { id: 'section.1', title: '1 Opening quartz', level: 1, target: 'name:section.1', page: 1 },
        { id: 'section.2', title: '2 Main argument', level: 1, target: 'name:section.2', page: 2 },
        { id: 'subsection.2.1', title: '2.1 A synthetic detail', level: 2, target: 'name:subsection.2.1', page: 3 },
      ];
      // Reproduce a background webview deterministically, without relaxing any navigation checks.
      await inspectUi(undefined, 'holdFrames');
      try {
        await panel.webview.postMessage({ type: 'outline', documentId: initialUi.documentId, entries: outlineEntries });
        const beforeOutlinePage = toolbarUi.pageText;
        toolbarUi = await inspectUi(undefined, 'outlineToggle');
        if (!toolbarUi.outlineOpen || toolbarUi.pageText !== beforeOutlinePage || toolbarUi.outlineRows.length !== 3 ||
          !toolbarUi.outlineRows[1].title.includes('Main argument')) {
          throw new Error(`opening the compiled outline lost entries or changed reading position: ${JSON.stringify(toolbarUi)}`);
        }
        toolbarUi = await inspectUi(undefined, 'outlineBranch', 'section.2');
        if (toolbarUi.outlineRows.map((row) => row.id).join(',') !== 'section.1,section.2' ||
          toolbarUi.outlineRows[1].expanded !== 'false' || !toolbarUi.outlineSaved?.collapsed.includes('section.2')) {
          throw new Error(`a branch did not collapse and save its preference: ${JSON.stringify(toolbarUi)}`);
        }
        await inspectUi(undefined, 'outlineBranch', 'section.2');
        step('the compiled outline opens without moving the reading page and its chapter branches collapse and expand');

        const wasOverlay = toolbarUi.outlineBackdrop;
        await inspectUi(undefined, 'outlineEntry', 'section.1');
        toolbarUi = await waitForUi('outline jump to the first compiled destination', (ui) => ui.pageText === '1 / 3');
        if (toolbarUi.backDisabled) throw new Error('the outline jump did not add the previous reading position to history');
        if (wasOverlay && (toolbarUi.outlineOpen || toolbarUi.outlineBackdrop || toolbarUi.activeId !== 'outlineToggle')) {
          throw new Error('an outline jump in a narrow panel did not close the overlay and return focus');
        }
        await inspectUi(undefined, 'back');
        await waitForUi('back from outline to the previous reading page', (ui) => ui.pageText === beforeOutlinePage);
        if (!(await inspectUi()).outlineOpen) await inspectUi(undefined, 'outlineToggle');
        await inspectUi(undefined, 'outlineEntry', 'subsection.2.1');
        toolbarUi = await waitForUi('outline jump to a nested compiled destination', (ui) => ui.pageText === '3 / 3');
        if (!toolbarUi.outlineOpen) await inspectUi(undefined, 'outlineToggle');
        toolbarUi = await waitForUi('the outline highlights the current section', (ui) => ui.outlineRows.some((row) => row.id === 'subsection.2.1' && row.current));
        if (!toolbarUi.animationFramesHeld) throw new Error('outline highlighting was not checked with animation frames held');
        step('outline headings use real compiled destinations and reading history, including a nested section and current-section highlighting');
      } finally {
        await inspectUi(undefined, 'releaseFrames');
      }

      // Host-side storage belongs to the real synthetic source-sync document. A
      // webview reload must receive its presentation preferences from that host.
      await inspectUi(undefined, 'outlineBranch', 'section.2');
      const originalOutlineWidth = (await inspectUi()).outlineWidth;
      toolbarUi = await inspectUi(undefined, 'outlineResize');
      const savedOutline = toolbarUi.outlineSaved;
      if (!savedOutline?.open || !savedOutline.collapsed.includes('section.2')) throw new Error('outline state was not sent to the extension host');
      if (savedOutline.width < originalOutlineWidth + 50) throw new Error('the outline separator did not resize and save its width');
      automationReady = false;
      panel.webview.html = html.replace('</body>', `${automation}<!-- Outline state replay --></body>`);
      await waitFor('outline preferences after reloading the real preview', () => automationReady, 30000);
      toolbarUi = await waitForUi('the open outline preference after reload', (ui) => ui.outlineOpen);
      if (Math.abs(toolbarUi.outlineWidth - savedOutline.width) > 2) throw new Error('the outline width preference was not restored');
      // Reapply only compiled entries, without resending presentation state, to
      // confirm the collapsed branch survived the complete webview replacement.
      await panel.webview.postMessage({ type: 'outline', documentId: initialUi.documentId, entries: outlineEntries });
      toolbarUi = await inspectUi();
      if (toolbarUi.outlineRows.find((row) => row.id === 'section.2')?.expanded !== 'false') throw new Error('the collapsed outline branch was not restored');
      toolbarUi = await inspectUi(undefined, 'outlineClose');
      if (toolbarUi.outlineOpen || toolbarUi.activeId !== 'outlineToggle') throw new Error('closing the outline did not restore its toggle focus');
      step('outline open state, width and collapsed branches persist through a real webview reload; Close returns focus to the toolbar');

      await panel.webview.postMessage({ type: 'document', documentId: 'e2e-another-synthetic-document' });
      toolbarUi = await inspectUi();
      if (toolbarUi.outlineOpen) throw new Error('a different document inherited the previous document sidebar state');
      toolbarUi = await inspectUi(undefined, 'outlineToggle');
      if (!toolbarUi.outlineOpen || !toolbarUi.outlineEmpty || toolbarUi.outlineRows.length) throw new Error('a document without compiled headings has no useful empty state');
      await panel.webview.postMessage({ type: 'outline', documentId: initialUi.documentId, entries: outlineEntries });
      if ((await inspectUi()).outlineRows.length) throw new Error('a late outline from the previous document was shown on a different document');
      await panel.webview.postMessage({ type: 'document', documentId: initialUi.documentId });
      toolbarUi = await inspectUi();
      if (toolbarUi.outlineOpen) throw new Error('returning to a document lost its closed sidebar preference');
      step('documents keep independent outline preferences and empty states; delayed outlines cannot cross document identities');

      // Exercise real PDF.js decoding and native drawing of two pages from one file.
      await vscode.commands.executeCommand('workbench.action.focusWindow');
      panel.reveal(panel.viewColumn, false);
      await waitForUi('a visible preview for native pixel assertions', ui => ui.visibilityState === 'visible');
      await panel.webview.postMessage({ type: 'reset' });
      const imageFile = 'e2e-two-pages.pdf', sp = 65536;
      const imagePage = { page: 1, exact: true, dl: { ...samplePage.dl, fonts: {}, lines: [],
        page_width: 600 * sp, page_height: 800 * sp, flags: [],
        images_info: { '1': { file: imageFile, page: 1 }, '2': { file: imageFile, page: 2 } },
        other: [['i', 1, 50 * sp, 80 * sp, 100 * sp, 100 * sp], ['i', 2, 200 * sp, 80 * sp, 100 * sp, 100 * sp]] } };
      const sendImage = (colors?: string[]) => panel.webview.postMessage({ type: 'resources', fonts: [],
        images: [[imageFile, { kind: 'pdf', mime: 'application/pdf', data: new Uint8Array(Buffer.from(twoPagePdf(colors))) }]] });
      await sendImage();
      await panel.webview.postMessage({ type: 'layout', pagesTotal: 1, placements: [], keepFromRevision: null, pdf: null, pages: [imagePage] });
      const colorsMatch = (ui: UiState, colors: number[][]) => colors.every((color, i) =>
        color.every((value, channel) => Math.abs((ui.imagePixels[i]?.[channel] ?? -1000) - value) < 3));
      await waitForUi('distinct red and blue PDF image pages', ui => colorsMatch(ui, [[255, 0, 0], [0, 0, 255]]));
      await sendImage(['0 1 0', '1 0 1']);
      await waitForUi('all PDF image pages refreshed after file replacement', ui => colorsMatch(ui, [[0, 255, 0], [255, 0, 255]]));
      step('one PDF file draws its selected pages distinctly and refreshes both decoded pages after replacement');

      await panel.webview.postMessage({ type: 'reset' });
      await inspectUi(undefined, 'zoom100');
      const memoryPages = Array.from({ length: 20 }, (_, index) => ({ page: index + 1, exact: true,
        dl: { ...imagePage.dl, images_info: {}, other: [['r', 40 * sp, 100 * sp, 100 * sp, 20 * sp],
          ['L', 'name:memory-end', 40 * sp, 100 * sp, 100 * sp, 20 * sp],
          ['D', 'name:memory-end', 40 * sp, 100 * sp]] } }));
      await panel.webview.postMessage({ type: 'layout', pagesTotal: memoryPages.length, placements: [], keepFromRevision: null,
        pdf: null, pages: memoryPages });
      await waitForUi('the first synthetic memory page to paint', ui => ui.paintedPages.includes(1));
      const memorySample = async (phase: string) => {
        const ui = await inspectUi();
        console.log(`[e2e] canvas-memory ${JSON.stringify({ phase, time: Date.now(), pages: ui.pageCount,
          painted: ui.paintedPages.length, backingBytes: ui.canvasBytes, dpr: ui.dpr })}`);
        return ui;
      };
      await memorySample('first');
      for (let page = 2; page <= memoryPages.length; page++) {
        await inspectUi(undefined, 'openPage');
        await inspectUi(undefined, 'submitPage', String(page));
        await waitForUi(`synthetic memory page ${page} to paint`, ui => ui.paintedPages.includes(page));
      }
      await sleep(1000);
      const lastMemory = await memorySample('last');
      await inspectUi(undefined, 'openPage');
      await inspectUi(undefined, 'submitPage', '1');
      await waitForUi('the first page to repaint after scrolling the whole document', ui => ui.paintedPages.includes(1));
      await sleep(1000);
      const homeMemory = await memorySample('home');
      const outsidePreload = (ui: UiState) => {
        const { scrollTop, width, height, pages } = ui.outlineGeometry;
        const margin = width; // IntersectionObserver's percentage margins use the root width.
        return ui.paintedPages.some(n => pages[n - 1].top + pages[n - 1].height < scrollTop - margin ||
          pages[n - 1].top > scrollTop + height + margin);
      };
      if (outsidePreload(lastMemory) || outsidePreload(homeMemory)) {
        throw new Error('offscreen page canvases retained pixels after scrolling');
      }
      await inspectUi(undefined, 'zoomIn');
      await waitForUi('visible canvas pixels to follow zoom after returning', ui =>
        ui.paintedPages.includes(1) && ui.firstCanvasWidth > homeMemory.firstCanvasWidth);
      step('scrolling twenty pages releases distant canvas pixels and repaints on return and zoom');

      automationReady = false;
      // VS Code ignores an identical HTML assignment; make this replay distinct.
      panel.webview.html = html.replace('</body>', `${automation}<!-- Source-sync replay --></body>`);
      await waitFor('the real source-sync document to replay after toolbar checks', () => automationReady, 30000);
      await waitForUi('the restored source-sync page count', (ui) => ui.pageCount === s.model.pagesTotal && ui.hasCanvas);

      await inspectUi('off');
      await waitFor('disabled follow setting', () => vscode.workspace.getConfiguration('realtimeTex', main.uri).get('followCursor') === 'off', 10000);
      // Force reveal is the existing manual command path, which stays available
      // with Follow cursor off and must retain the same visible highlight.
      const manualEditor = await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
      const manualPos = main.positionAt(main.getText().indexOf('Revisionviolet'));
      manualEditor.selection = new vscode.Selection(manualPos, manualPos);
      const beforeManual = outputs.length;
      await vscode.commands.executeCommand('realtimeTex.syncToPreview');
      const manualReveal = outputs.slice(beforeManual).find((output) => output.kind === 'reveal');
      const manualHit = renderedWord(s, 'Revisionviolet');
      if (manualReveal?.kind !== 'reveal' || !manualReveal.force || manualReveal.target.page !== manualHit.page ||
        Math.abs(manualReveal.target.y - manualHit.y) > 65536) throw new Error('manual source command did not reveal its exact rendered row');
      const highlightedUi = await inspectUi();
      if (!highlightedUi.hasCanvas || highlightedUi.markers < 1) throw new Error('manual source reveal did not highlight its target with follow off');
      await inspectUi('doubleClick');
      await waitFor('restored double-click setting', () => vscode.workspace.getConfiguration('realtimeTex', main.uri).get('followCursor') === 'doubleClick', 10000);
      step('a forced source jump highlights the preview target even when automatic follow is off');

      await vscode.window.showTextDocument(chapter, vscode.ViewColumn.One);
      await panel.webview.postMessage({ type: 'e2eDoubleClick', context: automationContext, ...hit, pageWidth: s.model.pages.get(hit.page)!.dl.page_width! });
      const wordAt = main.positionAt(main.getText().indexOf('invisible'));
      await waitFor('the real webview double-click jump', () => receivedJump &&
        vscode.window.activeTextEditor?.document.uri.fsPath === main.uri.fsPath &&
        vscode.window.activeTextEditor.selection.isEmpty && vscode.window.activeTextEditor.selection.active.isEqual(wordAt), 30000);
      step('the real webview double-click opens the exact source word at its nonzero column');

      hit = renderedWord(s, 'p+q=r', { start: 2, length: 1 });
      receivedJump = false;
      await vscode.window.showTextDocument(chapter, vscode.ViewColumn.One);
      await panel.webview.postMessage({ type: 'e2eDoubleClick', context: automationContext, ...hit, pageWidth: s.model.pages.get(hit.page)!.dl.page_width! });
      const formulaAt = main.getText().indexOf('$p+q=r$');
      await waitFor('the real webview formula double-click selection', () => {
        const active = vscode.window.activeTextEditor;
        if (!receivedJump || active?.document.uri.fsPath !== main.uri.fsPath || active.selection.isEmpty) return false;
        const start = main.offsetAt(active.selection.start), end = main.offsetAt(active.selection.end);
        return start >= formulaAt && end <= formulaAt + '$p+q=r$'.length && start <= formulaAt + 3 && end > formulaAt + 3;
      }, 30000);
      step('the real webview double-click selects the clicked inline formula on a line containing two formulas');
    } finally {
      await followConfig.update('followCursor', previousFollow?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder);
      await followConfig.update('followCursor', previousFollow?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      await followConfig.update('followCursor', previousFollow?.globalValue, vscode.ConfigurationTarget.Global);
      receive.dispose();
      panel.webview.html = html;
    }
  } finally {
    watch.dispose();
    api.panel()?.panel.dispose();
    await waitFor('source-sync engine stopped', () => !s.running, 10000);
  }
}

/** Full compiler → sidecar parser → matched layout → real webview integration.
 * Unlike the synthetic navigation checks above, no document/outline/layout messages
 * are injected: the automation can only inspect the DOM and click public controls. */
async function outlineSteps(api: Api, folder: string, step: (description: string) => void): Promise<void> {
  await vscode.commands.executeCommand('realtimeTex.stop');
  const main = await vscode.workspace.openTextDocument(path.join(folder, 'outline', 'main.tex'));
  await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
  await vscode.commands.executeCommand('realtimeTex.openPreview');
  await waitFor('the real outline fixture session', () => api.session()?.mainFile === main.fileName && !!api.session()?.running, 20000);
  const session = api.session()!;
  await waitFor('the real outline fixture layout', () => session.model.hasLayout && session.status.phase === 'live' &&
    session.status.convergence?.state === 'Converged' && !session.status.pending, 120000);
  const panel = api.panel()!.panel;
  const html = panel.webview.html;
  const nonce = /<script[^>]+nonce="([^"]+)"/.exec(html)?.[1];
  if (!nonce) throw new Error('outline fixture preview CSP nonce was not found');
  const context = `compiled-outline-${Date.now()}`;
  interface OutlineUi {
    documentId: string; published: { id: string; title: string; level: number; target: string; page?: number }[];
    rows: { id: string; title: string; page: string; current: boolean }[];
    open: boolean; pageText: string; backDisabled: boolean; canvasCount: number;
  }
  const replies = new Map<number, OutlineUi>();
  let automationReady = false;
  const watch = panel.webview.onDidReceiveMessage((message) => {
    if (message.type === 'e2eCompiledOutlineReady' && message.context === context) automationReady = true;
    if (message.type === 'e2eCompiledOutlineUi' && message.context === context) replies.set(message.token, message);
  });
  const automation = `<script nonce="${nonce}">{
    const api = acquireVsCodeApi();
    window.acquireVsCodeApi = function() { return api; };
    let documentId = '', published = [];
    function ready() {
      if (!document.querySelector('#outlineToggle') || !document.querySelector('#pages canvas')) { setTimeout(ready, 50); return; }
      api.postMessage({ type: 'e2eCompiledOutlineReady', context: ${JSON.stringify(context)} });
    }
    setTimeout(ready, 0);
    window.addEventListener('message', function(event) {
      const m = event.data;
      if (m.type === 'document') { documentId = m.documentId; published = []; }
      if (m.type === 'outline' && m.documentId === documentId) published = m.entries;
      if (m.type !== 'e2eInspectCompiledOutline' || m.context !== ${JSON.stringify(context)}) return;
      if (m.action === 'toggle') document.querySelector('#outlineToggle').click();
      if (m.action === 'back') document.querySelector('#navBack').click();
      if (m.action === 'entry') document.querySelector('[data-outline-entry="' + m.id + '"]').click();
      api.postMessage({ type: 'e2eCompiledOutlineUi', context: m.context, token: m.token,
        documentId: documentId, published: published,
        rows: Array.from(document.querySelectorAll('#outlineTree [role="treeitem"]')).map(function(row) {
          const button = row.querySelector('[data-outline-entry]');
          return { id: row.dataset.id, title: button.querySelector('.outline-title').textContent,
            page: button.querySelector('.outline-page').textContent, current: button.getAttribute('aria-current') === 'location' };
        }), open: !document.querySelector('#outlineSidebar').hidden,
        pageText: document.querySelector('#pageNo').textContent.trim(),
        backDisabled: document.querySelector('#navBack').disabled,
        canvasCount: document.querySelectorAll('#pages canvas').length });
    });
  }</script>`;
  let token = 0;
  const inspect = async (action?: string, id?: string) => {
    const key = ++token;
    await panel.webview.postMessage({ type: 'e2eInspectCompiledOutline', context, token: key, action, id });
    await waitFor('the compiled-outline preview inspection', () => replies.has(key), 10000);
    return replies.get(key)!;
  };
  const until = async (what: string, condition: (state: OutlineUi) => boolean) => {
    const start = Date.now();
    let state: OutlineUi;
    do {
      state = await inspect();
      if (condition(state)) return state;
      await sleep(100);
    } while (Date.now() - start < 30000);
    throw new Error(`${what}: ${JSON.stringify(state!)}`);
  };
  try {
    panel.webview.html = html.replace('</body>', `${automation}</body>`);
    await waitFor('the compiled outline preview automation', () => automationReady, 30000);
    let ui = await until('five real compiled outline entries delivered to the native preview', (state) => state.published.length === 5 && state.canvasCount > 0);
    if (!ui.documentId || ui.published.map((entry) => entry.level).join(',') !== '1,2,1,3,1' ||
      ui.published.map((entry) => entry.page).join(',') !== '1,1,2,2,3' || !ui.published[0].title.includes('Introduction x² and café') ||
      ui.published.at(-1)?.target !== 'name:appendix.A') {
      throw new Error(`the host delivered an incorrect compiled hierarchy or physical pages: ${JSON.stringify(ui)}`);
    }
    ui = await inspect('toggle');
    if (!ui.open || ui.rows.map((row) => row.page).join(',') !== '1,1,2,2,3' || ui.rows[2].title !== 'Second argument') {
      throw new Error(`the real compiled outline was not rendered in the sidebar: ${JSON.stringify(ui)}`);
    }
    step('real compiled metadata reaches the sidebar with five headings, Unicode math titles, hierarchy and physical pages across a numbering reset');

    const appendixId = ui.published.at(-1)!.id;
    await inspect('entry', appendixId);
    ui = await until('actual compiled appendix destination', (state) => state.pageText === '3 / 3');
    if (ui.backDisabled) throw new Error('the real compiled appendix jump did not preserve reading history');
    await inspect('back');
    await until('return from the real compiled appendix', (state) => state.pageText === '1 / 3');
    step('clicking a real compiled appendix heading moves the native viewport and Back returns to the previous reading page');

    const editor = await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
    const source = main.getText();
    const title = source.indexOf('Second argument');
    const pageBreak = source.indexOf('\\newpage');
    await editor.edit((builder) => {
      builder.replace(new vscode.Range(main.positionAt(title), main.positionAt(title + 'Second argument'.length)), 'Revised argument');
      builder.insert(main.positionAt(pageBreak + '\\newpage'.length), '\n\\null\\newpage');
    });
    ui = await until('fresh compiled outline title and shifted physical pages', (state) => state.published[2]?.title === 'Revised argument' &&
      state.published.map((entry) => entry.page).join(',') === '1,1,3,3,4' && state.pageText.endsWith('/ 4'));
    if (!ui.open) ui = await inspect('toggle');
    if (ui.rows[2].title !== 'Revised argument' || ui.rows.map((row) => row.page).join(',') !== '1,1,3,3,4') {
      throw new Error(`the real sidebar retained old titles or page positions: ${JSON.stringify(ui)}`);
    }
    await inspect('entry', ui.published[2].id);
    await until('the revised heading destination after repagination', (state) => state.pageText === '3 / 4');
    step('a real structural edit refreshes sidebar titles and physical page numbers, and its heading jumps to the recompiled destination');
  } finally {
    watch.dispose();
    api.panel()?.panel.dispose();
    await waitFor('the outline fixture engine stopped', () => !session.running, 10000);
  }
}

export async function run(): Promise<void> {
  try {
    await steps();
  } catch (e) {
    const s = vscode.extensions.getExtension<Api>('hengmamath.realtime-tex-enhanced')?.exports.session();
    console.log('[e2e] status at failure:', JSON.stringify(s?.status));
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
  await testFollowConfig(vscode.Uri.file(path.join(folder, 'main.tex')));
  step('follow defaults, legacy migration, explicit overrides and configuration scopes retain the intended choice');

  // Local diagnostic shortcut. Release/source/package validation still runs the full
  // suite; this only shortens iteration while investigating a source-navigation failure.
  if (process.env.RTEX_E2E_SOURCE_SYNC_ONLY === '1') {
    await sourceSyncSteps(api, folder, step);
    await outlineSteps(api, folder, step);
    console.log(`[e2e] all ${steps.length} source-sync steps passed`);
    return;
  }

  // close the side bars and the panel so the preview gets a predictable editor area
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

  // 2. a keystroke in the main file takes the fast path
  const main = await vscode.workspace.openTextDocument(path.join(folder, 'main.tex'));
  await insertAfter(main, 'This paragraph is typeset', ' live and instantly');
  await waitFor('a fast update', () => s.status.lastFastMs !== undefined && s.model.overlays.size > 0, 30000);
  step(`fast update in ${s.status.lastFastMs!.toFixed(2)} ms`);
  await sleep(800);
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
  await insertAfter(main, ' live and instantly', ' $x^2^3$');
  await waitFor('a live error', hasError, 30000);
  if (rowsShown() !== rowsBefore) throw new Error(`a live error left ${rowsShown()} of ${rowsBefore} rows of the part on screen`);
  if (!(await s.revealInPreview(main, main.positionAt(main.getText().indexOf('This paragraph is typeset') + 3), false))) {
    throw new Error('the part lost its place in the preview during a live error');
  }
  // another part's clean live result must not hide this part's error, listed at its own lines
  const errorPartFirst = main.positionAt(main.getText().indexOf('This paragraph is typeset')).line;
  const errorPartEnd = main.positionAt(main.getText().indexOf('\n\n', main.getText().indexOf(' $x^2^3$'))).line + 1;
  const otherRevision = latestRevision();
  await insertAfter(main, 'A second paragraph refers', ' also');
  await waitFor('another part typeset live', () => latestRevision() > otherRevision, 30000);
  const listed = vscode.languages.getDiagnostics(main.uri).filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
  if (!listed.length) throw new Error('a clean live update of another part hid the live error');
  if (!listed.every((d) => d.range.start.line >= errorPartFirst && d.range.start.line <= errorPartEnd)) {
    throw new Error(`live error listed on line(s) ${listed.map((d) => d.range.start.line + 1).join(', ')}, outside its part (${errorPartFirst + 1}-${errorPartEnd + 1})`);
  }
  const alsoAt = main.getText().indexOf('refers also') + 'refers'.length;
  await (await vscode.window.showTextDocument(main, vscode.ViewColumn.One)).edit((e) =>
    e.delete(new vscode.Range(main.positionAt(alsoAt), main.positionAt(alsoAt + ' also'.length))));
  const editor0 = await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
  const badAt = main.getText().indexOf(' $x^2^3$');
  await editor0.edit((e) => e.delete(new vscode.Range(main.positionAt(badAt), main.positionAt(badAt + ' $x^2^3$'.length))));
  await waitFor('the live error to clear', () => !hasError(), 30000);
  step(`a live error kept the part's ${rowsBefore} row(s) on screen, at its own lines, while another part updated`);

  // 2d. An inner fence still being typed keeps the previous good rows and defers errors.
  const fenceRows = rowsShown();
  await insertAfter(main, ' live and instantly', ' $\\left( a$');
  await waitFor('the unfinished fence to be deferred', () => s.status.pending, 30000);
  await sleep(500);
  if (hasError()) throw new Error('the unfinished fence reported an error before the settle delay');
  if (rowsShown() !== fenceRows) throw new Error('the unfinished fence replaced the previous good rows');
  const revision = latestRevision();
  const closeAt = main.getText().indexOf('\\left( a$') + '\\left( a'.length;
  await editor0.edit((e) => e.insert(main.positionAt(closeAt), ' \\right)'));
  await waitFor('the completed formula typeset live', () => latestRevision() > revision && !hasError(), 30000);
  const recovered = await spanAt('This paragraph is typeset');
  if (recovered?.kind !== 'live') throw new Error(`after \\left( the part is marked ${recovered?.kind}: ${recovered?.reasons?.join(', ')}`);
  step('an unfinished \\left( kept its previous rows without an immediate error and completed live');

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
  const ed2 = await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
  const start = main.getText().indexOf(' \\undefinedmacroxyz{}');
  await ed2.edit((e) => e.delete(new vscode.Range(main.positionAt(start), main.positionAt(start + ' \\undefinedmacroxyz{}'.length))));
  await waitFor('the error to clear', () => !vscode.languages.getDiagnostics(main.uri).some((d) => d.severity === vscode.DiagnosticSeverity.Error), 60000);
  step('diagnostic cleared after the fix');

  // 5. the TikZ page is marked for the PDF fallback (intro.tex starts it with \newpage)
  if (s.model.pagesTotal < 2) throw new Error(`expected the TikZ page 2, got ${s.model.pagesTotal} page(s)`);
  const pageTwo = s.model.pages.get(2);
  if (!pageTwo) throw new Error('page 2 is missing from the preview model');
  if (pageTwo.exact !== false) throw new Error('the TikZ page should be degraded (exact: false)');
  await api.panel()!.panel.webview.postMessage({ type: 'reveal', page: 2, x: 0, y: 0, force: true });
  await sleep(2500);
  step('the TikZ page is marked for the PDF fallback');

  // 6. export
  const pdf = await s.exportPdf();
  if (!pdf || !existsSync(pdf)) throw new Error(`export produced no PDF (${pdf})`);
  step(`exported ${path.basename(pdf)}`);

  // 7. A failed preamble after a good layout keeps its old ink and source revision.
  // Body edits while broken must not turn the old capture into a successful new layout.
  await waitFor('the clean layout before testing preamble recovery', () => s.status.compile?.state === 'Ok' &&
    s.status.convergence?.state === 'Converged' && !s.status.pending, 120000);
  const recoveryOutputs: SessionOutput[] = [];
  const recoveryWatch = s.onOutput((output) => recoveryOutputs.push(output));
  try {
    const pagesBefore = JSON.stringify([...s.model.pages]);
    const placementsBefore = JSON.stringify([...s.model.placements]);
    const countBefore = s.model.pagesTotal;
    const revisionBefore = Math.max(...[...s.model.pages.values()].map((page) => page.dl.source_revision ?? -1));
    await insertAfter(main, '\\usepackage{tikz}', '\n\\stop');
    await waitFor('a failed full compile with a reported error', () => s.status.compile?.state === 'Failed' &&
      !s.status.pending && hasError(), 120000);
    if (JSON.stringify([...s.model.pages]) !== pagesBefore) throw new Error('the failed preamble replaced the previous page ink or source revision');
    if (JSON.stringify([...s.model.placements]) !== placementsBefore) throw new Error('the failed preamble replaced the previous source placements');
    if (s.screen.screen !== null) throw new Error('a failed preamble hid the previous good pages');
    if (!/no pages of output/i.test(readFileSync(s.latexLogPath, 'utf8'))) throw new Error('Open LaTeX Log still points to the previous successful pass');
    if (!recoveryOutputs.some((output) => output.kind === 'banner' && output.level === 'error' && output.text?.includes('previous result'))) {
      throw new Error('the preview did not explain that its pages are the previous result');
    }
    step(`failed preamble reported an error and retained ${countBefore} page(s) with their source revision`);

    const bodyEditAfter = recoveryOutputs.length;
    await insertAfter(main, 'A second paragraph refers', ' Latestamber');
    await waitFor('a new failed compile after a body edit under the broken preamble', () =>
      recoveryOutputs.slice(bodyEditAfter).some((output) => output.kind === 'banner' && output.level === 'error' &&
        output.text?.includes('last full compile failed')) && !s.status.pending, 120000);
    if (s.status.compile?.state !== 'Failed' || !hasError()) throw new Error('a body edit hid the preamble failure');
    if (JSON.stringify([...s.model.pages]) !== pagesBefore) throw new Error('a body edit under the broken preamble replaced the previous pages');
    if (JSON.stringify([...s.model.placements]) !== placementsBefore) throw new Error('a body edit under the broken preamble replaced the previous source placements');
    if (recoveryOutputs.some((output) => output.kind === 'layout' && output.ev.compile.state === 'Ok')) {
      throw new Error('the broken preamble incorrectly produced a successful layout');
    }
    step('body edits under a broken preamble retained the failure and previous pages');

    const repairedAfter = recoveryOutputs.length;
    const ed3 = await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
    const bad = main.getText().indexOf('\n\\stop');
    await ed3.edit((e) => e.delete(new vscode.Range(main.positionAt(bad), main.positionAt(bad + '\n\\stop'.length))));
    await waitFor('automatic recovery to the latest body and cleared error', () => s.status.compile?.state === 'Ok' &&
      s.status.convergence?.state === 'Converged' && !s.status.pending && !hasError() &&
      recoveryOutputs.slice(repairedAfter).some((output) => output.kind === 'layout' &&
        (output.ev.source_revision ?? -1) > revisionBefore), 120000);
    const repairedInk = renderedWord(s, 'Latestamber');
    if (repairedInk.live || (repairedInk.revision ?? -1) <= revisionBefore) {
      throw new Error('recovery did not publish the latest body with a new full-layout source revision');
    }
    step('repairing the preamble automatically rendered the latest body and cleared diagnostics');

    const liveAfter = recoveryOutputs.length;
    await insertAfter(main, 'Latestamber', 'swift');
    await waitFor('live editing after preamble recovery', () => recoveryOutputs.slice(liveAfter).some((output) =>
      output.kind === 'paragraph' && output.ev.status === 'ok'), 30000);
    if (!renderedWord(s, 'Latestamberswift').live || hasError()) throw new Error('the repaired document did not resume clean live editing');
    step('live editing resumed after preamble recovery');
  } finally {
    recoveryWatch.dispose();
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
  const coldOutputs: SessionOutput[] = [];
  const coldWatch = sb.onOutput((output) => coldOutputs.push(output));
  try {
    const coldDoc = await vscode.workspace.openTextDocument(broken);
    const coldEditor = await vscode.window.showTextDocument(coldDoc, vscode.ViewColumn.One);
    const stop = coldDoc.getText().indexOf('\\stop\n');
    const hello = coldDoc.getText().indexOf('Hello');
    await coldEditor.edit((e) => {
      e.delete(new vscode.Range(coldDoc.positionAt(stop), coldDoc.positionAt(stop + '\\stop\n'.length)));
      e.replace(new vscode.Range(coldDoc.positionAt(hello), coldDoc.positionAt(hello + 'Hello'.length)), 'Coldrepairquartz');
    });
    await waitFor('automatic recovery from a failed first compile', () => sb.model.hasLayout &&
      sb.screen.screen === null && sb.status.compile?.state === 'Ok' && !sb.status.pending &&
      !vscode.languages.getDiagnostics(coldDoc.uri).some((d) => d.severity === vscode.DiagnosticSeverity.Error), 120000);
    renderedWord(sb, 'Coldrepairquartz');
    const coldLiveAfter = coldOutputs.length;
    await insertAfter(coldDoc, 'Coldrepairquartz', 'swift');
    await waitFor('live editing after a failed first compile was fixed', () => coldOutputs.slice(coldLiveAfter).some((output) =>
      output.kind === 'paragraph' && output.ev.status === 'ok'), 30000);
    if (!renderedWord(sb, 'Coldrepairquartzswift').live) throw new Error('a repaired first compile did not become live');
    step('fixing a failed first compile automatically opened the preview and resumed live editing');
  } finally {
    coldWatch.dispose();
  }

  // 10. A fresh installation uses the verified executable AND its matching support tree
  // from the extension, without a managed engine checkout, download, or explicit paths.
  await vscode.commands.executeCommand('realtimeTex.stop');
  const fakeCtx = {
    extensionPath: ext.extensionPath,
    extensionUri: vscode.Uri.file(ext.extensionPath),
    globalStorageUri: vscode.Uri.file(mkdtempSync(path.join(os.tmpdir(), 'rtex storage '))),
  } as unknown as vscode.ExtensionContext;
  const cfg = vscode.workspace.getConfiguration('realtimeTex');
  const previousServer = cfg.inspect<string>('serverPath')?.globalValue;
  const previousTexDir = cfg.inspect<string>('texDir')?.globalValue;
  await cfg.update('serverPath', '', vscode.ConfigurationTarget.Global);
  await cfg.update('texDir', '', vscode.ConfigurationTarget.Global);
  try {
    const runtime = getBundledRuntime(ext.extensionPath);
    if (!runtime) throw new Error('this enhanced release has no bundled runtime for this platform');
    const selected = resolveServer(fakeCtx);
    if (selected?.path !== runtime.path) throw new Error('a clean installation did not select the bundled executable');
    if (processEnv(fakeCtx, selected).RTEX_TEXDIR !== runtime.texDir) throw new Error('the bundled executable was not paired with its support tree');
    step(`fresh storage selected the verified bundled engine ${runtime.version}`);
    const foreignExecutable = path.join(fakeCtx.globalStorageUri.fsPath, 'foreign-rtex');
    writeFileSync(foreignExecutable, 'synthetic unrelated engine', { mode: 0o755 });
    await cfg.update('serverPath', foreignExecutable, vscode.ConfigurationTarget.Global);
    await cfg.update('texDir', path.join(fakeCtx.globalStorageUri.fsPath, 'stale-custom-support'), vscode.ConfigurationTarget.Global);
    const staleSelection = resolveServer(fakeCtx);
    if (staleSelection?.path !== runtime.path || processEnv(fakeCtx, staleSelection).RTEX_TEXDIR !== runtime.texDir) {
      throw new Error('stale external engine settings overrode the bundled pair');
    }
    step('stale external executable and support settings cannot override the bundled pair');

    const brokenRoot = path.join(fakeCtx.globalStorageUri.fsPath, 'broken-extension');
    const brokenCtx = { ...fakeCtx, extensionPath: brokenRoot, extensionUri: vscode.Uri.file(brokenRoot) } as vscode.ExtensionContext;
    if (resolveServer(brokenCtx) !== undefined) throw new Error('a missing bundle fell through to a configured external engine');
    mkdirSync(path.join(brokenRoot, 'resources', 'rtex-runtime'), { recursive: true });
    mkdirSync(path.join(brokenRoot, 'resources', 'rtex-engine', 'darwin-arm64'), { recursive: true });
    writeFileSync(path.join(brokenRoot, 'resources', 'rtex-runtime', 'manifest.json'),
      readFileSync(path.join(ext.extensionPath, 'resources', 'rtex-runtime', 'manifest.json')));
    writeFileSync(path.join(brokenRoot, 'resources', 'rtex-engine', 'darwin-arm64', 'rtex'), 'synthetic mismatched engine');
    if (resolveServer(brokenCtx) !== undefined) throw new Error('a corrupt bundle fell through to a configured external engine');
    step('missing and corrupt bundled engines fail closed despite an existing external engine setting');

    // Start a real session with both stale settings still present: selecting the pair
    // above must agree with the actual process that produces live paragraphs.
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
    rmSync(fakeCtx.globalStorageUri.fsPath, { recursive: true, force: true });
  }
  await sourceSyncSteps(api, folder, step);
  await outlineSteps(api, folder, step);
  console.log(`[e2e] all ${steps.length} steps passed`);
}
