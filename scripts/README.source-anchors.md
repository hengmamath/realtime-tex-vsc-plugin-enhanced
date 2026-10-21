# Source-anchor experiment

Version 0.1.2 connects source anchors to Preview double-clicks. The paired
`0.0.5+live.3` engine carries non-drawing source anchors inside each exact compiled
result, together with its source snapshot revision. The extension enables
`RTEX_SOURCE_SYNC=1` only for that verified bundled runtime. Background and live
rows use their own source revisions; the host rebases lines through acknowledged
edits and refuses ambiguous deleted or pending locations. It does not search
paper text or interpolate through comments when this source map is in use.

The older `RTEX_ANCHORS` diagnostic experiment remains separate. Its sidecars and
hex result dumps are not used by production double-clicks. The scripts below test
the diagnostic heuristic; the real VS Code suite separately checks the production
transport, long proofs, REV, included files, edits, undo and a real webview double-click.
The existing sharp drawing and live updates are preserved; executable, Lua support
and both runtime manifests must be updated together.

## Repeatable checks

Run `npm test` for the extension and experiment-helper checks. On the supported
Apple Silicon Mac, enable the real LuaLaTeX tests with `RTEX_TEST_BUNDLED=1` and set
`RTEX_TEST_TEXLIVE_BIN=/Library/TeX/texbin` (or the matching TeX Live folder).
The inline-input regression exercises the packaged runtime, nested and repeated
inputs, filenames containing spaces, independently recorded SyncTeX filenames,
and byte-identical display lists with the experiment off/on.

Run `npm run verify:engine`, `npm run typecheck`, and then `npm run test:anchors`.
The last command uses only `test/fixtures/source-anchors`, puts outputs in a
temporary folder, and checks the source files remain unchanged. `--keep` preserves
that folder for diagnosis. No paper or generated output belongs in the repository.

Structural failures always exit nonzero. `--markers` additionally requires every
independent source marker to appear at the expected file and line. Without an
expectation policy, the `after` rule must be exact. `--expectations <JSON>` supplies
an explicit fixture policy: the checked-in policy tests all three experimental
rules and names each known exception by marker, source position, resulting
position, and reason. It does not accept a percentage threshold. Thus deleting a
test marker or substituting an unrelated error with the same score fails.

The current primary `after` rule gets 64 of 66 source markers exactly right.
`MKal1` and `MKal2` in `align*` still point to the display's closing line. The
comparison rules have further named limitations. These are recorded limitations,
not fixes or claims of word-level accuracy. Source columns are not measured.
SyncTeX agreement is reported separately from the independent marker checks;
the reference copy needs a recovered Input entry for the main file, which was
opened before capture enabled SyncTeX.

## Live evidence and timing

Each serialized edit checkpoints the live logs before sending the edit. A result
must be successful and match exactly one fresh anchor record from one server.
The script compares the complete decoded binary display list, not just row
geometry; stale, ambiguous, rewritten, truncated, or failed evidence is rejected.
The Lua server's request/context IDs are not the public edit/paragraph IDs, so
the script does not pretend they are interchangeable.

Opt-in live sidecars include the binary result as hex for this verification.
This adds diagnostic I/O and is not a proposed production transport. It is absent
when the experiment is off. Sidecar files contain rendered document content and
source locations, so keep them local like other build outputs.

For a small timing comparison run:

```sh
node scripts/source-anchors.mjs --project test/fixtures/source-anchors --main main.tex --timing 2
```

Add `--production` to compare the installed preview's direct source metadata
against anchors off, without diagnostic logs. This option is timing-only.

This warms the font cache, reverses off/on order between rounds, reports sample
counts and every fallback/error, and fails if samples are incomplete. Its engine
times include diagnostic sidecar output. It does not measure Preview latency or
prove long-paper performance. Current live marker scenarios are serialized; they
do not establish behavior during rapid typing, deletion, undo, or overlapping
background layouts. Background rebasing checks cover only unedited spans.

Engine crashes, invalid JSON, and timeouts reject pending requests; teardown also
stops child process groups before temporary outputs are removed.

## VS Code verification boundary

The isolated VS Code suite can check the default (anchors-off) preview, live
updates, recovery, links, export and fresh runtime selection. Its existing
`RTEX_E2E_SKIP_FAILED_PASS=1` compatibility switch excludes the known case where
a deliberately stopped full compile is not reported as failed by the older
engine. The unskipped review encountered that case; source and packaged 0.1.2
compatibility runs each passed 25 steps. That skipped case is not fixed here and must
not be reported as full coverage of compile-failure handling.
