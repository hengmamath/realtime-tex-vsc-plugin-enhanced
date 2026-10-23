import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareTestRuntime } from './runtimeFixture';
export { realEngineUnavailable } from './runtimeFixture';
import type { DisplayList, EditResult, LayoutUpdateEvent, ParagraphUpdateEvent, RtexEvent } from '../src/protocol';
import { RtexProcess } from '../src/rtexProcess';

export async function realEngineFixture(fixtureName: string) {
  const root = path.resolve(__dirname, '..', '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rtex-structural-live-'));
  const project = path.join(temporary, 'project');
  const build = path.join(temporary, 'build');
  const cache = path.join(temporary, 'texmf-cache');
  await fs.mkdir(project);
  await fs.mkdir(cache);
  const runtime = await prepareTestRuntime(root);
  const main = path.join(project, 'main.tex');
  let source = await fs.readFile(path.join(root, 'test', 'fixtures', fixtureName), 'utf8');
  const originalSource = source;
  await fs.writeFile(main, source);
  const texliveBin = process.env.RTEX_TEST_TEXLIVE_BIN;
  const events: RtexEvent[] = [];
  const stderr: string[] = [];
  const engine = new RtexProcess({
    serverPath: runtime.serverPath, projectRoot: project,
    mainFile: 'main.tex', buildDir: build, extraArgs: ['--eligibility', 'probe'],
    env: { ...process.env, RTEX_TEXDIR: runtime.texDir, TEXMFVAR: cache, TEXMFCACHE: cache,
      PATH: texliveBin ? `${texliveBin}${path.delimiter}${process.env.PATH ?? ''}` : process.env.PATH },
  });
  engine.on('event', (event: RtexEvent) => events.push(event));
  engine.on('stderr', (line: string) => {
    stderr.push(line);
    if (stderr.length > 30) stderr.shift();
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
    if (reply.reply !== 'edit') throw new Error('Unexpected edit reply');
    source = source.slice(0, start) + text + source.slice(end);
    return reply.result;
  }

  async function editLive(start: number, end: number, text: string, description: string): Promise<ParagraphUpdateEvent> {
    const after = events.length;
    const result = await edit(start, end, text);
    assert.equal(result.routed, 'fast', `${description} edit was refused: ${result.reasons.join(', ')}`);
    const update = await waitFor(after, (event) =>
      (event.event === 'ParagraphUpdate' || event.event === 'BackgroundScheduled') &&
      event.edit_id === result.edit_id, `${description} live update`);
    assert.equal(update.event, 'ParagraphUpdate', JSON.stringify(update));
    if (update.event !== 'ParagraphUpdate') throw new Error('Unexpected update event');
    assert.equal(update.status, 'ok', `${description}: ${update.reasons.join(', ')}`);
    return update;
  }

  return {
    engine, events, build, temporary,
    get source() { return source; },
    start: async (): Promise<LayoutUpdateEvent> => {
      engine.start();
      const initial = await waitFor(0, (event) => event.event === 'LayoutUpdate' &&
        event.compile.state === 'Ok' && event.convergence.state === 'Converged', 'initial converged layout');
      assert.equal(initial.event, 'LayoutUpdate');
      return initial as LayoutUpdateEvent;
    },
    edit, editLive, waitFor,
    editMarker: async (marker: string, inserted = 'X'): Promise<ParagraphUpdateEvent> => {
      const at = source.indexOf(marker);
      assert.ok(at >= 0, `missing source marker ${marker}`);
      const update = await editLive(at + marker.length, at + marker.length, inserted, marker);
      assert.ok(glyphText(update.dl).replace(/\s/g, '').includes((marker + inserted).replace(/\s/g, '')),
        `${marker} live update does not include edited text`);
      return update;
    },
    layout: async (sourceRevision: number): Promise<LayoutUpdateEvent> => {
      const after = events.length;
      const reply = await engine.request({ cmd: 'request_layout' });
      assert.equal(reply.reply, 'request_layout');
      const layout = await waitFor(after, (event) => event.event === 'LayoutUpdate' &&
        event.versions.source_revision >= sourceRevision && event.compile.state === 'Ok' &&
        event.convergence.state === 'Converged', 'latest converged layout');
      assert.equal(layout.event, 'LayoutUpdate');
      return layout as LayoutUpdateEvent;
    },
    close: async (preserve = false) => {
      await engine.stop();
      assert.equal(await fs.readFile(main, 'utf8'), originalSource, 'test edits must remain in memory');
      if (!preserve) await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

export function glyphText(dl: DisplayList): string {
  return [...dl.other, ...dl.lines.flatMap((line) => line.items)]
    .filter((item) => item[0] === 'g' && typeof item[2] === 'number')
    .map((item) => String.fromCodePoint(item[2] as number)).join('');
}
