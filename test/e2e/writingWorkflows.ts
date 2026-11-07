import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import * as vscode from 'vscode';
import type { Api } from '../../src/extension';
import type { Session, SessionOutput } from '../../src/session';
import { sourceMouse } from './sourceMouse';
import { glyphText } from '../realEngineFixture';

async function wait(what: string, check: () => boolean, timeout = 120000) {
  for (const start = Date.now(); !check();) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function visibleText(session: Session) {
  const lines = [];
  for (const [page, update] of session.model.pages) {
    const hidden = session.model.hiddenLines(page);
    lines.push(...update.dl.lines.filter((_, index) => !hidden.has(index)));
    for (const overlay of session.model.overlaysOn(page)) lines.push(...overlay.rows.map(row => row.line));
  }
  return lines.map(line => line.items.filter(item => item[0] === 'g')
    .map(item => String.fromCodePoint(item[2] as number)).join('')).join('').replace(/[\s-]/g, '');
}

async function start(api: Api, main: string) {
  await vscode.commands.executeCommand('realtimeTex.stop');
  const doc = await vscode.workspace.openTextDocument(main);
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  await vscode.commands.executeCommand('realtimeTex.openPreview');
  await wait('writing session', () => api.session()?.mainFile === main && !!api.session()?.running);
  const session = api.session()!;
  await wait('writing layout', () => session.status.compile?.state === 'Ok' &&
    session.status.convergence?.state === 'Converged' && !session.status.pending);
  return { doc, session };
}

async function ink(session: Session, present: string[], absent: string[] = []) {
  try {
    await wait(`current ink: ${present.join(', ')}`, () => {
      const text = visibleText(session);
      return present.every(word => text.includes(word)) && absent.every(word => !text.includes(word));
    });
  } catch (error) {
    throw new Error(`${error}\nVisible ink: ${visibleText(session)}\nStatus: ${JSON.stringify(session.status)}`);
  }
}

async function exportCurrent(session: Session, files: Record<string, string>) {
  const pdf = await session.exportPdf();
  assert.ok(pdf && existsSync(pdf), 'the current document must export');
  for (const [file, source] of Object.entries(files)) {
    assert.equal(readFileSync(path.join(session.buildDir, 'export-src', file), 'utf8'), source, `${file}: export uses current input`);
  }
  const runtime = path.join(vscode.extensions.getExtension('hengmamath.realtime-tex-enhanced')!.extensionPath,
    'resources', 'rtex-engine', 'darwin-arm64', 'rtex');
  // Full preview and export must agree on PDF content, not only copied source bytes.
  await wait('the preview to settle before comparing exported ink', () => session.status.compile?.state === 'Ok' &&
    session.status.convergence?.state === 'Converged' && !session.status.pending);
  const comparison = JSON.parse(execFileSync(runtime, ['pdf-compare', path.join(session.buildDir, 'bg', 'main.pdf'), pdf], { encoding: 'utf8' }));
  assert.equal(comparison.equal, true);
}

// Observe committed page text and canvas pixels without adding production test hooks.
async function previewInk(api: Api, initial: string) {
  const panel = api.panel()!.panel;
  const html = panel.webview.html;
  const nonce = /<script[^>]+nonce="([^"]+)"/.exec(html)?.[1];
  assert.ok(nonce);
  const context = `writing-${Date.now()}`;
  let ready = false;
  const replies = new Map<number, { hash: number; ink: number; painted: string; selection: string }>();
  type Point = { x: number; y: number };
  const ranges = new Map<number, { start?: Point; end?: Point; obsolete: boolean; visible: string }>();
  const copies = new Map<number, { text: string; selection: string }>();
  const receive = panel.webview.onDidReceiveMessage(message => {
    if (message.context !== context) return;
    if (message.type === 'writingReady') ready = true;
    if (message.type === 'writingPixels') replies.set(message.token, message);
    if (message.type === 'writingCopyReady') ranges.set(message.token, message);
    if (message.type === 'writingCopied') copies.set(message.token, message);
  });
  panel.webview.html = html.replace('</body>', `<script nonce="${nonce}">{
    const api = acquireVsCodeApi(); window.acquireVsCodeApi = () => api;
    const context = ${JSON.stringify(context)};
    let copyToken;
    // Give the preview's copy listener an in-memory clipboard for the native Cmd+C event.
    document.addEventListener('copy', native => {
      if (!native.isTrusted || !copyToken) return;
      native.preventDefault(); native.stopImmediatePropagation();
      const data = new DataTransfer();
      const event = new ClipboardEvent('copy', {bubbles:true,cancelable:true,clipboardData:data});
      document.dispatchEvent(event);
      api.postMessage({type:'writingCopied',context,token:copyToken,text:data.getData('text/plain'),selection:String(getSelection())});
      copyToken = undefined;
    }, true);
    window.addEventListener('message', ({data:m}) => {
      if (m.context !== context) return;
      if (m.type === 'writingPrepareCopy') {
        const spans = [...document.querySelectorAll('.text-layer span')];
        const words = spans.map(span => span.textContent.trimEnd());
        const i = words.indexOf(m.first);
        const edge = (span, last) => {
          const node = span.firstChild;
          const offset = last ? node.textContent.trimEnd().length - 1 : 0;
          const range = document.createRange();
          range.setStart(node, offset); range.setEnd(node, offset + 1);
          const r = range.getBoundingClientRect();
          return {x:r.left + r.width * (last ? 0.9 : 0.1), y:r.top + r.height / 2};
        };
        let start, end;
        if (i >= 0 && words[i+1] === m.last) {
          getSelection().removeAllRanges();
          spans[i].scrollIntoView({block:'nearest',inline:'nearest'});
          start = edge(spans[i], false); end = edge(spans[i+1], true);
          copyToken = m.token;
        }
        api.postMessage({type:'writingCopyReady',context,token:m.token,start,end,obsolete:words.includes(m.obsolete),visible:words.slice(0,12).join(' ')});
        return;
      }
      if (m.type !== 'writingInspect') return;
      let hash = 2166136261, ink = 0;
      for (const canvas of document.querySelectorAll('#pages canvas')) {
        if (!canvas.width || !canvas.height) continue;
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i+3] && pixels[i] + pixels[i+1] + pixels[i+2] < 700) ink++;
          hash = Math.imul(hash ^ pixels[i], 16777619);
        }
      }
      const painted = [...document.querySelectorAll('#pages .text-layer')].map(layer => layer.textContent).join('');
      api.postMessage({type:'writingPixels',context:m.context,token:m.token,hash:hash>>>0,ink,painted,selection:String(getSelection())});
    });
    api.postMessage({type:'writingReady',context});
  }</script></body>`);
  let token = 0;
  const read = async () => {
    const key = ++token;
    await panel.webview.postMessage({ type: 'writingInspect', context, token: key });
    await wait('actual preview pixel reply', () => replies.has(key), 15000);
    const result = replies.get(key)!;
    replies.delete(key);
    return result;
  };
  const changed = async (marker: string, previous?: number) => {
    for (const start = Date.now();;) {
      const result = await read();
      if (result.painted.includes(marker) && result.ink > 0 && result.hash !== previous) return result.hash;
      if (Date.now() - start > 30000) throw new Error(`Actual preview did not paint ${marker}: ${JSON.stringify(result)}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const copy = async (input: Awaited<ReturnType<typeof sourceMouse>>, first: string, last: string, obsolete: string) => {
    // VS Code routes the copy command using workbench focus, which can lag a mouse click in the webview.
    panel.reveal(panel.viewColumn, false);
    await wait('the preview to receive workbench focus', () => panel.active, 10000);
    const key = ++token;
    await panel.webview.postMessage({ type: 'writingPrepareCopy', context, token: key, first, last, obsolete });
    await wait('live word positions in the selection layer', () => ranges.has(key), 10000);
    const range = ranges.get(key)!;
    assert.ok(range.start && range.end && !range.obsolete, `unexpected selectable text: ${range.visible}`);
    await input.dragPreview(range.start, range.end);
    const { selection } = await read();
    assert.equal(selection.replace(/\s+/g, ' ').trim(), `${first} ${last}`, 'Chromium drag must select the two preview words');
    await input.key('c', 'KeyC', 67, 4);
    await wait('Cmd+C in the preview', () => copies.has(key), 10000).catch(async error => {
      throw new Error(String(error) + '\n' + JSON.stringify({ range, input: await input.diagnostics() }));
    });
    const result = copies.get(key)!;
    assert.equal(result.text, `${first} ${last}`, `Chromium selection: ${JSON.stringify(result.selection)}`);
  };
  try {
    await wait('writing preview observer ready', () => ready, 30000);
    const baseline = await changed(initial);
    return { baseline, changed, copy, close: () => { receive.dispose(); panel.webview.html = html; } };
  } catch (error) { receive.dispose(); throw error; }
}

export async function realEditingSteps(api: Api, folder: string, step: (message: string) => void) {
  const project = path.join(folder, 'real-editing');
  mkdirSync(project, { recursive: true });
  const file = path.join(project, 'main.tex');
  const original = String.raw`\documentclass{article}
\usepackage[T1]{fontenc}
\setlength{\textwidth}{440pt}
\begin{document}
TYPECONTROL has a stable sentence with $a+b=c$ and enough room.

MULTIA has a short first paragraph.

MULTIB has a short second paragraph.

% COMPOSITION:
AFTERUNICODE stays after the comment with $u+v=w$.

PASTECONTROL ends the synthetic document.
\end{document}
`;
  writeFileSync(file, original);
  const { doc, session } = await start(api, file);
  const preview = await previewInk(api, 'TYPECONTROL');
  const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  const input = await sourceMouse();
  let expected = original;
  const outputs: SessionOutput[] = [];
  const watch = session.onOutput(output => outputs.push(output));
  const select = async (needle: string, endOnly = false) => {
    const at = doc.getText().indexOf(needle);
    assert.ok(at >= 0, `missing selection ${needle}`);
    editor.selection = new vscode.Selection(doc.positionAt(endOnly ? at + needle.length : at), doc.positionAt(at + needle.length));
    editor.revealRange(editor.selection);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await input.focus();
  };
  const buffer = async () => {
    await wait('exact editor buffer', () => doc.getText() === expected, 10000).catch(() => {
      assert.equal(doc.getText(), expected, 'native input produced unexpected editor text');
    });
    assert.equal(doc.getText(), expected);
  };
  const settings = vscode.workspace.getConfiguration('files');
  const oldSave = settings.inspect('autoSave')?.globalValue;
  const oldDelay = settings.inspect('autoSaveDelay')?.globalValue;
  let formatter: vscode.Disposable | undefined;
  try {
    await select('TYPECONTROL', true);
    const after = outputs.length;
    await input.type('quartz');
    expected = expected.replace('TYPECONTROL', 'TYPECONTROLquartz');
    await buffer();
    await ink(session, ['TYPECONTROLquartz']);
    await wait('latest keyboard text delivered live', () => outputs.slice(after).some(output => output.kind === 'paragraph'
      && output.ev.status === 'ok' && glyphText(output.ev.dl).includes('TYPECONTROLquartz')), 30000);
    await preview.changed('TYPECONTROLquartz', preview.baseline);
    step('real keyboard events deliver the latest typed text as live ink');
    await preview.copy(input, 'TYPECONTROLquartz', 'has', 'TYPECONTROL');
    step('drag selection and Cmd+C copy the latest live preview text with normal word spacing');

    await select('TYPECONTROLquartz', true);
    await input.key('Backspace', 'Backspace', 8);
    expected = expected.replace('TYPECONTROLquartz', 'TYPECONTROLquart');
    await buffer();
    await ink(session, ['TYPECONTROLquart'], ['TYPECONTROLquartz']);
    await input.key('z', 'KeyZ', 90, 4);
    expected = expected.replace('TYPECONTROLquart', 'TYPECONTROLquartz');
    await buffer();
    await ink(session, ['TYPECONTROLquartz']);
    await input.key('Z', 'KeyZ', 90, 12);
    expected = expected.replace('TYPECONTROLquartz', 'TYPECONTROLquart');
    await buffer();
    await ink(session, ['TYPECONTROLquart'], ['TYPECONTROLquartz']);
    step('keyboard deletion, Cmd+Z and Cmd+Shift+Z preserve buffer and preview agreement');

    await select('PASTECONTROL');
    const pasted = 'PASTEAMBER begins a new paragraph.\n\nPASTECOBALT contains $x+y=z$.';
    await input.paste(pasted);
    expected = expected.replace('PASTECONTROL', pasted);
    await buffer();
    await ink(session, ['PASTEAMBER', 'PASTECOBALT', 'endsthesyntheticdocument.']);
    step('the real editor paste handler inserts multiple paragraphs and math without losing following text');

    await select('% COMPOSITION:', true);
    await input.compose('中');
    await wait('first IME composition', () => doc.getText().includes('% COMPOSITION:中'), 10000);
    await input.compose('中文');
    await wait('updated IME composition', () => doc.getText().includes('% COMPOSITION:中文'), 10000);
    await input.insertText('中文α🙂');
    expected = expected.replace('% COMPOSITION:', '% COMPOSITION:中文α🙂');
    await buffer();
    await select('AFTERUNICODE', true);
    await input.type('amber');
    expected = expected.replace('AFTERUNICODE', 'AFTERUNICODEamber');
    await buffer();
    await ink(session, ['AFTERUNICODEamber']);
    step('Chromium composition updates and a Unicode commit preserve subsequent UTF-8 edit offsets');

    await select('MULTI');
    await input.key('d', 'KeyD', 68, 4);
    await wait('Cmd+D creates a second selection', () => editor.selections.length === 2, 10000);
    await input.key('ArrowRight', 'ArrowRight', 39);
    await wait('both keyboard cursors collapse at the selection ends', () => editor.selections.every(selection => selection.isEmpty), 10000);
    await input.type('Z');
    expected = expected.replace('MULTIA', 'MULTIZA').replace('MULTIB', 'MULTIZB');
    await buffer();
    await ink(session, ['MULTIZA', 'MULTIZB']);
    await input.key('z', 'KeyZ', 90, 4);
    expected = expected.replace('MULTIZA', 'MULTIA').replace('MULTIZB', 'MULTIB');
    await buffer();
    await ink(session, ['MULTIA', 'MULTIB'], ['MULTIZA', 'MULTIZB']);
    step('multi-cursor keyboard edits and one-step undo update both paragraphs');

    await select('TYPECONTROLquart');
    await input.type('REPLACECONTROL');
    expected = expected.replace('TYPECONTROLquart', 'REPLACECONTROL');
    await buffer();
    await ink(session, ['REPLACECONTROL'], ['TYPECONTROL']);
    formatter = vscode.languages.registerDocumentFormattingEditProvider({ language: doc.languageId, pattern: file }, {
      provideDocumentFormattingEdits(document) {
        return ['MULTIA', 'MULTIB'].map(marker => {
          const at = document.positionAt(document.getText().indexOf(marker));
          return vscode.TextEdit.insert(at, '  ');
        });
      },
    });
    await vscode.commands.executeCommand('editor.action.formatDocument');
    expected = expected.replace('MULTIA', '  MULTIA').replace('MULTIB', '  MULTIB');
    await buffer();
    await ink(session, ['MULTIA', 'MULTIB', 'REPLACECONTROL']);
    step('selection replacement and a formatter batch retain all current paragraphs');

    await settings.update('autoSaveDelay', 500, vscode.ConfigurationTarget.Global);
    await settings.update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Global);
    await select('REPLACECONTROL', true);
    await input.type('saved');
    expected = expected.replace('REPLACECONTROL', 'REPLACECONTROLsaved');
    await buffer();
    await wait('auto-save writes the current buffer', () => !doc.isDirty && readFileSync(file, 'utf8') === expected, 15000);
    await ink(session, ['REPLACECONTROLsaved', 'AFTERUNICODEamber']);
    await preview.changed('REPLACECONTROLsaved', preview.baseline);
    await exportCurrent(session, { 'main.tex': expected });
    step('auto-save and PDF export retain every keyboard, Unicode, paste and formatting edit');
  } finally {
    formatter?.dispose();
    watch.dispose();
    preview.close();
    input.close();
    await settings.update('autoSave', oldSave, vscode.ConfigurationTarget.Global);
    await settings.update('autoSaveDelay', oldDelay, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('realtimeTex.stop');
  }
}

export async function bibliographyLifecycleSteps(api: Api, folder: string, step: (message: string) => void) {
  for (const backend of ['bibtex', 'biber']) {
    const project = path.join(folder, `lifecycle-${backend}`);
    mkdirSync(path.join(project, 'parts'), { recursive: true });
    const main = path.join(project, 'main.tex');
    const bib = path.join(project, 'refs.bib');
    let chapter = path.join(project, 'parts', 'chapter.tex');
    const entry = (key: string, title: string) => `@book{${key}, author={Amber, Ada}, title={{${title}}}, publisher={Synthetic Press}, year={2026}}\n`;
    let bibliography = entry('alpha', 'REFAMBER');
    let chapterSource = '% !TeX root = ../main.tex\n\\section{Lifecycle chapter}\\label{sec:chapter}\n'
      + 'CHAPTERAMBER cites~\\cite{alpha} with a stable sentence.\n\nCHAPTERTAIL remains here.\n';
    writeFileSync(bib, bibliography);
    writeFileSync(chapter, chapterSource);
    const preamble = backend === 'biber'
      ? '\\usepackage[backend=biber,style=numeric]{biblatex}\n\\addbibresource{refs.bib}' : '';
    const references = backend === 'biber' ? '\\printbibliography' : '\\bibliographystyle{plain}\n\\bibliography{refs}';
    writeFileSync(main, '\\documentclass{article}\n\\usepackage[T1]{fontenc}\n'
      + preamble + '\n\\usepackage{hyperref}\n\\begin{document}\n\\input{parts/chapter}\n'
      + '\nMAINCONTROL refers to Section~\\ref{sec:chapter}.\n' + references + '\n\\end{document}\n');
    const { doc, session } = await start(api, main);
    const preview = await previewInk(api, 'REFAMBER');
    const outputs: SessionOutput[] = [];
    const watch = session.onOutput(output => outputs.push(output));
    const replace = async (document: vscode.TextDocument, before: string, after: string) => {
      const at = document.getText().indexOf(before);
      assert.ok(at >= 0, `missing replacement ${before}`);
      const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      assert.ok(await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(at), document.positionAt(at + before.length)), after)));
    };
    const close = async (document: vscode.TextDocument, discard = false) => {
      await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      await vscode.commands.executeCommand(discard ? 'workbench.action.revertAndCloseActiveEditor' : 'workbench.action.closeActiveEditor');
    };
    try {
      await ink(session, ['CHAPTERAMBER', 'REFAMBER', 'MAINCONTROL']);
      assert.ok(!visibleText(session).includes('??'), `${backend}: initial citations and cross-references must resolve`);
      const after = outputs.length;
      bibliography = entry('alpha', 'REFCOPPER');
      writeFileSync(bib, bibliography);
      await ink(session, ['REFCOPPER'], ['REFAMBER']);
      await preview.changed('REFCOPPER', preview.baseline);
      assert.ok(outputs.slice(after).some(output => output.kind === 'inputsChanged' && output.files.includes(bib)), 'the disk watcher must drive bibliography updates');
      step(`${backend}: a closed bibliography changed on disk refreshes the visible reference automatically`);

      const bibDoc = await vscode.workspace.openTextDocument(bib);
      await replace(bibDoc, 'REFCOPPER', 'REFCOBALT');
      assert.equal(readFileSync(bib, 'utf8'), bibliography, 'an unsaved bib edit must not change the file');
      assert.ok(await bibDoc.save());
      bibliography = entry('alpha', 'REFCOBALT');
      await ink(session, ['REFCOBALT'], ['REFCOPPER']);
      await close(bibDoc);
      step(`${backend}: saving a bibliography editor refreshes the reference and clears its old text`);

      bibliography += entry('beta', 'REFVIOLET');
      writeFileSync(bib, bibliography);
      const chapterDoc = await vscode.workspace.openTextDocument(chapter);
      await replace(chapterDoc, '\\cite{alpha}', '\\cite{beta}');
      chapterSource = chapterDoc.getText();
      await ink(session, ['REFVIOLET'], ['REFCOBALT']);
      assert.ok(!visibleText(session).includes('??'), `${backend}: the new citation must resolve`);
      await replace(chapterDoc, '\\cite{beta}', '\\cite{alpha,beta}');
      chapterSource = chapterDoc.getText();
      await ink(session, ['REFCOBALT', 'REFVIOLET']);
      assert.ok(await chapterDoc.save());
      await exportCurrent(session, { 'main.tex': doc.getText(), 'parts/chapter.tex': chapterSource, 'refs.bib': bibliography });
      step(`${backend}: adding, replacing and restoring citations converges and exports both current references`);

      // One backend is enough for filesystem lifecycle; both exercise bibliography passes above.
      if (backend === 'biber') continue;

      await replace(chapterDoc, 'CHAPTERAMBER', 'UNSAVEDCHAPTER');
      await ink(session, ['UNSAVEDCHAPTER'], ['CHAPTERAMBER']);
      await close(chapterDoc, true);
      await ink(session, ['CHAPTERAMBER'], ['UNSAVEDCHAPTER']);
      assert.equal(readFileSync(chapter, 'utf8'), chapterSource);
      step('discarding an unsaved chapter restores its saved text in the running preview');

      const renamed = path.join(project, 'parts', 'renamed chapter.tex');
      const rename = new vscode.WorkspaceEdit();
      rename.renameFile(vscode.Uri.file(chapter), vscode.Uri.file(renamed));
      assert.ok(await vscode.workspace.applyEdit(rename));
      await replace(doc, '\\input{parts/chapter}', '\\input{parts/renamed chapter}');
      assert.ok(await doc.save());
      chapter = renamed;
      await ink(session, ['CHAPTERAMBER', 'REFCOBALT', 'REFVIOLET']);
      await exportCurrent(session, { 'main.tex': doc.getText(), 'parts/renamed chapter.tex': chapterSource, 'refs.bib': bibliography });
      assert.ok(!existsSync(path.join(session.buildDir, 'export-src', 'parts', 'chapter.tex')), 'the renamed input must not survive in the export snapshot');
      const renamedDoc = await vscode.workspace.openTextDocument(chapter);
      const beforeReveal = outputs.length;
      assert.ok(await session.revealInPreview(renamedDoc, renamedDoc.positionAt(chapterSource.indexOf('CHAPTERAMBER')), true));
      const reveal = outputs.slice(beforeReveal).find(output => output.kind === 'reveal');
      assert.ok(reveal?.kind === 'reveal');
      assert.ok(await session.jumpToSource(reveal.target.page, reveal.target.x, reveal.target.y));
      assert.equal(vscode.window.activeTextEditor?.document.fileName, chapter, 'renamed chapter must round-trip through the preview');
      await close(renamedDoc);
      step('renaming an included chapter to a path with spaces updates export inputs and source navigation');

      const retained = visibleText(session);
      rmSync(chapter);
      await wait('deleted chapter reports a compile failure', () => session.status.compile?.state === 'Failed');
      assert.equal(visibleText(session), retained, 'a missing chapter must retain the last good ink');
      chapterSource = chapterSource.replace('CHAPTERAMBER', 'RESTOREDCHAPTER');
      writeFileSync(chapter, chapterSource);
      await ink(session, ['RESTOREDCHAPTER'], ['CHAPTERAMBER']);
      await wait('restored chapter clears compile failure', () => session.status.compile?.state === 'Ok' && !session.status.pending);
      step('deleting and restoring a closed chapter reports failure, retains good ink and recovers automatically');

      const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      git('init', '-q', '-b', 'baseline');
      git('config', 'user.name', 'Synthetic test');
      git('config', 'user.email', 'test@example.invalid');
      writeFileSync(path.join(project, '.gitignore'), '*.pdf\n');
      git('add', '.');
      git('commit', '-qm', 'Synthetic baseline');
      git('checkout', '-qb', 'alternate');
      writeFileSync(chapter, chapterSource.replace('RESTOREDCHAPTER', 'BRANCHCHAPTER'));
      writeFileSync(bib, bibliography.replace('REFCOBALT', 'REFBRANCH'));
      git('add', '.');
      git('commit', '-qm', 'Synthetic alternate');
      await ink(session, ['BRANCHCHAPTER', 'REFBRANCH'], ['RESTOREDCHAPTER', 'REFCOBALT']);
      git('checkout', '-q', 'baseline');
      await ink(session, ['RESTOREDCHAPTER', 'REFCOBALT'], ['BRANCHCHAPTER', 'REFBRANCH']);
      await exportCurrent(session, { 'main.tex': doc.getText(), 'parts/renamed chapter.tex': chapterSource, 'refs.bib': bibliography });
      step('a real Git checkout restores chapter and bibliography content without restarting the session');

      await vscode.commands.executeCommand('realtimeTex.stop');
      await close(doc);
      const moved = path.join(folder, '移动 project');
      cpSync(project, moved, { recursive: true, filter: source => path.basename(source) !== '.git' && !source.endsWith('.pdf') });
      rmSync(project, { recursive: true, force: true });
      const child = await vscode.workspace.openTextDocument(path.join(moved, 'parts', 'renamed chapter.tex'));
      await vscode.window.showTextDocument(child, vscode.ViewColumn.One);
      await vscode.commands.executeCommand('realtimeTex.openPreview');
      await wait('moved child resolves the new main', () => api.session()?.mainFile === path.join(moved, 'main.tex') && !!api.session()?.running);
      const reopened = api.session()!;
      await ink(reopened, ['RESTOREDCHAPTER', 'REFCOBALT', 'REFVIOLET']);
      await exportCurrent(reopened, { 'main.tex': readFileSync(path.join(moved, 'main.tex'), 'utf8'),
        'parts/renamed chapter.tex': chapterSource, 'refs.bib': bibliography });
      step('moving the project to a Unicode path and reopening an included file resolves the new root and exports');
    } finally {
      watch.dispose();
      preview.close();
      await vscode.commands.executeCommand('realtimeTex.stop');
    }
  }
}
