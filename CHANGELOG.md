# Changelog

The text under each version heading is what installed copies show as release notes, as plain
text. `npm run release` takes it from here and refuses to publish a version without a section.

## 0.4.0

Photos
- Camera raw files from every major brand now open from their sensor data, in 16-bit ProPhoto RGB: Canon (CR2, CR3), Nikon (NEF), Sony (ARW), Fujifilm (RAF), Olympus / OM (ORF), Panasonic (RW2), Pentax (PEF), Samsung (SRW) and many more. Before, only DNG files did; other raw files opened as the camera's 8-bit JPEG preview.
- You can open raw files by double-clicking them or with Open with.
- Vibrance, Photo Filter, Color Balance (with Preserve Luminosity), Selective Color and Hue/Saturation colour ranges now match Photoshop. Each was measured on every colour of a 32-step colour cube; most colours come out within 2/255 of Photoshop.
- Fixed: Photo Filter layers from Photoshop opened at 1 % of their density and with the wrong colour, and Celenne saved Photo Filter density 100 times too strong.
- Fixed: Hue/Saturation colour ranges no longer change grays.

## 0.3.0

Text
- Text is now drawn by Celenne's own text engine, with each font's real kerning, ligatures and shapes, so it looks the same on every computer.
- Photoshop paragraphs keep Photoshop's exact line breaks and spacing when you recolour them or edit other paragraphs. Only the paragraph you edit is re-flowed.
- Paragraph text breaks lines, justifies and hyphenates like Photoshop.
- Underline, strikethrough and faux italic match Photoshop.
- Photoshop opens text saved by Celenne without asking to update text layers, and lays it out the same way. Photoshop files keep Photoshop's own text data when you edit, add, copy or delete text layers.
- Thai lines break, squeeze and justify like Photoshop's, with vowels and tone marks stacked correctly.
- Vertical text and text on a path are drawn by Celenne's text engine and open in Photoshop as live vertical and path text, laid out the same way.
- Anti-aliasing None and Strong now look like Photoshop's.
- Photoshop's Every-line composer is followed much more closely when you edit a paragraph that uses it.
- New: Celenne's own composer (Paragraph panel > Composer). It plans whole paragraphs to avoid a single short word on the last line and hyphens on consecutive lines, and keeps word spacing even.
- New: Optical margins. Quotes, punctuation and letters such as T and W hang slightly past the edge so the margins look straight.
- New: Type > Fit Text to Frame sizes paragraph text to fill its box.
- Fixed: paragraphs with the same settings no longer run together in Photoshop.
- The text caret and selection follow the text as it is drawn. Clicking, Up, Down, Home and End move by the lines you see, and the caret never splits a Thai character from its vowels and tone marks.

Moving layers
- Dragging layers is smooth in many more files: layers inside groups, and files with Multiply, Overlay or other blend-mode layers on top.
- A drag starts at full speed: Celenne gets ready while the pointer rests on the layer.
- Dragging layers in the Layers panel is lighter.

Fixes
- Clicking the eye button quickly no longer opens the Layer Style dialog.
- Moving selected pixels again no longer leaves a second hole: the pixels stay floating as in Photoshop, so the place they were moved away from shows what it showed before. Moving a selection is also smoother.
- Photoshop no longer asks to update text layers when it opens a document made in Celenne. Choosing Update could hide the text, and choosing No could make Photoshop crash while editing. Celenne now saves Photoshop's own text data for every document.
- Saving while you are typing finishes the text first, so an empty text layer is never saved.
- Photoshop no longer reports fonts such as Arial as missing in text saved by Celenne: fonts are now saved under the names Photoshop looks them up by.
- Opening a Photoshop file no longer warns that some features are not editable just because of Photoshop's own metadata. Celenne now understands it (EXIF, print settings, Content Credentials and colour-management settings), updates it when you save as Photoshop does (image size, resolution and date), and writes the same metadata into documents made in Celenne.
- Setup no longer fails part-way when you install just for yourself into a folder that needs administrator rights, such as Program Files. It now says so before installing and lets you choose another folder or install for everyone.

Downloads
- Celenne Studio now comes as an installer only; there is no portable version.

## 0.2.0

The app is now called Celenne Studio (formerly Lumen Studio). Recovered documents and presets
move over automatically; editor preferences start from their defaults.

Updates
- Celenne Studio now updates itself. New versions download in the background and install when you quit, or straight away with Help > Check for Updates > Restart Now.
- Every update is checked against a signed release file before it installs.
- Turn automatic checks off in Preferences > Updates & Privacy.
- The portable version tells you when a new version is available.

Error reports
- When something goes wrong, Celenne Studio can send a report so it can be fixed. Reports are off until you agree: it asks first, or you choose Always or Never.
- A report never contains your images, layer names, text, file names or folders.
- See Help > Error Reports.

Photoshop files match Photoshop more closely
- Gradient fills and Gradient Map: midpoints, stop positions, smoothness, the 0° angle, angle gradients and the Perceptual / Linear methods now match Photoshop.
- Layer effects (shadows, glows, satin, overlays, strokes and all bevel styles) match Photoshop much more closely, especially on straight edges.
- Brightness/Contrast, Hue/Saturation, Color Balance, Exposure and Posterize match Photoshop; Hue/Saturation no longer adds black ink in CMYK files.
- Fill opacity in Color Burn, Hard Mix and the other special blend modes, knockout, and 32-bit Linear Dodge now match Photoshop.
- 32-bit files saved by Celenne Studio open in Photoshop, and hide-all masks in 16-bit files stay hidden.
- Duotone overprint colours can be edited, and there is a new Merge Spot Channel command.

## 0.1.0

First engineering preview (as Lumen Studio).
