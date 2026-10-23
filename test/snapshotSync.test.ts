import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { realEngineFixture, realEngineUnavailable } from './realEngineFixture';
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

function assertPdfEqual(executable: string, first: string, second: string, equal: boolean): void {
  const comparison = spawnSync(executable, ['pdf-compare', first, second], { encoding: 'utf8', timeout: 10000 });
  assert.equal(comparison.error, undefined);
  assert.equal(comparison.status, equal ? 0 : 1, comparison.stderr);
  assert.equal(JSON.parse(comparison.stdout).equal, equal, 'compare rendered PDF contents, ignoring dates and object IDs');
}

test('warm layouts refresh equal-size PDF replacements with equal or older timestamps, reject deletion and recover', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const fixture = await realEngineFixture('pdf-images.tex');
  try {
    const { serverPath } = await prepareTestRuntime(root);
    const resource = resourceFor(fixture), snapshot = path.join(fixture.build, 'src', 'two-pages.pdf');
    const original = twoPagePdf();
    await fs.writeFile(resource, original);
    await fixture.start();
    assert.equal(await fs.readFile(snapshot, 'utf8'), original, 'the initial session must capture the current resource');
    for (const slot of [0, 1]) assert.equal(await fs.readFile(path.join(fixture.build, `src-body-${slot}`, 'two-pages.pdf'), 'utf8'),
      original, 'both reusable warm snapshot slots must already contain the old resource');
    const baseline = path.join(fixture.temporary, 'initial-layout.pdf');
    await fs.copyFile(path.join(fixture.build, 'bg', 'main.pdf'), baseline);
    let previous = baseline;
    for (const [older, colors] of [[false, ['0 1 0', '1 0 1']], [true, ['0 1 1', '1 1 0']]] as const) {
      const replacement = twoPagePdf([...colors]);
      await replaceResource(resource, snapshot, replacement, older);
      const layout = await requestLayout(fixture);
      assert.equal(layout.compile.state, 'Ok', JSON.stringify(layout.compile));
      assert.equal(await fs.readFile(snapshot, 'utf8'), replacement, 'the copied PDF must match the replacement byte for byte');
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
    await assert.rejects(fs.stat(snapshot), { code: 'ENOENT' });
    await fs.writeFile(resource, original);
    const recovered = await requestLayout(fixture);
    assert.equal(recovered.compile.state, 'Ok', JSON.stringify(recovered.compile));
    assert.equal(await fs.readFile(snapshot, 'utf8'), original);
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
