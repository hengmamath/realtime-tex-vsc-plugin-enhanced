import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { DisplayList, Line, ParagraphUpdateEvent } from '../src/protocol';
import { glyphText, realEngineFixture, realEngineUnavailable } from './realEngineFixture';

type Fixture = Awaited<ReturnType<typeof realEngineFixture>>;
test('capture only normalizes an exhausted, recognized kernel run-in state', {
  skip: realEngineUnavailable,
}, () => {
  const run = spawnSync(path.join(process.env.RTEX_TEST_TEXLIVE_BIN ?? '', 'texlua'), ['tex/tests/run.lua'], {
    cwd: path.resolve(__dirname, '../../vendor/engine'), encoding: 'utf8', timeout: 30000,
  });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
const compact = (text: string) => text.replace(/[\s-]/g, '');
const rowText = (line: Line) => line.items.filter((item) => item[0] === 'g')
  .map((item) => String.fromCodePoint(item[2] as number)).join('');

function inkRows(dl: DisplayList, lines: Line[]) {
  const origin = lines[0];
  assert.ok(origin, 'the paragraph must contain visible lines');
  return lines.map((line) => ({
    x: line.x - origin.x, y: line.y - origin.y, w: line.w, h: line.h, d: line.d,
    glyphs: line.items.filter((item) => item[0] === 'g').map((item) => {
      const font = dl.fonts[String(item[1])];
      return [[font.filename ?? font.psname ?? font.name, font.subfont, font.size,
        font.slant, font.extend, font.squeeze], item[2], item[3], Number(item[4]) - origin.x,
        Number(item[5]) - origin.y, item[6], item[7]];
    }),
  }));
}

async function assertLive(f: Fixture, update: ParagraphUpdateEvent, retained: string[]) {
  const text = compact(glyphText(update.dl));
  for (const marker of retained) assert.ok(text.includes(compact(marker)), `live paragraph lost ${marker}: ${text}`);
  assert.deepEqual(update.diagnostics, []);
  assert.equal(update.context_stale, false);
  const latest = await f.layout(update.versions.source_revision);
  const pages = new Map<number, DisplayList>();
  for (const event of f.events) {
    if (event.event !== 'LayoutUpdate') continue;
    for (const page of event.pages_changed) pages.set(page.page, page.dl);
    if (event === latest) break;
  }
  const first = rowText(update.dl.lines[0]);
  const page = [...pages.values()].find((dl) => dl.lines.some((line) => rowText(line) === first));
  assert.ok(page, 'the full layout must contain the live paragraph');
  const start = page.lines.findIndex((line) => rowText(line) === first);
  assert.deepEqual(inkRows(update.dl, update.dl.lines),
    inkRows(page, page.lines.slice(start, start + update.dl.lines.length)),
    'live line boxes and glyph positions must match the full layout exactly');
  assert.deepEqual(f.events.slice(f.events.indexOf(update)).flatMap((event) =>
    event.event === 'Diagnostics' ? event.items : []), [], 'the edited paragraph must compile without diagnostics');
}

async function appendMarker(f: Fixture, marker: string) {
  const at = f.source.indexOf(marker);
  assert.ok(at >= 0, `missing source marker ${marker}`);
  return f.editLive(at + marker.length, at + marker.length, 'X', marker);
}

test('ordinary amsart prose remains live with exact full-layout fidelity', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const f = await realEngineFixture('run-in-live.tex');
  try {
    const initial = await f.start();
    const update = await appendMarker(f, 'PLAINCONTROL');
    assert.equal(update.versions.engine_generation, initial.versions.engine_generation);
    await assertLive(f, update, ['PLAINCONTROLX has an ordinary paragraph with a+b=c. ' +
      'PLAINCONTINUED completes the control paragraph.']);
  } finally { await f.close(); }
});

test('later amsart prose stays live across edits to the preceding run-in heading', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const f = await realEngineFixture('run-in-live.tex');
  try {
    const initial = await f.start();
    const before = await appendMarker(f, 'AFTERCONTROL');
    await assertLive(f, before, ['AFTERCONTROLX is a later paragraph with a+b=c. ' +
      'AFTERTAIL completes the later paragraph.']);
    const heading = await appendMarker(f, 'SATITLE');
    await assertLive(f, heading, ['SATITLEX', 'SABODY begins the opening paragraph with x+y=z. ' +
      'SATAIL completes the same paragraph.']);
    const after = await appendMarker(f, 'AFTERCONTROLX');
    assert.equal(after.versions.engine_generation, initial.versions.engine_generation);
    await assertLive(f, after, ['AFTERCONTROLXX is a later paragraph with a+b=c. ' +
      'AFTERTAIL completes the later paragraph.']);
  } finally { await f.close(); }
});

for (const [description, title, body, continued, prose] of [
  ['same-line subsection', 'SATITLE', 'SABODY', 'SATAIL', ' begins the opening paragraph with x+y=z. '],
  ['next-line subsection', 'SBTITLE', 'SBBODY', 'SBTAIL', ' begins the opening paragraph with u+v=w. '],
  ['same-line subsubsection', 'SSATITLE', 'SSABODY', 'SSATAIL', ' begins with p+q=r. '],
  ['next-line subsubsection', 'SSBTITLE', 'SSBBODY', 'SSBTAIL', ' begins with j+k=l. '],
  ['blank-line subsection', 'BLTITLE', 'BLBODY', 'BLTAIL', ' begins the opening paragraph with d+e=f. '],
]) {
  test(`run-in ${description} retains its heading and complete first paragraph while editing live`, {
    skip: realEngineUnavailable, timeout: 120000,
  }, async () => {
    const f = await realEngineFixture('run-in-live.tex');
    try {
      const initial = await f.start();
      const edited = new Set<string>();
      for (const marker of [body, title, continued]) {
        const update = await appendMarker(f, marker);
        edited.add(marker);
        assert.equal(update.versions.engine_generation, initial.versions.engine_generation);
        await assertLive(f, update, [title + (edited.has(title) ? 'X' : ''),
          body + 'X' + prose + continued + (edited.has(continued) ? 'X' : '') + ' completes the same paragraph.']);
      }
    } finally { await f.close(); }
  });
}

for (const target of ['before an existing heading', 'at a blank-line start']) {
  for (const separator of [' ', '\n']) {
    test(`inserted run-in subsection ${target} resumes live with ${separator === ' ' ? 'same-line' : 'next-line'} prose`, {
      skip: realEngineUnavailable, timeout: 120000,
    }, async () => {
      const f = await realEngineFixture('run-in-live.tex');
      try {
        const initial = await f.start();
        const at = target === 'at a blank-line start'
          ? f.source.indexOf('\n\n', f.source.indexOf('SATAIL')) + 1
          : f.source.indexOf('\\subsection{SBTITLE}');
        assert.ok(at > 0);
        const inserted = '\\subsection{INTITLE}' + separator +
          'INBODY begins a new paragraph with $s+t=u$.\n' +
          'INTAIL completes the new paragraph.\n\n';
        const insertion = await f.edit(at, at, inserted);
        await f.layout(insertion.source_revision);
        const update = await appendMarker(f, 'INBODY');
        assert.equal(update.versions.engine_generation, initial.versions.engine_generation);
        await assertLive(f, update, ['INTITLE', 'INBODYX begins a new paragraph with s+t=u. ' +
          'INTAIL completes the new paragraph.']);
        const boundary = f.source.indexOf('}' + separator + 'INBODY') + 1;
        const changed = await f.edit(boundary, boundary + separator.length, separator === ' ' ? '\n' : ' ');
        await f.layout(changed.source_revision);
        await assertLive(f, await appendMarker(f, 'INTAIL'),
          ['INTITLE', 'INBODYX begins a new paragraph with s+t=u. ' +
            'INTAILX completes the new paragraph.']);
        const undone = await f.edit(boundary, boundary + 1, separator);
        await f.layout(undone.source_revision);
        await assertLive(f, await appendMarker(f, 'INBODYX'),
          ['INTITLE', 'INBODYXX begins a new paragraph with s+t=u. ' +
            'INTAILX completes the new paragraph.']);
      } finally { await f.close(); }
    });
  }
}
