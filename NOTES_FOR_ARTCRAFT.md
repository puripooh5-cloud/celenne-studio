# Notes for the ArtCraft / PhotoCraft team

Hi! This is **Celenne Studio**, a Photoshop-class image editor that has been developed separately
from PhotoCraft. Its code is shared here so PhotoCraft can use whatever helps: the code, the
measurements, the test files or the lessons. This page tells you where to look first and what to
watch out for.

- **Licence:** see [`LICENSE`](LICENSE). It covers everything in this repository except the
  third-party parts listed under [Licences and clean-room](#licences-and-clean-room).
- **Questions:** open an issue on this repository, or ask in the ArtCraft Discord.

## The short version

| | Celenne Studio | PhotoCraft |
|---|---|---|
| Language | TypeScript (about 49,000 lines in `src/`) | Rust |
| Shell | Electron + React, WebGPU compositor | egui/eframe on wgpu |
| PSD | own reader/writer on top of ag-psd (`src/psd/`) | own |
| Tests | Vitest, about 620 tests, including a 170-file Photoshop corpus | cargo |

PhotoCraft is Rust only, so this code is something to **port, not paste**. The most useful parts
are the **rules and formulas** (they are language-neutral and each is backed by a test), the
**Photoshop-made test files** and the **scripts that drive Photoshop** to measure it.

## Where Celenne can help most

These are ordered by PhotoCraft's own [roadmap](https://github.com/storytold/photocraft/blob/main/ROADMAP.md),
where "PSD that Photoshop trusts" is item 1.

### 1. PSD files that Photoshop opens without complaint

Related PhotoCraft issues: [#1281](https://github.com/storytold/photocraft/issues/1281) (version
error) and [#2469](https://github.com/storytold/photocraft/issues/2469) ("program error"). I have
not reproduced those bugs, so I can't say these points fix them. They are what Celenne had to get
right for Photoshop 2025 (26.5) to open its files cleanly:

| Rule | Where |
|---|---|
| Write the document metadata blocks Photoshop writes for a new document: 1012–1017 halftone and transfer (one set per colour mode), 1028 IPTC, 1058 EXIF, 1083 print style, 1092, 10000 print flags, plus the global blocks `CAI ` and `OCIO`. Never create `GenI` (the generative AI record): you can't know whether AI was used. | `src/psd/docMetadata.ts` |
| Global (document-level) tagged blocks store the **exact data length**, with the padding written after it. For example `CAI ` is 77 bytes followed by 3 bytes of padding, not a length of 80. Layer-level blocks and `Layr`/`Lr16`/`Lr32` keep the padded length. | `src/psd/container.ts` `writeInfoBlock` |
| Descriptors must round-trip byte for byte. A key stored with an explicit length of 4 is different from a 4-character class ID, and Photoshop notices. Celenne keeps such keys as `#key`. | `src/psd/descriptor.ts` |
| EXIF: patch the existing block in place (size, resolution, colour space, app, date), appending values that got longer, rather than rebuilding it. Build Photoshop's layout only when there is none. | `src/psd/exif.ts` |
| `1083` print style: `Rslt` is the document resolution. | `src/psd/docMetadata.ts` `printStyle` |
| Text layers: keep, update or build Photoshop's `Txt2` engine data. Otherwise Photoshop asks to "update" every text layer. | `src/psd/txt2*.ts`, [`docs/TYPOGRAPHY.md`](docs/TYPOGRAPHY.md) |
| 16-bit layers: ZIP-with-prediction channel data plus `Lr16` records. 32-bit layers: raw float. | `src/psd/export.ts` |

**How we check it:** `scripts/photoshop/open-probe.ps1` opens a file in Photoshop and reports any
dialog or prompt. `roundtrip-export.ts`, then `resave.ps1`, then `roundtrip-compare.ts` save in
Celenne, re-save in Photoshop and compare the pixels. See
[`tests/fixtures/photoshop/README.md`](tests/fixtures/photoshop/README.md).

The full feature-by-feature matrix is in [`docs/PSD_COMPATIBILITY.md`](docs/PSD_COMPATIBILITY.md).

### 2. Adjustment layers that match Photoshop's pixels

Every adjustment was fitted against Photoshop renderings of probe images: a 32-step RGB cube and
random colours, in `scripts/photoshop/cases-photoprobes.jsx` and `photoprobe-images.ts`. Largest
difference on the corpus, on a 0–255 scale:

| Adjustment | Before | Now | What made the difference |
|---|---:|---:|---|
| Vibrance | 37 | 2 | Measured 32³ tables at 10 levels, mixed in **linear** light. Saturation is applied in linear light around ProPhoto Y (0.288, 0.7119, 0.0001). |
| Photo Filter | 21 | 4 | Mix the filter colour with white in linear light, then multiply in D50 XYZ relative to white (one 3×3 matrix on linear sRGB). Preserve Luminosity uses SetLum (weights 0.3 / 0.59 / 0.11) plus ClipColor. |
| Color Balance | 32 | 3 | With Preserve Luminosity, shift each range before the curves: shadows by −max, midtones by −(max+min)/2, highlights by −min. When the black point is at or above the white point, the curve is a step at the white point. |
| Selective Color | 8 | 2 | Per range: apply the full change and clip it, then blend by weight. The change is `((−1−a)·k − a)·(relative ? 1−v : 1)`. |
| Hue/Saturation (ranges) | 8 | 6 | Grays are untouched. Range lightness moves toward the max channel (up) or the min channel (down). The saturation boost is Σ w·s/(1−s), capped at 1/S−1. Lightness is applied before the boost. |

The code is `src/adjustments/apply.ts`, with the GPU versions in `src/gpu/adjustEncode.ts` and
`shaders.ts`. The tests are `tests/engine/photoAdjustments.test.ts`, plus the corpus test.

What's still off:
- Hue/Saturation master plus a range, on pastel reds: up to 18.
- Narrow Hue/Saturation ranges: up to 10.
- Vibrance between the measured levels: 5–10.
- Photo Filter with Preserve Luminosity at the gamut edge: up to 9.

### 3. Camera raw (PhotoCraft's roadmap: 45%)

- **Proprietary formats** (CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF, SRW): LibRaw 0.22.2 compiled to
  WebAssembly unpacks the sensor data (`third_party/libraw/`, `src/formats/libraw.ts`). Celenne's
  own code develops it (`src/formats/rawDevelop.ts`), and DNG goes through the same stages:
  1. black level (per-channel and table),
  2. white balance,
  3. Malvar–He–Cutler demosaic for Bayer sensors (X-Trans gets a simpler average),
  4. camera matrix to ProPhoto RGB,
  5. 16-bit output.
- **Accuracy:** for one camera from each of 10 brands, Celenne's result is within ΔE2000 0.04–0.32
  (mean) of LibRaw's own development. A 24-megapixel file opens in about 1.5 s.
- **Pitfalls we hit:**
  - LibRaw's `baseline_exposure` is −999 when absent, so guard it.
  - LibRaw's crop is relative to the sensor, not to the visible area.
  - For a fair reference, `adjust_maximum_thr` must be 0.
  - Image sizes match Photoshop for 6 of the 10 cameras. Adobe trims some cameras using its own
    tables, which we did not copy.
- **Test files:** 11 CC0 files from raw.pixls.us, downloaded by `node scripts/raw/fetch-samples.mjs`
  and checked against SHA-256 values in `tests/fixtures/raw/samples.json`. They are not stored in
  the repo.
- For Rust, you'd use a native raw decoder. The development stages in `rawDevelop.ts` are
  Celenne's own code and port directly.

### 4. Measuring Photoshop itself (Windows, COM)

`scripts/photoshop/` builds test documents in a real Photoshop, saves them and compares results:
- `build-corpus.ps1 -Only <prefix> -Cases <file.jsx>` runs the `cases-*.jsx` builders;
- `resave.ps1` re-saves files in Photoshop;
- `open-probe.ps1` opens a file and catches prompts;
- `compare-corpus.ts`, `photoprobe-compare.ts` and `roundtrip-compare.ts` do the comparisons.

The scripts are written to be safe on someone's working machine:
- They close **only the documents they opened**, and never quit Photoshop while other documents
  are open.
- `build-corpus.ps1` sets Maximize Compatibility to Always while it runs and restores the user's
  setting afterwards.

PhotoCraft's `photocraft-corpus` uses the same idea, so these scripts and cases may slot straight
in.

### 5. Test files you can reuse

- `tests/fixtures/photoshop/corpus/`: 170 PSDs built by Photoshop 26.5 from scripts, each with
  Photoshop's own composite. `corpus-baseline.json` records the expected difference per file. They
  cover:
  - blend modes and fill opacity;
  - groups, masks, clipping and knockout;
  - every adjustment layer and fill layer;
  - smart objects;
  - 16- and 32-bit, Gray, CMYK and Lab;
  - layer effects;
  - single-formula probes.
- `tests/fixtures/photoshop/text/` and `new-docs/`: text layers and Photoshop's blank new
  documents (the metadata blocks above).
- `tests/fixtures/photoshop/duotone-renderings.json`: 73 Duotone specifications with Photoshop's
  rendering of each.

All content in these files is generated: clouds, shapes, ramps and made-up text. There are no
photos, presets or third-party images.

### 6. Smaller things worth a look

- **Colour modes:** native CMYK, Lab, Duotone, Multichannel, Indexed and Bitmap documents
  (`src/color/`, `src/document/`).
- **Layer effects:** within 1/255 of Photoshop on straight edges (`src/effects/render.ts`).
- **Type engine:** layout, OpenType shaping through HarfBuzz, vertical and path text
  (`src/typography/`, [`docs/TYPOGRAPHY.md`](docs/TYPOGRAPHY.md)).
- **Security model:** sandboxed renderer, user-granted file access only, atomic writes, resource
  limits on every parser, and a signed auto-update manifest. See
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Licences and clean-room

Celenne follows the same clean-room rule as PhotoCraft: no Adobe code, shaders, icons, profiles or
UI assets. Behaviour was matched by **observation**, by rendering in Photoshop and measuring.

These parts contain data that was measured from, or written by, Photoshop. Check each against your
own clean-room rule before taking it:

| File | What it is |
|---|---|
| `src/adjustments/vibranceTables.ts`, `brightnessContrastTables.ts` | Curves and tables measured from Photoshop's output on test images (by `gen-vibrance-tables.ts` and `gen-bc-tables.ts`). |
| `src/psd/txt2Template.ts` | The document-level part of a `Txt2` block as Photoshop wrote it (default style sheets and composer settings), with the text removed. Used when a document has no `Txt2` of its own. |
| Constants in `src/psd/docMetadata.ts` | Photoshop's default halftone, transfer and print-flag values, read from its new documents. |
| `tests/fixtures/photoshop/` | Files saved by Photoshop (test data only, not shipped). |

Third-party parts keep their own licences:

| Part | Licence |
|---|---|
| LibRaw (`third_party/libraw/`, `src/formats/libraw/`) | **LGPL 2.1** (or CDDL 1.0), not MIT. Shipped as a separate, replaceable WebAssembly module, with its source included. |
| psd-tools fixtures (`tests/fixtures/third-party/`) | MIT |
| jpeg-js / pdf.js JPEG decoder (`src/formats/vendor/`) | Apache 2.0 |
| npm dependencies | Mostly MIT (ag-psd, lcms-wasm, fflate, UTIF, fast-png, React, zustand, flexlayout-react, Electron, harfbuzzjs). Check `package.json`. |

The name "Celenne Studio" and its icon (`build/icon.png`) identify this project. Please don't use
them for another product. "Photoshop" is a trademark of Adobe Inc.; neither project is affiliated
with Adobe.

## Running it

You need Windows and Node 22 or later. macOS should work but has never been built.

```bash
npm ci
npm test                 # about 620 tests; raw tests skip unless you fetch the samples
npm run dev:electron     # the app with hot reload
node scripts/raw/fetch-samples.mjs   # optional: the 265 MB of CC0 raw samples
```

- Rebuilding LibRaw needs the Emscripten SDK: `scripts/raw/build-libraw.ps1`. The built
  `libraw.wasm` is already in the repo.
- Corpus scripts need Photoshop installed.
- More detail is in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Map of the docs

| Doc | For |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Layering, process model, security |
| [`docs/PSD_COMPATIBILITY.md`](docs/PSD_COMPATIBILITY.md) | What is read, edited, written and preserved, feature by feature |
| [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) | What is partial or approximate. Read this before trusting a feature. |
| [`docs/TYPOGRAPHY.md`](docs/TYPOGRAPHY.md) | The text engine and `Txt2` |
| [`docs/PHASE4_PLAN.md`](docs/PHASE4_PLAN.md) | Current work: photo adjustments (done), camera raw (done), raw layers and DNG next |
| [`docs/BENCHMARK_RESULTS.md`](docs/BENCHMARK_RESULTS.md) | Performance numbers |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed when. 0.3.0 is the last release; 0.4.0 work is in the code. |
