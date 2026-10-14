# Phase 3 — Text

**Goal:** text that moves freely between Celenne and Photoshop, and a text engine that is Celenne's own
and better where it counts. Photoshop is the reference for compatibility, not the design to copy.

**What "work freely" means here:** a PSD can go Celenne → Photoshop → Celenne and nothing shifts, nothing
is lost, and neither app shows a prompt. Where that is impossible, the app says so instead of hiding it.

## Already done (foundation)

- Our own text engine: HarfBuzz shaping, our own glyph rasterizer, font registry with per-script fallback
  (Thai, CJK, …), TrueType `kern` table support.
- Line breaking that matches Photoshop's **Single-line composer**, including justification, word spacing
  limits, hyphenation (en-US), paragraph spacing, leading, overflow and alignment rules.
- Reader for Photoshop's layout data (`Txt2`): line starts, baselines, every glyph position, kerning mode.
- Photoshop-generated corpus (55 PSDs) and comparison scripts: **43 of 54 files match Photoshop exactly**
  (same line breaks, baselines and glyph x within 0.05 px). The rest use the Every-line composer, optical
  kerning or faux bold — handled by 3.1 below rather than by cloning them.

## Milestones (in order)

### Progress (2026-10-03)
- 3.1 done: opened text keeps Photoshop's pixels; after an edit, unchanged paragraphs keep
  Photoshop's line breaks, word spacing and (optical kerning / faux bold) glyph positions.
  50 of 54 corpus files match Photoshop's layout exactly with the stored data; the other 4 match
  Photoshop's pixels (Tahoma, Thai) or are within 0.7 px (all caps).
- 3.2 done: the engine draws horizontal text in the app (fonts through Local Font Access,
  loaded on demand, browser fallback while loading), including warp, underline / strikethrough
  (font metrics, as Photoshop), faux bold and faux italic (10°, as Photoshop). The caret and
  selection are drawn from the engine's layout; clicks, drags, up / down and Home / End use it
  (`src/typography/caret.ts`, `src/ui/textCaret.ts`). A 1,000-character paragraph lays out in
  about 1 ms (Latin or Thai, either composer).
- 3.3 done for horizontal text: Photoshop's `Txt2` block is kept and patched for edited layers,
  and new (or copied) text layers get objects and frames of their own (`src/psd/txt2Patch.ts`).
  Documents without `Txt2` (made in Celenne, or from other apps) get one built on Photoshop's own
  template (`src/psd/txt2Template.ts`); before that Photoshop asked to update their text on every
  open (an earlier probe missed this prompt). Checked with Photoshop 2025 (`scripts/photoshop/open-probe.ps1`, `retype.ps1`,
  `retype-compare.ts`): Celenne-made files, edited Photoshop files, and Photoshop files with text
  layers added, copied or deleted open with no prompt, show the edits, and Photoshop's own
  re-layout matches Celenne's (same line breaks, baselines within 0.004 px, glyph x within
  0.08 px). Vertical text, text on a path and OpenType features / variable axes still drop `Txt2`
  (Photoshop then asks to update those layers), because their keys are not known yet.
- 3.4 mostly done: Thai shaping matches Photoshop's outlines exactly; Photoshop's ragged Thai
  line rule (overhang and squeeze) matches exactly and justified Thai matches 95 % of its line
  decisions; the caret moves and selects by whole Thai clusters (a consonant with its vowels and
  tone marks; SARA AM stays with its consonant), and Backspace removes the last mark first, as
  Thai keyboards expect. Still open: a few dictionary differences against Photoshop's word list
  (for example "ทดลองใช้"), and Thai with the Every-line composer.
- 3.6 done (2026-10-04): vertical text and type on a path are drawn by the engine and written to
  Photoshop's text data (vertical frames: orientation 2; path frames: type 2 with the path and the
  markers as Bezier parameters, the layer recorded as a box spanning the path). Photoshop opens them
  without a prompt; its outlines of the same text match Celenne's at IoU 0.997 (vertical) and 0.98
  (path). Paragraph runs are written one per paragraph (a run spanning a paragraph break made
  Photoshop join the paragraphs). Anti-aliasing modes measured on text-aa-*: None aliased, Strong a
  fitted tone curve (IoU with Photoshop's pixels 0.80 / 0.91 -> 0.93 / 0.97), Smooth / Crisp / Sharp
  plain coverage (the rest is hinting). Every-line composer: a total-fit composer fitted to 246
  Photoshop paragraphs (probe-every-*), 44 % of paragraphs / 70 % of line starts exactly as
  Photoshop (Single-line rules: 23 % / 60 %). Comparison tool: `outline.ps1` + `outline-compare.ts`
  (Photoshop converts the text to shapes with its own layout).
- 3.5 done (2026-10-04): Celenne's composer (Paragraph panel > Composer > Celenne), optical margins
  and Type > Fit Text to Frame. On the 246 probe paragraphs, against Photoshop's Every-line breaks:
  no short last lines (Photoshop 23), no hyphen stacks (4), more even justified spacing (0.31 /
  0.41), no lines squeezed past the minimum spacing (88), as even a ragged edge (3.47 % / 3.43 %),
  3 % more lines. These settings are kept in the file's XMP metadata; the layer shows a "C" badge
  and the save dialog says Photoshop lays such text out with its own composer.
- 3.7 (2026-10-05): corpus regression test `tests/psd/textCorpus.test.ts` (every horizontal corpus
  file, stored and re-composed, with today's results pinned; skipped without the Windows fonts);
  typography guide `docs/TYPOGRAPHY.md`; 0.3.0 installers built. Publishing waits for your go.

### 3.1 Open Photoshop text exactly
Show each text layer exactly as Photoshop laid it out, using the glyph positions Photoshop stores in the file.
Celenne re-flows a layer only when the user edits it.
- Use `Txt2` lines and glyph runs for display of unedited layers. Fall back to our engine when the data is
  missing, such as in older PSDs or files saved by other apps.
- Keep the original font name when a font is missing. Show a close substitute and list the missing fonts.
- **Done when:** all 54 corpus files display with Photoshop's line breaks and glyph positions (±0.05 px),
  including the Every-line, optical-kerning and faux-bold files.

### 3.2 New engine inside the app
Today only the test scripts use the engine; the canvas still draws text with Canvas2D.
- Use the engine to draw text layers, with the Canvas2D drawing kept as a fallback.
- Load installed fonts through Local Font Access. Loading is asynchronous, and the canvas redraws when a
  font arrives.
- Type tool caret, selection and hit testing from the engine's glyph positions.
- Performance budget: re-laying out a 1,000-character paragraph takes under 5 ms.
- **Done when:** typing, selecting and styling text in the app uses the engine, and corpus files look the
  same in the app as in the comparison scripts.

### 3.3 Save text Photoshop can edit
- Write `EngineData` and `Txt2` so Photoshop opens Celenne files with live, editable text and no
  "update text layers" prompt. Unknown Photoshop keys are preserved.
- **Done when:** every corpus file and a set of Celenne-made text files are opened and saved by Photoshop
  through COM automation, with no dialog, editable text and matching pixels.

### 3.4 Thai as a first-class language
- Thai word breaking (dictionary based) and correct stacking of vowel and tone marks by default. No special
  mode to turn on.
- Caret movement and deletion by whole Thai character clusters.
- Thai test files compared with Photoshop, plus a review by you of real Thai layouts.
- **Done when:** the Thai corpus matches Photoshop or is judged better in your review, and no marks collide.

### 3.5 Celenne line breaking (our own)
Each paragraph offers a choice of composer: **Photoshop-compatible**, which breaks on the same words as
Photoshop, or **Celenne**.
- Plans the whole paragraph at once, balances ragged edges, and avoids a single word alone on the last
  line and stacks of hyphens.
- Optical margin alignment: quotes, hyphens and letters such as "T" and "W" hang slightly outside the margin
  so edges look straight.
- Fit text to frame: shrink or grow text to fill its box.
- Saving to PSD: Photoshop re-flows Celenne-composed paragraphs with its own rules. The layer shows a badge
  and the save dialog lists these layers, so nothing changes silently.
- **Done when:** a side-by-side test page shows fewer short last lines, fewer hyphen stacks and smoother
  edges than Photoshop on the same text.

### 3.6 Remaining text features
- Vertical text, warp (all 15 Photoshop styles), and text on a path, including reading and writing them in
  PSD.
- Drawing underline and strikethrough; faux bold and faux italic matched to Photoshop.
- Anti-alias modes (None, Sharp, Crisp, Strong, Smooth).
- Editing approximations for optical kerning and the Every-line composer. Display of opened files is
  already exact through 3.1.

### 3.7 Finish
- Regression tests for the corpus. These tests skip on machines without the Windows fonts.
- Documentation: PSD compatibility, known limitations, typography guide.
- Release 0.3.0 installers.

## Honest limits
- Editing a Photoshop paragraph that used the Every-line composer re-flows it with Celenne's rules, so the
  lines may differ from Photoshop's. The app shows this.
- Hyphenation is English (US) only at first. Other languages are not hyphenated, and the UI says so.
