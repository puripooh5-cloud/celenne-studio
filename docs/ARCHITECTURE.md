# Architecture

Celenne Studio is split into layers that depend only downward. React components never touch pixel buffers directly; they call **actions**, which call **ops**, which push **commands** that mutate the **document model**. The **render engine** observes document changes and redraws only affected tiles.

```
UI (React: menu bar, options bar, toolbar, canvas, panels, dialogs)        src/ui
  ↓ actions (registry, shortcuts, menus, macros)                          src/app/actions.ts
Application state (zustand store: tools, dialogs, revision counters)       src/app/store.ts
  ↓ editor + document sessions                                             src/app/editor.ts, session.ts
Operations (layer, select, image, edit, filter, view ops)                  src/app/ops/*
  ↓ commands (undo/redo)                                                   src/history, src/commands
Document model (layers, masks, channels, paths, selection, guides)         src/document, src/selection
  ↓ change events
Rendering engine (compositor, display tiles, viewport renderers)           src/rendering
  ↓
Image-processing engine (tiled rasters, blending, resampling, filters)     src/image-engine, src/filters, src/brush, …
  ↓
PSD reader/writer + other formats                                          src/psd, src/formats
  ↓
Platform / storage (Electron bridge or browser fallback)                   src/app/platform, electron/
```

## Process model and security (Electron)

- **Main process** (`electron/main.ts`):
  - Serves the built renderer from a privileged `app://celenne/` protocol with a strict Content-Security-Policy: no `unsafe-eval`, `object-src 'none'`, scripts only from the app and blob workers.
  - Owns all file access. The renderer can only read or write paths the user granted through a dialog, a drop, the launch arguments or the recent-files list, plus the app's own recovery, scratch and preset folders.
  - Writes are **atomic**: a temp sibling file is written, then renamed over the target.
  - Holds a single-instance lock, handles `.psd`/`.psb` file associations, and reloads the renderer after a crash so recovery can be offered.
  - Auto-update (`electron/updater.ts`): electron-updater downloads; installs only files that match the Ed25519-signed release manifest (`electron/updateManifest.ts`), and only on quit.
  - Opt-in error reports (`electron/reports.ts`, `electron/reportFormat.ts`): scrubbed in the main process before they are saved; sent in the Sentry envelope format only with consent and a configured destination. Release settings are baked in from `celenne.release.json` (`electron/buildConfig.ts`).
- **Preload** (`electron/preload.ts`): exposes a narrow `window.celenne` bridge (`src/app/platform/bridge.ts`). `contextIsolation`, `sandbox` and `nodeIntegration: false` are enforced; the renderer has no Node access (verified by the packaging smoke test, `CELENNE_SMOKE=1`).
- **Browser fallback** (`src/app/platform/platform.ts`): the same UI runs in a plain browser for development and UI testing. It uses file pickers, downloads and IndexedDB for recovery and scratch data.

## Document model

`CelenneDocument` (`src/document/document.ts`) holds:
- the canvas (size, resolution, mode, bit depth) and ICC profile;
- a root group with the layer tree, plus guides, grid, alpha/spot channels, saved/work paths, smart-object sources and patterns;
- the selection, metadata, compatibility issues and PSD preservation data.

Every mutation emits `DocumentChange` events (`pixels`/`mask` with a dirty rect, `layer`, `structure`, `canvas`, `selection`, `channels`), batched per operation.

Layer kinds (`src/document/types.ts`):

| Kind | Notes |
|---|---|
| `pixel` | TiledRaster + offset |
| `group` | pass-through or isolated, collapsible |
| `adjustment` | one of 16 adjustment types, never adds alpha |
| `fill` | solid / gradient / pattern |
| `text` | styled runs + paragraphs; rendered raster cached; original PSD rendering kept until edited |
| `shape` | vector path + fill/stroke, live-shape origin |
| `smartObject` | embedded/linked source, transform quad, smart filters |

All layers share: name, visibility, opacity, fill opacity, blend mode, clipping, locks, color tag, raster mask (density/feather), vector mask, layer effects, advanced blending, and `metadata.psd` (raw preserved blocks keyed by layer id).

Pixel buffers never live in React state. The store holds only lightweight UI state and revision counters (`docRev`, `historyRev`, `viewRev`, `selectionRev`) that components subscribe to.

## Tiled rasters

`TiledRaster` (`src/image-engine/tiledRaster.ts`):
- **Sparse 256×256 tiles** in a map keyed by tile coordinate. Missing tiles read as a `fill` value, so a "reveal all" mask costs nothing.
- **Depth-generic storage:** `Uint8ClampedArray`, `Uint16Array` or `Float32Array`, accessed through `readFloat`/`writeFloat`.
- **Copy-on-write:** `snapshot()` shares tile references. A write clones only the touched tile. Undo stores tile deltas, not whole images.
- **Lazy mip pyramid:** each pyramid tile caches the child tiles it was built from and rebuilds only when they change. It is used for zoomed-out display, thumbnails and fast previews.

## Compositing

`compositeRegion(doc, rect, {level})` (`src/rendering/compositor.ts`) renders any region at any pyramid level. The algorithm:

- It works on a **premultiplied backdrop** with straight-alpha sources, using the W3C compositing formulas for all 27 blend modes. Dissolve uses a positional hash.
- **Groups:** isolated groups render into their own buffer, while pass-through groups composite directly into the backdrop.
- **Clipping groups** use a source-atop composite against the base layer's alpha.
- **Adjustments** apply to the backdrop in place, never adding alpha, modulated by their masks.
- **Masks:** raster masks (with density and feather) and vector masks (rasterized per region) multiply coverage.
- **Layer effects** render in Photoshop's stacking order within a padded region.
- **Overrides** (`LayerOverride`) substitute a layer's content during live previews (transform drag, filter preview, smart-object edits) without touching the document.

## Display pipeline

- `RenderEngine` (`src/rendering/renderEngine.ts`):
  - keeps 8-bit **display tiles** per pyramid level;
  - invalidates only tiles intersecting a change's dirty rect, padded by blur and effect extents;
  - runs a **time-budgeted** priority queue each frame (visible tiles first).
  - Stale tiles keep drawing until replaced (progressive refinement), and an LRU evicts beyond the cache budget.
- Viewport renderers, chosen in Preferences ▸ Performance (Auto = WebGPU, then WebGL 2, then Canvas 2D):
  - `WebGPUViewportRenderer` (`src/rendering/webgpuRenderer.ts`) and `WebGLViewportRenderer` (`src/rendering/viewportRenderer.ts`) draw tiles under the view transform (zoom, rotation, flip), draw the checkerboard in screen space and apply the **display 3D LUT** (document profile → monitor, optional soft proof); nearest-neighbour sampling when magnified.
  - `Canvas2DViewportRenderer` is the CPU fallback.
  - If the GPU is lost (driver reset), the view switches to WebGL 2 at once and tries WebGPU again a few seconds later.
- **GPU compositing** (`src/gpu/`, WebGPU only): `GpuCompositor` composites display tiles with compute shaders, mirroring `compositeRegion` operation for operation — the layer tree is walked on the CPU with the same skipping and clipping rules, and each blend / adjustment / group / clipping step is one dispatch on premultiplied f32 tile buffers. Layer pixels live in texture-array atlases (8-bit unorm, 16-bit uint, 32-bit float pages of 32 MB) and are re-uploaded only when a tile changes (`Tile.rev`); masks, vector masks, gradient / pattern fills and live-preview overrides are evaluated by the CPU code and uploaded. The composited tile stays on the GPU and the viewport samples it directly. A tile the GPU path cannot reproduce exactly (layer effects, knockout, Color Lookup tables larger than 65³, single-channel views, overlays, quick mask, soft proofing, Duotone / Multichannel / spot inks) is composited on the CPU instead, so a result is never wrong, only slower. CMYK documents are displayed on both paths through the same 33⁴ grid of the exact profile transform (`src/color/cmykDisplayGrid.ts`), so GPU and CPU tiles match.
  - Live previews of Gaussian Blur, Box Blur, Unsharp Mask and Image ▸ Adjustments run in the same compute pipeline (`LayerOverride.gpu`); applying a filter or adjustment, saving and exporting always use the CPU code.
  - `tests/gpu/` compares the GPU and CPU paths on headless WebGPU (Dawn, the `webgpu` dev dependency): composites agree to within 1/255 per channel (the largest difference in the suite is 0.007/255), display tiles to within 1/255.
- Overlays (marching ants, transform handles, guides, paths, brush cursor) are drawn on a separate 2D canvas.

## History

`History` (`src/history/history.ts`) is a command stack.
- A `Command` has `do`, `undo`, an optional `mergeWith` (consecutive slider drags merge within 1.5 s), `memoryBytes` and a `record` used for macros.
- Raster edits store tile snapshots (`RasterEditCommand`, `editRaster()`).
- Structural edits either use `DocumentStateCommand`, which captures the document state cheaply because tile storage is copy-on-write, or `ReplaceLayerCommand`.
- Named snapshots, a state limit and history purging are supported.

## PSD pipeline

`src/psd/`:

1. `container.ts` is a bounds-checked parser/serializer for the PSD/PSB container: header, resources, layer records and raw channel data, additional-info blocks and the merged image. It enforces limits on dimensions, layer and channel counts, and memory.
2. `cmyk.ts` converts CMYK containers to RGB before parsing (merged image and each layer's color channels; masks and alpha stay byte-exact).
3. `import.ts` parses with **ag-psd**, then maps to the Celenne model (`mapping.ts`). Along the way it:
   - records unknown blocks and resources per layer;
   - reads alpha channels, paths and DisplayInfo from the container;
   - decodes deep composites;
   - collects `CompatibilityIssue`s.
4. `export.ts` writes with ag-psd, then post-processes the container:
   - re-injects preserved raw blocks (matched by layer id), ICC, DisplayInfo and paths;
   - rebuilds the merged composite on a white matte;
   - writes 16-bit layer channels ZIP-with-prediction and 32-bit channels raw, with a depth patch and Lr16/Lr32 relocation;
   - lists pre-save notes (`analyzePsdExport`) the user confirms.
5. `compatibility.ts` is the feature matrix shown in the app and in [PSD_COMPATIBILITY.md](PSD_COMPATIBILITY.md).

## Color

`src/color/cms.ts` wraps LittleCMS (WebAssembly):
- builds the display LUTs and soft-proof transforms;
- converts pixels between profiles (with rendering intent and black-point compensation) and CMYK → RGB on import.

`src/color/icc.ts` generates ICC profiles for built-in spaces: sRGB, Display P3, Adobe RGB, ProPhoto, linear sRGB and gray gammas.

## Tools, filters, brush

- **Tools** (`src/tools`) implement `Tool { down, move, up, keyDown, drawOverlay, … }` against a `ToolHost` supplied by the canvas. They create commands; they never mutate state behind the history.
- **Filters** (`src/filters`) declare parameters, processing space (premultiplied or straight), padding and whether they need the whole image. They run in a **worker** with progress and cancellation (the worker is terminated on cancel). Smart filters re-run on the smart object's source.
- **Brush engine** (`src/brush`): `DabEmitter` produces dabs from pointer samples (spacing, smoothing, pressure, tilt, twist and velocity dynamics, jitter, scatter). Paint ops (paint, clone, heal, smudge, dodge/burn, …) apply them through a stroke buffer that caps stroke opacity.

## Extensibility

- **Actions** (`src/app/actions.ts`) are the single command surface for menus, shortcuts, the command palette and macros. Replay-only actions reproduce recorded operations with their arguments.
- **Plugins** (`src/plugins`) run in sandboxed workers (see [PLUGINS.md](PLUGINS.md)).
- **AI** goes through `AIProvider` (see [AI_PROVIDERS.md](AI_PROVIDERS.md)).
- **Formats** register importers and exporters in `src/formats/registry.ts`.

## Reliability

- **Auto-save** (`src/app/autosave.ts`) writes PSD/PSB recovery snapshots of modified documents at the interval set in Preferences, never over the user's file. A "running" marker detects abnormal exits and opens *Recovered Documents* on the next launch.
- **External changes:** saving over a file that changed on disk asks first.
- **Memory pressure:** display caches and mip pyramids are released when free memory drops below about 8%.
- **Robust import:** corrupt or hostile files fail with a clear message, never a crash. Damaged layer pixel data falls back to structure only, which is reported.
