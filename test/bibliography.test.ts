import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { DisplayList } from '../src/protocol';
import { glyphText, realEngineFixture, realEngineUnavailable } from './realEngineFixture';
import { prepareTestRuntime } from './runtimeFixture';

for (const backend of ['bibtex', 'biber']) {
  test(`${backend} refreshes bibliography data and citation keys, then resumes live editing and exports current ink`, {
    skip: realEngineUnavailable, timeout: 180000,
  }, async () => {
    const preamble = backend === 'biber'
      ? '\\usepackage[backend=biber,style=numeric]{biblatex}\n\\addbibresource{refs.bib}' : '';
    const references = backend === 'biber' ? '\\printbibliography' : '\\bibliographystyle{plain}\n\\bibliography{refs}';
    const f = await realEngineFixture({ source: '\\documentclass{article}\n\\usepackage[T1]{fontenc}\n'
      + preamble + '\n\\begin{document}\nCITECONTROL cites~\\cite{alpha} in a short sentence.\n\n'
      + 'Another paragraph stays here.\n' + references + '\n\\end{document}\n' });
    const bib = path.join(f.temporary, 'project', 'refs.bib');
    const entry = (key: string, title: string) => `@book{${key},author={Amber, Ada},title={{${title}}},publisher={Synthetic Press},year={2026}}\n`;
    const text = () => {
      const pages = new Map<number, DisplayList>();
      for (const event of f.events) if (event.event === 'LayoutUpdate') {
        for (const page of event.pages_changed) pages.set(page.page, page.dl);
        for (const page of pages.keys()) if (page > event.pages_total) pages.delete(page);
      }
      return [...pages.values()].map(glyphText).join('').replace(/\s/g, '');
    };
    try {
      await fs.writeFile(bib, entry('alpha', 'REFAMBER'));
      await f.start();
      assert.ok(text().includes('REFAMBER'), 'the initial bibliography must be resolved');
      assert.ok(!text().includes('??'));
      const bibliography = entry('alpha', 'REFCOPPER') + entry('beta', 'REFVIOLET');
      await fs.writeFile(bib, bibliography);
      await f.layout(0);
      assert.ok(text().includes('REFCOPPER'), 'a warm pass must reread the bibliography');
      assert.ok(!text().includes('REFAMBER'), 'the old title must disappear');
      const at = f.source.indexOf('\\cite{alpha}') + '\\cite{'.length;
      const edit = await f.edit(at, at + 'alpha'.length, 'beta');
      await f.layout(edit.source_revision!);
      assert.ok(text().includes('REFVIOLET'));
      assert.ok(!text().includes('REFCOPPER'), 'uncited entries must disappear');
      assert.ok(!text().includes('??'));
      const update = await f.editMarker('CITECONTROL');
      assert.ok(!glyphText(update.dl).includes('?'), 'the live server must use the resolved bibliography');
      await f.layout(update.versions.source_revision);
      const after = f.events.length;
      const reply = await f.engine.request({ cmd: 'export_pdf', out: path.join(f.temporary, 'result.pdf') });
      assert.ok(reply.reply === 'export_pdf');
      const exported = await f.waitFor(after, event => event.event === 'PdfExported' && event.job_id === reply.job_id, 'bibliography PDF export');
      assert.ok(exported.event === 'PdfExported' && exported.status.state === 'Ok' && exported.path);
      assert.equal(await fs.readFile(path.join(f.build, 'export-src', 'refs.bib'), 'utf8'), bibliography);
      assert.equal(await fs.readFile(path.join(f.build, 'export-src', 'main.tex'), 'utf8'), f.source);
      const { serverPath } = await prepareTestRuntime(path.resolve(__dirname, '../..'));
      const comparison = spawnSync(serverPath, ['pdf-compare', path.join(f.build, 'bg', 'main.pdf'), exported.path], { encoding: 'utf8', timeout: 10000 });
      assert.ifError(comparison.error);
      assert.equal(comparison.status, 0, comparison.stderr);
      assert.equal(JSON.parse(comparison.stdout).equal, true, 'full preview and export must contain the same current references');
    } finally { await f.close(); }
  });
}
