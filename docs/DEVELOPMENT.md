# Development

## Environment

- **Node.js 22 or newer** (developed with Node 24) and npm.
- **Windows 10/11 x64** for the desktop build and installers. The renderer and all tests also run on macOS and Linux.
- A GPU with WebGL 2 is recommended. Without one, Celenne falls back to the Canvas 2D renderer.
- No native build tools are required. There are no native Node modules; LittleCMS ships as WebAssembly.

```bash
npm install
```

The first install also downloads the Electron binary.

## Running

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server at http://localhost:5183; the full UI runs in a normal browser with file pickers, downloads and IndexedDB |
| `npm run dev:electron` | Starts Vite plus Electron pointed at it (hot reload in the desktop shell) |
| `npm run build` then `npm start` | Production build run in Electron (`app://` protocol, production CSP) |

In dev builds, `window.__celenneTest` exposes the app's own module instances (editor, actions, file ops, store, ops, PSD import/export, macros, plugins) for scripted UI testing from the devtools console or browser automation. It is stripped from production builds.

## Tests

```bash
npm test
```

| Suite | File(s) | What it checks |
|---|---|---|
| Engine | `tests/engine/core.test.ts` | tiled rasters (COW, 16-bit, fill, pyramid), all blend modes, compositing (opacity, masks, clipping, groups, adjustments, fill layers), adjustments, every built-in filter, history undo/redo, selection ops, brush spacing, Liquify, transforms |
| PSD round trip | `tests/psd/roundtrip.test.ts` | complex document structure, pixels, masks, channels, paths, guides, resolution, 16-bit precision, unknown-block preservation, corrupt-file rejection |
| Compatibility suite | `tests/psd/compatibility-suite.test.ts` | the 14 fixtures: open → render → edit → save → reopen → compare structure and pixels; CMYK conversion reporting; plus any files in `tests/fixtures/psd/external/` |
| Visual regression | `tests/visual/visual-regression.test.ts` | renders every fixture at 50/100/200 % and diffs against `tests/fixtures/reference/*.png`; writes `tests/visual/report/visual-report.{md,json}` |

Regenerate the fixtures and references after intentional format or rendering changes, then review the diff report before committing new references:

```bash
npm run fixtures -- --refs
```

**Testing with real Photoshop files:** copy `.psd`/`.psb` files into `tests/fixtures/psd/external/`, then run `npm test`. To test a file in place without copying it into the repository, run the harness below. It writes Celenne's render, Photoshop's stored composite, diff images, the re-saved file and a JSON report (render-vs-Photoshop pixel difference, round-trip structure and pixels, preserved data blocks) to the output folder:

```bash
node scripts/run-ts.mjs scripts/test-real-psd.ts "path/to/file.psd" "path/to/output-folder"
```

**Camera raw:** LibRaw is built to WebAssembly from `third_party/libraw` with the Emscripten SDK
(`scripts/raw/build-libraw.ps1`; the output `src/formats/libraw/libraw.{mjs,wasm}` is committed).

The raw tests use CC0 samples from raw.pixls.us, which are not stored in the repository. To fetch
them (about 265 MB, checked by SHA-256):

```bash
node scripts/raw/fetch-samples.mjs
```

**Packaging smoke test:** set `CELENNE_SMOKE=1` to start the built app, open any files given on the command line, report UI health and console errors as JSON on stdout, and exit non-zero on failure. On Windows (PowerShell):

```powershell
$env:CELENNE_SMOKE=1; & ".\release\win-unpacked\Celenne Studio.exe" C:\path\to\file.psd
```

In Git Bash, prefix the variable instead:

```bash
CELENNE_SMOKE=1 "release/win-unpacked/Celenne Studio.exe" tests/fixtures/psd/14-complex-professional.psd
```

**Drag performance benchmark:** `CELENNE_SMOKE_DRAG="docX,docY,dx,dy"` additionally Ctrl-drags the layer under that document point with real OS input events (60 moves at 60 Hz) and reports frame times, and whether the layer moved and was recorded in History. `CELENNE_SMOKE_SHOT=file.png` saves a screenshot after the drop.

```bash
CELENNE_SMOKE=1 CELENNE_SMOKE_DRAG="900,350,300,120" npx electron . path/to/file.psd
```

## Building installers

```bash
npm run dist
```

This produces `release/Celenne-Studio-<version>-setup.exe` (NSIS, per-user or for everyone, custom install directory). It is associated with `.psd`/`.psb` files. There is no portable version.

- The renderer and main process are fully bundled, so the packaged app contains no `node_modules`.
- Packaging copies Electron from `node_modules/electron/dist` (`build.electronDist`) instead of extracting a downloaded archive. This avoids `EPERM … rename win-unpacked.tmp` failures when antivirus scanning locks freshly extracted files.
- The builds are **not code-signed**; Windows SmartScreen will warn until a signing certificate is configured (`CSC_LINK`/`CSC_KEY_PASSWORD`, see the electron-builder docs).
- A macOS target (`dmg`) is configured but has not been built or tested.

## Code conventions

- Engine code (`image-engine`, `rendering`, `psd`, `filters`, …) must not import React or UI modules.
- UI never mutates the document directly: call actions or ops, which push commands.
- Pixel data stays out of React state; components subscribe to revision counters.
- Every unfinished feature must be marked `comingSoon` (actions and tools) or show a **Coming Soon** tag. No control may silently do nothing.
- Keep `src/psd/compatibility.ts` current; `npm run docs` regenerates `docs/PSD_COMPATIBILITY.md` from it.
