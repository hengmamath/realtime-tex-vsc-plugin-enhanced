# Preserved enhanced engine source

This directory contains the complete development source needed to build the
paired Realtime TeX Enhanced engine. Building it does not clone or update any
upstream Git repository.

## Origin and included changes

- Upstream: <https://github.com/HenryXiaoYang/realtime-tex>
- Base tag: `v0.0.5`
- Base commit: `e0ad11765ec016846b6e07619081f0528621636b`
- Enhanced engine version: `0.0.5+live.9`
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
Version `0.0.5+live.4` schedules background passes after typing pauses (bounded) and
lets a structure still being typed (an unclosed or mismatched math delimiter,
environment or brace) wait instead of compiling it on every pause; it matches math
delimiters to their openers, keeps units after a never-closed `\begin` as they were,
refreshes a layout's errors once their unit compiles cleanly, and leaves TeX's error
recovery out of live error results (`session/schedule.rs`, `docs/embedding.md`).

Version `0.0.5+live.5` extends this waiting to incomplete standard math arguments
and delimiter pairs, and ties crash isolation to failed source content. Changed
content can return to live editing on a fresh server after a short cooldown, with
a bounded retry budget; obsolete failures cannot discard already queued fixes.

Version `0.0.5+live.6` rejects stale outputs after a failed preamble in warm
and cold background passes. The warm engine explicitly signals that its preamble
is ready before it can receive the body release command. Failed passes preserve
the previous preview and publish their current log; correcting the preamble
automatically restores a fresh layout and live editing. Body edits cannot reuse
contexts captured before the current preamble revision. The full recovery test
is enabled in both source and packaged VS Code runs.

Version `0.0.5+live.7` synchronizes snapshot input contents independently of file
size and modification time, and removes deleted inputs for cold/warm passes and
PDF exports. A private inventory distinguishes mirrored inputs from files generated
by Lua in the snapshot. Interrupted copies retain ownership for the next refresh;
legacy snapshot contents are rebuilt in place before any reader starts. The
snapshot root and separate auxiliary/output directories are retained, as are
buffer overlays and the two alternating standby slots. Content comparison uses
bounded buffers; unchanged assets are not rewritten. This does not reload packages
already interpreted by a live or preloaded engine; restart after changing those.

Version `0.0.5+live.8` retains each converted math glyph's SyncTeX tag and source
line in private attributes before output routines can replace its location. Production
source synchronization adds one `mg` anchor per captured source location in each
visible row, including formulas such as `x` or a fraction with no math-spacing glue.
Nested aligned material retains its outer formula conversion location; collected
amsmath environments still identify their closing source line, so hosts resolve
verified formula blocks rather than guessing individual alignment rows. Rendering,
optional anchor diagnostics and the source transport format remain unchanged.

Version `0.0.5+live.9` adds explicit source ranges for common alignment rows.
A shared input filter marks each explicit row/cell with a private node attribute
before amsmath collects and replays it; nested alignments retain their own range.
Production `mr` anchors include the first visible glyph's actual baseline and an
end-exclusive UTF-16 source range, including same-line rows and continuation lines.
Ordinary `mg` anchors remain the fallback when macros or source syntax do not
identify a row reliably. Attribute assignments add no drawing nodes; source-sync
on/off drawing and layout records are tested for equality.

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
engine regressions use the released, verified executable and matching support in
`resources/`; the extension does not load a custom engine or a separate support
tree. Test source builds directly with the preserved engine's own test suite.

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
   values. The original `source.patch` remains an archival record of the initial
   enhancement; it is not a runtime overlay and must not be applied again.
5. Run the verifier, extension tests and real-engine integration tests before
   packaging the extension. Keep the prior release available for rollback.

Do not replace only the executable or only the Lua support. Engine and TeX
support are one versioned runtime. Other operating systems/architectures require
their own tested binary and release support; this snapshot's existing binary is
for Apple Silicon macOS only.
