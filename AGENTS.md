# Maintaining Realtime TeX Enhanced

This is an independently maintained fork. The enhanced engine source is already
patched in `vendor/engine/`. Do not replace it with an upstream checkout, restore
upstream automatic update/install code, or apply `source.patch` again.

Preserve sharp native rendering, genuine live editing, scoped colors, direct
formula links, reading history and latest-edit delivery. Layout-fidelity checks
and genuine PDF fallback remain necessary.

The supported release is Apple Silicon macOS only. Engine selection must use only
the verified executable and complete matching support in `resources/` as one
pair. Legacy external-engine path settings are retained for migration and ignored.
New engine versions require coordinated source, executable, Lua/TeX support and manifest
updates. Follow `vendor/engine/README.enhanced.md`; do not edit the binary alone.

Use synthetic documents for tests. Never add a user's paper, screenshots, PDFs,
local configuration, debug bundles, source mirrors, build outputs or temporary
files to Git or release assets. `/live-test/` and `/releases/` are local ignored
directories. The VSIX uses an explicit file allowlist in `.vscodeignore`.

Before release run `npm run verify:engine`, `npm run typecheck`, and `npm test`.
On a supported Mac run actual engine regressions with `RTEX_TEST_BUNDLED=1` and
the isolated VS Code suite with `npm run test:e2e`. Test the packaged VSIX too:
`RTEX_E2E_EXTENSION_PATH` can select an extracted/installed package. Engine-source
changes additionally need a locked Rust build and relevant Rust tests. CI gates
release on those checks. Keep old GitHub releases for rollback.

The extension identity is `hengmamath.realtime-tex-enhanced`. Existing
`realtimeTex.*` commands/settings are retained for migration, so the original
extension must be disabled. Preserve original MIT notices and attribution.
