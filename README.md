# Realtime TeX Enhanced

[中文安装说明](README.zh-CN.md)

An independently maintained fork of [Henry Yang’s Realtime TeX VS Code extension](https://github.com/HenryXiaoYang/realtime-tex-vsc-plugin), with sharper native text and formula rendering, scoped revision colors, responsive live delivery, and direct internal reference navigation.

**First release: Apple Silicon Mac (M series) only.** The matching enhanced `rtex 0.0.5+live.2` executable and complete Lua/TeX support are included in the VSIX. Engine updates are delivered only with a tested enhanced extension release. This extension does not check, download, clone or pull upstream engine updates.

## Install

1. Install desktop VS Code and LuaLaTeX with your document’s packages. TeX Live 2026+ is recommended; the release also has local regression coverage on TeX Live 2025. [MacTeX](https://www.tug.org/mactex/) supplies a full TeX environment. The VSIX includes the live engine, not the TeX distribution.
2. Disable the original **Realtime TeX** extension (`henryxiaoyang.realtime-tex`) if installed. The enhanced fork retains existing `realtimeTex.*` settings and shortcuts, so only one variant may be enabled.
3. Download the `.vsix` from this repository’s [Releases](https://github.com/hengmamath/realtime-tex-vsc-plugin-personal-version/releases).
4. In VS Code, open Extensions → `…` → **Install from VSIX…**, select the file, then reload the window if prompted.
5. Open a `.tex` file and run **Realtime TeX Enhanced: Open Live Preview to the Side** (`Cmd+Alt+V`). Run **Check Setup** if LuaLaTeX is not found. On a normal MacTeX install the binary folder is `/Library/TeX/texbin`.

Leave `realtimeTex.serverPath` and `realtimeTex.texDir` empty to use the verified bundled pair. If migrating settings from an older setup, clear those two overrides. An explicitly selected custom engine is an advanced override and is not guaranteed compatible.

No Rust, Git or separate rtex installation is required to use the released VSIX. Intel Mac, Windows and Linux need separately built and tested enhanced runtimes; they are not supported by this release.

## Included enhancements

- Sharper native Type1 text and formula rendering, enabled by default with no comparison switch.
- Revision colors preserved across paragraphs, lists, formulas, nested scopes and page breaks.
- Live editing of supported proofs containing references, `showonlyrefs`, revision wrappers and appendix structures.
- Click equation references to jump immediately. `Cmd+[` returns and `Cmd+]` goes forward within preview history.
- Latest compatible paragraph edits are delivered without waiting for unrelated background resources. Reusable high-resolution backgrounds avoid unnecessary redraws.
- A more visible scrollbar and a toolbar that recovers its natural height after narrowing and widening the panel.
- Existing PDF fallback, source navigation and export remain available.

A first full compile is still needed. Preamble changes, structural changes, complex graphics and content that cannot be safely replayed can require a background full compile. These checks preserve layout fidelity; the extension does not promise every edit is instantaneous.

## Update and rollback

Install a newer enhanced VSIX from this repository to update the extension and its matched engine together. Keep the previous installer to roll back. Legacy `installFrom=release/source` and `updateCheck=notify/auto` preferences do not download or update an engine in this fork. **Verify Bundled rtex Engine** verifies the packaged runtime rather than following upstream.

## Source, build and tests

The repository preserves both the extension source and the enhanced engine source:

- `src/`, `webview/`, `media/`: extension and preview.
- `vendor/engine/`: complete development source for the paired enhanced Rust/Lua engine, dependency lockfile, tests and source inventory.
- `resources/rtex-engine/`: released Apple Silicon executable, original enhancement patch, manifest and license.
- `resources/rtex-runtime/`: full matching runtime support tree and per-file checksums.
- `test/`: synthetic extension and live-engine regression fixtures.

With Node.js 22+:

```sh
npm ci
npm run verify:engine
npm run typecheck
npm test
npm run package
```

On a supported Apple Silicon Mac with LuaLaTeX available, run all packaged-runtime regressions:

```sh
RTEX_TEST_BUNDLED=1 RTEX_TEST_TEXLIVE_BIN=/Library/TeX/texbin npm test
RTEX_E2E_TEXLIVE_BIN=/Library/TeX/texbin npm run test:e2e
```

The first command also runs color, proof, formula-link and latest-edit delivery tests against the actual bundled engine. Tests for the optional legacy original-engine overlay are skipped unless `RTEX_TEST_TEXDIR` names an original v0.0.5 support tree. The E2E suite starts an isolated VS Code profile with synthetic documents and a fresh bundled-runtime configuration.

To rebuild the engine, install Rust/Cargo and run `npm run build:engine`. This builds the source already stored here using `Cargo.lock`; it never pulls a new upstream checkout or replaces the released binary automatically. Cargo downloads may be needed for locked dependencies. See [engine maintenance instructions](vendor/engine/README.enhanced.md) before publishing an engine change. A rebuild may differ byte-for-byte with toolchain/platform changes.

CI verifies the source/runtime pair, typechecks and tests the extension, and runs the bundled runtime plus isolated VS Code integration on Apple Silicon. A `v` tag matching `package.json` produces a versioned VSIX and SHA-256 checksum after those checks pass.

## Documents and privacy

Your papers stay on your computer. The repository and VSIX exclude local paper builds, screenshots, previews, debug bundles, personal configuration and temporary files. Debugging is off by default; if enabled, bundles can contain document source and remain in local storage. Do not commit those bundles. Test fixtures in this repository are synthetic or public upstream fixtures.

## Attribution and license

MIT. Original VS Code extension copyright © 2026 Henry Yang. The engine is based on realtime-tex `v0.0.5`, commit `e0ad11765ec016846b6e07619081f0528621636b`, copyright © 2026 Henry Yang and the realtime-tex contributors. Original copyright and permission notices are preserved in the root and engine/resource licenses. This enhanced fork is maintained independently and does not imply upstream endorsement.
