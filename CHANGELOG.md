# Changelog

## Unreleased

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
