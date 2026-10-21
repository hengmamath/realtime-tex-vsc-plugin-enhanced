import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { prepareTestRuntime, realEngineUnavailable } from './runtimeFixture';
import type { DisplayList, EditResult, ParagraphUpdateEvent, RtexEvent } from '../src/protocol';
import { RtexProcess } from '../src/rtexProcess';

// Exercise the packaged pair with RTEX_TEST_BUNDLED=1 and a compatible LuaLaTeX.
test('showonlyrefs keeps proof edits live and removes equation tags after references disappear', {
  skip: realEngineUnavailable,
  timeout: 90000,
}, async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rtex-showonlyrefs-'));
  let processHandle: RtexProcess | undefined;
  try {
    const project = path.join(temporary, 'project');
    const build = path.join(temporary, 'build');
    const cache = path.join(temporary, 'texmf-cache');
    await fs.mkdir(project);
    await fs.mkdir(cache);
    const runtime = await prepareTestRuntime(path.resolve(__dirname, '..', '..'));
    let source = String.raw`\documentclass{article}
\usepackage[T1]{fontenc}
\usepackage{mathtools,amsthm}
\mathtoolsset{showonlyrefs}
% This harmless conditional intentionally needs probe verification rather than the allow-list.
\newcommand{\fixtureprobe}{\iftrue\relax\fi}
\begin{document}
\begin{proof}
MARKER \fixtureprobe The first identity is
\begin{equation}\label{eq:used}
x=x.
\end{equation}
The other identity is
\begin{equation}\label{eq:unused}
y=y.
\end{equation}
This finishes the proof.
\end{proof}

Only this reference is used: \eqref{eq:used}.

\end{document}
`;
    const originalSource = source;
    const main = path.join(project, 'main.tex');
    await fs.writeFile(main, source);
    const texliveBin = process.env.RTEX_TEST_TEXLIVE_BIN;
    const events: RtexEvent[] = [];
    const stderr: string[] = [];
    const engine = processHandle = new RtexProcess({
      serverPath: runtime.serverPath,
      projectRoot: project,
      mainFile: 'main.tex',
      buildDir: build,
      extraArgs: ['--eligibility', 'probe'],
      env: { ...process.env, RTEX_TEXDIR: runtime.texDir, TEXMFVAR: cache, TEXMFCACHE: cache,
        PATH: texliveBin ? `${texliveBin}${path.delimiter}${process.env.PATH ?? ''}` : process.env.PATH },
    });
    engine.on('event', (event: RtexEvent) => events.push(event));
    engine.on('stderr', (line: string) => {
      stderr.push(line);
      if (stderr.length > 20) stderr.shift();
    });

    function waitFor(after: number, matches: (event: RtexEvent) => boolean, description: string): Promise<RtexEvent> {
      const existing = events.slice(after).find(matches);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for ${description}; events: ${events.slice(after).map((event) =>
            event.event === 'BackgroundScheduled' ? `${event.event}: ${event.reasons.join(', ')}` : event.event).join(', ')}\n${stderr.join('\n')}`));
        }, 30000);
        const onEvent = (event: RtexEvent) => {
          if (!matches(event)) return;
          cleanup();
          resolve(event);
        };
        const onExit = () => {
          cleanup();
          reject(new Error(`Engine exited while waiting for ${description}\n${stderr.join('\n')}`));
        };
        const cleanup = () => {
          clearTimeout(timer);
          engine.off('event', onEvent);
          engine.off('exit', onExit);
        };
        engine.on('event', onEvent);
        engine.on('exit', onExit);
      });
    }

    async function edit(start: number, end: number, text: string): Promise<EditResult> {
      const reply = await engine.request({ cmd: 'edit', path: 'main.tex', start, end, text });
      assert.equal(reply.reply, 'edit', JSON.stringify(reply));
      if (reply.reply !== 'edit') throw new Error('unreachable reply type');
      source = source.slice(0, start) + text + source.slice(end);
      return reply.result;
    }

    async function editProof(marker: string, inserted: string): Promise<ParagraphUpdateEvent> {
      const at = source.indexOf(marker) + marker.length;
      assert.ok(at >= marker.length, `missing source marker ${marker}`);
      const after = events.length;
      const result = await edit(at, at, inserted);
      assert.equal(result.routed, 'fast', `proof edit was refused: ${result.reasons.join(', ')}`);
      const update = await waitFor(after, (event) =>
        (event.event === 'ParagraphUpdate' || event.event === 'BackgroundScheduled') &&
        event.edit_id === result.edit_id, 'a real live proof update');
      assert.equal(update.event, 'ParagraphUpdate', JSON.stringify(update));
      if (update.event !== 'ParagraphUpdate') throw new Error('unreachable event type');
      assert.equal(update.status, 'ok', update.reasons.join(', '));
      assert.ok(glyphText(update.dl).includes(marker + inserted), 'the update must contain the edited proof text');
      t.diagnostic(`proof live update: ${(update.timing.total_us / 1000).toFixed(1)} ms`);
      return update;
    }

    engine.start();
    const initial = await waitFor(0, (event) => event.event === 'LayoutUpdate' &&
      event.compile.state === 'Ok' && event.convergence.state === 'Converged', 'the initial converged layout');
    assert.equal(initial.event, 'LayoutUpdate');

    const first = await editProof('MARKER', 'X');
    assert.ok(glyphText(first.dl).includes('(1)'), 'the referenced first equation must have its real tag');
    assert.ok(!glyphText(first.dl).includes('(2)'), 'the unreferenced second equation must have no tag');

    // Remove only the outside reference through the same unsaved-buffer edit protocol used
    // by VS Code. Convergence must finish before the next proof probe, so it compares against
    // a background layout in which showonlyrefs has actually removed the old equation tag.
    const reference = String.raw`\eqref{eq:used}`;
    const at = source.indexOf(reference);
    assert.ok(at >= 0);
    const afterRemoval = events.length;
    const removal = await edit(at, at + reference.length, 'the identity');
    const requested = await engine.request({ cmd: 'request_layout' });
    assert.equal(requested.reply, 'request_layout');
    await waitFor(afterRemoval, (event) => event.event === 'LayoutUpdate' &&
      event.versions.source_revision >= removal.source_revision &&
      event.compile.state === 'Ok' && event.convergence.state === 'Converged', 'the converged layout after reference removal');
    const second = await editProof('MARKERX', 'Y');
    assert.equal(second.versions.engine_generation, first.versions.engine_generation,
      'reference removal must refresh the existing live engine without restarting it');
    assert.ok(!glyphText(second.dl).includes('(1)'), 'the removed reference must not leave a stale first-equation tag');
    assert.ok(!glyphText(second.dl).includes('(2)'), 'the second equation must remain unnumbered');
    assert.equal(await fs.readFile(main, 'utf8'), originalSource, 'all test edits must remain in memory');
  } finally {
    await processHandle?.stop();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

function glyphText(dl: DisplayList): string {
  return [...dl.other, ...dl.lines.flatMap((line) => line.items)]
    .filter((item) => item[0] === 'g' && typeof item[2] === 'number')
    .map((item) => String.fromCodePoint(item[2] as number)).join('');
}
