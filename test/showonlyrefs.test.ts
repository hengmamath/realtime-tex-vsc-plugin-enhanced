import assert from 'node:assert/strict';
import { test } from 'node:test';
import { glyphText, realEngineFixture, realEngineUnavailable } from './realEngineFixture';

// Exercise the packaged pair with RTEX_TEST_BUNDLED=1 and a compatible LuaLaTeX. The fixture's
// \fixtureprobe needs probe verification rather than the allow-list.
test('showonlyrefs keeps proof edits live and removes equation tags after references disappear', {
  skip: realEngineUnavailable,
  timeout: 90000,
}, async (t) => {
  const f = await realEngineFixture('showonlyrefs.tex');
  try {
    await f.start();
    const first = await f.editMarker('MARKER', 'X');
    assert.ok(glyphText(first.dl).includes('MARKERX'), 'the update must contain the edited proof text');
    t.diagnostic(`proof live update: ${(first.timing.total_us / 1000).toFixed(1)} ms`);
    assert.ok(glyphText(first.dl).includes('(1)'), 'the referenced first equation must have its real tag');
    assert.ok(!glyphText(first.dl).includes('(2)'), 'the unreferenced second equation must have no tag');

    // Remove only the outside reference through the same unsaved-buffer edit protocol used
    // by VS Code. Convergence must finish before the next proof probe, so it compares against
    // a background layout in which showonlyrefs has actually removed the old equation tag.
    const reference = String.raw`\eqref{eq:used}`;
    const at = f.source.indexOf(reference);
    assert.ok(at >= 0);
    const removal = await f.edit(at, at + reference.length, 'the identity');
    await f.layout(removal.source_revision);
    const second = await f.editMarker('MARKERX', 'Y');
    assert.ok(glyphText(second.dl).includes('MARKERXY'), 'the update must contain the edited proof text');
    t.diagnostic(`proof live update: ${(second.timing.total_us / 1000).toFixed(1)} ms`);
    assert.equal(second.versions.engine_generation, first.versions.engine_generation,
      'reference removal must refresh the existing live engine without restarting it');
    assert.ok(!glyphText(second.dl).includes('(1)'), 'the removed reference must not leave a stale first-equation tag');
    assert.ok(!glyphText(second.dl).includes('(2)'), 'the second equation must remain unnumbered');
  } finally {
    await f.close();
  }
});
