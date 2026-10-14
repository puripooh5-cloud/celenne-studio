# Photoshop reference data

Files made with Adobe Photoshop 26.5 (Windows, default Color Settings) to check Celenne against
Photoshop itself. All content is generated (clouds, shapes, gradients, ramps) or made up by Celenne;
there are no presets, samples or third-party images. Test data only, not shipped with the app.

## `corpus/` and `corpus-baseline.json`

170 PSD files that Photoshop built and saved with Maximize Compatibility, so each one carries
Photoshop's own composite. `tests/psd/photoshop-corpus.test.ts` renders every file in Celenne and
compares it with that composite; `corpus-baseline.json` records the largest and 99th-percentile
difference per file (and a note for each known gap). The test fails when a file gets worse.

| Prefix | What it covers |
| --- | --- |
| `blend-`, `fill-` | every blend mode at 75 % opacity; fill opacity in the special modes |
| `group-`, `mask-`, `clip-`, `knockout-`, `channels-` | groups (pass-through, isolated, nested, masked), masks, vector masks, clipping, knockout, channel restrictions |
| `adj-` | every adjustment layer type, masked / clipped / in a group |
| `fill-solid`, `fillgrad-` | solid and gradient fill layers (all five styles) |
| `smart-` | smart objects, plain and transformed |
| `depth16-`, `depth32-`, `gray-`, `cmyk`, `lab` | other depths and colour modes |
| `fx-` | layer effects on a shape layer |
| `celenne-blendif-` | Blend If (Photoshop cannot script it): written by Celenne, re-saved by Photoshop |
| `probe-`, `aprobe-`, `cbprobe-`, `bcsweep-`, `fxp-` | probes that isolate one formula (gradients, Gradient Map, gradient geometry, special-mode fill, adjustments, effect falloffs and bevels) |
| `pp-`, `pv-` | photo adjustment probes on a 32-step RGB cube (`pp-`) or random colours (`pv-`): Vibrance, Photo Filter, Color Balance, Selective Color, Hue/Saturation ranges (a selection of `cases-photoprobes.jsx`; images from `photoprobe-images.ts`) |

Rebuild or extend with the scripts in `scripts/photoshop/` (Photoshop must be installed):

    powershell -ExecutionPolicy Bypass -File scripts/photoshop/build-corpus.ps1 [-Only fx-] [-Cases cases.jsx,cases-effects.jsx]
    node scripts/run-ts.mjs scripts/photoshop/compare-corpus.ts            # table + diff images
    node scripts/run-ts.mjs scripts/photoshop/inspect.ts <file.psd> out.png  # one file in detail

The build script sets Photoshop's Maximize Compatibility to Always while it runs and restores
the user's setting afterwards. Celenne → Photoshop round trip: `roundtrip-export.ts`, then
`resave.ps1`, then `roundtrip-compare.ts`.

## `duotone-renderings.json`

73 Duotone specifications with made-up inks, curves and overprint colours (written by Celenne),
re-saved by Photoshop. Each entry holds the colour-mode data Photoshop wrote and its rendering from
resource 1066 (256 × L a b bytes by gray level). Used by `tests/engine/inkModes.test.ts`.
