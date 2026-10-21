import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RtexEvent } from '../src/protocol';
import { realEngineFixture, realEngineUnavailable } from './realEngineFixture';

type Fixture = Awaited<ReturnType<typeof realEngineFixture>>;

async function eventAfter(f: Fixture, after: number, matches: (event: RtexEvent) => boolean, what: string): Promise<RtexEvent> {
  for (const t0 = Date.now(); Date.now() - t0 < 30000;) {
    const hit = f.events.slice(after).find(matches);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('math ending inside \\left reports a live error and keeps the engine and the paragraph live', { skip: realEngineUnavailable }, async () => {
  const f = await realEngineFixture('live-recovery.tex');
  try {
    await f.start();
    await f.editMarker('RECOVERY-MARK');

    // typed on the way to \left( a \right): LuaTeX's own recovery loops until it gives up
    const at = f.source.indexOf('RECOVERY-MARKX') + 'RECOVERY-MARKX'.length;
    const after = f.events.length;
    const result = await f.edit(at, at, ' $\\left( a$');
    assert.equal(result.routed, 'fast', result.reasons.join(', '));
    const update = await eventAfter(f, after, (event) =>
      (event.event === 'ParagraphUpdate' || event.event === 'BackgroundScheduled') && event.edit_id === result.edit_id, 'the live result');
    assert.equal(update.event, 'ParagraphUpdate', JSON.stringify(update).slice(0, 400));
    if (update.event !== 'ParagraphUpdate') return;
    assert.equal(update.status, 'error');
    assert.ok(update.diagnostics.length >= 1 && update.diagnostics.length < 5, JSON.stringify(update.diagnostics));
    assert.ok(!f.events.slice(after).some((event) => event.event === 'EngineState' && event.state !== 'Ready'),
      'the live server must survive the error');

    // completing the formula is typeset live again: the paragraph was not quarantined
    const close = f.source.indexOf('\\left( a$') + '\\left( a'.length;
    const completed = await f.editLive(close, close, ' \\right)', 'completed formula');
    assert.equal(completed.diagnostics.length, 0);
    assert.ok(!f.events.slice(after).some((event) => event.event === 'EngineState' && event.state !== 'Ready'));
  } finally {
    await f.close();
  }
});
