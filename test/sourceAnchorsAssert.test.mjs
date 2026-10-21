import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AnchorAssertionError, assertAnchorExperiment } from '../scripts/source-anchors-assert.mjs';

const main = (line) => ({ file: 'main.tex', line });
const good = () => ({
  rows: { rows: 2, withAnchors: 1, mismatched: 0, unknownTags: [] },
  displayLists: { same: true, pagesOff: 1, pagesOn: 1 },
  markers: { total: 1, decoys: 0, checks: [{ marker: 'MKtest1', expected: main(10), found: true,
    got: { after: main(10), before: main(10), nearest: main(10) } }] },
  live: [{ marker: 'MKlva', expected: 'main.tex:11', routed: 'fast', event: 'ParagraphUpdate', status: 'ok', after: 11 }],
  rebase: { total: 1, rebased: 1 },
  projectFilesUnchanged: true,
});
const failure = (mutate, pattern, policy) => {
  const report = good();
  mutate(report);
  assert.throws(() => assertAnchorExperiment(report, policy), (error) => error instanceof AnchorAssertionError && pattern.test(error.message));
};

test('acceptance checks explicitly measure file and line, not word columns', () => {
  const report = good();
  report.markers.checks[0].expected.column = 100;
  report.markers.checks[0].got.after.column = 0;
  assert.deepEqual(assertAnchorExperiment(report), { precision: 'file:line', markerExceptions: [], liveExceptions: [] });
});

test('row geometry mismatch, missing capture and unresolved file tags fail', () => {
  failure((r) => { r.rows.mismatched = 1; }, /row geometry/);
  failure((r) => { r.rows.rows = 0; }, /no valid rows/);
  failure((r) => { r.rows.unknownTags = [10]; }, /source-file tags.*10/);
  failure((r) => { delete r.rows; }, /no valid rows/);
});

test('off/on drawing differences and incomplete page comparisons fail', () => {
  failure((r) => { r.displayLists.same = false; }, /display lists differ/);
  failure((r) => { r.displayLists.pagesOn = 2; }, /display lists differ/);
  failure((r) => { r.displayLists.pagesOn = r.displayLists.pagesOff = 0; }, /display lists differ/);
});

test('a missing output marker cannot pass by lowering the score denominator', () => {
  failure((r) => { r.markers.checks[0].found = false; }, /missing from output/);
  failure((r) => { r.markers.checks = []; }, /every source marker/);
  failure((r) => { r.markers.total = 0; r.markers.checks = []; }, /missing or empty/);
});

test('comment decoys and duplicate source-marker identities fail', () => {
  failure((r) => { r.markers.decoys = 1; }, /comment markers/);
  failure((r) => { r.markers.checks.push(structuredClone(r.markers.checks[0])); r.markers.total++; }, /duplicate source marker/);
});

test('the same correct aggregate score cannot hide a newly wrong marker', () => {
  failure((r) => { r.markers.score = { after: 1 }; r.markers.checks[0].got.after = main(20); }, /MKtest1\/after: expected main.tex:10, got main.tex:20/);
});

test('correct line in the wrong file is a failure', () => {
  failure((r) => { r.markers.checks[0].got.after.file = 'chapter.tex'; }, /got chapter.tex:10/);
});

test('known limitations require exact marker, rule, expected point and actual point', () => {
  const report = good();
  report.markers.checks[0].got.before = main(12);
  const exception = { marker: 'MKtest1', rule: 'before', expected: main(10), actual: main(12), reason: 'Synthetic display row uses the environment end line.' };
  const policy = { markerRules: ['after', 'before', 'nearest'], markerExceptions: [exception] };
  assert.deepEqual(assertAnchorExperiment(report, policy).markerExceptions, ['MKtest1/before']);
  for (const change of [
    (e) => { e.marker = 'MKother1'; },
    (e) => { e.rule = 'after'; },
    (e) => { e.expected.line = 9; },
    (e) => { e.actual.line = 13; },
    (e) => { e.actual.file = 'chapter.tex'; },
    (e) => { e.reason = ''; },
  ]) {
    const changed = structuredClone(policy);
    change(changed.markerExceptions[0]);
    assert.throws(() => assertAnchorExperiment(report, changed), AnchorAssertionError);
  }
});

test('a known limitation becoming exact is accepted as an improvement', () => {
  assert.doesNotThrow(() => assertAnchorExperiment(good(), { markerExceptions: [
    { marker: 'MKtest1', rule: 'after', expected: main(10), actual: main(12), reason: 'Previously measured limitation.' },
  ] }));
});

test('empty, misspelled, repeated and malformed rule policies cannot disable accuracy checks', () => {
  for (const name of ['markerRules', 'liveRules']) for (const rules of [[], ['afetr'], ['after', 'after'], 'after', null]) {
    assert.throws(() => assertAnchorExperiment(good(), { [name]: rules }), (error) =>
      error instanceof AnchorAssertionError && /must contain unique known rules/.test(error.message));
  }
});

test('fixture policy marker lists require valid unique identities and source points', () => {
  for (const name of ['expectedMarkers', 'expectedLiveMarkers']) for (const identities of [null, 'MKtest1', ['', 'MKlva'], ['MKlva', 'MKlva'], [null]]) {
    assert.throws(() => assertAnchorExperiment(good(), { [name]: identities }), AnchorAssertionError);
  }
  assert.throws(() => assertAnchorExperiment(good(), { expectedMarkers: [{ marker: 'MKtest1', file: 'main.tex', line: 0 }] }), /valid source file:line/);
  assert.throws(() => assertAnchorExperiment(good(), { expectedLiveMarkers: [{ marker: 'MKlva' }] }), /must contain marker names/);
});

test('exception policy must state its exact identity, result and reason', () => {
  for (const kind of ['markerExceptions', 'liveExceptions']) for (const exceptions of [null, {}, [null], [{ marker: 'MKtest1', rule: 'after' }]]) {
    assert.throws(() => assertAnchorExperiment(good(), { [kind]: exceptions }), AnchorAssertionError);
  }
});

test('fixture policy detects removed, unreviewed and moved source markers', () => {
  failure(() => {}, /fixture marker MKother1 was removed/, { expectedMarkers: ['MKtest1', 'MKother1'] });
  failure(() => {}, /has no expected result/, { expectedMarkers: [] });
  failure(() => {}, /source changed/, { expectedMarkers: [{ marker: 'MKtest1', ...main(9) }] });
  assert.doesNotThrow(() => assertAnchorExperiment(good(), { expectedMarkers: [{ marker: 'MKtest1', ...main(10) }] }));
});

test('missing, errored, background-routed and unmatched live results fail', () => {
  failure((r) => { delete r.live; }, /live-result report is missing/, { expectedLiveMarkers: ['MKlva'] });
  failure((r) => { r.live = []; }, /live result for MKlva is missing/, { expectedLiveMarkers: ['MKlva'] });
  failure((r) => { r.live[0].status = 'error'; }, /successful ParagraphUpdate/);
  failure((r) => { r.live[0].routed = 'background'; }, /successful ParagraphUpdate/);
  failure((r) => { r.live[0].event = 'BackgroundScheduled'; }, /successful ParagraphUpdate/);
  failure((r) => { r.live[0].missing = 'no sidecar'; }, /successful ParagraphUpdate/);
  failure((r) => { delete r.live[0].status; }, /successful ParagraphUpdate/);
});

test('a matched live result still fails for the wrong source position', () => {
  failure((r) => { r.live[0].after = 10; }, /live MKlva\/after: expected main.tex:11, got main.tex:10/);
  failure((r) => { r.live[0].after = 'chapter.tex:11'; }, /got chapter.tex:11/);
  failure((r) => { delete r.live[0].after; }, /missing\/invalid file:line/);
});

test('live known limitation is scoped to its marker and rule', () => {
  const report = good();
  report.live[0].before = 10;
  const policy = { liveRules: ['after', 'before'], liveExceptions: [
    { marker: 'MKlva', rule: 'before', expected: main(11), actual: main(10), reason: 'Glue before a newly inserted source line.' },
  ] };
  assert.deepEqual(assertAnchorExperiment(report, policy).liveExceptions, ['MKlva/before']);
  report.live[0].before = 9;
  assert.throws(() => assertAnchorExperiment(report, policy), AnchorAssertionError);
});

test('empty or inaccurate rebasing and lost rebasing cases fail', () => {
  failure((r) => { r.rebase.rebased = 0; }, /source-line rebasing/);
  failure((r) => { r.rebase.total = r.rebase.rebased = 0; }, /source-line rebasing/);
  failure((r) => { delete r.rebase; }, /source-line rebasing/, { expectedRebaseCount: 1 });
  failure(() => {}, /expected 2 rebasing checks/, { expectedRebaseCount: 2 });
});

test('changed project files or omitted preservation checks fail', () => {
  failure((r) => { r.projectFilesUnchanged = false; }, /project source files changed/);
  failure((r) => { delete r.projectFilesUnchanged; }, /preservation was not checked/);
});

test('an acceptance failure produces a nonzero process exit', () => {
  const helper = fileURLToPath(new URL('../scripts/source-anchors-assert.mjs', import.meta.url));
  const report = good();
  report.rows.unknownTags = [10];
  const run = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { assertAnchorExperiment } from ${JSON.stringify(helper)}; assertAnchorExperiment(${JSON.stringify(report)});`], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /AnchorAssertionError.*|Source-anchor acceptance failed/);
});
