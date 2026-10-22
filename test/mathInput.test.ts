import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EditResult, ParagraphUpdateEvent, RtexEvent } from '../src/protocol';
import { realEngineFixture, realEngineUnavailable } from './realEngineFixture';

type Fixture = Awaited<ReturnType<typeof realEngineFixture>>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Type `text` one character at a time after `marker`, as an editor sends it. */
async function type(f: Fixture, marker: string, text: string): Promise<EditResult[]> {
  let at = f.source.indexOf(marker);
  assert.ok(at >= 0, `missing ${marker}`);
  at += marker.length;
  const results: EditResult[] = [];
  for (const c of text) {
    results.push(await f.edit(at, at, c));
    at += Buffer.byteLength(c);
  }
  return results;
}

async function update(f: Fixture, after: number, editId: number): Promise<ParagraphUpdateEvent> {
  for (const t0 = Date.now(); Date.now() - t0 < 30000;) {
    const hit = f.events.slice(after).find((e) => e.event === 'ParagraphUpdate' && e.edit_id === editId);
    if (hit) return hit as ParagraphUpdateEvent;
    await sleep(10);
  }
  throw new Error(`no live update for edit ${editId}`);
}

const layoutsAfter = (f: Fixture, after: number) => f.events.slice(after).filter((e) => e.event === 'LayoutUpdate');
const restartsAfter = (f: Fixture, after: number) => f.events.slice(after).filter((e) =>
  e.event === 'EngineState' && e.state !== 'Ready');

test('typing a formula key by key starts no full compile, and closing it is live at once', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const f = await realEngineFixture('math-input.tex');
  try {
    await f.start();
    const after = f.events.length;
    const typed = await type(f, 'INLINE-MARK', ' $x+y$');
    // an unclosed `$` is a structure being typed: refused, without asking for a pass
    for (const r of typed.slice(1, -1)) assert.deepEqual([r.routed, r.reasons], ['background', ['UnbalancedMath']]);
    const closing = typed.at(-1)!;
    assert.equal(closing.routed, 'fast', closing.reasons.join(', '));
    const live = await update(f, after, closing.edit_id);
    assert.equal(live.status, 'ok');
    assert.equal(live.pass_pending, false, 'nothing should be left to compile');
    // well past the settle time: the formula was completed live, so no pass ran
    await sleep(3000);
    assert.deepEqual(layoutsAfter(f, after).map((e) => e.event), []);
    assert.deepEqual(restartsAfter(f, after), []);
  } finally {
    await f.close();
  }
});

test('known incomplete math inside preclosed delimiters keeps the last good rows until completion', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const f = await realEngineFixture('math-typing-intermediates.tex');
  try {
    await f.start();
    const after = f.events.length;
    const scenarios = [
      { marker: 'FENCE-MARK', incomplete: '+\\left( u', suffix: ' \\right)' },
      { marker: 'FRAC-MARK', incomplete: '+\\frac{u}', suffix: '{v}' },
      { marker: 'ROOT-MARK', incomplete: '+\\sqrt', suffix: '{w}' },
      { marker: 'SCRIPT-MARK', incomplete: '+k^', suffix: '2' },
      { marker: 'SCRIPT-MARK', incomplete: '+m_', suffix: '3' },
    ];
    for (const { marker, incomplete, suffix } of scenarios) {
      const lastGood = await f.editMarker(marker);
      const opening = f.source.indexOf('$', f.source.indexOf(marker));
      let at = f.source.indexOf('$', opening + 1);
      assert.ok(opening >= 0 && at > opening, `missing preclosed math at ${marker}`);
      const start = f.events.length;
      const refused = await f.edit(at, at, incomplete);
      assert.equal(refused.routed, 'background', `${incomplete}: ${refused.reasons.join(', ')}`);
      assert.ok(refused.reasons.includes('IncompleteMath'), `${incomplete}: ${refused.reasons.join(', ')}`);
      at += incomplete.length;
      await sleep(70);
      assert.ok(!f.events.slice(start).some((event) => event.event === 'ParagraphUpdate' && event.par_id === lastGood.par_id),
        `${incomplete}: incomplete input must leave the paragraph's last good rows in place`);

      const sent: Promise<EditResult>[] = [];
      // The editor does not wait for each engine acknowledgment before accepting another key.
      // A control-word completion is one editor change; its ambiguous prefixes are tested below.
      for (const fragment of marker === 'FENCE-MARK' ? [suffix] : [...suffix]) {
        sent.push(f.edit(at, at, fragment));
        at += fragment.length;
        await sleep(70);
      }
      const final = (await Promise.all(sent)).at(-1)!;
      assert.equal(final.routed, 'fast', `${marker}: ${final.reasons.join(', ')}`);
      const completed = await update(f, start, final.edit_id);
      assert.equal(completed.status, 'ok', `${marker}: ${completed.diagnostics.map((d) => d.message).join(', ')}`);
      assert.equal(completed.diagnostics.length, 0);
      assert.equal(completed.par_id, lastGood.par_id, 'typing must keep the paragraph identity');
      assert.ok(!f.events.slice(start).some((event) => event.event === 'ParagraphUpdate' && event.status === 'error'),
        `${marker}: a known incomplete structure must never be sent to live TeX`);
    }
    await sleep(2300);
    assert.equal(layoutsAfter(f, after).length, 0, 'completion must cancel the deferred unfinished-input compile');
    assert.equal(restartsAfter(f, after).length, 0, 'ordinary math typing must not restart the engine');
  } finally {
    await f.close();
  }
});

test('literal command typing at editor cadence recovers live after ambiguous control-word prefixes', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const f = await realEngineFixture('math-typing-intermediates.tex');
  try {
    await f.start();
    const after = f.events.length;
    for (const { marker, text } of [
      { marker: 'FENCE-MARK', text: '+\\left( u \\right)' },
      { marker: 'FRAC-MARK', text: '+\\frac{u}{v}' },
    ]) {
      const opening = f.source.indexOf('$', f.source.indexOf(marker));
      let at = f.source.indexOf('$', opening + 1);
      const start = f.events.length;
      const sent: Promise<EditResult>[] = [];
      for (const character of text) {
        sent.push(f.edit(at, at, character));
        at += character.length;
        await sleep(70);
      }
      const final = (await Promise.all(sent)).at(-1)!;
      assert.equal(final.routed, 'fast', final.reasons.join(', '));
      const completed = await update(f, start, final.edit_id);
      assert.equal(completed.status, 'ok');
      assert.equal(completed.diagnostics.length, 0,
        'valid completion must clear any TeX error from an ambiguous prefix such as \\lef or \\fra');
    }
    assert.equal(restartsAfter(f, after).length, 0);
  } finally {
    await f.close();
  }
});

test('unused arguments of a declared macro do not turn complete math into unfinished input', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const f = await realEngineFixture('math-typing-intermediates.tex');
  try {
    await f.start();
    const after = f.events.length;
    for (const ignored of ['\\frac', 'x^', '\\left']) {
      const opening = f.source.indexOf('$', f.source.indexOf('FENCE-MARK'));
      const at = f.source.indexOf('$', opening + 1);
      const live = await f.editLive(at, at, '\\ignore{' + ignored + '}', 'ignored macro argument ' + ignored);
      assert.equal(live.diagnostics.length, 0);
    }
    await sleep(2300);
    assert.equal(layoutsAfter(f, after).length, 0, 'unused macro arguments must not schedule an unfinished-input pass');
    assert.equal(restartsAfter(f, after).length, 0);
  } finally {
    await f.close();
  }
});

test('a formula left unfinished is compiled and reported, and its fix clears the error', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const f = await realEngineFixture('math-input.tex');
  try {
    await f.start();
    const after = f.events.length;
    await type(f, 'INLINE-MARK', ' $z');
    // the writer stopped: after the settle time the pass shows and reports the real state
    for (const t0 = Date.now(); !layoutsAfter(f, after).length; await sleep(50)) {
      if (Date.now() - t0 > 30000) throw new Error('the unfinished formula was never compiled');
    }
    const first = layoutsAfter(f, after)[0];
    assert.ok(first.event === 'LayoutUpdate' && first.compile.state === 'CompiledWithErrors', JSON.stringify(first.event === 'LayoutUpdate' && first.compile));
    // closing it is typeset live, and a pass then refreshes the layout and its diagnostics
    const next = f.events.length;
    const [closing] = await type(f, ' $z', '$');
    assert.equal(closing.routed, 'fast', closing.reasons.join(', '));
    assert.equal((await update(f, next, closing.edit_id)).status, 'ok');
    for (const t0 = Date.now(); ; await sleep(50)) {
      const clean = layoutsAfter(f, next).find((e) => e.event === 'LayoutUpdate' && e.compile.state === 'Ok');
      if (clean) break;
      if (Date.now() - t0 > 30000) throw new Error('the fixed formula never cleared the layout errors');
    }
  } finally {
    await f.close();
  }
});

test('a clean live result after a full compile that failed asks for a new one', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const f = await realEngineFixture('math-input.tex');
  try {
    await f.start();
    const after = f.events.length;
    // \textbf{ left open swallows the rest of the file: the settle pass fails or errs
    await type(f, 'INLINE-MARK', ' \\textbf{abc');
    for (const t0 = Date.now(); !layoutsAfter(f, after).length; await sleep(50)) {
      if (Date.now() - t0 > 30000) throw new Error('the open argument was never compiled');
    }
    const broken = layoutsAfter(f, after)[0];
    assert.ok(broken.event === 'LayoutUpdate' && broken.compile.state !== 'Ok', JSON.stringify(broken.event === 'LayoutUpdate' && broken.compile));
    const next = f.events.length;
    const [closing] = await type(f, ' \\textbf{abc', '}');
    assert.equal(closing.routed, 'fast', closing.reasons.join(', '));
    for (const t0 = Date.now(); ; await sleep(50)) {
      if (layoutsAfter(f, next).some((e) => e.event === 'LayoutUpdate' && e.compile.state === 'Ok')) break;
      if (Date.now() - t0 > 30000) throw new Error('fixing the argument never brought a clean full compile');
    }
  } finally {
    await f.close();
  }
});

test('a part the scan always refuses keeps the usual full-compile timing', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const f = await realEngineFixture('math-input.tex');
  try {
    await f.start();
    const after = f.events.length;
    // `\tag{$*$}` is valid TeX the scan refuses: an edit there is not a structure being typed
    const t0 = Date.now();
    const [edit] = await type(f, 'a=b', 'c');
    assert.equal(edit.routed, 'background');
    for (; !layoutsAfter(f, after).length; await sleep(20)) {
      if (Date.now() - t0 > 30000) throw new Error('no full compile');
    }
    // the scheduling delay, without the pass itself: about the 300 ms debounce, not the 2 s
    // settle time of a structure being typed
    const layout = layoutsAfter(f, after)[0];
    const delay = Date.now() - t0 - (layout.event === 'LayoutUpdate' ? layout.wall_ms : 0);
    assert.ok(delay < 1500, `the pass started ${delay} ms after the edit, as if the tag were being typed`);
  } finally {
    await f.close();
  }
});

test('blank lines between paragraphs: one more or less compiles nothing, the one after a list does', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const f = await realEngineFixture('math-input.tex');
  try {
    await f.start();
    // one of two blank lines: TeX typesets the same, nothing to compile
    const extra = f.source.indexOf('with two blank lines after it.\n') + 'with two blank lines after it.\n'.length;
    const same = await f.edit(extra, extra + 1, '');
    assert.equal(same.routed, 'fast');
    assert.deepEqual(same.outcome, { touched: [], added: [], removed: [], preamble_changed: false });
    // the blank line after a list decides whether the text after it starts a paragraph
    const after = f.events.length;
    const listEnd = f.source.indexOf('\\end{itemize}\n') + '\\end{itemize}\n'.length;
    const joined = await f.edit(listEnd, listEnd + 1, '');
    assert.equal(joined.routed, 'background', joined.reasons.join(', '));
    for (const t0 = Date.now(); !layoutsAfter(f, after).length; await sleep(50)) {
      if (Date.now() - t0 > 30000) throw new Error('removing the blank line after a list was never compiled');
    }
  } finally {
    await f.close();
  }
});

test('a mismatched pair while converting inline math to a display does not restart the engine', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const f = await realEngineFixture('math-input.tex');
  try {
    const initial = await f.start();
    const generation = initial.versions.engine_generation;
    const after = f.events.length;
    // `$p+q$` → `\[p+q$` (with amsmath, TeX's recovery from this pair left the server's
    // grouping out of step) → `\[p+q\]`
    let at = f.source.indexOf('$p+q$');
    await f.edit(at, at + 1, '');
    const opened = await type(f, 'holds ', '\\[');
    assert.deepEqual(opened.at(-1)!.reasons, ['UnbalancedMath']);
    at = f.source.indexOf('\\[p+q$') + '\\[p+q'.length;
    await f.edit(at, at + 1, '');
    const closed = await type(f, '\\[p+q', '\\]');
    const closing = closed.at(-1)!;
    assert.equal(closing.routed, 'fast', closing.reasons.join(', '));
    assert.equal((await update(f, after, closing.edit_id)).status, 'ok');
    assert.deepEqual(restartsAfter(f, after), []);
    assert.ok(!f.events.slice(after).some((e) => e.event === 'EngineState' && e.engine_generation !== generation));
  } finally {
    await f.close();
  }
});

test('an environment typed before its \\end keeps the paragraphs after it, and a deleted paragraph is removed', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const f = await realEngineFixture('math-input.tex');
  try {
    await f.start();
    const after = f.events.length;
    const typed = await type(f, 'EQUATION-MARK', '\n\\begin{equation}\nE=mc^2\n\\end{equation}');
    const removed = (from: number) => f.events.slice(from).filter((e: RtexEvent) =>
      e.event === 'ParagraphUpdate' && e.status === 'removed');
    assert.deepEqual(removed(after), [], 'no paragraph after the unfinished environment may be dropped');
    assert.ok(typed.every((r) => r.outcome.added.length === 0 && r.outcome.removed.length === 0));
    const closing = typed.at(-1)!;
    assert.equal(closing.routed, 'fast', closing.reasons.join(', '));
    assert.equal((await update(f, after, closing.edit_id)).status, 'ok');
    // deleting a whole paragraph announces its removal (hosts hide its rows at once)
    const next = f.events.length;
    const start = f.source.indexOf('\n\nA final paragraph REMOVE-MARK');
    const end = f.source.indexOf('as a whole.') + 'as a whole.'.length;
    const result = await f.edit(start, end, '');
    assert.equal(result.outcome.removed.length, 1);
    for (const t0 = Date.now(); removed(next).length === 0 && Date.now() - t0 < 5000;) await sleep(10);
    assert.deepEqual(removed(next).map((e) => e.event === 'ParagraphUpdate' && e.par_id), result.outcome.removed);
    assert.deepEqual(restartsAfter(f, after), []);
  } finally {
    await f.close();
  }
});
