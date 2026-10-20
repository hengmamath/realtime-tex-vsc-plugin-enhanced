# Use the bundled enhanced engine

This extension includes the Apple Silicon Mac executable and all matching TeX/Lua support files. **Use Bundled rtex Engine** verifies them and clears old custom-engine overrides so that the packaged pair is used.

The enhanced fork does not download upstream engines, pull source updates or run remotely fetched installer scripts. Install a newer enhanced VSIX from this repository to update the plugin and engine together.

Keep `realtimeTex.serverPath` and `realtimeTex.texDir` empty for the supported default. Install LuaLaTeX separately; for MacTeX its executable folder is normally `/Library/TeX/texbin`. Rust is needed only when developing and rebuilding the preserved engine source, as described in `vendor/engine/README.enhanced.md`.
