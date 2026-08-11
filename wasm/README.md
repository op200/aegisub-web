# Aegisub core WASM boundary

`aegisub_core_api.h` is the stable C ABI consumed by the subtitle Worker. The current runnable build uses the TypeScript implementation behind the same request protocol because Emscripten is not installed in this workspace and Aegisub's `AssFile` still exposes wxWidgets types.

The native port should extract `AssFile`, dialogue/style entries, format readers and undo state into a wx-free target, implement this ABI, and compile it with Emscripten as a single-threaded module. The Worker protocol and React UI do not change when that module replaces the fallback.
