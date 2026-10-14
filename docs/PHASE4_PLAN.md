# Phase 4: Photographs

**Goal:** photographers can open any camera's raw files in Celenne, develop them without losing
quality, and move the result between Celenne and Photoshop freely.

Photoshop is the reference for compatibility, not the design to copy. Photoshop develops raw files
in a separate dialog, Camera Raw. Celenne makes the raw file a layer you can re-develop at any time,
right in the Properties panel.

**What "work freely" means here:** a raw photo developed in Celenne and saved as a PSD opens in
Photoshop with no prompt, as a Camera Raw smart object Photoshop can edit. A raw smart object made
in Photoshop opens in Celenne with its settings. Where the two apps cannot render a photo the same
way, the app says so instead of hiding it.

## Where things stand (0.3.0)

- **DNG** is fully decoded. The pipeline covers:
  - the as-shot white balance and baseline exposure;
  - demosaicing: Malvar–He–Cutler for Bayer sensors, a neighbourhood average for other layouts;
  - the camera colour matrix;
  - 16-bit ProPhoto RGB output.

  Not done yet:
  - lens corrections and gain maps (DNG opcode lists);
  - camera profiles (DCP);
  - highlight reconstruction;
  - lossy and floating-point DNG.

  (`src/formats/dng.ts`)
- **Other raw formats** (CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF, SRW and others) open as the
  camera's embedded JPEG preview, and the app says so. That throws away the raw data's dynamic range
  and colour depth, which is the reason people shoot raw.
- **There is no develop step.** White balance and exposure can only be adjusted after the photo
  has opened.
- **Five photo adjustments are still visibly off from Photoshop.** These are the largest gaps
  measured on the corpus test image (0–255 scale):

| Adjustment | Largest gap |
|---|---|
| Vibrance | 37 |
| Color Balance with Preserve Luminosity | 32 |
| Photo Filter | 21 |
| Selective Color | 8 |
| Hue/Saturation colour ranges | 8 |

## Decisions

Decided 2026-10-05: LibRaw; download the raw.pixls.us samples; start with 4.1. Lens corrections use
what the files carry for now.

## Progress

- 4.1 done (2026-10-05). Photoshop applied each adjustment to a 32-step RGB cube (177 probes,
  `scripts/photoshop/cases-photoprobes.jsx`) plus random colours for validation, and Celenne was
  fitted to that:
  - **Photo Filter:** a white-balance-style multiply in D50 XYZ (within 1/255).
  - **Preserve Luminosity:** the Luminosity blend rule (within 9).
  - **Color Balance Preserve Luminosity:** each range is shifted before the curves (exact).
  - **Selective Color:** each range is clipped before it is weighted (within 1).
  - **Hue/Saturation colour ranges:** grays are untouched, range Lightness moves toward the
    brightest or darkest channel, and saturation boosts are weighted (within 3; up to 18 with a
    master edit on pastel reds).
  - **Vibrance:** Photoshop's measured tables (`src/adjustments/vibranceTables.ts`, within 5). Its
    Saturation slider is exact: linear light with ProPhoto luminance weights.
  - **Import and save bugs fixed:** Photo Filter density (ag-psd uses 0..1) and its Lab colour.

  Corpus largest gaps (0–255 scale):

  | Adjustment | Before | After |
  |---|---|---|
  | Vibrance | 37 | 2 |
  | Photo Filter | 21 | 4 |
  | Color Balance | 32 | 3 |
  | Selective Color | 8 | 2 |
  | Hue/Saturation | 8 | 6 |

  Photoshop re-renders Celenne-saved files the same way (99 % of pixels within 1–4).
- 4.2 done (2026-10-05):
  - **Decoder:** LibRaw 0.22.2 built to WebAssembly (`scripts/raw/build-libraw.ps1`, a 0.7 MB
    module). Celenne's bridge (`third_party/libraw/celenne_libraw.cpp`) passes the sensor data and
    metadata to the development stages shared with DNG (`src/formats/rawDevelop.ts`).
  - **Worker:** decoding runs in a worker with a two-minute limit, and anything that fails falls
    back to the embedded preview.
  - **Samples:** 10 brands (11 CC0 files, `scripts/raw/fetch-samples.mjs`).
  - **Colour:** matches LibRaw's own development within ΔE 0.3 on average (95 % of blocks within
    0.9).
  - **Size:** the same as Photoshop for 6 cameras. Nikon D750, Pentax PEF and Samsung keep up to
    16 px more edge (Adobe's crops are in its own camera tables), and the X-T3 is 5 rows shorter.
  - **Speed:** 1.4–1.7 s per 24 MP Bayer file; 3 s for X-Trans.
  - **Safety:** cut-short, damaged and non-raw files are rejected cleanly.
  - **Licence:** LibRaw's licence, source and build files ship in the installer
    (`resources/licenses/LibRaw`), and `libraw.wasm` is kept outside the app archive so it can be
    replaced.
  - **Also fixed:** raw files can now be opened from Explorer, and opening a raw file no longer
    shows the Photoshop-features warning.

1. **Which raw decoder to use.** Recommended: **LibRaw**, compiled to WebAssembly.
   - **Why LibRaw:** it is the standard open-source raw decoder, used by darktable and RawTherapee,
     among others. It reads about 1,200 camera models, including CR3 and Fujifilm compressed files.
   - **The licence:** you can choose LGPL 2.1 or CDDL 1.0. Celenne's own code stays closed either
     way.
   - **What the licence requires:**
     - ship the LibRaw licence text and a notice in About;
     - publish the exact LibRaw source used;
     - keep LibRaw in its own `.wasm` file, so it can be replaced.
   - **The alternative:** write our own decoders. That would take months and still miss many
     cameras.
2. **Test raw files.** Recommended: samples from raw.pixls.us. They are public domain (CC0), so
   they can live in the repository.
   - Each file is 20–60 MB. About 15 files cover the major brands.
   - Downloading them needs your OK.
   - A few of your own raw files would help, but they would stay in the scratchpad, never the
     repository.
3. **Lens corrections.** Recommended for now: use the corrections cameras and DNG files carry
   themselves (embedded lens data and opcodes).
   - The lensfun database covers far more lenses, but its data is CC BY-SA. That needs attribution
     and keeps the data under the same licence.
   - Adding it later is an option.

## Milestones (in order)

### 4.1 Photo adjustments matched to Photoshop
Nothing blocks this, so it comes first. It helps every PSD user, not just photographers.

- **What changes:** fit Vibrance, Photo Filter, Color Balance (Preserve Luminosity), Selective Color
  and the Hue/Saturation colour ranges to Photoshop, the same way the other adjustments were fitted.
- **How:** sweep the settings in Photoshop (`scripts/photoshop`), measure, fit the model, and add
  each case to the corpus.
- **Done when:** each of these matches Photoshop within 2/255 on the corpus test image, like the
  other adjustments. Any remaining gap is published in the compatibility table.

### 4.2 Raw files from every major camera
- **Decoding:** LibRaw (WebAssembly) decodes the sensor data. Everything after that runs through
  Celenne's DNG path: black and white levels, white balance, demosaic, camera matrix and ProPhoto
  output. All brands then share one colour pipeline, which is tested once.
- **Safety:** decoding runs in a worker, with limits on size and memory. Files that fail to decode
  fall back to the embedded preview, with a message. Every sample file is also tested cut short and
  corrupted.
- **Speed:** decoding a 24 MP raw file takes under 2 seconds on this PC.
- **Done when:** one sample from each brand (Canon CR2 and CR3, Nikon, Sony, Fujifilm X-Trans,
  Olympus/OM, Panasonic, Pentax, Samsung) passes all three checks:
  - it decodes to 16 bits per channel;
  - its size, crop and orientation are the same as when Photoshop opens it;
  - its colour matches Celenne's own decode of the same shot converted to DNG, within ΔE 2.

### 4.3 Raw layers: develop at any time (Celenne's own)
Opening a raw file creates a **raw layer**. It keeps the original raw data, and its develop
settings stay editable at any time in the Properties panel, with a live preview on the GPU. There
is no modal dialog and no "open as smart object" step to remember.

- **Settings:** white balance (temperature / tint, or click a neutral spot), exposure, highlights
  (with highlight reconstruction from the channels that did not clip), shadows, whites, blacks,
  contrast, vibrance, saturation, noise reduction (light and colour), sharpening, and the camera's
  own lens corrections.
- **Saving to PSD:** a raw layer is written as a Camera Raw smart object. It holds the original raw
  file, with its settings written in Camera Raw's own XMP terms. Photoshop opens it with no prompt,
  shows Celenne's rendering, and edits it in Camera Raw. A raw smart object made in Photoshop opens
  in Celenne as a raw layer with the same settings.
- **Investigated first:** Photoshop's raw smart-object format, by having Photoshop make test files.
- **Honest limit:** Camera Raw and Celenne use different colour science. The same settings give
  similar results, not identical pixels. The layer says so when the file comes from Photoshop.
- **Done when:**
  - highlights clipped in the as-shot rendering can be recovered;
  - a developed photo goes Celenne → Photoshop → Celenne with its settings intact and no prompt;
  - re-developing a 24 MP layer updates the preview at least 10 times a second.

### 4.4 DNG completeness
- **What changes:**
  - DNG opcode lists (gain maps, lens distortion and vignetting corrections), as written by phones
    and lens-correcting converters;
  - lossy (JPEG) DNG and floating-point DNG;
  - DCP camera profiles.
- **Done when:** phone DNGs (Apple ProRAW, Google Pixel, Samsung) and lossy DNGs open as full raw
  images, and their corrections are applied.

### 4.5 Finish
- **Tests:** regression tests for raw decoding and develop, which skip when the sample files are
  absent.
- **Documentation:** a photography guide, plus updates to the compatibility table and the known
  limitations.
- **Release:** publish the 0.4.0 installer, which updates installed copies.

## Honest limits
- Celenne's raw rendering will not be pixel-identical to Camera Raw, whose colour profiles and
  processing are Adobe's own. Compatibility means the settings and the file move freely, not
  identical pixels.
- Cameras released after the bundled LibRaw version need a LibRaw update, which ships with a
  normal Celenne update.
