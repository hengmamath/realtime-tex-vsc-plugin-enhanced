# Use the bundled enhanced engine

This extension includes and always uses the Apple Silicon Mac executable and all matching TeX/Lua support files. **Use Bundled rtex Engine** verifies the packaged pair. Legacy custom-engine paths are ignored.

The enhanced fork does not download upstream engines, pull source updates or run remotely fetched installer scripts. Install a newer enhanced VSIX from this repository to update the plugin and engine together.

Install LuaLaTeX separately; for MacTeX its executable folder is normally `/Library/TeX/texbin`, selectable through `realtimeTex.texliveBin`. Rust is needed only when developing and rebuilding the preserved engine source, as described in `vendor/engine/README.enhanced.md`.
