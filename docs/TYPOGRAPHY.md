# Typography guide

How text works in Celenne Studio, and what happens to it when a file moves between Celenne and
Photoshop. Exact compatibility figures are in [PSD_COMPATIBILITY.md](PSD_COMPATIBILITY.md); what is
not done yet is in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## The text engine

Celenne draws text with its own engine rather than the operating system's:

- **Shaping** with HarfBuzz: the font's kerning, ligatures and contextual forms, and complex scripts
  such as Thai.
- **Drawing** from the font's own outlines, so text looks the same on every computer that has the
  font.
- **Fonts** are the fonts installed on your computer, loaded when a layer first needs them. While a
  font is loading, the layer is drawn with the browser's text renderer and redrawn when the font
  arrives. If a script is missing from the chosen font (Thai in a Latin-only font, for example),
  Celenne falls back to an installed font that has it.

A 1,000-character paragraph lays out in about 1 ms.

## Kinds of text

Use the Type tool (T):

| To make | Do this |
|---|---|
| Point text: one line that grows as you type | Click on the canvas |
| Paragraph text: wraps inside a box | Drag a box |
| Text on a path | Click on a path or shape outline |
| Vertical text | Type > Vertical Orientation, or the Horizontal / Vertical switch in the Paragraph panel |

Convert between point and paragraph text with Type > Convert to Paragraph Text / Convert to Point
Text.

**Vertical text** is laid out as in Photoshop: every character upright, one character per em down
the column, columns running from right to left.

**Text on a path:** drag the start and end markers along the path to move the text, or set Start
and End in the options bar. The options bar also has **Flip**, which puts the text on the other side
of the path, and **Detach**, which turns it back into point text.

**Warp** (Type > Warp Text…) offers all 15 of Photoshop's warp styles. It is not available for text
on a path.

## Character settings (Character panel)

These settings are available:

- font and size;
- leading (0 = Auto);
- kerning: Metrics, Optical or 0;
- tracking;
- vertical and horizontal scale;
- baseline shift;
- All Caps / Small Caps;
- superscript / subscript;
- ligatures;
- faux bold, faux italic, underline and strikethrough.

Faux bold, faux italic (a 10° slant), underline and strikethrough are drawn as Photoshop draws
them. Underline and strikethrough use the font's own line positions and thickness.

**Anti-alias:**

| Mode | What you get |
|---|---|
| None | Hard edges; each pixel is either on or off |
| Strong | Heavier edges, using a tone curve measured from Photoshop |
| Smooth, Crisp, Sharp | Exact outline coverage. Photoshop also snaps small text to the pixel grid, so very small text can look slightly softer in Celenne. |

## Paragraph settings (Paragraph panel)

These settings are available:

- alignment, including the four justify modes;
- left, right and first-line indents;
- space before and after;
- hyphenation;
- composer;
- optical margins.

**Hyphenation** uses US English rules. Other languages are not hyphenated.

### Composers

The composer decides where lines break. Choose it per paragraph:

| Composer | What it does |
|---|---|
| **Adobe Single-line** | Decides one line at a time, exactly as Photoshop's Single-line composer does. On the test files it gives the same line breaks, baselines and glyph positions as Photoshop. |
| **Adobe Every-line** | Plans the whole paragraph, following Photoshop's Every-line composer. This is an approximation fitted to 246 paragraphs laid out by Photoshop: it matches 44 % of paragraphs and 70 % of lines exactly. Thai under this composer uses the Single-line rules. |
| **Celenne** | Celenne's own composer, which also plans the whole paragraph. It avoids a single short word on the last line, hyphens on consecutive lines, and lines squeezed tighter than the minimum word spacing. It keeps justified word spacing even. It uses about 3 % more lines than Photoshop's Every-line composer. |

On the same 246 paragraphs, against Photoshop's Every-line composer:

| | Photoshop Every-line | Celenne |
|---|---|---|
| Single short word on the last line | 23 | 0 |
| Hyphens on consecutive lines | 4 | 0 |
| Variation in justified word spacing (lower is more even) | 0.41 | 0.31 |
| Lines squeezed below the minimum spacing | 88 | 0 |
| Ragged-edge unevenness | 3.43 % | 3.47 % |

### Optical margins

With **Optical margins** on, characters that look lighter at the edge of a line hang slightly past
the edge of the box, so that the margin looks straight:

| Character | Hangs out by |
|---|---|
| Quotes | Their full width |
| Full stops, commas, hyphens, dashes, colons and semicolons | Half their width at the end of a line, a fifth at the start |
| Brackets | 30 % of their width |
| A, V, W, Y and T | A little |
| C, G, O and Q | Less |

### Fit Text to Frame

**Type > Fit Text to Frame**, also in the Paragraph panel, sets the size of the paragraph text so it
fills its box as fully as possible without overflowing. Sizes are rounded down to 0.1 px. The change
can be undone in one step.

## Thai

Thai works without any setting to turn on:

- **Line breaks:** lines break between words, found with a dictionary. A few words split
  differently from Photoshop's word list.
- **Marks:** vowels and tone marks stack as the font intends.
- **Ragged and justified lines:** these follow Photoshop's Thai rules.
- **Caret:** the caret moves and selects by whole characters, never between a consonant and its
  marks.
- **Backspace:** removes the last mark first, as Thai keyboards expect.

## Editing text

- The caret and selection follow the text as it is drawn.
- Clicking, dragging, Up, Down, Home and End work by the lines you see.
- Vertical text and text on a path use a simpler caret.

## Photoshop files

### Opening

- **Photoshop's pixels:** Photoshop text is shown with the pixels Photoshop stored, until you edit
  it.
- **Layout after an edit:**
  - Paragraphs you did not change keep Photoshop's exact line breaks and spacing.
  - Recolouring text, or editing another paragraph, does not move anything.
  - Only the paragraph you edit is laid out again, with its composer.
- **Missing fonts:** these are listed as "Font not installed". The original font names are kept, and
  the layer keeps Photoshop's pixels until you edit it or replace the font in the Missing Fonts dialog.

### Saving

Celenne writes Photoshop's own text data. For text that Celenne edited, added or copied, in either
a Photoshop file or a document made in Celenne:

- Photoshop opens the text as live, editable text, without asking to update text layers.
- This covers horizontal text, vertical text and text on a path.
- Photoshop lays the text out as Celenne did. On the test files the line breaks are the same and
  positions are within a fraction of a pixel; vertical text and text on a path match about 98 %.
- Fonts are saved under the names Photoshop looks them up by, so they are not reported missing.

**Celenne-only settings:**

- **What they are:** the Celenne composer and optical margins.
- **In Photoshop:** Photoshop does not have them, so it lays those paragraphs out with its own
  composer, and lines can break differently there.
- **How Celenne shows this:** such layers show a **C** badge in the Layers panel, and the save
  dialog lists them.
- **When the file comes back:** the settings are stored in the file's metadata, so Celenne restores
  them when it opens the file again.

**Still prompts in Photoshop:** text that uses OpenType features or variable-font axes. Photoshop
asks to update those layers when it opens the file.

## How this is checked

The checks run against a set of PSDs made by Photoshop 2025, in `tests/fixtures/photoshop/text`.

| Test | What it checks |
|---|---|
| `tests/psd/textCorpus.test.ts` | Every horizontal text file is laid out by Celenne and compared line by line with the layout Photoshop stored: line starts, baselines and the x position of every glyph. Today, 50 of 72 files are identical to Photoshop within 0.05 px with Photoshop's line breaks, and 44 when Celenne re-composes them. The other files have known, bounded differences, listed in the test. A change that makes any file worse fails the test. |
| `tests/psd/textEngine.test.ts` | Celenne's drawing compared with Photoshop's own outlines of the same text, including vertical text and text on a path. Also checks anti-aliasing, underline position and the handling of stored line breaks. |
| `tests/psd/txt2Patch.test.ts` | That Photoshop's text data is written correctly. |
| `tests/typography/composer.test.ts` | The composers, optical margins and Fit Text to Frame. |

The Photoshop scripts in `scripts/photoshop` re-check the results against Photoshop itself:

| Script | What it does |
|---|---|
| `open-probe.ps1` | Checks that a file opens without a prompt. |
| `retype.ps1` | Has Photoshop lay the text out again, for comparison. |
| `outline.ps1` | Has Photoshop convert the text to shapes, for comparison. |

These tests need the Windows fonts the files use (Arial, Times New Roman, Tahoma, Leelawadee UI
and others). They are skipped on computers that do not have them.
