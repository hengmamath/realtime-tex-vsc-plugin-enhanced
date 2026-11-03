import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { Api } from '../../src/extension';
import type { SessionOutput } from '../../src/session';
import type { DisplayList } from '../../src/protocol';

const text = (dl: DisplayList) => dl.lines.flatMap(row => row.items)
  .filter(item => item[0] === 'g').map(item => String.fromCodePoint(item[2] as number))
  .join('').replace(/[\s-]/g, '');

export async function runInHeadingSteps(api: Api, folder: string, step: (message: string) => void): Promise<void> {
  const wait = async (what: string, check: () => boolean) => {
    for (const start = Date.now(); !check();) {
      if (Date.now() - start > 120000) throw new Error(`Timed out: ${what}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  await vscode.commands.executeCommand('realtimeTex.stop');
  const project = path.join(folder, 'run-in');
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, 'main.tex'), readFileSync(path.resolve(__dirname, '../../test/fixtures/run-in-live.tex')));
  const doc = await vscode.workspace.openTextDocument(path.join(project, 'main.tex'));
  const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  await vscode.commands.executeCommand('realtimeTex.openPreview');
  await wait('run-in session', () => api.session()?.mainFile === doc.fileName && !!api.session()?.running);
  const session = api.session()!;
  await wait('run-in layout', () => session.model.hasLayout && session.status.convergence?.state === 'Converged' && !session.status.pending);
  const outputs: SessionOutput[] = [];
  const watch = session.onOutput(output => outputs.push(output));
  try {
    for (const [title, body, tail] of [['SATITLE', 'SABODY', 'SATAIL'], ['SBTITLE', 'SBBODY', 'SBTAIL'], ['BLTITLE', 'BLBODY', 'BLTAIL']]) {
      const after = outputs.length;
      const at = doc.getText().indexOf(body) + body.length;
      await editor.edit(edit => edit.insert(doc.positionAt(at), 'X'));
      await wait('run-in first paragraph updating live', () => outputs.slice(after).some(output =>
        output.kind === 'paragraph' && output.ev.status === 'ok' && text(output.ev.dl).includes(body + 'X')));
      const update = outputs.slice(after).find(output => output.kind === 'paragraph' && text(output.ev.dl).includes(body + 'X'));
      assert.ok(update?.kind === 'paragraph');
      const ink = text(update.ev.dl);
      for (const marker of [title, body + 'X', tail]) assert.equal(ink.split(marker).length - 1, 1, `${marker}: missing or duplicate live ink`);
      assert.equal(vscode.languages.getDiagnostics(doc.uri).filter(d => d.severity === vscode.DiagnosticSeverity.Error).length, 0);
      assert.ok(await session.revealInPreview(doc, doc.positionAt(at), true));
      step('run-in heading and complete first paragraph update live with ' + (body === 'SABODY' ? 'same-line' : body === 'SBBODY' ? 'next-line' : 'blank-line') + ' source prose');
    }
  } finally {
    watch.dispose();
    await vscode.commands.executeCommand('realtimeTex.stop');
  }
}
