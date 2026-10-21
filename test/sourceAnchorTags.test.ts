import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import { prepareTestRuntime } from './runtimeFixture';

const exec = promisify(execFile);
type Anchor = [number, number, number, number, string];
type AnchorRow = { box_tag: number; box_line: number; a: Anchor[] };
type AnchorFile = { version: number; tags: Record<string, string>; pages: AnchorRow[][] };

// These children have no paragraph boundaries: the old paragraph/unit hooks only saw
// main.tex after both nested inputs had closed. Repeated inputs receive distinct tags.
test('source anchor tags cover nested and repeated inline inputs without changing drawing', {
  skip: !process.env.RTEX_TEST_BUNDLED &&
    'set RTEX_TEST_BUNDLED=1 to run against the complete matching anchor-capable support',
  timeout: 90000,
}, async () => {
  const root = path.resolve(__dirname, '..', '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rtex-anchor-inputs-'));
  try {
    const { texDir: support } = await prepareTestRuntime(root);
    const project = path.join(temporary, 'project');
    const cache = path.join(temporary, 'texmf-cache');
    await fs.cp(path.join(root, 'test', 'fixtures', 'source-anchor-inputs'), project, { recursive: true });
    await fs.mkdir(cache);
    const bin = process.env.RTEX_TEST_TEXLIVE_BIN;
    const executable = bin ? path.join(bin, process.platform === 'win32' ? 'lualatex.exe' : 'lualatex') : 'lualatex';
    const compile = async (anchors: boolean) => {
      const out = path.join(temporary, anchors ? 'on' : 'off');
      await fs.mkdir(out);
      const env: NodeJS.ProcessEnv = { ...process.env, TEXINPUTS: `${support}//:${project}//:`, LUAINPUTS: `${support}//:`,
        TEXMFVAR: cache, TEXMFCACHE: cache, RTEX_CAPTURE_DIR: out };
      if (anchors) env.RTEX_ANCHORS = '1'; else delete env.RTEX_ANCHORS;
      try {
        await exec(executable, ['-interaction=nonstopmode', '-halt-on-error', '-file-line-error',
          `-output-directory=${out}`, '-jobname=inline-inputs',
          '\\RequirePackage{rtex-capture}\\input{main.tex}'], {
          cwd: project, env, timeout: 60000, maxBuffer: 4 * 1024 * 1024,
        });
      } catch (error) {
        const detail = error as Error & { stdout?: string; stderr?: string };
        throw new Error(`LuaLaTeX anchor fixture failed: ${detail.message}\n${detail.stdout ?? ''}\n${detail.stderr ?? ''}`);
      }
      return out;
    };
    const off = await compile(false);
    const on = await compile(true);
    assert.ok(!(await fs.readdir(off)).some((name) => name.endsWith('.rtex-anchors.json')),
      'the default path must not produce anchor side files');
    const pages = (await fs.readdir(on)).filter((name) => /^inline-inputs\.rtex-page\d+\.json$/.test(name)).sort();
    assert.equal(pages.length, 1, 'the inline input fixture must fit on one page');
    for (const name of pages) {
      assert.deepEqual(await fs.readFile(path.join(on, name)), await fs.readFile(path.join(off, name)),
        'enabling anchor metadata must keep display-list drawing byte-identical');
    }
    const anchors: AnchorFile = JSON.parse(await fs.readFile(path.join(on, 'inline-inputs.rtex-anchors.json'), 'utf8'));
    assert.equal(anchors.version, 1);
    const rows = anchors.pages.flat();
    assert.ok(rows.length > 0);
    const referenced = new Set(rows.flatMap((row) => [row.box_tag, ...row.a.map((anchor) => anchor[2])]).filter((tag) => tag > 0));
    for (const tag of referenced) assert.ok(anchors.tags[String(tag)], `missing source file for referenced tag ${tag}`);

    // LuaTeX's own Input records provide independent evidence for each newly opened
    // child's tag. The main input predates enabling SyncTeX and is recorded by Lua.
    const sync = gunzipSync(await fs.readFile(path.join(on, 'inline-inputs.synctex.gz'))).toString('utf8');
    const inputs = new Map([...sync.matchAll(/^Input:(\d+):(.+)$/gm)].map((match) => [Number(match[1]), match[2]]));
    for (const name of ['inline.tex', 'nested part.tex']) {
      const tags = [...inputs].filter(([, filename]) => path.basename(filename) === name).map(([tag]) => tag);
      assert.equal(tags.length, 2, `both openings of ${name} must have independent SyncTeX tags`);
      for (const tag of tags) {
        assert.equal(path.resolve(project, anchors.tags[String(tag)] ?? ''), path.resolve(project, inputs.get(tag)!),
          `wrong input file for tag ${tag}`);
        assert.ok(rows.some((row) => row.a.some((anchor) => anchor[2] === tag && anchor[3] === 1)),
          `fixture must contain a line-1 anchor from ${name}, tag ${tag}`);
      }
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
