/**
 * Generates documentation that must stay in sync with the code:
 *  - docs/PSD_COMPATIBILITY.md from src/psd/compatibility.ts (the internal matrix)
 *  - samples/plugins/vignette.lplugin.json from src/plugins/samplePlugin.ts
 *
 *   npm run docs
 */
import fs from 'node:fs';
import { COMPATIBILITY, Level } from '../src/psd/compatibility';
import { SAMPLE_PLUGIN } from '../src/plugins/samplePlugin';
import { FIXTURES } from '../tests/helpers/fixtures';

const label: Record<Level, string> = { yes: '✅ Yes', partial: '🟡 Partial', no: '— No', preserve: '🔒 Preserved', render: '🖼 Rendered' };

const md = [
  '# PSD / PSB compatibility',
  '',
  '> Generated from `src/psd/compatibility.ts` by `npm run docs`. The same matrix is shown in the app under **Help ▸ PSD Compatibility Matrix**; the per-document report is under **Help ▸ Compatibility Report**.',
  '',
  '**Read** = parsed from files · **Edit** = editable in Celenne · **Write** = written back on save · **Preserve** = kept intact when not editable.',
  '',
  '- *Preserved* — the original data is carried through a save byte-for-byte (or re-emitted from the parsed structure) even though Celenne cannot edit it.',
  '- *Rendered* — Celenne shows the pixels Photoshop stored in the file, but cannot recompute them.',
  '',
  '| Feature | Read | Edit | Write | Preserve | Notes |',
  '|---|---|---|---|---|---|',
  ...COMPATIBILITY.map((r) => `| ${r.feature} | ${label[r.read]} | ${label[r.edit]} | ${label[r.write]} | ${label[r.preserve]} | ${r.notes} |`),
  '',
  '## Guarantees',
  '',
  '- **Documents are never flattened** on open or when saving as PSD/PSB. Flat formats (PNG, JPEG, TIFF, WebP) are always written as a *copy*; the open document keeps its layers and PSD path.',
  '- **Bit depth is never reduced silently.** Converting to a lower depth asks first; exporting a deep document to an 8-bit format says so and leaves the document untouched.',
  '- **Unsupported features are reported.** On open, anything that is not fully editable produces the notice *"Some Photoshop features in this document are not currently editable. They have been preserved where possible."* with a per-layer report.',
  '- **Missing fonts** are listed as *"Font not installed: [font name]"*; text keeps its stored rendering and original font names until edited or substituted.',
  '- Before saving a PSD, Celenne lists anything that will be written differently (e.g. text rendered by Celenne, Indexed/Bitmap files being flat).',
  '',
  '## Color modes',
  '',
  'Celenne edits RGB and Grayscale (8, 16 and 32 bits per channel), CMYK and Lab (8 and 16 bits) natively, and Indexed Color and Bitmap (8-bit, single layer, as in Photoshop). CMYK documents keep every layer’s C, M, Y and K values (stored as Photoshop stores them, inverted ink) and are displayed and proofed through their CMYK profile; PSD files are written back in CMYK with their profile. Lab documents keep L, a, b. Image ▸ Mode and Edit ▸ Convert to Profile convert between modes through LittleCMS (rendering intent, black point compensation); without a CMYK profile the built-in “Celenne Coated CMYK (approximate)” profile is used. Duotone documents are Grayscale data with up to four inks (Image ▸ Mode ▸ Duotone), shown, exported and saved with their inks; Multichannel documents are ink channels without layers. TIFF, JPEG and PDF keep CMYK (and TIFF / PDF keep Lab); PNG and WebP receive the sRGB appearance.',
  '',
  '## Test suite',
  '',
  'The compatibility suite (`tests/psd/compatibility-suite.test.ts`) opens, renders, edits, saves, reopens and structurally compares each fixture below. Visual regression (`tests/visual`) renders every fixture at 50 %, 100 % and 200 % and compares with reference PNGs.',
  '',
  '| # | Fixture | File |',
  '|---|---|---|',
  ...FIXTURES.map((f, i) => `| ${i + 1} | ${f.title} | \`tests/fixtures/psd/${f.file}\` |`),
  '',
  'These fixtures are **synthetic**: they are written by Celenne\'s own PSD writer (the CMYK file is written byte-by-byte) to exercise the listed structures deterministically. They are not files saved by Adobe Photoshop. To test real-world files, place `.psd`/`.psb` files in `tests/fixtures/psd/external/`; the suite opens, renders, saves and reopens each of them and compares their structure.',
  '',
  '## Verified against Photoshop',
  '',
  'A second corpus, `tests/fixtures/photoshop/corpus`, is **built by Adobe Photoshop 26.5** through its scripting interface from generated content (scripts in `scripts/photoshop/`): every blend mode and fill opacity, groups, masks, clipping, knockout, all adjustment types, fill layers, smart objects, layer effects, 16/32-bit, Gray, CMYK and Lab, plus probe files that isolate single formulas (gradients, Brightness/Contrast, Color Balance, effect falloffs). `tests/psd/photoshop-corpus.test.ts` renders each file and compares it with the composite Photoshop stored in it, against a per-file baseline (`corpus-baseline.json`, which also names the known gaps). The same files were saved by Celenne and re-saved by Photoshop to check that Photoshop reads Celenne files with the same layers and appearance (`scripts/photoshop/roundtrip-*.ts`).',
  '',
].join('\n');

fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/PSD_COMPATIBILITY.md', md);
fs.mkdirSync('samples/plugins', { recursive: true });
fs.writeFileSync('samples/plugins/vignette.lplugin.json', JSON.stringify(SAMPLE_PLUGIN, null, 2) + '\n');
console.log('Wrote docs/PSD_COMPATIBILITY.md and samples/plugins/vignette.lplugin.json');
