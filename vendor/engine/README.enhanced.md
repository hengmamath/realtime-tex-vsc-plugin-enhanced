# Preserved enhanced engine source

This directory contains the complete development source needed to build the
paired Realtime TeX Enhanced engine. Building it does not clone or update any
upstream Git repository.

## Origin and included changes

- Upstream: <https://github.com/HenryXiaoYang/realtime-tex>
- Base tag: `v0.0.5`
- Base commit: `e0ad11765ec016846b6e07619081f0528621636b`
- Enhanced engine version: `0.0.5+live.3`
- License: MIT; the upstream copyright notice remains in `LICENSE`.
- Exact original enhancement patch: `../../resources/rtex-engine/source.patch`.
- Reviewed source inventory and SHA-256 checksums: `SOURCE.json`.

The enhancement patch is **already applied**. It includes Rust display-list
hyperlinks and destinations, auxiliary `showonlyrefs` markers, transparent
revision wrappers, appendix structure recognition, and the matching Lua drawing,
binary transport and live-serving support. Do not apply the patch a second time.
Later maintenance fixes to this source (for example the live server's recovery
from math that ends inside `\left`, in `tex/rtex-serve.lua`) are recorded in the
extension's `CHANGELOG.md` and Git history; `source.patch` stays the original
enhancement. Version `0.0.5+live.3` also carries optional source synchronization
metadata directly with each display list (`RTEX_SOURCE_SYNC=1`), with exact source
snapshot revisions and request origins. Its transport is documented in
`docs/display-list.md`; the separate `RTEX_ANCHORS` diagnostics stay opt-in.

All upstream Rust crates, dependency lockfile, source tests, TeX support,
development documentation, headers, examples, and non-generated fixtures are
preserved. The manifest lists omitted upstream workflow files, demonstration
media, benchmark result logs, and generated fixture build directories. No local
paper, user configuration, compiler cache, nested Git repository or build output
was copied into this source snapshot. The `.tex` fixtures here are public upstream
synthetic test documents.

## Verify and build

Install Rust/Cargo and Node.js, then run from the extension repository root:

```sh
node scripts/verify-engine.mjs
node scripts/build-engine.mjs
```

The build uses `cargo build -p rtex-cli --profile dist --locked` and writes to
`vendor/engine/target/dist/`. Cargo may download the exact dependencies recorded
in `Cargo.lock`; it never obtains a newer realtime-tex engine. The existing
released binary stays unchanged. Rust toolchain/platform differences can change
the binary checksum, so a source rebuild is not promised to produce
byte-identical machine code.

To run only Rust unit tests without the optional TeX integration suite:

```sh
cd vendor/engine
cargo test --workspace --lib --locked
```

Integration tests additionally need a compatible LuaLaTeX installation and the
packages described in the upstream `docs/development.md`. The extension's real
engine regression suite must use this engine and its matching `tex/` tree.

## Maintaining this independent version

Edit this preserved source directly. After reviewing an intentional source
change, refresh checksums with `node scripts/verify-engine.mjs --refresh-source
--source-only`. New source files must also be explicitly added to the `files`
inventory in `SOURCE.json`; generated build outputs must never be added.
When changing the engine version, update `Cargo.toml`, its workspace package
entries in `Cargo.lock`, and `SOURCE.json` together.

For a new tested Apple Silicon Mac engine release:

1. Build and test the source on the intended platform.
2. Deliberately replace `resources/rtex-engine/darwin-arm64/rtex` with the tested
   executable, preserving executable permissions.
3. Copy all runtime files from this `tex/` directory into
   `resources/rtex-runtime/tex/`, excluding only `experiments/` and `tests/`.
4. Update both resource manifests with the engine version, platform and SHA-256
   values, and update the legacy three-file overlay in `resources/rtex-color/`
   if its Lua support changed.
5. Run the verifier, extension tests and real-engine integration tests before
   packaging the extension. Keep the prior release available for rollback.

Do not replace only the executable or only the Lua support. Engine and TeX
support are one versioned runtime. Other operating systems/architectures require
their own tested binary and release support; this snapshot's existing binary is
for Apple Silicon macOS only.
