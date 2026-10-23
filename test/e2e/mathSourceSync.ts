import assert from 'node:assert/strict';
import { copyFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Api } from '../../src/extension';
import type { Line } from '../../src/protocol';
import type { SessionOutput } from '../../src/session';
import { expectedMathRow, mathRowGlyphY } from '../mathSourceSyncExpected';
import { sourceMouse } from './sourceMouse';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, description: string, timeout = 10000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${description}`);
    await pause(50);
  }
}

export async function mathSourceSyncSteps(api: Api, folder: string, step: (description: string) => void) {
  await vscode.commands.executeCommand('realtimeTex.stop');
  const file = path.join(folder, 'math-source-sync.tex');
  copyFileSync(path.resolve(__dirname, '../../test/fixtures/math-source-sync.tex'), file);
  const doc = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  await vscode.commands.executeCommand('realtimeTex.openPreview');
  await until(() => api.session()?.mainFile === file && api.session()?.status.convergence?.state === 'Converged'
    && !api.session()?.status.pending, 'math fixture converged', 120000);
  const session = api.session()!;
  const outputs: SessionOutput[] = [];
  const watch = session.onOutput(output => outputs.push(output));
  const mouse = await sourceMouse();
  const config = vscode.workspace.getConfiguration('realtimeTex', doc.uri);
  const previous = config.inspect('followCursor')?.workspaceValue;
  let page = 0, count = 0, rowCount = 0, marker = '';
  const ink = (row: Line) => row.items.filter(i => i[0] === 'g').map(i => String.fromCodePoint(i[2] as number)).join('');
  const visibleRows = (page: number) => {
    const rows = session.model.overlaysOn(page).flatMap(overlay => overlay.rows.map(row => ({
      row: row.line, dy: row.dy, revision: overlay.overlay.dl.source_revision,
    })));
    const dl = session.model.pages.get(page)?.dl;
    const hidden = session.model.hiddenLines(page);
    dl?.lines.forEach((row, i) => { if (!hidden.has(i)) rows.push({ row, dy: 0, revision: dl.source_revision }); });
    return rows;
  };
  const assertJump = async (page: number, marker: string, line: number, character: number, mode: 'context' | 'double') => {
    const text = doc.lineAt(line).text;
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    editor.revealRange(new vscode.Range(line, character, line, Math.min(character + 1, text.length)), vscode.TextEditorRevealType.InCenter);
    await pause(120);
    const start = outputs.length;
    await mouse.at(text, line, character, mode);
    await until(() => outputs.slice(start).some(o => o.kind === 'reveal'), `${mode} ${page}:${line + 1}:${character}; active ${vscode.window.activeTextEditor?.document.fileName}, selection ${JSON.stringify(editor.selection)}`);
    assert.equal(editor.selection.start.line, line, 'mouse input must reach the requested source line');
    if (mode === 'context') assert.ok(Math.abs(editor.selection.active.character - character) <= 1, 'right click must reach the requested column');
    else assert.ok(!editor.selection.isEmpty && editor.selection.start.character <= character + 1
      && editor.selection.end.character >= character, `native selection must touch ${line + 1}:${character} in ${text}; got ${JSON.stringify(editor.selection)}`);
    const reveal = outputs.slice(start).find(o => o.kind === 'reveal');
    assert.ok(reveal?.kind === 'reveal' && reveal.force);
    assert.equal(reveal.target.page, page, `${mode}: wrong formula page`);
    const rows = visibleRows(page);
    const before = rows.find(({ row }) => ink(row).startsWith(`START${marker}`));
    const after = rows.find(({ row }) => ink(row).endsWith(`END${marker}`));
    assert.ok(before && after, 'independent rendered markers must bound this formula');
    const beforeY = before.row.y + before.dy, afterY = after.row.y + after.dy;
    const prose = text.indexOf('where');
    if (prose >= 0 && character > prose) assert.equal(reveal.target.y, afterY, `${mode}: trailing prose must retain its own target`);
    else {
      const macroFallback = marker === 'MACRO' && text.includes('\\SyntheticRows');
      const expected = expectedMathRow(text, character) ?? (macroFallback ? 'z10' : undefined);
      if (expected) {
        const baselines = new Set<number>();
        for (const { row, dy } of rows) {
          const y = mathRowGlyphY(row, expected);
          if (y !== undefined && y + dy > beforeY && y + dy < afterY) baselines.add(y + dy);
        }
        assert.equal(baselines.size, 1, `${marker}: ${expected} must independently identify one drawn formula row`);
        assert.equal(reveal.target.y, [...baselines][0], `${mode} ${marker} ${line + 1}:${character}: ${macroFallback
          ? 'unknown macro must retain first-row block fallback' : `must reach formula row ${expected}`}`);
        if (!macroFallback) rowCount++;
      } else assert.ok(reveal.target.y > beforeY && reveal.target.y < afterY, `${mode}: uncertain source must retain formula block fallback`);
    }
    count++;
  };
  try {
    for (let line = 0; line < doc.lineCount; line++) {
      const text = doc.lineAt(line).text;
      if (text.startsWith('START')) { page++; marker = text.slice(5); continue; }
      if (text.startsWith('END')) { step(`${marker}: native source clicks and context-menu jumps passed`); marker = ''; continue; }
      if (!marker || !text.trim()) continue;
      const formulaText = text.includes('\\end{proof}') ? text.slice(0, text.indexOf('\\end{proof}')) : text;
      const columns = [...new Set([0, formulaText.search(/\S/), formulaText.search(/[A-Za-z]/),
        ...Array.from(formulaText.matchAll(/[&=+\\_{}]/g), match => match.index!)].filter(n => n >= 0))];
      const prose = text.indexOf('where');
      if (prose >= 0) columns.push(prose + 1);
      for (const mode of ['context', 'double'] as const) {
        await config.update('followCursor', mode === 'context' ? 'off' : 'doubleClick', vscode.ConfigurationTarget.Workspace);
        for (const character of columns) {
          await assertJump(page, marker, line, character, mode);
        }
      }
    }
    const original = doc.getText();
    const lastRow = 'd_2 &= e_2 + f_2';
    const extraRow = `${lastRow} \\\\\n  j_2 &= k_2 + l_2`;
    const checkLiveRows = async (after: number, inserted: boolean, description: string) => {
      await until(() => outputs.slice(after).some(o => o.kind === 'paragraph' && o.ev.status === 'ok'), description, 30000);
      const update = outputs.slice(after).find(o => o.kind === 'paragraph' && o.ev.status === 'ok');
      assert.ok(update?.kind === 'paragraph');
      const revision = update.ev.versions.source_revision;
      await until(() => visibleRows(2).some(row => row.revision !== undefined && row.revision >= revision), `${description}: visible revision`);
      assert.equal(doc.getText().includes('j_2'), inserted);
      for (const mode of ['context', 'double'] as const) {
        await config.update('followCursor', mode === 'context' ? 'off' : 'doubleClick', vscode.ConfigurationTarget.Workspace);
        for (const token of inserted ? ['d_2', 'j_2'] : ['d_2']) {
          const position = doc.positionAt(doc.getText().indexOf(token));
          await assertJump(2, 'ALIGNSTAR', position.line, position.character, mode);
        }
      }
    };
    for (const [oldText, text] of [[lastRow, extraRow], [extraRow, lastRow]]) {
      const after = outputs.length, at = doc.getText().indexOf(oldText);
      assert.ok(at >= 0);
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      assert.ok(await editor.edit(builder => builder.replace(new vscode.Range(doc.positionAt(at), doc.positionAt(at + oldText.length)), text)));
      await checkLiveRows(after, text === extraRow, 'live formula row insertion/deletion');
    }
    for (const inserted of [true, false]) {
      const after = outputs.length, version = doc.version;
      await mouse.focus();
      await vscode.commands.executeCommand('workbench.action.focusWindow');
      await until(() => vscode.window.state.focused, 'formula undo: native window focused', 5000);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, file, 'formula undo requires source editor focus');
      await vscode.commands.executeCommand('undo');
      await until(() => doc.version > version, 'formula undo: source buffer changed', 5000);
      await checkLiveRows(after, inserted, 'live formula row undo');
    }
    assert.equal(doc.getText(), original, 'row edits and undo must restore the synthetic document');
    step(`${count} real editor double-clicks and context-menu jumps cover all 13 formula bodies, delimiters and trailing prose; ${rowCount} verify exact formula rows`);
    step('native context-menu and double-click targets remain exact after live row insertion, deletion and undo');
  } catch (error) {
    writeFileSync(path.join(folder, 'math-mouse-failure.png'), Buffer.from(await mouse.screenshot(), 'base64'));
    throw error;
  } finally {
    mouse.close(); watch.dispose();
    await config.update('followCursor', previous, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('realtimeTex.stop');
  }
}
