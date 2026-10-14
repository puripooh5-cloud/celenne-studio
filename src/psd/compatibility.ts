/**
 * PSD feature compatibility matrix — the internal source of truth for development progress.
 * Read: parsed from files · Edit: editable in Celenne · Write: written back · Preserve: kept intact.
 */
export type Level = 'yes' | 'partial' | 'no' | 'preserve' | 'render';

export interface CompatRow {
  feature: string;
  read: Level;
  edit: Level;
  write: Level;
  preserve: Level;
  notes: string;
}

export const COMPATIBILITY: CompatRow[] = [
  { feature: 'Canvas size, resolution, guides, grid', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: '' },
  { feature: 'RGB / Grayscale color mode', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: 'Grayscale is written as a Grayscale-mode file (one channel, gray profile).' },
  { feature: 'Indexed Color / Bitmap', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: 'Edited natively as a single layer kept to the color table / black and white; written as flat Indexed (with transparency) or 1-bit Bitmap files.' },
  { feature: 'CMYK color mode', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: 'Native: C, M, Y and K values are kept per layer, edited and written back exactly (8/16-bit), with the embedded CMYK profile. Levels / Curves Black channels round-trip.' },
  { feature: 'Lab color mode', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: 'Native: L, a, b values are kept, edited and written back (8/16-bit).' },
  { feature: 'Duotone color mode', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: 'Native: Grayscale data with the ink specification (names, colours, curves, editable overprint colours in Photoshop’s slot order) read and written in Photoshop’s Duotone Options layout; unedited files keep their original bytes and Photoshop’s stored rendering (resource 1066).' },
  { feature: 'Multichannel color mode', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: 'Native: every channel is an editable ink (8/16-bit) with its name and display colour; no layers, as in Photoshop.' },
  { feature: '8-bit channels', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: '' },
  { feature: '16-bit channels', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: 'Written with ZIP-prediction layer data and Lr16 records.' },
  { feature: '32-bit float channels', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: 'Linear light; raw float layer data.' },
  { feature: 'PSB (Large Document Format)', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: '' },
  { feature: 'Pixel layers', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: '' },
  { feature: 'Groups (pass through / isolated)', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: '' },
  { feature: 'Layer names, visibility, opacity, fill', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: '' },
  { feature: 'Blend modes (27)', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: '' },
  { feature: 'Clipping masks', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: '' },
  { feature: 'Layer masks (density, feather)', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: '' },
  { feature: 'Vector masks', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: '' },
  { feature: 'Layer locks, color tags', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: '' },
  { feature: 'Adjustment layers (16 types)', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: "Matched to Photoshop's output (Levels, Curves, Brightness/Contrast, Exposure, Hue/Saturation including colour ranges, Color Balance including Preserve Luminosity, Photo Filter, Selective Color, Black & White, Channel Mixer, Invert, Posterize, Threshold, Gradient Map), measured on the full RGB cube. Vibrance uses Photoshop's own measured output, interpolated between ten levels. Color Lookup renders embedded .cube data; other LUT formats preserved." },
  { feature: 'Fill layers (solid, gradient, pattern)', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: 'Noise gradients render as solid gradients.' },
  { feature: 'Text layers (content, styles, paragraphs)', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: "Horizontal, vertical and path text open in Photoshop without an update prompt (its `Txt2` data is kept, updated, or built for Celenne documents); OpenType features and variable axes still prompt. Celenne-only composer / optical margins are kept in XMP." },
  { feature: 'Text warp / vertical text', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: "Stored rendering shown until edited. After an edit, vertical text follows Photoshop's layout (upright characters, columns right to left) and Celenne's warp curves approximate Photoshop's." },
  { feature: 'Text on a path', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: "The path, start / end markers and flip are read from Photoshop's text engine data and editable; Photoshop's rendering is shown until the text is edited. Celenne writes Photoshop's own path-text data: Photoshop opens it as live text on the path without a prompt, laid out within about 2 % of Celenne's." },
  { feature: 'Shape layers (paths, fill, stroke, live shapes)', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: '' },
  { feature: 'Layer effects (10 types)', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: 'Shadows, glows, overlays, strokes and Bevel & Emboss match Photoshop within 1/255 on straight edges (measured); curved anti-aliased edges and Satin differ slightly.' },
  { feature: 'Smart objects (embedded raster / PSD)', read: 'yes', edit: 'partial', write: 'yes', preserve: 'yes', notes: 'Edit Contents, Replace, non-destructive transform, Celenne smart filters.' },
  { feature: 'Smart objects (vector PDF/AI)', read: 'render', edit: 'no', write: 'preserve', preserve: 'yes', notes: 'Stored rendering shown; contents preserved.' },
  { feature: 'Linked smart objects', read: 'yes', edit: 'partial', write: 'yes', preserve: 'yes', notes: 'Relink via Replace Contents.' },
  { feature: 'Photoshop smart filters', read: 'render', edit: 'no', write: 'preserve', preserve: 'yes', notes: 'Displayed from stored rendering.' },
  { feature: 'Alpha channels', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: '' },
  { feature: 'Spot channels', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: 'Edited as channels and shown printed with their ink colour and solidity (DisplayInfo, 13-byte records as Photoshop writes them). Merge Spot Channel keeps the layers (the ink becomes masked Color Fill layers).' },
  { feature: 'Saved / work / clipping paths', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: '' },
  { feature: 'ICC profile', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: 'Assign / Convert to Profile via LittleCMS.' },
  { feature: 'XMP metadata, copyright, URL', read: 'yes', edit: 'partial', write: 'yes', preserve: 'yes', notes: '' },
  { feature: 'Document metadata (EXIF, IPTC, print settings, Content Credentials and colour-management settings)', read: 'yes', edit: 'no', write: 'yes', preserve: 'yes', notes: "Kept, and updated on save as Photoshop does: EXIF size, resolution, colour space, app and date; print resolution; the halftone and transfer set for the colour mode. Documents without them get the blocks Photoshop writes for a new document (the generative AI record is only kept, never created). Content Credentials turned on are reported: Celenne does not add its edits to them." },
  { feature: 'Blend If ranges', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: 'Applied when rendering (split sliders included).' },
  { feature: 'Knockout, channel restrictions', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: 'Shallow and deep knockout and R/G/B restrictions are applied when rendering.' },
  { feature: 'Artboards', read: 'yes', edit: 'partial', write: 'preserve', preserve: 'yes', notes: 'Edited as groups.' },
  { feature: 'Slices', read: 'yes', edit: 'yes', write: 'yes', preserve: 'yes', notes: 'User slices: Slice tool, Slices From Guides, Export Slices.' },
  { feature: 'Layer comps, annotations', read: 'yes', edit: 'no', write: 'preserve', preserve: 'yes', notes: '' },
  { feature: 'Thumbnail', read: 'no', edit: 'no', write: 'yes', preserve: 'no', notes: 'A JPEG thumbnail (resource 1036) is written on save.' },
  { feature: 'Timeline / video / 3D', read: 'partial', edit: 'no', write: 'preserve', preserve: 'yes', notes: 'Current frame shown.' },
  { feature: 'Unknown layer / document data blocks', read: 'preserve', edit: 'no', write: 'preserve', preserve: 'yes', notes: 'Copied byte-for-byte.' },
];
