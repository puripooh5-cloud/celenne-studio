# Celenne Studio

A layered raster image editor for Windows (Electron + React + TypeScript), built around an editable, **non-flattening** PSD/PSB document model. macOS is architecturally supported (the platform layer is abstracted) but not yet packaged or tested.

> **Status: 0.3.0 — preview.** The document model, PSD pipeline, rendering engine and most tools are implemented and tested. The full list of what is and isn't done is in [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md). Anything unfinished is marked **Coming Soon** in the UI. No button pretends to work.

> **ArtCraft / PhotoCraft developers:** start with [NOTES_FOR_ARTCRAFT.md](NOTES_FOR_ARTCRAFT.md). Licence: MIT OR Apache-2.0 ([LICENSE](LICENSE)); LibRaw stays LGPL 2.1.

## Highlights

- **PSD & PSB, layered.** Open, edit and save back pixel, group, adjustment, fill, text, shape and smart-object layers. This includes masks, vector masks, clipping, 27 blend modes, layer effects, alpha channels, paths, guides, ICC profiles and 8/16/32-bit data. Unknown data blocks are preserved byte-for-byte. See [docs/PSD_COMPATIBILITY.md](docs/PSD_COMPATIBILITY.md).
- **Text that moves freely with Photoshop.** Celenne's own text engine (HarfBuzz shaping, Thai, vertical text, text on a path, warp) writes Photoshop's own text data. Photoshop opens Celenne's text as live text with no update prompt, laid out the same way. Celenne adds a composer of its own, optical margins and Fit Text to Frame. See [docs/TYPOGRAPHY.md](docs/TYPOGRAPHY.md).
- **Camera raw from every major brand.** CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF, SRW and DNG open as 16-bit ProPhoto images, developed by Celenne (LibRaw unpacks proprietary formats).
- **Never flattens silently.** Flat formats are always saved as copies. Bit-depth reductions and mode conversions ask first. Unsupported features are reported per layer.
- **Non-destructive editing:** 16 adjustment-layer types, fill layers, smart objects with smart filters, editable layer styles and live shapes.
- **Tiled engine:** sparse 256 px tiles, copy-on-write history, mip pyramids and time-sliced display rendering. The viewport runs on WebGPU (WebGL 2 and Canvas 2D fallbacks) with a 3D-LUT for color-managed display, and WebGPU compute shaders composite the layers and run blur / sharpen / adjustment previews; files are always produced by the CPU code.
- **Color management** with LittleCMS (WebAssembly): assign/convert profiles, soft-proofing with a CMYK profile, and CMYK files converted on open.
- **Tools:**
  - Painting: brushes with pressure/tilt dynamics, retouching (clone, heal, patch, content-aware fill), erasers.
  - Selection: marquee, lasso, magnetic lasso, magic wand, quick selection, object/subject selection, and Select and Mask.
  - Other: transforms (free, distort, perspective), crop/perspective crop, gradients, type, pen/shape tools.
- **Also:** Liquify, 24 filters, actions/macros, customizable shortcuts, a dockable workspace, multi-document tabs, auto-save and crash recovery.
- **Extensible:**
  - Sandboxed plugins: filters, exporters, panels and AI tasks. See [docs/PLUGINS.md](docs/PLUGINS.md).
  - A provider-neutral AI layer: local algorithms, your own HTTPS endpoint, or plugin models. See [docs/AI_PROVIDERS.md](docs/AI_PROVIDERS.md).

## Quick start

Requirements: **Node.js 22+** (tested with Node 24) and Windows 10/11 x64.

Install dependencies:

```bash
npm install
```

Run the UI in a browser at http://localhost:5183 (fast iteration; files are opened with pickers and saved as downloads):

```bash
npm run dev
```

Run the desktop app against the dev server:

```bash
npm run dev:electron
```

Run the automated tests:

```bash
npm test
```

Build the Windows installer into `release/`:

```bash
npm run dist
```

Publish a release (signed manifest, auto-update, optional code signing) with `npm run release`; see [docs/RELEASING.md](docs/RELEASING.md). What the app sends over the network is listed in [docs/PRIVACY.md](docs/PRIVACY.md).

More detail in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` / `dev:electron` | Vite dev server / Electron against it |
| `npm run typecheck` | `tsc --noEmit` over app, Electron, tests and scripts |
| `npm run build` | typecheck + renderer (Vite) + Electron main/preload (esbuild) |
| `npm start` | run the built app with Electron |
| `npm run dist` / `dist:dir` | NSIS installer / unpacked app (local builds, no auto-update) |
| `npm run release -- --to …` | release build: tests, code signing, signed update manifest, upload ([RELEASING.md](docs/RELEASING.md)) |
| `npm run release:keygen` | create the Ed25519 release key (once) |
| `npm run release:serve -- <dir>` | local update server for testing |
| `npm test` | unit, PSD round-trip, compatibility suite, visual regression |
| `npm run fixtures -- --refs` | regenerate the 14 PSD fixtures and reference renders |
| `npm run benchmark` | engine benchmark → `docs/BENCHMARK_RESULTS.md` |
| `npm run docs` | regenerate `docs/PSD_COMPATIBILITY.md` and the sample plugin |
| `npm run icon` | regenerate `build/icon.png` |

## Repository layout

```
electron/        main process (app:// protocol, CSP, file access allowlist, atomic writes) + preload bridge
src/
  app/           editor, sessions, actions, menus, shortcuts, file operations, ops/*, autosave, platform/
  document/      document model, layer types & factory, cloning
  image-engine/  tiled rasters, blend modes, matrices, resampling, blur/morphology
  rendering/     compositor, render engine (display tiles), viewport renderers (WebGPU/WebGL2/Canvas2D)
  gpu/           WebGPU device, GPU tile compositor and preview filters (WGSL)
  psd/           container parser/serializer, ag-psd mapping, import/export, CMYK transcoding, matrix
  history/ commands/  command pattern, undo/redo, raster/layer commands
  selection/ vector/ typography/ color/ adjustments/ effects/ filters/ brush/ layers/ formats/
  ai/            AI provider abstraction (local / cloud / custom)
  plugins/       sandboxed plugin host + sample plugin
  tools/         all canvas tools
  ui/            React UI: menu bar, options bar, toolbar, canvas, panels, dialogs
tests/           engine, PSD round trip, compatibility suite, visual regression, fixtures
scripts/         build, fixtures, benchmark, docs, icon
docs/            architecture, API, compatibility, plugins, AI, limitations, benchmark
samples/plugins/ sample plugin package
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [PSD compatibility](docs/PSD_COMPATIBILITY.md)
- [API (document model, commands, actions)](docs/API.md)
- [Plugins](docs/PLUGINS.md)
- [AI providers](docs/AI_PROVIDERS.md)
- [Development & testing](docs/DEVELOPMENT.md)
- [Benchmark](docs/BENCHMARK.md) and [latest results](docs/BENCHMARK_RESULTS.md)
- [Typography guide](docs/TYPOGRAPHY.md)
- [Known limitations](docs/KNOWN_LIMITATIONS.md)

## Licensing and trademarks

Celenne Studio is licensed under MIT OR Apache-2.0, at your option ([LICENSE](LICENSE), [LICENSE-MIT](LICENSE-MIT), [LICENSE-APACHE](LICENSE-APACHE)). The name and icon are not licensed for other products.

Celenne Studio uses original UI styling and icons; it contains no Adobe assets. "Photoshop" is a trademark of Adobe Inc.; Celenne Studio is not affiliated with Adobe. Third-party components: ag-psd, LittleCMS (lcms-wasm), fflate, UTIF, fast-png, React, zustand, flexlayout-react and Electron (MIT-licensed), the JPEG decoder of jpeg-js / pdf.js (Apache License 2.0, vendored in `src/formats/vendor/` for CMYK JPEG files), and LibRaw 0.22 for camera raw files (LGPL 2.1, built to WebAssembly as a separate, replaceable module; source, licence and build script in `third_party/libraw/`, also shipped with the app). Test fixtures from psd-tools are listed in `tests/fixtures/third-party/README.md`. The `webgpu` package (Dawn for Node, MIT) runs the GPU tests and benchmark headless; it is a development dependency and is not shipped.
