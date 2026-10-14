# PSD / PSB compatibility

> Generated from `src/psd/compatibility.ts` by `npm run docs`. The same matrix is shown in the app under **Help ▸ PSD Compatibility Matrix**; the per-document report is under **Help ▸ Compatibility Report**.

**Read** = parsed from files · **Edit** = editable in Celenne · **Write** = written back on save · **Preserve** = kept intact when not editable.

- *Preserved* — the original data is carried through a save byte-for-byte (or re-emitted from the parsed structure) even though Celenne cannot edit it.
- *Rendered* — Celenne shows the pixels Photoshop stored in the file, but cannot recompute them.

| Feature | Read | Edit | Write | Preserve | Notes |
|---|---|---|---|---|---|
| Canvas size, resolution, guides, grid | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |  |
| RGB / Grayscale color mode | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | Grayscale is written as a Grayscale-mode file (one channel, gray profile). |
| Indexed Color / Bitmap | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | Edited natively as a single layer kept to the color table / black and white; written as flat Indexed (with transparency) or 1-bit Bitmap files. |
| CMYK color mode | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | Native: C, M, Y and K values are kept per layer, edited and written back exactly (8/16-bit), with the embedded CMYK profile. Levels / Curves Black channels round-trip. |
| Lab color mode | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | Native: L, a, b values are kept, edited and written back (8/16-bit). |
| Duotone color mode | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | Native: Grayscale data with the ink specification (names, colours, curves, editable overprint colours in Photoshop’s slot order) read and written in Photoshop’s Duotone Options layout; unedited files keep their original bytes and Photoshop’s stored rendering (resource 1066). |
| Multichannel color mode | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | Native: every channel is an editable ink (8/16-bit) with its name and display colour; no layers, as in Photoshop. |
| 8-bit channels | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |  |
| 16-bit channels | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | Written with ZIP-prediction layer data and Lr16 records. |
| 32-bit float channels | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | Linear light; raw float layer data. |
| PSB (Large Document Format) | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |  |
| Pixel layers | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |  |
| Groups (pass through / isolated) | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |  |
| Layer names, visibility, opacity, fill | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |  |
| Blend modes (27) | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |  |
| Clipping masks | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |  |
| Layer masks (density, feather) | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |  |
| Vector masks | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |  |
| Layer locks, color tags | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |  |
| Adjustment layers (16 types) | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | Matched to Photoshop's output (Levels, Curves, Brightness/Contrast, Exposure, Hue/Saturation including colour ranges, Color Balance including Preserve Luminosity, Photo Filter, Selective Color, Black & White, Channel Mixer, Invert, Posterize, Threshold, Gradient Map), measured on the full RGB cube. Vibrance uses Photoshop's own measured output, interpolated between ten levels. Color Lookup renders embedded .cube data; other LUT formats preserved. |
| Fill layers (solid, gradient, pattern) | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | Noise gradients render as solid gradients. |
| Text layers (content, styles, paragraphs) | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | Horizontal, vertical and path text open in Photoshop without an update prompt (its `Txt2` data is kept, updated, or built for Celenne documents); OpenType features and variable axes still prompt. Celenne-only composer / optical margins are kept in XMP. |
| Text warp / vertical text | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | Stored rendering shown until edited. After an edit, vertical text follows Photoshop's layout (upright characters, columns right to left) and Celenne's warp curves approximate Photoshop's. |
| Text on a path | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | The path, start / end markers and flip are read from Photoshop's text engine data and editable; Photoshop's rendering is shown until the text is edited. Celenne writes Photoshop's own path-text data: Photoshop opens it as live text on the path without a prompt, laid out within about 2 % of Celenne's. |
| Shape layers (paths, fill, stroke, live shapes) | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |  |
| Layer effects (10 types) | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | Shadows, glows, overlays, strokes and Bevel & Emboss match Photoshop within 1/255 on straight edges (measured); curved anti-aliased edges and Satin differ slightly. |
| Smart objects (embedded raster / PSD) | ✅ Yes | 🟡 Partial | ✅ Yes | ✅ Yes | Edit Contents, Replace, non-destructive transform, Celenne smart filters. |
| Smart objects (vector PDF/AI) | 🖼 Rendered | — No | 🔒 Preserved | ✅ Yes | Stored rendering shown; contents preserved. |
| Linked smart objects | ✅ Yes | 🟡 Partial | ✅ Yes | ✅ Yes | Relink via Replace Contents. |
| Photoshop smart filters | 🖼 Rendered | — No | 🔒 Preserved | ✅ Yes | Displayed from stored rendering. |
| Alpha channels | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |  |
| Spot channels | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | Edited as channels and shown printed with their ink colour and solidity (DisplayInfo, 13-byte records as Photoshop writes them). Merge Spot Channel keeps the layers (the ink becomes masked Color Fill layers). |
| Saved / work / clipping paths | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |  |
| ICC profile | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | Assign / Convert to Profile via LittleCMS. |
| XMP metadata, copyright, URL | ✅ Yes | 🟡 Partial | ✅ Yes | ✅ Yes |  |
| Document metadata (EXIF, IPTC, print settings, Content Credentials and colour-management settings) | ✅ Yes | — No | ✅ Yes | ✅ Yes | Kept, and updated on save as Photoshop does: EXIF size, resolution, colour space, app and date; print resolution; the halftone and transfer set for the colour mode. Documents without them get the blocks Photoshop writes for a new document (the generative AI record is only kept, never created). Content Credentials turned on are reported: Celenne does not add its edits to them. |
| Blend If ranges | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | Applied when rendering (split sliders included). |
| Knockout, channel restrictions | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | Shallow and deep knockout and R/G/B restrictions are applied when rendering. |
| Artboards | ✅ Yes | 🟡 Partial | 🔒 Preserved | ✅ Yes | Edited as groups. |
| Slices | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | User slices: Slice tool, Slices From Guides, Export Slices. |
| Layer comps, annotations | ✅ Yes | — No | 🔒 Preserved | ✅ Yes |  |
| Thumbnail | — No | — No | ✅ Yes | — No | A JPEG thumbnail (resource 1036) is written on save. |
| Timeline / video / 3D | 🟡 Partial | — No | 🔒 Preserved | ✅ Yes | Current frame shown. |
| Unknown layer / document data blocks | 🔒 Preserved | — No | 🔒 Preserved | ✅ Yes | Copied byte-for-byte. |

## Guarantees

- **Documents are never flattened** on open or when saving as PSD/PSB. Flat formats (PNG, JPEG, TIFF, WebP) are always written as a *copy*; the open document keeps its layers and PSD path.
- **Bit depth is never reduced silently.** Converting to a lower depth asks first; exporting a deep document to an 8-bit format says so and leaves the document untouched.
- **Unsupported features are reported.** On open, anything that is not fully editable produces the notice *"Some Photoshop features in this document are not currently editable. They have been preserved where possible."* with a per-layer report.
- **Missing fonts** are listed as *"Font not installed: [font name]"*; text keeps its stored rendering and original font names until edited or substituted.
- Before saving a PSD, Celenne lists anything that will be written differently (e.g. text rendered by Celenne, Indexed/Bitmap files being flat).

## Color modes

Celenne edits RGB and Grayscale (8, 16 and 32 bits per channel), CMYK and Lab (8 and 16 bits) natively, and Indexed Color and Bitmap (8-bit, single layer, as in Photoshop). CMYK documents keep every layer’s C, M, Y and K values (stored as Photoshop stores them, inverted ink) and are displayed and proofed through their CMYK profile; PSD files are written back in CMYK with their profile. Lab documents keep L, a, b. Image ▸ Mode and Edit ▸ Convert to Profile convert between modes through LittleCMS (rendering intent, black point compensation); without a CMYK profile the built-in “Celenne Coated CMYK (approximate)” profile is used. Duotone documents are Grayscale data with up to four inks (Image ▸ Mode ▸ Duotone), shown, exported and saved with their inks; Multichannel documents are ink channels without layers. TIFF, JPEG and PDF keep CMYK (and TIFF / PDF keep Lab); PNG and WebP receive the sRGB appearance.

## Test suite

The compatibility suite (`tests/psd/compatibility-suite.test.ts`) opens, renders, edits, saves, reopens and structurally compares each fixture below. Visual regression (`tests/visual`) renders every fixture at 50 %, 100 % and 200 % and compares with reference PNGs.

| # | Fixture | File |
|---|---|---|
| 1 | Simple one-layer PSD | `tests/fixtures/psd/01-simple-one-layer.psd` |
| 2 | Multi-layer PSD | `tests/fixtures/psd/02-multi-layer.psd` |
| 3 | Grouped PSD | `tests/fixtures/psd/03-grouped.psd` |
| 4 | Mask PSD | `tests/fixtures/psd/04-masks.psd` |
| 5 | Text PSD | `tests/fixtures/psd/05-text.psd` |
| 6 | Adjustment PSD | `tests/fixtures/psd/06-adjustments.psd` |
| 7 | Blend-mode PSD | `tests/fixtures/psd/07-blend-modes.psd` |
| 8 | Smart-object PSD | `tests/fixtures/psd/08-smart-object.psd` |
| 9 | Vector PSD | `tests/fixtures/psd/09-vector.psd` |
| 10 | Layer-effects PSD | `tests/fixtures/psd/10-layer-effects.psd` |
| 11 | CMYK PSD | `tests/fixtures/psd/11-cmyk.psd` |
| 12 | 16-bit PSD | `tests/fixtures/psd/12-16bit.psd` |
| 13 | Large PSB | `tests/fixtures/psd/13-large.psb` |
| 14 | Complex professional PSD | `tests/fixtures/psd/14-complex-professional.psd` |

These fixtures are **synthetic**: they are written by Celenne's own PSD writer (the CMYK file is written byte-by-byte) to exercise the listed structures deterministically. They are not files saved by Adobe Photoshop. To test real-world files, place `.psd`/`.psb` files in `tests/fixtures/psd/external/`; the suite opens, renders, saves and reopens each of them and compares their structure.

## Verified against Photoshop

A second corpus, `tests/fixtures/photoshop/corpus`, is **built by Adobe Photoshop 26.5** through its scripting interface from generated content (scripts in `scripts/photoshop/`): every blend mode and fill opacity, groups, masks, clipping, knockout, all adjustment types, fill layers, smart objects, layer effects, 16/32-bit, Gray, CMYK and Lab, plus probe files that isolate single formulas (gradients, Brightness/Contrast, Color Balance, effect falloffs). `tests/psd/photoshop-corpus.test.ts` renders each file and compares it with the composite Photoshop stored in it, against a per-file baseline (`corpus-baseline.json`, which also names the known gaps). The same files were saved by Celenne and re-saved by Photoshop to check that Photoshop reads Celenne files with the same layers and appearance (`scripts/photoshop/roundtrip-*.ts`).
