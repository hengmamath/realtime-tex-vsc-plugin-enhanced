# Changelog

## 0.1.5

- Restore source-to-preview navigation for single and multiline formulas, including `align`, nested `aligned`/`split`, `multline`, `gather` and `$$`. Source double-clicks also accept operators and indentation. Resolve common logical formula rows from captured source ranges, including nested rows, continued source lines and multiple rows on one source line. Verify captured source revisions and retain block navigation when provenance is uncertain; keep reverse selection conservative.
- Bundle enhanced engine `0.0.5+live.9` and its matching support: math glyphs retain non-drawing source anchors and exact row ranges, including formulas without spacing. Add real-engine and native VS Code mouse/context-menu regressions for row targets, live row insertion/deletion and undo.

- Match custom build directories at path boundaries, so sibling TeX files and PDF figures with the same name prefix keep syncing while actual build outputs remain ignored.
- Keep document-close and file-watcher reads in one per-file order, including discarded edits and immediate reopen. A stale read cannot replace newer engine text or leave an obsolete editor shadow.
- Keep the PDF parser worker shared independently of individual documents, so cleaning up one PDF cannot reject another open or interrupt an existing document.
- Recognize absolute `\import` directories when choosing between main files, while keeping exact path matching for chapters with the same name.
- Focus the real VS Code test window before native undo commands and require a visible preview before pixel assertions, alongside the test-only Chromium occlusion flag. Retain strict PDF color checks, held-frame outline checks, and delayed-visibility and reset-before-frame regressions without changing production rendering.
- Keep external source-file updates in watcher event order: a late disk read cannot replace a newer result, even when the newer read fails. Preserve editor-buffer priority and independent updates to different files.
- Skip workspace file enumeration when the active file or its resolved `% !TEX root` chain already identifies the main document. Keep unsaved-buffer priority and the existing chapter fallback selection.
- Cold compiles, preloaded body passes and PDF exports now remove deleted snapshot inputs and refresh changed content even when size and timestamps are unchanged or older. Preserve unsaved text, generated Lua inputs, auxiliary files and standby working directories; compare large assets in bounded chunks and retain input ownership after interrupted copies.

- Add a resizable, collapsible document-outline sidebar from compiled PDF bookmarks, with page numbers, current-section highlighting and jumps through the existing reading history. Keep sidebar preferences per document, preserve reading position as it opens or closes, and use an overlay in narrow panels. No source parsing or personal bookmarks are required.
- Compact the preview toolbar: use the **◎ ▾** Source to preview menu, add back/forward buttons and a clickable page counter for page jumps, keep whole-document recompile as **↻**, and place engine restart, LaTeX log and main-file selection under **⋯**.
- Keep formula destinations available when an unrelated live edit redraws nearby content. Hyperref anchors carry no ink and may sit above their formulas; pixel clearing no longer removes them. Replaced rows still discard obsolete targets, live targets retain priority, and genuinely unresolved links suggest recompiling instead of claiming a layout update is in progress.
- Redraw every background page hidden by a live overlay when a layout moves or removes it, including cross-page paragraphs that were shortened or deleted. Restore their content and reference hit areas together.
- Keep the previous PDF canvas and its reference hit areas together while the matching new PDF opens. Missing or failed PDFs cannot reuse an older layout's pixels; obsolete opens remain cancelled across newer layouts and document switches.
- Apply the same graphics transforms to reference hit areas and destination points as to their painted text, including scaling, rotation, nested transforms and live row movement.

## 0.1.4

- Report preamble failures after a successful layout correctly: warm and cold compiles discard previous output artifacts before starting, and a warm engine must confirm preamble readiness before receiving its body. Keep the previous preview on failure, publish the failing LaTeX log, and recover a fresh layout and live editing automatically after correction. Keep body edits on the background path until the current preamble has a matching successful layout. Ignore obsolete startup results and reap failed startup processes. Remove the failed-preamble recovery test skip from both the suite and CI, and verify the complete scenario against source and the packaged installer.

- Recognize incomplete standard math arguments and delimiter pairs before live typesetting: unmatched `\left`/`\right`, missing fraction arguments and dangling scripts keep the previous result while being typed; completing them resumes live updates. Preserve valid unbraced arguments, custom macros, scoped delimiters and genuine TeX error recovery.
- Isolate live engine failures by source content. Unchanged failed content stays on full compiles; corrected content can retry on a fresh server after a one-second cooldown, with at most three live/probe failures per paragraph and preamble. Successful edits do not reset this failure limit. Failures from superseded requests do not discard queued fixes or attach stale errors to them. A failed probe snapshot is tracked separately from the current edit, and font prewarming remains available without crash loops.
- Bundle enhanced engine `0.0.5+live.6`. A formula, environment or brace still being typed (an unclosed or mismatched `$`, `\[`, `\begin{…}`, `{`) keeps its paragraph's last picture and no longer starts a full compile on each pause; closing it is typeset live at once, and only a structure left unfinished (or a live TeX error left in place) for two seconds is compiled and reported as TeX sees it.
- Run full compiles in typing pauses, never more than two seconds after one is needed, instead of back to back while typing continues elsewhere. A paragraph whose error a full compile reported is rechecked by the engine once it compiles cleanly; the extension's whole-document recompile one second after every edit while any error was listed is removed.
- Match math delimiters to their openers: converting `$…$` to `\[…\]` no longer restarts the live engine (with amsmath, `\[ … $` left the server's grouping out of step) and quarantines the paragraph. A paragraph verified live stays verified when a full compile caught it unfinished, or with a TeX error the live engine reported too, so fixing it is live at once; the probe no longer compiles an unfinished snapshot, and known failed content stays off the live engine even on a borrowed context.
- Typing `\begin{equation}` before its `\end` no longer hides and re-creates every paragraph after it. Deleting a paragraph removes its old picture at once instead of after the next full compile, and merged paragraphs are no longer drawn twice meanwhile. A second blank line added or removed between paragraphs, or Enter next to a setup line, starts no compile or engine restart.
- Live error results no longer carry TeX's error recovery as a display list; live errors are listed at their own file and line, and one paragraph's clean update no longer hides another paragraph's live error. The status pill returns from "Updating layout…" when a formula left open is closed live. The gutter keeps its span list in step with edits instead of fetching every span after each pause.
- Add a node-only keystroke benchmark (`npm run bench:math-typing`) that replays synthetic math typing against the real engine and Session.
- Fix lifecycle gaps: an export no longer leaves its progress notification open forever when the engine stops first; a closed file reverted externally is sent again; regenerated figures are reloaded by an open preview; switching documents frees decoded figures, and a late figure decode can no longer replace a newer one.
- Remove leftovers: the Windows/Git Bash task runner and its E2E step, unused setup exports, the unreachable legacy `texlive.env` import, constant engine-source fields, unused preview members and message fields, the test-only copy of the PDF fallback rule (now tested through delivery), the no-op X11 screenshot plumbing in the E2E suite and CI, and duplicate status emits and `setContext` calls per keystroke. Check Setup verifies the bundle once instead of twice.
- Ship third-party notices for pdf.js and opentype.js. Show Mac shortcuts (Cmd+Alt) in hints; the palette's "Verify Bundled rtex Engine" now runs the full verification; settings descriptions drop the Windows example and link the live editing guide.
- Use only the verified bundled enhanced engine and its complete matching support. Ignore legacy external-engine paths, remove the original-engine compatibility overlays and their tests, and retain TeX Live selection separately.
- Choose Single click, Double click (default), or Off for source-to-preview navigation from the Follow cursor menu. Source clicks use the same target highlight as Show Cursor Position in Preview; keyboard movement and typing leave the reading position alone. Retain an existing disabled legacy follow preference until a new mode is chosen.
- Locate source-to-preview jumps from captured visible source anchors, including REV, long proofs with comments, included files and live edits. Follow the current rendered rows and rebase their source lines after edits and undo instead of estimating a position through the whole proof.
- Draw supported static OpenType/TrueType glyphs through native browser fonts, using TeX's exact glyph IDs and positions. Prepare the private glyph mapping once per font and reuse it for live edits, including newly introduced characters.
- Keep Type1 drawing and PDF fallback; wait only for the affected page's fonts, release fonts on preview reset, and avoid constructing outline paths when native text is ready.
- Batch at most 64 adjacent OpenType glyphs only when their original advances agree with TeX's positions. Explicit spacing, color, font, baseline and expansion changes end a batch.
- Static standalone CFF OpenType and TrueType fonts use the new path. Variable fonts, font collections and color fonts retain compatibility handling; `cmgraded` math fonts with missing map entries still require PDF fallback.

## 0.1.3

- Refine Preview double-clicks within the source line already confirmed by the engine: ordinary text can land on the clicked word, and supported math can select its formula or a source fragment. When a single display is anchored to its closing delimiter, a fresh, bounded, structurally matched formula range can be selected.
- Keep the existing line destination when text or formula matching is ambiguous, unsupported, or stale. Custom macro expansion is outside the refinement scope.
- Compute refinement only on navigation, with bounded local source context; preserve the bundled `0.0.5+live.3` engine, enhanced drawing, and live-update path.

## 0.1.2

- Use source positions carried by the actual rendered rows for Preview double-click navigation, including live proof and REV updates and text from included files.
- Keep source lines aligned after edits, deletion and undo; preserve each live result's source snapshot and refresh unchanged background source metadata without redrawing identical pages.
- Stop guessing through a whole proof when the paired engine cannot confirm the clicked source location. Source navigation is line-based; complex formulas and macro-generated content can still have limited precision.
- Bundle the matching `0.0.5+live.3` engine and runtime. Production source mapping uses direct metadata without diagnostic sidecar logs, while enhanced drawing, colors, links and live updates remain intact.
- Harden the opt-in source-anchor experiment: record nested and repeated inline input filenames, match fresh live anchor records to their complete compiled result, and reject stale or ambiguous evidence.
- Add strict synthetic file-and-line acceptance checks with explicitly named current limitations. The diagnostic sidecar experiment remains disabled by default; production navigation uses direct metadata.

## 0.1.1

- Show page canvases with exactly their own device pixels at every zoom and screen scale, avoiding resampling that softens text and formulas.
- Recompute page geometry when Fit width and screen scale change together, even if the canvas keeps the same backing pixels; keep pages and formula links aligned after live edits.
- Keep a paragraph's last good result on screen while a live compile reports a TeX error, and resume live updates when the error is corrected.
- Recover from math that ends inside `\left` without restarting the live engine or leaving the paragraph on the full compile path.
- Avoid republishing unchanged diagnostics on each live update.
- Explain crash quarantine correctly and stop the first-compile status timer when its session is disposed.
- Retain the original paragraph-based reverse sync. The experimental word-matching implementation was withdrawn after incorrect source jumps and is not included in this version.

### Known limitation

- Reverse sync remains approximate within a paragraph or proof. Long proofs with large commented sections can still jump to an incorrect source line, including a comment. Accurate source mapping remains unresolved.

## 0.1.0

- First independently maintained Realtime TeX Enhanced release, with its own extension identity.
- Bundle enhanced rtex 0.0.5+live.2 and all matching TeX/Lua support files for Apple Silicon Mac; use the verified pair by default on a fresh installation.
- Remove upstream engine downloads, automatic update checks, source pulls and installer-script downloads. Engine updates ship only with a new enhanced VSIX.
- Preserve the full enhanced Rust/Lua engine source, dependency lockfile, provenance, tests and local build instructions.
- Retain enhanced native text clarity, scoped colors, visible scrollbars, live proof updates, direct formula links, reading history, asynchronous delivery and toolbar resize fixes from native.12.
- Keep documents, previews, screenshots and local temporary builds out of source control and extension packages.

## 0.0.2-native.12

- Let the preview toolbar shrink back to its natural height after the panel widens, keeping its minimum height separate from the measured page offset.
- Fit controls using their actual rows at any UI font size, and refit when status text, page numbers, or control visibility changes.
- Batch toolbar measurements per animation frame and avoid repeated text writes, keeping resize observers idle once the layout settles.

## 0.0.2-native.11

- Prepare live paragraphs independently of background layout resources and PDF reads, so compatible live updates no longer wait behind unrelated background work.
- Coalesce superseded updates for the same paragraph, merge pending page changes safely, and retain current live text when an older background task completes.
- Cancel obsolete PDF reads and guard asynchronous resources across preview reset, paper changes, and disposal.
- Preserve placement dependencies, enhanced native drawing, sharp background caches, colors, and reference navigation.

## 0.0.2-native.10

- Reuse unchanged page backgrounds at their original device resolution while drawing live edits, with a bounded raster cache and reusable composition buffer.
- Repaint only pages whose content, geometry, or used resources changed; ordinary text pages no longer repaint when a background PDF finishes loading.
- Load fonts and images from actual display-list usage so unused virtual-font descriptors do not trigger unnecessary full-PDF transfers.
- Treat the engine's document-wide PDF path as availability information; reload only when a changed page needs it, while retaining fallback for genuinely missing glyphs and unreadable fonts.
- Preserve enhanced native text, revision colors, live updates, genuine PDF fallback, and direct reference navigation.

## 0.0.2-native.9

- Follow reference links on the first click without the previous 350 ms double-click delay.
- Prevent a rapid second click from accidentally following a different link after the page moves.
- Keep Cmd/Ctrl-click source navigation, normal-text double-click source navigation, and Cmd+[ / Cmd+] reading history.

## 0.0.2-native.8

- Use Cmd+[ and Cmd+] for preview reading history on macOS, replacing its Cmd+Left/Right shortcuts.
- Retain direct reference jumps, enhanced text clarity and live updates.

## 0.0.2-native.7

- Jump directly to references without scrolling or highlight fade animations.
- Keep a separate reading history inside the preview: Cmd+Left returns to the previous reading position and Cmd+Right goes forward (Alt+Left/Right on other platforms).
- Scope navigation commands to the active Realtime TeX preview and preserve editor navigation elsewhere.
- Retain enhanced text clarity, revision colors, live proof updates and reference targets.

## 0.0.2-native.6

- Keep proofs wrapped in transparent revision-color environments eligible for live editing, including multi-paragraph scopes.
- Separate appendix sections and proofs into independent live units instead of grouping the whole appendix together.
- Make internal references clickable in the preview using link regions and named destinations from LuaTeX; update regions with live overlays and highlight the target.
- Clear temporary engine-error gutter markers when the next layout recovers.
- Keep enhanced native text drawing, scoped colors, visible scrollbars and the layout-fidelity safety checks.

## 0.0.2-native.5

- Keep paragraphs containing document references eligible for live updates when their captured reference context can be replayed safely.
- Clear removed mathtools reference markers before replay so cached fast-path state cannot leak between paragraphs.
- Use the paired engine and support fixes from the session build directory only for the recognized macOS arm64 release, with checksum guards and original-engine fallback.
- Retain enhanced text rendering, scoped colors and the visible preview scrollbar.

## 0.0.2-native.4

- Make the preview scrollbar wider, opaque and easier to see in light and dark themes.
- Keep a visible vertical track while a document is open, with a larger minimum thumb and clear hover/drag feedback.

## 0.0.2-native.3

- Preserve scoped colors across paragraphs, formulas, nested color changes, and page breaks in the live display list.
- Load the color fix from a session-local support tree for the supported rtex engine, while retaining enhanced native text drawing and live paragraph updates.

## 0.0.2-native.2

- Always use enhanced native text drawing for supported Type1 fonts, including live paragraph updates.
- Remove the rendering comparison buttons and test label. Previous comparison selections no longer affect rendering.
- Keep existing font fallbacks, zoom, navigation, and PDF export behavior.

## 0.0.1

First release.

- Live preview that re-typesets the edited paragraph through rtex's fast path and installs background layouts as they arrive.
- Native display-list renderer for OpenType/TrueType fonts (glyph indices) and Type1/TFM fonts (through `pdftex.map`), with colors, rules, images and graphicx transforms. Pages it cannot draw exactly fall back to the background PDF, rendered by pdf.js.
- Live markers next to the line numbers: a solid green bar beside the parts that update live as you type, a dotted amber bar beside the parts that wait for the full compile, with the reason on hover (`realtimeTex.editor.liveMarkers`).
- **Install rtex** downloads the prebuilt engine of the latest realtime-tex release (v0.0.2 and later) for Linux (x86_64, arm64), macOS (arm64, x86_64) or Windows (x86_64), checks its SHA-256 and unpacks it into the extension's storage; no Rust needed. **Install rtex (Build from Source)** still builds realtime-tex `main` with `cargo`, and `realtimeTex.installFrom` picks the default. Updates follow the way the rtex in use was installed (a newer release, or new commits on `main`). **Install TeX Live** downloads realtime-tex's installer script instead of cloning the repository.
- `realtimeTex.engine.fastBudgetMs` defaults to 50 ms, rtex's own default since 0.0.2.
- Windows support (realtime-tex `3741920`): the preview runs rtex natively on Windows. **Install rtex** and **Install TeX Live** run their scripts in Git Bash, the managed binary is `rtex.exe`, and lualatex is found as `lualatex.exe`. CI runs the integration suite on Linux, macOS and Windows.
- Two-way navigation: the preview follows the cursor, and a double-click in the preview jumps to the source.
- LaTeX errors and warnings in the Problems panel; a status pill and status bar entry that explain what the engine is doing.
- Export PDF, recompile, restart and stop commands; automatic main-file detection.
- Guided setup: walkthrough, **Check Setup**, one-click **Install rtex** (build from source) and an optional minimal TeX Live install.
- A first compile that fails or takes long explains itself (with the LaTeX log one click away) instead of waiting silently.
- Keep rtex up to date: **Update rtex Engine** pulls the latest realtime-tex, rebuilds it and restarts the engine; the `realtimeTex.updateCheck` setting (`notify` / `auto` / `off`) checks once a day.
- Follows realtime-tex `e5cab6a`: a full compile that produces no pages (`compile: Failed`) keeps the previous pages on screen with a banner (before the first layout it explains the failure); paragraphs rtex reports as `removed` are cleared; TikZ pictures reused from the picture cache are drawn from the PDF; new routing reasons are explained in plain words.
- Engine settings: `realtimeTex.engine.eligibility`, `realtimeTex.engine.fastBudgetMs`, `realtimeTex.engine.pictureCache` (passed to `rtex serve` only when changed, so older rtex builds still start); changing them restarts the engine.
- Removed the workaround for projects with subfolders: rtex creates them itself since `e324bef` (update rtex with **Update rtex Engine**).
- Debugging: `realtimeTex.debug.enabled` (and `realtimeTex.debug.directory`) makes rtex save a bundle for every live-engine failure; the extension announces each bundle with **Reveal Bundle** / **Copy Path**. **Open Debug Folder** opens the folder.
