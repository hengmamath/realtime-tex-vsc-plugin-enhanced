# Writing regression tests

All committed documents are synthetic. The bundled-engine fixtures and isolated
VS Code runner create temporary projects; successful runs remove them. Failed UI
runs print their retained diagnostic directory. Never substitute a user's paper
into a committed fixture or package.

| Group | Exercises | Checks |
| --- | --- | --- |
| Real editing (`e2e/writingWorkflows.ts`) | Individual keyboard events, Backspace, Cmd+Z / Cmd+Shift+Z, selected text replacement, multiline paste event, Chromium composition updates and Unicode commit, multi-cursor input/undo, formatter batch, auto-save | Exact buffer, current visible ink, live updates, saved bytes, exported snapshot and PDF content agreement |
| Theorems and macros (`runInLive.test.ts`, `fixtures/theorem-macros.tex`) | Proof/theorem after run-in headings, theorem styles and shared numbering, custom/nested environments, optional arguments, operators, paired delimiters, local macro/color scopes, global macro replacement and restoration | Live/full line boxes and glyph positions, macro expansion in every affected paragraph, scoped definitions, resolved references, live editing after a macro change |
| Bibliography and project lifecycle (`bibliography.test.ts`, `e2e/writingWorkflows.ts`) | BibTeX and Biber, closed `.bib` changes, `.bib` editor save, citation addition/replacement/restoration, chapter discard/rename/delete/recreate, real Git checkout, moved project with spaces and Unicode in its path | Automatic watcher updates, current references, live citations after changes, last-good ink on failure, recovery, renamed source navigation, current export inputs and PDF content |

## Run

On the supported Apple Silicon Mac, with TeX Live installed:

```sh
npm run verify:engine
npm run typecheck
RTEX_TEST_BUNDLED=1 RTEX_TEST_TEXLIVE_BIN=/Library/TeX/texbin npm test
RTEX_E2E_TEXLIVE_BIN=/Library/TeX/texbin npm run test:e2e
```

Together, `npm test` and the full E2E suite cover all three groups, alongside the
existing rendering, navigation, PDF fallback and recovery checks. Run E2E with an unlocked, interactive desktop;
do not type into its isolated test window. To test a package, set
`RTEX_E2E_EXTENSION_PATH` to its extracted `extension` directory. For local
iteration only, `RTEX_E2E_WRITING_ONLY=1` selects the new editing/lifecycle group;
release verification must run the full suite.

The paste case drives Monaco's paste event without changing the system clipboard.
Composition uses Chromium's input protocol: it does not automate the macOS input
method's candidate window. The formatter is a synthetic provider exercising VS
Code's batch-edit path, not a third-party formatter compatibility test. Unsaved
`.bib` contents are not advertised as live: the save triggers their refresh.
These tests do not establish support for every LaTeX package, platform, font or
input method, nor replace long-duration writing checks.
