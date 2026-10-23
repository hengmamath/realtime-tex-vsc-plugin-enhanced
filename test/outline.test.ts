import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { decodeOutlineString, documentIdFor, loadCompiledOutline, outlineDestinations, outlineViewState, parseCompiledOutline } from '../src/preview/outline';
import { PreviewModel } from '../webview/model';
import { findDestination } from '../webview/links';
import { realEngineFixture, realEngineUnavailable } from './realEngineFixture';

const destinations = new Map([['name:section.1', 2], ['name:subsection.1.1', 2], ['name:appendix.A', 4]]);
const octal = (value: string) => '\\376\\377' + [...Buffer.from(value, 'utf16le').swap16()].map(byte => '\\' + byte.toString(8).padStart(3, '0')).join('');
const hex = (value: string) => Buffer.from(value, 'latin1').toString('hex');

test('compiled bookmarks retain UTF-16 titles, nesting, and exact physical destinations', () => {
  const result = parseCompiledOutline({ out: String.raw`\BOOKMARK [1][-]{section.1}{` + octal('Intro x² and café {α}') + String.raw`}{}% 1
\BOOKMARK [2][-]{subsection.1.1}{A child}{section.1}% 2
\BOOKMARK [1][-]{appendix.A}{Supplement}{}% 3
\BOOKMARK [2][-]{missing.target}{Stale heading}{appendix.A}% 4
` }, destinations);
  assert.deepEqual(result.entries.map(({ title, level, target, page }) => ({ title, level, target, page })), [
    { title: 'Intro x² and café {α}', level: 1, target: 'name:section.1', page: 2 },
    { title: 'A child', level: 2, target: 'name:subsection.1.1', page: 2 },
    { title: 'Supplement', level: 1, target: 'name:appendix.A', page: 4 },
  ]);
  assert.equal(result.unavailable, undefined);
});

test('PDF string decoding handles escaped braces, PDFDocEncoding, and surrogate pairs', () => {
  assert.equal(decodeOutlineString(String.raw`A \173braced\175 title \046 \050round\051`), 'A {braced} title & (round)');
  assert.equal(decodeOutlineString(String.raw`A \204 B`), 'A — B');
  assert.equal(decodeOutlineString(octal('数学 ∑ and 𝒜')), '数学 ∑ and 𝒜');
});

test('bookmark package joins compiler aux hierarchy and outranks an obsolete .out', () => {
  const aux = String.raw`\providecommand\BKM@entry[2]{}
\BKM@entry{id=1,dest={` + hex('section.1') + String.raw`}}{` + hex(octal('New title α')) + String.raw`}
\BKM@entry{id=2,dest={` + hex('subsection.1.1') + String.raw`}}{` + hex(octal('Child')) + String.raw`}
\@writefile{toc}{\contentsline {section}{\numberline {1}A heading}{i}{section.1}}
\@writefile{toc}{\contentsline {subsection}{\numberline {1.1}A child}{i}{subsection.1.1}}`;
  const result = parseCompiledOutline({ aux, out: String.raw`\BOOKMARK [1][-]{section.1}{Obsolete}{}% 1` }, destinations);
  assert.deepEqual(result.entries.map(entry => [entry.title, entry.level, entry.page]), [['New title α', 1, 2], ['Child', 2, 2]]);
});

test('compiler contentsline fallback requires real named targets and parses nested titles', () => {
  const result = parseCompiledOutline({ toc: String.raw`\contentsline {section}{\numberline {1}\textbf{Intro {with} nested} \& café}{iii}{section.1}%
\contentsline {subsection}{\numberline {1.1}Child}{iii}{subsection.1.1}%
\contentsline {section}{Wrong destination}{12}{section.9}%
\contentsline {section}{Legacy without hyperref}{2}%
` }, destinations);
  assert.deepEqual(result.entries.map(entry => [entry.title, entry.level, entry.page]), [['1 Intro with nested & café', 1, 2], ['1.1 Child', 2, 2]]);
  assert.deepEqual(parseCompiledOutline({ toc: String.raw`\contentsline {section}{Unsupported}{1}` }, destinations).entries, []);
});

test('malformed or untrusted generated metadata cannot create arbitrary navigation', () => {
  const result = parseCompiledOutline({ out: String.raw`% \BOOKMARK [1][-]{section.1}{Commented title}{}
\BOOKMARK [NaN][-]{section.1}{bad depth}{}
\BOOKMARK [1][-]{section.1}{<img src=x onerror=alert(1)>}{}
\BOOKMARK [2][-]{section.1}{Duplicate}{}
\BOOKMARK [1][-]{javascript:evil}{Wrong destination}{}
\BOOKMARK [1][-]{appendix.A}{Truncated` }, destinations);
  assert.deepEqual(result.entries.map(entry => [entry.target, entry.title]), [['name:section.1', '<img src=x onerror=alert(1)>']]);
  assert.ok(parseCompiledOutline({}, destinations).unavailable);
});

test('sidebar preferences are isolated by a non-path document ID and clamped', () => {
  const id = documentIdFor('/synthetic/project/main.tex');
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.notEqual(id, documentIdFor('/synthetic/other/main.tex'));
  assert.equal(documentIdFor('/synthetic/project/../project/main.tex'), id);
  assert.deepEqual(outlineViewState({ open: true, width: 1, collapsed: ['a', 'a', 1, ''] }), { open: true, width: 200, collapsed: ['a'] });
  assert.equal(outlineViewState({ open: true, width: NaN, collapsed: [] }), undefined);
  assert.equal(outlineViewState({ open: 'true', width: 240, collapsed: [] }), undefined);
});

test('loader reads only bounded compiler sidecars and rejects aux traversal or symlinks', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rtex-outline-loader-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const build = path.join(root, 'build');
  await fs.mkdir(build);
  const malicious = String.raw`\contentsline {section}{Outside}{1}{section.1}`;
  await fs.writeFile(path.join(root, 'outside.aux'), malicious);
  await fs.symlink(path.join(root, 'outside.aux'), path.join(build, 'symlink.aux'));
  await fs.writeFile(path.join(build, 'main.aux'), String.raw`\@input{../outside.aux}
\@input{symlink.aux}
\@input{nested.aux}`);
  await fs.writeFile(path.join(build, 'nested.aux'), String.raw`\contentsline {subsection}{Child}{iv}{subsection.1.1}
\@input{main.aux}`);
  const result = await loadCompiledOutline(path.join(build, 'main.pdf'), destinations);
  assert.deepEqual(result.entries.map(entry => entry.title), ['Child']);
  const abort = new AbortController(); abort.abort();
  assert.deepEqual((await loadCompiledOutline(path.join(build, 'main.pdf'), destinations, abort.signal)).entries, []);
});

test('alternating compiler pass metadata must match the delivered PDF, not file recency', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rtex-outline-pass-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const main = path.join(root, 'main.pdf');
  const delivered = path.join(root, 'layout-7.pdf');
  await fs.writeFile(delivered, 'the displayed PDF');
  await fs.writeFile(main, 'a newer stable PDF');
  for (const [slot, pdf, title] of [['pass-0', 'unrelated PDF', 'Wrong pass'], ['pass-1', 'the displayed PDF', 'Displayed title']]) {
    const directory = path.join(root, slot);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'main.pdf'), pdf);
    await fs.writeFile(path.join(directory, 'main.rtex.json'), '{}');
    await fs.writeFile(path.join(directory, 'main.out'), String.raw`\BOOKMARK [1][-]{section.1}{` + title + '}{}');
  }
  assert.deepEqual((await loadCompiledOutline(main, destinations, undefined, delivered)).entries.map(entry => entry.title), ['Displayed title']);
  const result = await loadCompiledOutline(main, destinations);
  assert.deepEqual(result.entries, [], 'no completed matching pass means no speculative navigation');
  assert.match(result.unavailable!, /next complete layout/);
  await fs.rm(path.join(root, 'pass-1', 'main.rtex.json'));
  assert.deepEqual((await loadCompiledOutline(main, destinations, undefined, delivered)).entries, [], 'an unfinished standby is not a compiler result');
});

test('a pass reused during metadata reads cannot publish titles from the new pass', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rtex-outline-reuse-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pass = path.join(root, 'pass-0');
  await fs.mkdir(pass);
  const main = path.join(root, 'main.pdf');
  const passPdf = path.join(pass, 'main.pdf');
  await fs.writeFile(main, 'original PDF');
  await fs.writeFile(passPdf, 'original PDF');
  await fs.writeFile(path.join(pass, 'main.rtex.json'), '{}');
  await fs.writeFile(path.join(pass, 'main.out'), String.raw`\BOOKMARK [1][-]{section.1}{A title}{}`);
  const originalRead = fs.readFile;
  let reused = false;
  fs.readFile = (async (file: string, options: { encoding: 'utf8' }) => {
    const value = await originalRead(file, options);
    if (file.endsWith(path.join('pass-0', 'main.out'))) {
      reused = true;
      await fs.writeFile(passPdf, 'a newer and different PDF');
    }
    return value;
  }) as typeof fs.readFile;
  t.after(() => { fs.readFile = originalRead; });
  assert.deepEqual((await loadCompiledOutline(main, destinations)).entries, []);
  assert.ok(reused, 'the pass must be changed between PDF matching and sidecar completion');
});

test('bundled compiler outline follows recompiled heading titles, appendix anchors, and physical pages', {
  skip: realEngineUnavailable, timeout: 120000,
}, async () => {
  const fixture = await realEngineFixture('outline.tex');
  try {
    await fixture.start();
    const model = new PreviewModel();
    let applied = 0;
    const sync = () => {
      for (const layout of fixture.events.slice(applied)) if (layout.event === 'LayoutUpdate') {
        model.applyLayout({ pages: layout.pages_changed, pagesTotal: layout.pages_total, placements: layout.placements, keepFromRevision: null });
      }
      applied = fixture.events.length;
    };
    sync();
    const pdf = path.join(fixture.build, 'bg', 'main.pdf');
    const load = () => loadCompiledOutline(pdf, outlineDestinations(model.pages.values()));
    const settledOutline = async () => {
      // edit() can already schedule a pass before the explicit request_layout.
      // Its first converged event may therefore be immediately followed by another
      // pass reusing the slot. The real panel retries at that next layout event.
      let result;
      for (let attempt = 0; attempt < 250; attempt++) {
        sync();
        result = await load();
        if (result.entries.length === 5) return result;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`No settled compiled outline: ${JSON.stringify(result)}`);
    };
    const outline = await load();
    assert.equal(outline.entries.length, 5, JSON.stringify(outline));
    assert.deepEqual(outline.entries.map(entry => entry.level), [1, 2, 1, 3, 1]);
    assert.deepEqual(outline.entries.map(entry => entry.page), [1, 1, 2, 2, 3]);
    assert.match(outline.entries[0].title, /Introduction x² and café/);
    assert.equal(outline.entries.at(-1)?.target, 'name:appendix.A');
    for (const entry of outline.entries) assert.equal(findDestination(model, entry.target)?.page, entry.page);
    const at = fixture.source.indexOf('Second argument');
    const edited = await fixture.edit(at, at + 'Second argument'.length, 'Revised argument');
    await fixture.layout(edited.source_revision);
    sync();
    const revisedResult = await settledOutline();
    const revised = revisedResult.entries;
    assert.equal(revised[2].title, 'Revised argument');
    const preamble = fixture.source.indexOf('\\usepackage{hyperref}');
    const withBookmark = await fixture.edit(preamble, preamble + '\\usepackage{hyperref}'.length, '\\usepackage{hyperref,bookmark}');
    await fixture.layout(withBookmark.source_revision);
    sync();
    const bookmarkEntries = (await settledOutline()).entries;
    assert.deepEqual(bookmarkEntries.map(entry => [entry.title, entry.level]),
      revised.map(entry => [entry.title, entry.level]));
    assert.equal(bookmarkEntries[2].title, 'Revised argument');
    assert.equal(bookmarkEntries.length, 5);
  } finally { await fixture.close(); }
});
