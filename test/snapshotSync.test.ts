import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { glyphText, realEngineFixture, realEngineUnavailable } from './realEngineFixture';
import { prepareTestRuntime } from './runtimeFixture';
import { twoPagePdf } from './pdfFixture';

type Fixture = Awaited<ReturnType<typeof realEngineFixture>>;
const root = path.resolve(__dirname, '..', '..');
const resourceFor = (fixture: Fixture) => path.join(fixture.temporary, 'project', 'two-pages.pdf');

async function replaceResource(resource: string, snapshot: string, contents: string, older: boolean): Promise<void> {
  assert.equal(Buffer.byteLength(contents), (await fs.stat(resource)).size, 'the replacement must keep exactly the same file size');
  const copiedTime = new Date('2020-01-02T00:00:00Z');
  const sourceTime = older ? new Date('2020-01-01T00:00:00Z') : copiedTime;
  await fs.utimes(snapshot, copiedTime, copiedTime);
  await fs.writeFile(resource, contents);
  await fs.utimes(resource, sourceTime, sourceTime);
  const [sourceStat, copiedStat] = await Promise.all([fs.stat(resource), fs.stat(snapshot)]);
  assert.equal(sourceStat.mtimeMs === copiedStat.mtimeMs, !older, 'exercise equal or older modification times explicitly');
  assert.ok(sourceStat.mtimeMs <= copiedStat.mtimeMs, 'a newer source timestamp must not make this regression pass');
}

async function requestLayout(fixture: Fixture) {
  const after = fixture.events.length;
  const reply = await fixture.engine.request({ cmd: 'request_layout' });
  assert.equal(reply.reply, 'request_layout');
  const event = await fixture.waitFor(after, event => {
    if (event.event !== 'LayoutUpdate') return false;
    // A completed pass with stable aux files can still report Converging when TeX had errors.
    const completedError = event.compile.state !== 'Ok' && (event.convergence.state !== 'Converging' ||
      !event.convergence.reasons.includes('another pass is running'));
    return completedError || event.convergence.state === 'Converged' || event.convergence.state === 'PassLimitReached';
  }, 'the requested resource layout');
  assert.ok(event.event === 'LayoutUpdate');
  return event;
}

async function exportPdf(fixture: Fixture, name: string) {
  const after = fixture.events.length;
  const reply = await fixture.engine.request({ cmd: 'export_pdf', out: path.join(fixture.temporary, name) });
  assert.ok(reply.reply === 'export_pdf');
  const event = await fixture.waitFor(after, event => event.event === 'PdfExported' && event.job_id === reply.job_id, 'PDF export');
  assert.ok(event.event === 'PdfExported');
  return event;
}

test('an aborted export cannot replace a valid PDF with an unreadable partial file', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const fixture = await realEngineFixture({ source: String.raw`\documentclass{article}
\begin{document}
First page.\newpage
Second page.\newpage
Last page.
\end{document}
` });
  try {
    await fixture.start();
    const good = await exportPdf(fixture, 'result.pdf');
    assert.equal(good.status.state, 'Ok');
    const saved = await fs.readFile(good.path!);
    const end = fixture.source.indexOf('\\end{document}');
    const missing = '\\input{never-created}\n';
    await fixture.edit(end, end, missing);
    const aborted = await exportPdf(fixture, 'result.pdf');
    assert.equal(aborted.status.state, 'Failed', 'an incomplete PDF is not a usable export with errors');
    assert.equal(aborted.path, null);
    assert.equal(aborted.converged, false);
    assert.deepEqual(await fs.readFile(good.path!), saved, 'a failed export preserves the last valid file');

    await fixture.edit(end, end + missing.length, '\\undefinedqacommand\n');
    const recoverable = await exportPdf(fixture, 'recoverable.pdf');
    assert.equal(recoverable.status.state, 'CompiledWithErrors', 'readable PDFs with nonfatal TeX errors remain available with warnings');
    assert.ok(recoverable.path);
    const { serverPath } = await prepareTestRuntime(root);
    assertPdfEqual(serverPath, good.path!, recoverable.path, true);
  } finally { await fixture.close(); }
});

test('starred includes load source anchors and the included file before it is opened by an editor', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const fixture = await realEngineFixture({ source: String.raw`\documentclass{article}
\usepackage{newclude}
\begin{document}
\include*{chapter}
\end{document}
` }, true);
  try {
    await fs.writeFile(path.join(fixture.temporary, 'project', 'chapter.tex'), '\uFEFFChapterquartz belongs to this document.\r\n\nAnother line.\n');
    await fixture.start();
    const pages = fixture.events.flatMap(event => event.event === 'LayoutUpdate' ? event.pages_changed : []);
    assert.ok(pages.some(page => page.dl.lines.some(line => line.source_anchors?.some(anchor => anchor.file === 'chapter.tex' && anchor.line === 1))),
      'the compiled included source must retain its trusted source anchors');
    const spans = await fixture.engine.request({ cmd: 'spans', path: 'chapter.tex' });
    assert.equal(spans.reply, 'spans');
    assert.ok(spans.reply === 'spans' && spans.spans.length > 0);
    const at = Buffer.byteLength('\uFEFFChapterquartz');
    const edited = await fixture.engine.request({ cmd: 'edit', path: 'chapter.tex', start: at, end: at, text: 'Z' });
    assert.equal(edited.reply, 'edit');
    assert.ok(edited.reply === 'edit');
    await fixture.layout(edited.result.source_revision!);
    const exported = await exportPdf(fixture, 'included-edit.pdf');
    assert.equal(exported.status.state, 'Ok');
    assert.match(await fs.readFile(path.join(fixture.build, 'export-src', 'chapter.tex'), 'utf8'), /ChapterquartzZ/);
    const { serverPath } = await prepareTestRuntime(root);
    assertPdfEqual(serverPath, path.join(fixture.build, 'bg', 'main.pdf'), exported.path!, true);
  } finally { await fixture.close(); }
});

test('missing and deleted TeX inputs fail layouts and exports, then recover when recreated', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const fixture = await realEngineFixture({ source: String.raw`\documentclass{article}
\begin{document}
\input{chapter}
\end{document}
` });
  const chapter = path.join(fixture.temporary, 'project', 'chapter.tex');
  try {
    await fs.writeFile(chapter, 'Original chapter.\n');
    await fixture.start();
    await fixture.engine.request({ cmd: 'set_document', path: 'chapter.tex', text: 'Unsaved chapter.\n' });
    await fs.rm(chapter);
    const removed = await fixture.engine.request({ cmd: 'remove_document', path: 'chapter.tex' });
    assert.equal(removed.reply, 'remove_document');
    assert.notEqual((await requestLayout(fixture)).compile.state, 'Ok', 'deleted input must not reuse an old buffer');
    assert.notEqual((await exportPdf(fixture, 'deleted.pdf')).status.state, 'Ok');
    await assert.rejects(fs.stat(path.join(fixture.build, 'export-src', 'chapter.tex')), { code: 'ENOENT' });
    await fs.writeFile(chapter, 'Recreated chapter.\n');
    await fixture.engine.request({ cmd: 'set_document', path: 'chapter.tex', text: 'Recreated chapter.\n' });
    assert.equal((await requestLayout(fixture)).compile.state, 'Ok');
    assert.equal((await exportPdf(fixture, 'recreated.pdf')).status.state, 'Ok');

    const at = fixture.source.indexOf('\\input{chapter}');
    await fixture.edit(at, at + '\\input{chapter}'.length, '\\input{never-created}');
    assert.notEqual((await requestLayout(fixture)).compile.state, 'Ok', 'a missing input must not become an empty file');
    assert.notEqual((await exportPdf(fixture, 'missing.pdf')).status.state, 'Ok');
    await assert.rejects(fs.stat(path.join(fixture.build, 'export-src', 'never-created.tex')), { code: 'ENOENT' });
  } finally { await fixture.close(); }
});

function assertPdfEqual(executable: string, first: string, second: string, equal: boolean): void {
  const comparison = spawnSync(executable, ['pdf-compare', first, second], { encoding: 'utf8', timeout: 10000 });
  assert.equal(comparison.error, undefined);
  assert.equal(comparison.status, equal ? 0 : 1, comparison.stderr);
  assert.equal(JSON.parse(comparison.stdout).equal, equal, 'compare rendered PDF contents, ignoring dates and object IDs');
}

for (const bounds of ['\\path[use as bounding box]', '\\useasboundingbox', '\\path[custombounds]']) {
test(`a TikZ bounding box override (${bounds}) cannot clip visible labels in a warm preview`, {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const fixture = await realEngineFixture({ source: String.raw`\documentclass{article}
\usepackage{tikz}
${bounds.includes('custombounds') ? '\\tikzset{custombounds/.style={use as bounding box}}' : ''}
\begin{document}
\begin{tikzpicture}
${bounds} (0,0) rectangle (2,2);
\draw (0,0) rectangle (2,2);
\node[left] at (0,1) {Outside label};
\end{tikzpicture}

The visible label extends beyond the declared box.
\end{document}
` });
  try {
    const { serverPath } = await prepareTestRuntime(root);
    await fixture.start();
    const warm = await requestLayout(fixture);
    assert.equal(warm.compile.state, 'Ok');
    const exported = await exportPdf(fixture, 'bounding-box.pdf');
    assert.equal(exported.status.state, 'Ok');
    assertPdfEqual(serverPath, path.join(fixture.build, 'bg', 'main.pdf'), exported.path!, true);
  } finally { await fixture.close(); }
});
}

test('restoring a preamble input restores its theorem contexts and current macros for live editing', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const fixture = await realEngineFixture({ source: String.raw`\documentclass{article}
\usepackage{amsthm}
\input{definitions}
\begin{document}
\begin{auditlemma}
SOURCE-MARK \auditword.
\end{auditlemma}
\end{document}
` });
  const definitions = path.join(fixture.temporary, 'project', 'definitions.tex');
  const original = '\\newtheorem{auditlemma}{Lemma}\n\\newcommand{\\auditword}{OLD}\n';
  try {
    await fs.writeFile(definitions, original);
    await fixture.start();
    await fixture.editMarker('SOURCE-MARK');
    await fs.rm(definitions);
    await fixture.engine.request({ cmd: 'remove_document', path: 'definitions.tex' });
    assert.notEqual((await requestLayout(fixture)).compile.state, 'Ok');
    const restored = original.replace('{OLD}', '{NEW}');
    await fs.writeFile(definitions, restored);
    const reply = await fixture.engine.request({ cmd: 'set_document', path: 'definitions.tex', text: restored });
    assert.ok(reply.reply === 'set_document' && reply.result.routed === 'preamble');
    assert.equal((await requestLayout(fixture)).compile.state, 'Ok');
    const live = await fixture.editMarker('SOURCE-MARKX');
    assert.ok(glyphText(live.dl).includes('NEW'), 'the restored live server must use the latest preamble definitions');
  } finally { await fixture.close(); }
});

test('warm layouts refresh equal-size PDF replacements with equal or older timestamps, reject deletion and recover', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const fixture = await realEngineFixture('pdf-images.tex');
  try {
    const { serverPath } = await prepareTestRuntime(root);
    const resource = resourceFor(fixture);
    const snapshots = [0, 1].map(slot => path.join(fixture.build, `src-body-${slot}`, 'two-pages.pdf'));
    const original = twoPagePdf();
    await fs.writeFile(resource, original);
    await fixture.start();
    await assert.rejects(fs.stat(path.join(fixture.build, 'src')), { code: 'ENOENT' }, 'warm passes must not copy an unused cold snapshot');
    for (const snapshot of snapshots) assert.equal(await fs.readFile(snapshot, 'utf8'), original,
      'both reusable warm snapshot slots must already contain the old resource');
    const baseline = path.join(fixture.temporary, 'initial-layout.pdf');
    await fs.copyFile(path.join(fixture.build, 'bg', 'main.pdf'), baseline);
    let previous = baseline;
    for (const [older, colors] of [[false, ['0 1 0', '1 0 1']], [true, ['0 1 1', '1 1 0']]] as const) {
      const replacement = twoPagePdf([...colors]);
      for (const snapshot of snapshots) await replaceResource(resource, snapshot, replacement, older);
      const layout = await requestLayout(fixture);
      assert.equal(layout.compile.state, 'Ok', JSON.stringify(layout.compile));
      for (const snapshot of snapshots) assert.equal(await fs.readFile(snapshot, 'utf8'), replacement, 'the copied PDF must match the replacement byte for byte');
      const current = path.join(fixture.temporary, older ? 'older-layout.pdf' : 'equal-layout.pdf');
      await fs.copyFile(path.join(fixture.build, 'bg', 'main.pdf'), current);
      assertPdfEqual(serverPath, previous, current, false);
      previous = current;
    }
    await fs.rm(resource);
    const beforeMissing = fixture.events.length;
    const missing = await requestLayout(fixture);
    assert.notEqual(missing.compile.state, 'Ok', 'a deleted image cannot yield a stale successful layout');
    assert.ok(fixture.events.slice(beforeMissing).some(event => event.event === 'Diagnostics' &&
      event.items.some(item => item.severity === 'error' && item.message.includes('two-pages.pdf'))),
    'the failed layout must report the missing resource, not an unrelated error');
    for (const snapshot of snapshots) await assert.rejects(fs.stat(snapshot), { code: 'ENOENT' });
    await fs.writeFile(resource, original);
    const recovered = await requestLayout(fixture);
    assert.equal(recovered.compile.state, 'Ok', JSON.stringify(recovered.compile));
    for (const snapshot of snapshots) assert.equal(await fs.readFile(snapshot, 'utf8'), original);
    assertPdfEqual(serverPath, baseline, path.join(fixture.build, 'bg', 'main.pdf'), true);
  } finally { await fixture.close(); }
});

test('repeated cold PDF exports synchronize equal-size resource replacements, deletion and recovery', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const fixture = await realEngineFixture('pdf-images.tex');
  try {
    const { serverPath } = await prepareTestRuntime(root);
    const resource = resourceFor(fixture), snapshot = path.join(fixture.build, 'export-src', 'two-pages.pdf');
    const original = twoPagePdf();
    await fs.writeFile(resource, original);
    await fixture.start();
    const initial = await exportPdf(fixture, 'initial-export.pdf');
    assert.equal(initial.status.state, 'Ok', JSON.stringify(initial.status));
    assert.ok(initial.path);
    assert.equal(await fs.readFile(snapshot, 'utf8'), original);
    let previous = initial.path;
    for (const [older, colors] of [[false, ['0 1 0', '1 0 1']], [true, ['0 1 1', '1 1 0']]] as const) {
      const replacement = twoPagePdf([...colors]);
      await replaceResource(resource, snapshot, replacement, older);
      const current = await exportPdf(fixture, older ? 'older-export.pdf' : 'equal-export.pdf');
      assert.equal(current.status.state, 'Ok', JSON.stringify(current.status));
      assert.ok(current.path);
      assert.equal(await fs.readFile(snapshot, 'utf8'), replacement);
      assertPdfEqual(serverPath, previous, current.path, false);
      previous = current.path;
    }
    await fs.rm(resource);
    const missing = await exportPdf(fixture, 'missing-export.pdf');
    assert.notEqual(missing.status.state, 'Ok', 'a deleted image cannot yield a stale successful export');
    await assert.rejects(fs.stat(snapshot), { code: 'ENOENT' });
    await fs.writeFile(resource, original);
    const recovered = await exportPdf(fixture, 'recovered-export.pdf');
    assert.equal(recovered.status.state, 'Ok', JSON.stringify(recovered.status));
    assert.ok(recovered.path);
    assert.equal(await fs.readFile(snapshot, 'utf8'), original);
    assertPdfEqual(serverPath, initial.path, recovered.path, true);
  } finally { await fixture.close(); }
});
