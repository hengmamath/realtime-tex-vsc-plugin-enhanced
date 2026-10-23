import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findMainFile, includes, isMainFile, magicRoot } from '../src/root';

test('magic root comment', () => {
  assert.equal(magicRoot('% !TEX root = ../main.tex\n\\section{A}'), '../main.tex');
  assert.equal(magicRoot('%!TeX root=thesis.tex\n'), 'thesis.tex');
  assert.equal(magicRoot('\\section{A}\n'), undefined);
});

test('documentclass detection ignores comments', () => {
  assert.ok(isMainFile('\\documentclass{article}\n'));
  assert.ok(!isMainFile('% \\documentclass{article}\n'));
  assert.ok(isMainFile(String.raw`\% \documentclass{article}`));
  assert.ok(!isMainFile(String.raw`\\% \documentclass{article}`));
});

test('include detection matches normalized paths and import directories', () => {
  assert.ok(includes(String.raw`\input{./chapters/../intro.tex}`, 'intro.tex'));
  assert.ok(!includes(String.raw`\input{intro}`, '../b/intro.tex'));
  for (const command of ['import', 'import*', 'subimport', 'subimport*']) {
    const source = `\\${command} {chapters/} {intro.tex}`;
    assert.ok(includes(source, 'chapters/intro.tex'), command);
    assert.ok(!includes(source, 'intro.tex'), command);
    assert.ok(!includes(source, 'other/intro.tex'), command);
  }
});

test('include detection respects escaped percent signs and linebreak comments', () => {
  assert.ok(includes(String.raw`\% \input{chapter}`, 'chapter.tex'));
  assert.ok(!includes(String.raw`\\% \input{old}`, 'old.tex'));
  assert.ok(includes(String.raw`\\\% \input{chapter}`, 'chapter.tex'));
});

test('include detection', () => {
  const main = '\\documentclass{book}\n\\begin{document}\n\\include{chapters/intro}\n% \\input{old}\n\\input{appendix.tex}\n\\end{document}';
  assert.ok(includes(main, 'chapters/intro.tex'));
  assert.ok(includes(main, 'appendix.tex'));
  assert.ok(!includes(main, 'old.tex'));
});

const files: Record<string, string> = {
  '/p/main.tex': '\\documentclass{book}\n\\begin{document}\n\\include{ch/one}\n\\end{document}\n',
  '/p/ch/one.tex': '\\chapter{One}\n',
  '/p/ch/two.tex': '% !TEX root = ../main.tex\n\\chapter{Two}\n',
  '/p/other.tex': '\\documentclass{article}\n',
};
const readFile = async (f: string) => files[f];
const candidates = Object.keys(files);

test('main file resolution', async () => {
  assert.equal(await findMainFile({ activeFile: '/p/main.tex', candidates, readFile }), '/p/main.tex');
  assert.equal(await findMainFile({ activeFile: '/p/ch/two.tex', candidates, readFile }), '/p/main.tex');
  assert.equal(await findMainFile({ activeFile: '/p/ch/one.tex', candidates, readFile }), '/p/main.tex');
  assert.equal(await findMainFile({ activeFile: '/p/ch/one.tex', candidates, readFile, configured: '/p/other.tex' }), '/p/other.tex');
  // not included anywhere and two candidates: ambiguous
  assert.equal(await findMainFile({ activeFile: '/p/loose.tex', candidates, readFile }), undefined);
});

test('main file resolution does not pick a different directory with the same child name', async () => {
  const sources: Record<string, string> = {
    '/p/a/main.tex': '\\documentclass{article}\n\\input{intro}',
    '/p/b/main.tex': '\\documentclass{article}\n\\input{intro}',
    '/p/b/intro.tex': '\\section{Intro}',
  };
  assert.equal(await findMainFile({ activeFile: '/p/b/intro.tex', candidates: Object.keys(sources),
    readFile: async (file) => sources[file] }), '/p/b/main.tex');
});

test('main file resolution matches absolute import directories without matching unrelated same-name files', async () => {
  for (const command of ['import', 'import*']) {
    const sources: Record<string, string> = {
      '/p/main.tex': `\\documentclass{article}\n\\${command}{/p/chapters/../chapters/}{intro}`,
      '/p/other.tex': `\\documentclass{article}\n\\${command}{/p/other/}{intro.tex}`,
      '/p/chapters/intro.tex': 'The selected chapter.',
      '/p/other/intro.tex': 'Another chapter with the same name.',
      '/p/unrelated/intro.tex': 'A chapter neither main file includes.',
    };
    for (const [activeFile, expected] of [
      ['/p/chapters/intro.tex', '/p/main.tex'],
      ['/p/other/intro.tex', '/p/other.tex'],
      ['/p/unrelated/intro.tex', undefined],
    ] as const) {
      assert.equal(await findMainFile({ activeFile, candidates: Object.keys(sources),
        readFile: async (file) => sources[file] }), expected, `${command}: ${activeFile}`);
    }
  }
});
