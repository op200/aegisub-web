# Aegisub Web

A local-first subtitle editor for modern browsers, Windows WebView2, and Android WebView. The browser application can edit ASS/SRT files, preview ASS-styled text over local video, display audio waveforms, autosave locally, and work offline after its first load.

## Development

```powershell
corepack enable
pnpm install
pnpm dev
```

Open the URL printed by Vite. Production checks:

```powershell
pnpm check
pnpm build
pnpm test:e2e
pnpm test:e2e:firefox
```

## Structure

- `src/core`: document model, ASS/SRT formats, undo runtime, and Worker client
- `src/workers`: subtitle and waveform workers
- `src/platform`: browser and native `HostAdapter` implementations
- `platforms/windows`: .NET 8 WebView2 shell
- `platforms/android`: Kotlin Android WebView shell
- `wasm`: stable ABI for the native Aegisub core extraction

The Pages workflow passes `PAGES_REPO` to Vite so the production artifact uses the repository subpath. GitHub Pages runs the single-threaded build and does not require cross-origin isolation.

## Native core status

The UI and Worker boundary are WASM-ready, but this machine does not have Emscripten. The runnable MVP currently uses the TypeScript core runtime. Replacing it with the native Aegisub implementation requires extracting the document model from wxWidgets and implementing `wasm/aegisub_core_api.h`. libass and FFmpeg are likewise isolated behind rendering/media boundaries and are not bundled in this first build.
