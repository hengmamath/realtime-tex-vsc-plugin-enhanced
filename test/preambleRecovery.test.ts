import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import type { LayoutUpdateEvent, RtexEvent } from '../src/protocol';
import { glyphText, realEngineFixture, realEngineUnavailable } from './realEngineFixture';

type Fixture = Awaited<ReturnType<typeof realEngineFixture>>;

async function nextLayout(f: Fixture, after: number, revision: number): Promise<LayoutUpdateEvent> {
  for (const t0 = Date.now(); Date.now() - t0 < 30000;) {
    const hit = f.events.slice(after).find((event): event is LayoutUpdateEvent =>
      event.event === 'LayoutUpdate' && (event.source_revision ?? event.versions.source_revision) >= revision);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for the full compile of revision ${revision}`);
}

const errors = (events: RtexEvent[]) => events.filter((event) => event.event === 'Diagnostics' &&
  event.source === 'background' && event.items.some((diagnostic) => diagnostic.severity === 'error'));

test('a warm preamble failure retains the previous pages and recovers automatically to the latest body', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const f = await realEngineFixture('preamble-recovery.tex');
  try {
    await f.start();
    const good = await f.editMarker('PREAMBLEMARK');
    await f.layout(good.versions.source_revision);
    const after = f.events.length;
    const stopAt = f.source.indexOf('\\begin{document}');
    const broken = await f.edit(stopAt, stopAt, '\\stop\n');
    const failed = await nextLayout(f, after, broken.source_revision);
    assert.equal(failed.compile.state, 'Failed', 'a stopped preamble must not report old captured pages as a successful new compile');
    assert.equal(failed.pages_total, 0, 'the failed pass itself produced no pages; the host retains the previous layout');
    assert.deepEqual(failed.pages_changed, [], 'a failed pass must not publish stale captured pages as newly compiled ink');
    assert.deepEqual(failed.placements, [], 'a failed pass must not claim old source placements belong to the failed revision');
    assert.ok(errors(f.events.slice(after)).length, 'the failed preamble must produce a background error diagnostic');

    const editing = f.events.length;
    const bodyAt = f.source.indexOf('HEALTHYMARK') + 'HEALTHYMARK'.length;
    const changed = await f.edit(bodyAt, bodyAt, 'LATESTBODY');
    assert.equal(changed.routed, 'background', 'a body edit cannot use the previous preamble context');
    assert.ok(changed.reasons.some((reason) => reason.includes('preamble context is not ready')), changed.reasons.join(', '));
    const stillFailed = await nextLayout(f, editing, changed.source_revision);
    assert.equal(stillFailed.compile.state, 'Failed', 'editing the body must not hide the broken preamble');
    assert.deepEqual(stillFailed.pages_changed, []);
    assert.ok(!f.events.slice(after).some((event) => event.event === 'LayoutUpdate' && event.compile.state === 'Ok'),
      'no full compile is successful while the preamble still stops the document');

    const fixing = f.events.length;
    const fixed = await f.edit(stopAt, stopAt + '\\stop\n'.length, '');
    const repaired = await nextLayout(f, fixing, fixed.source_revision);
    assert.equal(repaired.compile.state, 'Ok', JSON.stringify(repaired.compile));
    assert.ok(repaired.pages_changed.some((page) => glyphText(page.dl).replace(/\s/g, '').includes('HEALTHYMARKLATESTBODY')),
      'automatic recovery must render the body edit made while the preamble was broken');
    assert.notEqual(repaired.convergence.state, 'Stale');
    // A current clean layout clears the host's previous background diagnostics;
    // the protocol does not send a separate empty Diagnostics event for this.
    assert.equal(errors(f.events.slice(fixing)).length, 0, 'the repaired preamble has no background errors');
    await f.editMarker('PREAMBLEMARKX', 'RECOVERED');
  } finally {
    await f.close();
  }
});

test('a real preamble error replaces the previous log and clears automatically after repair', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const f = await realEngineFixture('preamble-recovery.tex');
  try {
    await f.start();
    const failure = '\\errmessage{SYNTHETIC PREAMBLE FAILURE}\\stop\n';
    const at = f.source.indexOf('\\begin{document}');
    const after = f.events.length;
    const broken = await f.edit(at, at, failure);
    const failed = await nextLayout(f, after, broken.source_revision);
    assert.equal(failed.compile.state, 'Failed');
    assert.equal(failed.pages_total, 0);
    assert.deepEqual(failed.pages_changed, []);
    assert.ok(f.events.slice(after).some((event) => event.event === 'Diagnostics' &&
      event.source === 'background' && event.items.some((diagnostic) =>
        diagnostic.severity === 'error' && diagnostic.message.includes('SYNTHETIC PREAMBLE FAILURE'))),
      'the actual preamble error is reported');
    assert.match(await fs.readFile(path.join(f.build, 'bg', 'main.log'), 'utf8'), /SYNTHETIC PREAMBLE FAILURE/,
      'Open LaTeX Log must show this failed pass rather than the previous successful log');

    const fixing = f.events.length;
    const fixed = await f.edit(at, at + failure.length, '');
    const repaired = await nextLayout(f, fixing, fixed.source_revision);
    assert.equal(repaired.compile.state, 'Ok');
    assert.notEqual(repaired.convergence.state, 'Stale');
    assert.equal(errors(f.events.slice(fixing)).length, 0);
    assert.doesNotMatch(await fs.readFile(path.join(f.build, 'bg', 'main.log'), 'utf8'), /SYNTHETIC PREAMBLE FAILURE/);
    await f.editMarker('PREAMBLEMARK', 'AFTERERROR');
  } finally {
    await f.close();
  }
});
