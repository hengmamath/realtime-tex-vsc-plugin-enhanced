import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const { outputFiles } = await build({ absWorkingDir: root,
  stdin: { contents: "export { Session } from './src/session'; export * as vscode from './test/bench/vscodeShim';", resolveDir: root, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent',
  alias: { vscode: './test/bench/vscodeShim.ts' }, external: ['./config', './rtexProcess', 'fs', 'child_process'] });
const require = createRequire(import.meta.url);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
async function until(check) {
  for (let i = 0; i < 40 && !check(); i++) await tick();
  assert.ok(check(), 'expected asynchronous work to begin');
}

function harness(t, project = '/synthetic', buildDir = path.join(project, 'build')) {
  const processes = [], watchers = [], outputs = [];
  const io = { ...fs.promises, mkdir: async () => undefined };
  const config = { buildDirFor: () => buildDir, debugDir: () => undefined,
    engineArgs: () => [], processEnv: () => ({}), resolveServer: () => ({ path: '/fake/rtex', version: 'test' }),
    exportPathFor: () => path.join(project, 'export.pdf') };
  class RtexProcess extends EventEmitter {
    running = false;
    commands = [];
    stopGate = undefined;
    constructor() { super(); processes.push(this); }
    start() { this.running = true; }
    async stop() {
      await this.stopGate?.promise;
      this.running = false;
      this.emit('exit', { code: 0, signal: null, requested: true, stderrTail: [] });
    }
    send(command, reply) { this.commands.push({ command, reply }); }
    request(command) {
      return new Promise(resolve => this.commands.push({ command, reply: resolve }));
    }
  }
  const context = vm.createContext({ module: { exports: {} }, Buffer, process, console, setTimeout, clearTimeout, setInterval, clearInterval,
    require(id) {
      if (id === './config') return config;
      if (id === './rtexProcess') return { RtexProcess };
      if (id === 'fs') return { ...fs, promises: io };
      if (id === 'child_process') return { execFile: (_cmd, _args, _opts, cb) => cb(null, 'test') };
      return require(id);
    } });
  vm.runInContext(outputFiles[0].text, context);
  const { Session, vscode } = context.module.exports;
  vscode.workspace.createFileSystemWatcher = () => {
    const watcher = { disposed: false, dispose() { this.disposed = true; },
      onDidChange(fn) { this.change = fn; return { dispose() {} }; },
      onDidCreate() { return { dispose() {} }; }, onDidDelete() { return { dispose() {} }; } };
    watchers.push(watcher);
    return watcher;
  };
  const ctx = { extensionUri: vscode.Uri.file(root) };
  const diagnostics = new vscode.DiagnosticCollection();
  const session = new Session(ctx, path.join(project, 'main.tex'), { appendLine() {} }, diagnostics);
  session.onOutput(output => outputs.push(output));
  t.after(() => { session.dispose(); for (const proc of processes) proc.stopGate?.resolve(); });
  return { session, processes, watchers, outputs, diagnostics, io, config, vscode };
}

const layout = { event: 'LayoutUpdate', versions: { layout_version: 1 }, pages_total: 1,
  pages_changed: [{ page: 1, dl: { fonts: {}, lines: [], other: [], flags: [] } }], placements: [],
  eligible_paragraphs: [], convergence: { state: 'Converged' }, compile: { state: 'Ok' }, source_revision: 1, wall_ms: 1 };

test('formula closing delimiters beat trailing prose while direct body rows remain precise', async t => {
  const h = harness(t), PT = 65536;
  const lines = ['\\begin{proof}', '\\begin{align}', 'a&=b', 'c&=d', '\\end{align}\\end{proof} where constants are positive.'];
  const doc = { fileName: '/synthetic/main.tex', uri: h.vscode.Uri.file('/synthetic/main.tex'),
    lineCount: lines.length, lineAt: line => ({ text: lines[line] }) };
  const glyphs = (text, font, y) => [...text].map((char, i) => ['g', font, char.charCodeAt(0), null, (10 + 5 * i) * PT, y * PT, 5 * PT, 0]);
  const row = (text, font, y, line, kind) => ({ x: 10 * PT, y: y * PT, w: text.length * 5 * PT, h: 8 * PT, d: 2 * PT,
    items: glyphs(text, font, y), source_anchors: [{ x: 10 * PT, w: 5 * PT, file: 'main.tex', line, kind }] });
  h.session.model.applyLayout({ pages: [{ page: 1, exact: true, hash: 1, dl: {
    kind: 'page', width: 600 * PT, height: 800 * PT, depth: 0, other: [], flags: [], source_revision: 1,
    fonts: { 1: { id: 1, name: 'cmmi10', size: 10 * PT }, 2: { id: 2, name: 'cmr10', size: 10 * PT } },
    lines: [row('a', 1, 100, 5, 'mg'), row('c', 1, 120, 4, 'mg'), row('where', 2, 150, 5, 'g')],
  } }], pagesTotal: 1, placements: [], keepFromRevision: null });
  for (const [line, character, baseline] of [[4, 0, 100], [4, 5, 100], [3, 0, 120], [4, lines[4].indexOf('where') + 1, 150]]) {
    assert.equal(await h.session.revealInPreview(doc, new h.vscode.Position(line, character), true), true);
    assert.equal(h.outputs.at(-1).target.y, baseline * PT, `${line}:${character}`);
  }
});

test('exact math-row ranges take precedence when the same source line also closes the display', async t => {
  const h = harness(t), PT = 65536;
  const text = '\\begin{align} a&=b \\\\ c&=d\\end{align}';
  const start = text.indexOf('c&=d');
  const doc = { fileName: '/synthetic/main.tex', uri: h.vscode.Uri.file('/synthetic/main.tex'), lineCount: 1,
    lineAt: () => ({ text }) };
  h.session.model.applyLayout({ pages: [{ page: 1, exact: true, hash: 1, dl: {
    kind: 'page', width: 600 * PT, height: 800 * PT, depth: 0, other: [], flags: [], source_revision: 1, fonts: {},
    lines: [{ x: 10 * PT, y: 100 * PT, w: 5 * PT, h: 8 * PT, d: 2 * PT,
      items: [['g', 1, 97, null, 10 * PT, 100 * PT, 5 * PT, 0]],
      source_anchors: [{ x: 10 * PT, w: 5 * PT, file: 'main.tex', line: 1, kind: 'mg' },
        { x: 10 * PT, w: 5 * PT, y: 120 * PT, file: 'main.tex', line: 1, end_line: 1,
          start_column: start, end_column: start + 4, kind: 'mr' }] }],
  } }], pagesTotal: 1, placements: [], keepFromRevision: null });
  assert.equal(await h.session.revealInPreview(doc, new h.vscode.Position(0, start), true), true);
  assert.equal(h.outputs.at(-1).target.y, 120 * PT);
});

test('custom build directories preserve sibling source startup, close, watcher and incremental edits', async t => {
  for (const [project, buildDir] of [
    ['/synthetic', '/synthetic/build'], ['/synthetic', '/synthetic/build/'],
    ['/synthetic', '/synthetic/staging/../build'], ['/synthetic-other', '/synthetic'],
  ]) {
    const h = harness(t, project, buildDir), reads = [];
    let text = 'unsaved source';
    const doc = { fileName: path.join(project, 'building.tex'), uri: h.vscode.Uri.file(path.join(project, 'building.tex')),
      isDirty: true, isClosed: false, getText: () => text, lineCount: 1,
      lineAt: () => ({ range: { end: { character: text.length } } }), offsetAt: pos => pos.character };
    h.vscode.workspace.textDocuments.push(doc);
    await h.session.start();
    const commands = h.processes[0].commands;
    assert.deepEqual(commands.map(({ command }) => [command.cmd, command.path, command.text]),
      [['set_document', 'building.tex', text]], buildDir);
    h.io.readFile = async file => { reads.push(file); return 'saved source'; };
    doc.isClosed = true;
    h.vscode.workspace.textDocuments.length = 0;
    await h.session.onDidCloseDocument(doc);
    assert.equal(commands.at(-1).command.text, 'saved source');
    assert.deepEqual(reads, [doc.fileName]);
    h.io.stat = async () => ({ isDirectory: () => false, mtimeMs: Date.now() + 1000 });
    h.io.readFile = async file => { reads.push(file); return 'external source'; };
    await h.watchers[0].change(doc.uri);
    assert.equal(commands.at(-1).command.text, 'external source');
    assert.equal(h.session.diskTexts.get('building.tex'), 'external source');
    assert.deepEqual(reads, [doc.fileName, doc.fileName]);
    text = 'reopened source';
    doc.isClosed = false;
    h.vscode.workspace.textDocuments.push(doc);
    h.session.onDidOpenDocument(doc);
    assert.equal(commands.at(-1).command.text, text);
    const end = text.length;
    text += '!';
    h.session.onDidChangeDocument({ document: doc, contentChanges: [{ rangeOffset: end, rangeLength: 0, text: '!' }] });
    assert.equal(commands.at(-1).command.cmd, 'edit');
    assert.equal(commands.at(-1).command.path, 'building.tex');
    assert.equal(commands.at(-1).command.text, '!');
    assert.equal(h.session.shadows.get('building.tex').text, text);
  }
});

test('custom build directories preserve referenced PDF figures in a same-prefix sibling directory', async t => {
  const project = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rtex-session-build-'));
  t.after(() => fs.promises.rm(project, { recursive: true, force: true }));
  const figures = path.join(project, 'build-figures'), figure = path.join(figures, 'figure.pdf');
  await fs.promises.mkdir(figures);
  await fs.promises.writeFile(path.join(figures, 'figure.tex'), 'synthetic standalone figure');
  for (const suffix of ['/build', '/build/', '/staging/../build']) {
    const h = harness(t, project, project + suffix);
    await h.session.start();
    h.session.model.pages.set(1, { page: 1, dl: { fonts: {}, lines: [], other: [['i', 1, 0, 0, 10, 10]],
      images_info: { '1': { file: 'build-figures/figure.pdf' } } } });
    await fs.promises.writeFile(figure, '%PDF-1.4\nsynthetic updated figure\n%%EOF\n');
    await h.watchers[0].change(h.vscode.Uri.file(figure));
    await new Promise(resolve => setTimeout(resolve, 450));
    const updates = h.outputs.filter(item => item.kind === 'inputsChanged');
    assert.equal(updates.length, 1, suffix);
    assert.deepEqual([...updates[0].files], [figure]);
    assert.equal(h.processes[0].commands.filter(item => item.command.cmd === 'request_layout').length, 1);
  }
});

test('build directory descendants and the filesystem root are excluded before source or watcher I/O', async t => {
  const sessions = [];
  for (const [buildDir, directory] of [
    ['/synthetic/build', '/synthetic/build'], ['/synthetic/build/', '/synthetic/build'],
    ['/synthetic/staging/../build', '/synthetic/build'], ['/synthetic/cache/', '/synthetic/cache'],
    ['/synthetic/staging/../cache', '/synthetic/cache'], ['/', '/synthetic'],
  ]) {
    const h = harness(t, '/synthetic', buildDir), io = [];
    h.io.stat = async file => { io.push(file); return { isDirectory: () => false }; };
    h.io.readFile = async file => { io.push(file); return 'generated source'; };
    const doc = { fileName: path.join(directory, 'generated.tex'), uri: h.vscode.Uri.file(path.join(directory, 'generated.tex')),
      isDirty: true, getText: () => 'unsaved generated source' };
    h.vscode.workspace.textDocuments.push(doc);
    await h.session.start();
    assert.equal(h.processes[0].commands.length, 0, buildDir);
    h.session.onDidOpenDocument(doc);
    h.session.onDidChangeDocument({ document: doc, contentChanges: [{ rangeOffset: 0, rangeLength: 0, text: '!' }] });
    await h.session.onDidCloseDocument(doc);
    await h.watchers[0].change(doc.uri);
    await h.watchers[0].change(h.vscode.Uri.file(path.join(directory, 'figure.pdf')));
    await h.watchers[0].change(h.vscode.Uri.file(path.resolve(buildDir)));
    await h.watchers[0].change(h.vscode.Uri.file(path.join(directory, 'nested', 'generated.tex')));
    await h.watchers[0].change(h.vscode.Uri.file(path.join(directory, 'nested', 'figure.pdf')));
    assert.deepEqual(io, [], buildDir);
    sessions.push(h);
  }
  await new Promise(resolve => setTimeout(resolve, 450));
  for (const h of sessions) {
    assert.equal(h.processes[0].commands.length, 0, h.session.buildDir);
    assert.equal(h.outputs.filter(item => item.kind === 'inputsChanged').length, 0);
  }
});

test('concurrent starts share one engine and one stop reaches it', async t => {
  const h = harness(t), gate = deferred();
  let reads = 0;
  h.io.mkdir = () => { reads++; return gate.promise; };
  const first = h.session.start(), second = h.session.start();
  assert.equal(first, second);
  await until(() => reads > 0);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(reads, 1);
  assert.equal(h.processes.length, 1);
  await h.session.stop();
  assert.equal(h.processes[0].running, false);
});

test('stop and dispose cancel pending startup, including debug-directory preparation', async t => {
  for (const action of ['stop', 'dispose']) for (const debug of [false, true]) {
    const h = harness(t), gate = deferred();
    let reads = 0;
    if (debug) h.config.debugDir = () => '/debug';
    h.io.mkdir = () => { reads++; return reads === (debug ? 2 : 1) ? gate.promise : Promise.resolve(); };
    const starting = h.session.start();
    await until(() => reads === (debug ? 2 : 1));
    await h.session[action]();
    gate.resolve();
    await starting;
    assert.equal(h.processes.length, 0, `${action}, debug=${debug}`);
  }
});

test('overlapping restarts wait for exit and a later stop cancels a restart', async t => {
  const h = harness(t);
  await h.session.start();
  const old = h.processes[0];
  old.stopGate = deferred();
  const first = h.session.restart(), second = h.session.restart();
  await tick();
  assert.equal(h.processes.length, 1);
  old.stopGate.resolve();
  await Promise.all([first, second]);
  assert.equal(h.processes.length, 2);
  assert.equal(old.running, false);
  const current = h.processes[1];
  current.stopGate = deferred();
  const restarting = h.session.restart(), stopping = h.session.stop();
  current.stopGate.resolve();
  await Promise.all([restarting, stopping]);
  assert.equal(h.processes.length, 2);
  assert.equal(h.session.status.phase, 'stopped');
});

test('a start requested while stopping waits and survives the older stop', async t => {
  const h = harness(t);
  await h.session.start();
  const old = h.processes[0];
  old.stopGate = deferred();
  const stopping = h.session.stop(), starting = h.session.start();
  await tick();
  assert.equal(h.processes.length, 1);
  old.stopGate.resolve();
  await Promise.all([stopping, starting]);
  assert.equal(h.processes.length, 2);
  assert.equal(h.session.running, true);
  assert.equal(h.session.status.phase, 'starting');
});

test('late events, edit acknowledgements and spans from a stopped engine cannot change its replacement', async t => {
  const h = harness(t);
  await h.session.start();
  const old = h.processes[0];
  h.session.sendDocument(old, 'main.tex', 'old');
  const spans = h.session.spans('main.tex');
  const callbacks = old.commands.map(item => item.reply);
  await h.session.restart();
  old.emit('event', layout);
  callbacks[0]({ reply: 'set_document', result: { source_revision: 2, routed: 'preamble', reasons: [] } });
  callbacks[1]({ reply: 'spans', spans: [{ par_id: 99 }] });
  assert.equal((await spans).length, 0);
  assert.equal(h.session.model.hasLayout, false);
  assert.equal(h.session.status.phase, 'starting');
  assert.equal(h.session.status.pending, false);
  assert.equal(h.session.editsInFlight.size, 0);
  assert.equal(h.session.spansKnown.size, 0);
  h.processes[1].emit('event', layout);
  assert.equal(h.session.status.phase, 'live');
});

test('PDF figures refresh but document PDFs, configured exports and build files do not', async t => {
  const project = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rtex-session-'));
  t.after(() => fs.promises.rm(project, { recursive: true, force: true }));
  await fs.promises.writeFile(path.join(project, 'main.tex'), 'synthetic');
  await fs.promises.writeFile(path.join(project, 'figure.tex'), 'synthetic standalone figure');
  const h = harness(t, project);
  await h.session.start();
  const change = file => h.watchers[0].change(h.vscode.Uri.file(path.join(project, file)));
  for (const file of ['main.pdf', 'export.pdf', 'build/figure.pdf', 'main.aux', 'figure.pdf']) await change(file);
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(h.outputs.filter(item => item.kind === 'inputsChanged').length, 0);
  h.session.model.pages.set(1, { page: 1, dl: { fonts: {}, lines: [], other: [['i', 1, 0, 0, 10, 10]],
    images_info: { '1': { file: 'figure.pdf' } } } });
  await change('figure.pdf');
  await new Promise(resolve => setTimeout(resolve, 450));
  const updates = h.outputs.filter(item => item.kind === 'inputsChanged');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].files[0], path.join(project, 'figure.pdf'));
  assert.equal(h.processes[0].commands.filter(item => item.command.cmd === 'request_layout').length, 1);
  const page = h.session.model.pages.get(1);
  h.session.model.pages.clear();
  h.session.model.overlays.set(1, { dl: page.dl });
  await change('figure.pdf');
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(h.outputs.filter(item => item.kind === 'inputsChanged').length, 2);
});

test('stopping clears debounced input refresh and ignores an already pending watcher read', async t => {
  const h = harness(t);
  h.io.stat = async () => ({ isDirectory: () => false });
  await h.session.start();
  const watcher = h.watchers[0];
  await watcher.change(h.vscode.Uri.file('/synthetic/figure.pdf'));
  const gate = deferred();
  h.io.stat = () => gate.promise;
  const reading = watcher.change(h.vscode.Uri.file('/synthetic/second.pdf'));
  await h.session.restart();
  gate.resolve({ isDirectory: () => false });
  await reading;
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(watcher.disposed, true);
  assert.equal(h.outputs.filter(item => item.kind === 'inputsChanged').length, 0);
  assert.equal(h.processes[1].commands.length, 0);
});

test('failed startup can be retried and restart does not flash the stopped screen', async t => {
  const h = harness(t);
  h.io.mkdir = async () => { throw new Error('synthetic mkdir failure'); };
  await assert.rejects(h.session.start(), /synthetic mkdir failure/);
  h.io.mkdir = async () => undefined;
  await h.session.start();
  const screens = [];
  h.session.onScreen(screen => screens.push(screen.screen));
  await h.session.restart();
  assert.equal(h.processes.length, 2);
  assert.equal(screens.includes('stopped'), false);
  assert.equal(h.session.running, true);
});

test('a late document-close read cannot replace buffers in the new engine', async t => {
  const h = harness(t), gate = deferred();
  let text = 'unsaved';
  const doc = { fileName: '/synthetic/main.tex', uri: h.vscode.Uri.file('/synthetic/main.tex'),
    isDirty: true, getText: () => text };
  h.vscode.workspace.textDocuments.push(doc);
  await h.session.start();
  h.io.readFile = () => gate.promise;
  const closing = h.session.onDidCloseDocument(doc);
  text = 'new unsaved text';
  await h.session.restart();
  gate.resolve('old disk text');
  await closing;
  assert.equal(h.session.shadows.get('main.tex').text, text);
  assert.equal(h.processes[1].commands.length, 1);
  assert.equal(h.processes[1].commands[0].command.text, text);
});

test('a late export acknowledgement cannot register a job against the replacement engine', async t => {
  const h = harness(t);
  await h.session.start();
  const old = h.processes[0];
  const exporting = h.session.exportPdf();
  await until(() => old.commands.some(item => item.command.cmd === 'export_pdf'));
  await h.session.restart();
  old.commands.find(item => item.command.cmd === 'export_pdf').reply({ reply: 'export_pdf', job_id: 1 });
  assert.equal(await exporting, undefined);
  assert.equal(h.session.exports.size, 0);
});

test('reopening a document cancels its old close read without discarding new edits', async t => {
  for (const failedRead of [false, true]) {
    const h = harness(t), gate = deferred();
    const doc = { fileName: '/synthetic/main.tex', uri: h.vscode.Uri.file('/synthetic/main.tex'),
      isDirty: true, isClosed: false, getText: () => 'old' };
    h.vscode.workspace.textDocuments.push(doc);
    await h.session.start();
    doc.isClosed = true;
    h.vscode.workspace.textDocuments.length = 0;
    h.io.readFile = () => gate.promise.then(() => { if (failedRead) throw new Error('unreadable'); return 'disk'; });
    const closing = h.session.onDidCloseDocument(doc);
    let reopenedText = 'old';
    const reopened = { ...doc, isClosed: false, getText: () => reopenedText, lineCount: 1,
      lineAt: () => ({ range: { end: { character: 4 } } }), offsetAt: pos => pos.character };
    h.vscode.workspace.textDocuments.push(reopened);
    h.session.onDidOpenDocument(reopened);
    reopenedText = 'old!';
    h.session.onDidChangeDocument({ document: reopened, contentChanges: [{ rangeOffset: 3, rangeLength: 0, text: '!' }] });
    const sent = h.processes[0].commands.length;
    gate.resolve();
    await closing;
    assert.equal(h.session.shadows.get('main.tex').text, reopened.getText());
    assert.equal(h.processes[0].commands.length, sent);
  }
});

test('a watcher read cannot replace a file opened in the editor while the read was pending', async t => {
  const h = harness(t), gate = deferred();
  h.io.stat = async () => ({ isDirectory: () => false, mtimeMs: Date.now() + 1000 });
  h.io.readFile = () => gate.promise;
  await h.session.start();
  const reading = h.watchers[0].change(h.vscode.Uri.file('/synthetic/part.tex'));
  await tick();
  const doc = { fileName: '/synthetic/part.tex', uri: h.vscode.Uri.file('/synthetic/part.tex'),
    isDirty: true, isClosed: false, getText: () => 'unsaved editor text' };
  h.vscode.workspace.textDocuments.push(doc);
  h.session.onDidOpenDocument(doc);
  gate.resolve('disk text');
  await reading;
  assert.equal(h.processes[0].commands.length, 1);
  assert.equal(h.processes[0].commands[0].command.text, doc.getText());
});

test('close and watcher reads share freshness in either start and completion order', async t => {
  for (const closeFirst of [false, true]) for (const olderFirst of [false, true]) {
    const h = harness(t), first = deferred(), second = deferred();
    let text = 'unsaved editor text', reads = 0;
    const doc = { fileName: '/synthetic/part.tex', uri: h.vscode.Uri.file('/synthetic/part.tex'),
      isDirty: true, isClosed: false, getText: () => text, lineCount: 1,
      lineAt: () => ({ range: { end: { character: text.length } } }), offsetAt: pos => pos.character };
    h.io.stat = async () => ({ isDirectory: () => false, mtimeMs: Date.now() + 1000 });
    h.io.readFile = () => ++reads === 1 ? first.promise : second.promise;
    await h.session.start();
    const close = () => {
      doc.isClosed = false;
      h.vscode.workspace.textDocuments.push(doc);
      h.session.onDidOpenDocument(doc);
      h.processes[0].commands.length = 0;
      doc.isClosed = true;
      h.vscode.workspace.textDocuments.length = 0;
      return h.session.onDidCloseDocument(doc);
    };
    const change = () => h.watchers[0].change(doc.uri);
    const older = closeFirst ? close() : change();
    await until(() => reads === 1);
    const newer = closeFirst ? change() : close();
    await until(() => reads === 2);
    if (olderFirst) {
      first.resolve('obsolete disk text');
      await older;
      assert.equal(h.processes[0].commands.length, 0, 'a superseded read cannot publish while its replacement is pending');
    }
    second.resolve('latest disk text');
    await newer;
    first.resolve('obsolete disk text');
    await older;
    assert.deepEqual(h.processes[0].commands.map(({ command }) => command.text), ['latest disk text']);
    assert.equal(h.session.diskTexts.get('part.tex'), 'latest disk text');
    assert.equal(h.session.shadows.has('part.tex'), false, 'a superseded close must not leave its shadow behind');
    text = 'latest disk text';
    doc.isClosed = false;
    h.vscode.workspace.textDocuments.push(doc);
    h.session.onDidOpenDocument(doc);
    assert.equal(h.session.shadows.get('part.tex').text, text);
    const end = text.length;
    text += '!';
    h.session.onDidChangeDocument({ document: doc, contentChanges: [{ rangeOffset: end, rangeLength: 0, text: '!' }] });
    assert.equal(h.session.shadows.get('part.tex').text, text);
    assert.equal(h.processes[0].commands.at(-1).command.cmd, 'edit');
    assert.equal(h.processes[0].commands.at(-1).command.text, '!');
  }
});

test('failed close and watcher reads cannot overwrite or erase a newer delivery', async t => {
  for (const failedClose of [false, true]) {
    const h = harness(t), gate = deferred();
    const doc = { fileName: '/synthetic/part.tex', uri: h.vscode.Uri.file('/synthetic/part.tex'),
      isDirty: true, isClosed: false, getText: () => 'unsaved editor text' };
    h.vscode.workspace.textDocuments.push(doc);
    await h.session.start();
    h.processes[0].commands.length = 0;
    doc.isClosed = true;
    h.vscode.workspace.textDocuments.length = 0;
    h.io.readFile = () => gate.promise.then(() => {
      if (failedClose) throw new Error('old close read failed');
      return 'obsolete disk text';
    });
    const closing = h.session.onDidCloseDocument(doc);
    h.io.stat = async () => ({ isDirectory: () => false, mtimeMs: Date.now() + 1000 });
    h.io.readFile = async () => {
      if (!failedClose) throw Object.assign(new Error('newer file was deleted'), { code: 'ENOENT' });
      return 'latest disk text';
    };
    await h.watchers[0].change(doc.uri);
    const delivered = h.session.diskTexts.get('part.tex');
    gate.resolve();
    await closing;
    assert.equal(h.session.diskTexts.get('part.tex'), delivered, 'the obsolete close cannot erase a newer result');
    assert.deepEqual(h.processes[0].commands.map(({ command }) => command.text), failedClose ? ['latest disk text'] : []);
    assert.equal(h.session.shadows.has('part.tex'), false);
    h.io.readFile = async () => 'recovered disk text';
    await h.watchers[0].change(doc.uri);
    assert.equal(h.processes[0].commands.at(-1).command.text, 'recovered disk text');
    assert.equal(h.session.diskTexts.get('part.tex'), 'recovered disk text');
  }
});

test('a watcher replacing a close restores disk text even if its timestamp or cached text predates editing', async t => {
  for (const oldTimestamp of [false, true]) {
    const h = harness(t), gate = deferred();
    await h.session.start();
    h.session.diskTexts.set('part.tex', 'saved disk text');
    const doc = { fileName: '/synthetic/part.tex', uri: h.vscode.Uri.file('/synthetic/part.tex'),
      isDirty: true, isClosed: false, getText: () => 'unsaved editor text' };
    h.vscode.workspace.textDocuments.push(doc);
    h.session.onDidOpenDocument(doc);
    h.processes[0].commands.length = 0;
    doc.isClosed = true;
    h.vscode.workspace.textDocuments.length = 0;
    h.io.readFile = () => gate.promise;
    const closing = h.session.onDidCloseDocument(doc);
    h.io.stat = async () => ({ isDirectory: () => false, mtimeMs: oldTimestamp ? 0 : Date.now() + 1000 });
    h.io.readFile = async () => 'saved disk text';
    await h.watchers[0].change(doc.uri);
    assert.deepEqual(h.processes[0].commands.map(({ command }) => command.text), ['saved disk text']);
    gate.resolve('obsolete disk text');
    await closing;
    assert.equal(h.session.diskTexts.get('part.tex'), 'saved disk text');
    assert.equal(h.processes[0].commands.length, 1);
  }
});

test('reopening a clean main during a close restores editor text and a second close owns its read', async t => {
  for (const olderFirst of [false, true]) {
    const h = harness(t), first = deferred(), second = deferred();
    const doc = { fileName: '/synthetic/main.tex', uri: h.vscode.Uri.file('/synthetic/main.tex'),
      isDirty: true, isClosed: false, getText: () => 'discarded unsaved text' };
    h.vscode.workspace.textDocuments.push(doc);
    await h.session.start();
    h.processes[0].commands.length = 0;
    doc.isClosed = true;
    h.vscode.workspace.textDocuments.length = 0;
    h.io.readFile = () => first.promise;
    const older = h.session.onDidCloseDocument(doc);
    const reopened = { ...doc, isDirty: false, isClosed: false, getText: () => 'reopened saved text' };
    h.vscode.workspace.textDocuments.push(reopened);
    h.session.onDidOpenDocument(reopened);
    assert.equal(h.session.shadows.get('main.tex').text, reopened.getText());
    assert.deepEqual(h.processes[0].commands.map(({ command }) => command.text), ['reopened saved text']);
    reopened.isClosed = true;
    h.vscode.workspace.textDocuments.length = 0;
    h.io.readFile = () => second.promise;
    const newer = h.session.onDidCloseDocument(reopened);
    if (olderFirst) { first.resolve('obsolete disk text'); await older; }
    second.resolve('latest disk text');
    await newer;
    first.resolve('obsolete disk text');
    await older;
    assert.deepEqual(h.processes[0].commands.map(({ command }) => command.text), ['reopened saved text', 'latest disk text']);
    assert.equal(h.session.diskTexts.get('main.tex'), 'latest disk text');
    assert.equal(h.session.shadows.has('main.tex'), false);
    const unchanged = { ...doc, isDirty: false, isClosed: false, getText: () => 'latest disk text' };
    h.vscode.workspace.textDocuments.push(unchanged);
    h.session.onDidOpenDocument(unchanged);
    assert.equal(h.processes[0].commands.length, 2, 'an unchanged clean main must not be resent on reopen');
  }
});

test('a failed close retains the engine text so reopening or an old-timestamp watcher can recover', async t => {
  for (const reopen of [false, true]) {
    const h = harness(t);
    const doc = { fileName: '/synthetic/main.tex', uri: h.vscode.Uri.file('/synthetic/main.tex'),
      isDirty: true, isClosed: false, getText: () => 'unsaved editor text' };
    h.vscode.workspace.textDocuments.push(doc);
    await h.session.start();
    h.processes[0].commands.length = 0;
    doc.isClosed = true;
    h.vscode.workspace.textDocuments.length = 0;
    h.io.readFile = async () => { throw new Error('temporarily unreadable'); };
    await h.session.onDidCloseDocument(doc);
    assert.equal(h.session.diskTexts.get('main.tex'), 'unsaved editor text');
    assert.equal(h.session.shadows.has('main.tex'), false);
    if (reopen) {
      const reopened = { ...doc, isClosed: false, isDirty: false, getText: () => 'saved disk text' };
      h.vscode.workspace.textDocuments.push(reopened);
      h.session.onDidOpenDocument(reopened);
      assert.equal(h.session.shadows.get('main.tex').text, 'saved disk text');
    } else {
      h.io.readFile = async () => 'saved disk text';
      h.io.stat = async () => ({ isDirectory: () => false, mtimeMs: 0 });
      await h.watchers[0].change(doc.uri);
      assert.equal(h.session.diskTexts.get('main.tex'), 'saved disk text');
    }
    assert.deepEqual(h.processes[0].commands.map(({ command }) => command.text), ['saved disk text']);
  }
});

test('only the latest watcher read for a file can reach the engine, in either completion order', async t => {
  for (const olderFirst of [false, true]) {
    const h = harness(t), first = deferred(), second = deferred();
    let reads = 0;
    h.io.stat = async () => ({ isDirectory: () => false, mtimeMs: Date.now() + 1000 });
    h.io.readFile = () => ++reads === 1 ? first.promise : second.promise;
    await h.session.start();
    const change = () => h.watchers[0].change(h.vscode.Uri.file('/synthetic/part.tex'));
    const older = change();
    await until(() => reads === 1);
    const newer = change();
    await until(() => reads === 2);
    if (olderFirst) {
      first.resolve('older disk content');
      await older;
      assert.equal(h.processes[0].commands.length, 0, 'an older read cannot publish while the latest read is pending');
    }
    second.resolve('latest disk content');
    await newer;
    first.resolve('older disk content');
    await older;
    assert.deepEqual(h.processes[0].commands.map(({ command }) => command.text), ['latest disk content']);
    assert.equal(h.session.diskTexts.get('part.tex'), 'latest disk content');
  }
});

test('a late initial stat cannot start another read after a newer watcher event completes', async t => {
  const h = harness(t), firstStat = deferred();
  const stat = { isDirectory: () => false, mtimeMs: Date.now() + 1000 };
  let stats = 0, reads = 0;
  h.io.stat = () => ++stats === 1 ? firstStat.promise : Promise.resolve(stat);
  h.io.readFile = async () => { reads++; return 'latest disk content'; };
  await h.session.start();
  const change = () => h.watchers[0].change(h.vscode.Uri.file('/synthetic/part.tex'));
  const older = change();
  await until(() => stats === 1);
  await change();
  firstStat.resolve(stat);
  await older;
  assert.equal(reads, 1, 'an obsolete event must stop before reading the file');
  assert.deepEqual(h.processes[0].commands.map(({ command }) => command.text), ['latest disk content']);
  assert.equal(h.session.diskTexts.get('part.tex'), 'latest disk content');
});

test('a newer failed or deleted input invalidates pending reads and a later event can recover', async t => {
  for (const deleted of [false, true]) {
    const h = harness(t), first = deferred();
    const stat = { isDirectory: () => false, mtimeMs: Date.now() + 1000 };
    let reads = 0;
    h.io.stat = async () => stat;
    h.io.readFile = () => { reads++; return first.promise; };
    await h.session.start();
    h.session.diskTexts.set('part.tex', 'previously delivered content');
    const change = () => h.watchers[0].change(h.vscode.Uri.file('/synthetic/part.tex'));
    const older = change();
    await until(() => reads === 1);
    const error = Object.assign(new Error('synthetic unreadable input'), { code: deleted ? 'ENOENT' : 'EACCES' });
    h.io.readFile = async () => { throw error; };
    if (deleted) h.io.stat = async () => { throw error; };
    await change();
    first.resolve('obsolete disk content');
    await older;
    assert.equal(h.processes[0].commands.length, 0, 'a failed newer read must not revive an older result');
    assert.equal(h.session.diskTexts.get('part.tex'), 'previously delivered content');
    h.io.stat = async () => stat;
    h.io.readFile = async () => 'recovered disk content';
    await change();
    assert.deepEqual(h.processes[0].commands.map(({ command }) => command.text), ['recovered disk content']);
    assert.equal(h.session.diskTexts.get('part.tex'), 'recovered disk content');
  }
});

test('overlapping watcher reads for different files remain independent', async t => {
  const h = harness(t), first = deferred(), second = deferred();
  let reads = 0;
  h.io.stat = async () => ({ isDirectory: () => false, mtimeMs: Date.now() + 1000 });
  h.io.readFile = file => { reads++; return file.endsWith('/first.tex') ? first.promise : second.promise; };
  await h.session.start();
  const older = h.watchers[0].change(h.vscode.Uri.file('/synthetic/first.tex'));
  const newer = h.watchers[0].change(h.vscode.Uri.file('/synthetic/second.tex'));
  await until(() => reads === 2);
  second.resolve('second file');
  await newer;
  first.resolve('first file');
  await older;
  assert.deepEqual(h.processes[0].commands.map(({ command }) => [command.path, command.text]),
    [['second.tex', 'second file'], ['first.tex', 'first file']]);
  assert.equal(h.session.diskTexts.get('first.tex'), 'first file');
  assert.equal(h.session.diskTexts.get('second.tex'), 'second file');
});
