# Enhanced live-preview engine

Built from HenryXiaoYang/realtime-tex tag v0.0.5, commit e0ad11765ec016846b6e07619081f0528621636b, with source.patch applied. The complete already-patched build source, dependency lockfile, tests and MIT license are preserved in `vendor/engine/`; `vendor/engine/SOURCE.json` records every included file and its SHA-256.

This build imports mathtools showonlyrefs markers from each completed auxiliary snapshot. The paired rtex-serve.lua clears removed markers. It also recognizes transparent revision wrappers and structural appendix containers, and transports non-ink hyperlink regions and destinations. It retains the engine's layout-fidelity probe and all fallback checks.

The independently maintained extension uses only this bundled engine together with the complete matching support tree in `resources/rtex-runtime/tex`. Installation does not follow the original author's latest release. The standalone runtime verifies platform and SHA-256 values before use. Legacy executable and support-path settings are ignored. `source.patch` is preserved as an archival record of the initial enhancement, not as a runtime overlay.

From the extension repository root, run `node scripts/verify-engine.mjs` to verify the preserved source, binary and support-file pairing. Run `node scripts/build-engine.mjs` with Rust/Cargo installed to build from the checked-in source without downloading any upstream engine version. See `vendor/engine/README.enhanced.md` for maintenance and release instructions. Do not replace the released executable without updating and testing its paired runtime manifests. MIT license included.
