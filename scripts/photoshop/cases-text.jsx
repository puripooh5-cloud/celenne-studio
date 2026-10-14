// Text corpus: Photoshop lays out text in installed Windows fonts. Every case keeps the live text
// layer and, hidden above it, a copy converted to a shape layer, so the PSD carries both
// Photoshop's rendering (anti-aliased pixels) and its exact glyph outlines (vector mask).
// Requires lib.jsx. Fonts: Windows core fonts only (Arial, Times New Roman, Georgia, Verdana, …).

var TJ = {
  left: Justification.LEFT, center: Justification.CENTER, right: Justification.RIGHT,
  justifyLeft: Justification.LEFTJUSTIFIED, justifyCenter: Justification.CENTERJUSTIFIED,
  justifyRight: Justification.RIGHTJUSTIFIED, justifyAll: Justification.FULLYJUSTIFIED
};

/**
 * A text layer. o: { text, font (PostScript name), size (px at 72 ppi), x, y (point text origin
 * or paragraph box top-left), box: [w, h] for paragraph text, tracking, leading (px) | null (auto),
 * kerning 'metrics' | 'optical' | 'none', justify, hyphenate, composer 'single' | 'every',
 * firstIndent, leftIndent, rightIndent, spaceBefore, spaceAfter, hScale, vScale, baselineShift,
 * caps 'all' | 'small', fauxBold, fauxItalic, underline, strike, aa 'none'|'sharp'|'crisp'|'strong'|'smooth',
 * vertical, ligatures, color [r,g,b] }
 */
function textLayer(name, o) {
  var doc = app.activeDocument;
  var l = doc.artLayers.add();
  l.kind = LayerKind.TEXT;
  l.name = name;
  var t = l.textItem;
  if (o.box) {
    t.kind = TextType.PARAGRAPHTEXT;
    t.width = new UnitValue(o.box[0], 'px');
    t.height = new UnitValue(o.box[1], 'px');
  }
  if (o.vertical) t.direction = Direction.VERTICAL;
  t.contents = o.text.replace(/\n/g, '\r');
  t.font = o.font || 'ArialMT';
  t.size = new UnitValue(o.size || 36, 'px');
  t.color = rgb((o.color || [0, 0, 0])[0], (o.color || [0, 0, 0])[1], (o.color || [0, 0, 0])[2]);
  t.antiAliasMethod = { none: AntiAlias.NONE, sharp: AntiAlias.SHARP, crisp: AntiAlias.CRISP, strong: AntiAlias.STRONG, smooth: AntiAlias.SMOOTH }[o.aa || 'smooth'];
  if (o.tracking) t.tracking = o.tracking;
  if (o.leading != null) { t.useAutoLeading = false; t.leading = new UnitValue(o.leading, 'px'); } else t.useAutoLeading = true;
  if (o.autoLeading) t.autoLeadingAmount = o.autoLeading;
  if (o.justify) t.justification = TJ[o.justify];
  t.hyphenation = !!o.hyphenate;
  if (o.composer) t.textComposer = o.composer === 'every' ? TextComposer.ADOBEEVERYLINE : TextComposer.ADOBESINGLELINE;
  if (o.firstIndent) t.firstLineIndent = new UnitValue(o.firstIndent, 'px');
  if (o.leftIndent) t.leftIndent = new UnitValue(o.leftIndent, 'px');
  if (o.rightIndent) t.rightIndent = new UnitValue(o.rightIndent, 'px');
  if (o.spaceBefore) t.spaceBefore = new UnitValue(o.spaceBefore, 'px');
  if (o.spaceAfter) t.spaceAfter = new UnitValue(o.spaceAfter, 'px');
  if (o.hScale) t.horizontalScale = o.hScale;
  if (o.vScale) t.verticalScale = o.vScale;
  if (o.baselineShift) t.baselineShift = new UnitValue(o.baselineShift, 'px');
  if (o.caps) t.capitalization = o.caps === 'all' ? TextCase.ALLCAPS : TextCase.SMALLCAPS;
  if (o.fauxBold) t.fauxBold = true;
  if (o.fauxItalic) t.fauxItalic = true;
  if (o.underline) t.underline = UnderlineType.UNDERLINERIGHT;
  if (o.strike) t.strikeThru = StrikeThruType.STRIKEHEIGHT;
  if (o.ligatures === false) t.ligatures = false;
  if (o.words) { t.minimumWordSpacing = o.words[0]; t.desiredWordSpacing = o.words[1]; t.maximumWordSpacing = o.words[2]; }
  if (o.letters) { t.minimumLetterSpacing = o.letters[0]; t.desiredLetterSpacing = o.letters[1]; t.maximumLetterSpacing = o.letters[2]; }
  if (o.glyphs) { t.minimumGlyphScaling = o.glyphs[0]; t.desiredGlyphScaling = o.glyphs[1]; t.maximumGlyphScaling = o.glyphs[2]; }
  t.position = [new UnitValue(o.x || 0, 'px'), new UnitValue(o.y || 0, 'px')];
  // Kerning through Action Manager: the DOM's autoKerning changes the rendering but is not saved.
  if (o.kerning && o.kerning !== 'metrics') setTextStyle(function (s) { s.putEnumerated(sT('autoKern'), sT('autoKern'), sT(o.kerning === 'optical' ? 'opticalKern' : 'manual')); });
  return l;
}

/** Sets character style properties on the whole active text layer (Action Manager 'textStyle'). */
function setTextStyle(fill) {
  var d = new ActionDescriptor(), r = new ActionReference();
  r.putProperty(cT('Prpr'), sT('textStyle'));
  r.putEnumerated(cT('TxLr'), cT('Ordn'), cT('Trgt'));
  d.putReference(cT('null'), r);
  var s = new ActionDescriptor();
  fill(s);
  d.putObject(cT('T   '), sT('textStyle'), s);
  executeAction(cT('setd'), d, DialogModes.NO);
}

/** Duplicates the active text layer, converts the copy to a shape layer named "<name> outline" and hides it. */
function outlineCopy() {
  var doc = app.activeDocument;
  var src = doc.activeLayer;
  var dup = src.duplicate();
  doc.activeLayer = dup;
  var d = new ActionDescriptor(), r = new ActionReference(), r2 = new ActionReference();
  r.putClass(sT('contentLayer'));
  d.putReference(cT('null'), r);
  r2.putEnumerated(cT('TxLr'), cT('Ordn'), cT('Trgt'));
  d.putReference(cT('Usng'), r2);
  executeAction(cT('Mk  '), d, DialogModes.NO);
  var shape = doc.activeLayer;
  shape.name = src.name + ' outline';
  shape.visible = false;
  doc.activeLayer = src;
}

/** One document per case: white background, one text layer plus its outline copy. */
function textCase(name, w, h, o) {
  add(name, function () {
    newDoc('t', w, h);
    textLayer('Text', o);
    try { outlineCopy(); } catch (e) { /* Photoshop cannot convert some text (faux bold) to shapes */ while (app.activeDocument.activeLayer.kind !== LayerKind.TEXT) app.activeDocument.activeLayer.remove(); }
  });
}

// Sample text written for the corpus (kerning pairs, ligatures, punctuation, figures).
var LINE = 'AVATAR WAVE Type, Tofu & "Quotes" fi fl 2026';
var PARA = 'Celenne lays out every paragraph with rules that follow the familiar composer, so lines should break on the same words. ' +
  'Justified columns keep an even rhythm when the spacing limits allow it, and hyphenation only steps in when a long word would leave a gap. ' +
  'Typography rewards patience: kerning, tracking and leading each change how a block of text reads.';
var PARA2 = 'Short opening paragraph.\nA second paragraph follows the first and wraps across several lines inside the same text box.';
var THAI = 'สวัสดีครับ ภาษาไทย กำลังใจ 2026';
var LINES = 'First line of point text\nSecond line, longer than the first\nThird';

var FONTS = [['arial', 'ArialMT'], ['times', 'TimesNewRomanPSMT'], ['georgia', 'Georgia'], ['verdana', 'Verdana'], ['segoe', 'SegoeUI'], ['calibri', 'Calibri'], ['tahoma', 'Tahoma'], ['courier', 'CourierNewPSMT']];

// Point text: fonts, sizes, kerning, tracking, scaling, caps and faux styles.
for (var fi = 0; fi < FONTS.length; fi++) textCase('text-point-' + FONTS[fi][0], 900, 120, { text: LINE, font: FONTS[fi][1], size: 36, x: 20, y: 70 });
textCase('text-point-small', 400, 60, { text: LINE, font: 'ArialMT', size: 11, x: 10, y: 30 });
textCase('text-point-large', 1600, 220, { text: 'AVATAR Wave', font: 'TimesNewRomanPSMT', size: 150, x: 20, y: 170 });
textCase('text-kern-none', 900, 120, { text: LINE, font: 'ArialMT', size: 36, x: 20, y: 70, kerning: 'none' });
textCase('text-kern-optical', 900, 120, { text: LINE, font: 'ArialMT', size: 36, x: 20, y: 70, kerning: 'optical' });
textCase('text-kern-optical-times', 900, 120, { text: LINE, font: 'TimesNewRomanPSMT', size: 36, x: 20, y: 70, kerning: 'optical' });
textCase('text-track-plus', 1100, 120, { text: LINE, font: 'ArialMT', size: 36, x: 20, y: 70, tracking: 120 });
textCase('text-track-minus', 900, 120, { text: LINE, font: 'ArialMT', size: 36, x: 20, y: 70, tracking: -60 });
textCase('text-hscale', 1200, 120, { text: LINE, font: 'ArialMT', size: 36, x: 20, y: 70, hScale: 140 });
textCase('text-vscale', 900, 140, { text: LINE, font: 'ArialMT', size: 36, x: 20, y: 90, vScale: 160 });
textCase('text-baseline-shift', 900, 120, { text: LINE, font: 'ArialMT', size: 36, x: 20, y: 70, baselineShift: 12 });
textCase('text-allcaps', 1100, 120, { text: LINE, font: 'ArialMT', size: 36, x: 20, y: 70, caps: 'all' });
textCase('text-smallcaps', 1000, 120, { text: LINE, font: 'ArialMT', size: 36, x: 20, y: 70, caps: 'small' });
textCase('text-faux-bold', 1000, 120, { text: LINE, font: 'ArialMT', size: 36, x: 20, y: 70, fauxBold: true });
textCase('text-faux-italic', 1000, 120, { text: LINE, font: 'ArialMT', size: 36, x: 20, y: 70, fauxItalic: true });
textCase('text-underline', 900, 120, { text: LINE, font: 'ArialMT', size: 36, x: 20, y: 70, underline: true, strike: true });
textCase('text-ligatures-on', 600, 120, { text: 'office fifty fluffy', font: 'Calibri', size: 48, x: 20, y: 70 });
textCase('text-ligatures-off', 600, 120, { text: 'office fifty fluffy', font: 'Calibri', size: 48, x: 20, y: 70, ligatures: false });
textCase('text-thai', 900, 140, { text: THAI, font: 'Tahoma', size: 40, x: 20, y: 80 });
textCase('text-thai-leelawadee', 900, 140, { text: THAI, font: 'LeelawadeeUI', size: 40, x: 20, y: 80 });

// Point text with line breaks: leading and alignment.
textCase('text-lines-auto', 700, 260, { text: LINES, font: 'ArialMT', size: 32, x: 20, y: 60 });
textCase('text-lines-leading', 700, 260, { text: LINES, font: 'ArialMT', size: 32, x: 20, y: 60, leading: 54 });
textCase('text-lines-center', 700, 260, { text: LINES, font: 'ArialMT', size: 32, x: 350, y: 60, justify: 'center' });
textCase('text-lines-right', 700, 260, { text: LINES, font: 'ArialMT', size: 32, x: 680, y: 60, justify: 'right' });

// Paragraph text: wrapping, composers, justification, hyphenation, spacing and indents.
function para(name, o) {
  if (!o.text) o.text = PARA;
  if (!o.font) o.font = 'ArialMT';
  if (!o.size) o.size = 16;
  if (!o.box) o.box = [340, 260];
  o.x = 20; o.y = 20;
  textCase(name, o.box[0] + 40, o.box[1] + 40, o);
}
para('text-para-left', {});
para('text-para-every', { composer: 'every' });
para('text-para-center', { justify: 'center' });
para('text-para-right', { justify: 'right' });
para('text-para-justify', { justify: 'justifyLeft' });
para('text-para-justify-every', { justify: 'justifyLeft', composer: 'every' });
para('text-para-justify-all', { justify: 'justifyAll' });
para('text-para-justify-center', { justify: 'justifyCenter' });
para('text-para-hyphen', { justify: 'justifyLeft', hyphenate: true, box: [220, 360] });
para('text-para-hyphen-every', { justify: 'justifyLeft', hyphenate: true, composer: 'every', box: [220, 360] });
para('text-para-hyphen-left', { hyphenate: true, box: [220, 360] });
para('text-para-narrow', { box: [120, 520], size: 14 });
para('text-para-times', { font: 'TimesNewRomanPSMT', size: 18 });
para('text-para-georgia', { font: 'Georgia', size: 15, justify: 'justifyLeft' });
para('text-para-verdana', { font: 'Verdana', size: 13 });
para('text-para-segoe-every', { font: 'SegoeUI', size: 17, composer: 'every', justify: 'justifyLeft', hyphenate: true });
para('text-para-leading', { leading: 26 });
para('text-para-autolead', { autoLeading: 150 });
para('text-para-tracking', { tracking: 50 });
para('text-para-paragraphs', { text: PARA2, spaceBefore: 6, spaceAfter: 14, firstIndent: 24, leftIndent: 10, rightIndent: 20 });
para('text-para-wordspacing', { justify: 'justifyLeft', words: [100, 100, 100] });
para('text-para-letterspacing', { justify: 'justifyLeft', words: [80, 100, 200], letters: [-5, 0, 10] });
para('text-para-big', { size: 30, box: [340, 300] });

// Thai: written without spaces between words, so lines break at dictionary word boundaries; vowels
// and tone marks stack above and below the consonants.
var THAI_PARA = 'เซเลนน์สตูดิโอเป็นโปรแกรมแต่งภาพที่ออกแบบมาเพื่อนักออกแบบชาวไทย ตัวอักษรไทยต้องตัดคำได้ถูกต้องเพราะภาษาไทยไม่มีการเว้นวรรคระหว่างคำ ' +
  'สระและวรรณยุกต์ต้องวางซ้อนกันอย่างสวยงามโดยไม่ชนกัน เมื่อเปิดไฟล์จากโฟโตชอปแล้วข้อความต้องอยู่ตำแหน่งเดิมทุกบรรทัด';
var THAI_MIXED = 'โปรแกรม Celenne Studio รองรับไฟล์ PSD จาก Photoshop ทั้งเลเยอร์ข้อความ มาสก์ และเอฟเฟกต์ ราคาเริ่มต้น 1,290 บาท (ทดลองใช้ฟรี 30 วัน)';
var THAI_MARKS = 'ปั้นน้ำ ที่นี่ ผู้ใหญ่ ฟ้า ญี่ปุ่น ฐาน ฎีกา ปู่ย่า กั๊ก ซึ่ง ถั่ว';
para('text-thai-para-tahoma', { text: THAI_PARA, font: 'Tahoma', size: 18, composer: 'single' });
para('text-thai-para-leelawadee', { text: THAI_PARA, font: 'LeelawadeeUI', size: 18, composer: 'single' });
para('text-thai-para-every', { text: THAI_PARA, font: 'LeelawadeeUI', size: 18, composer: 'every' });
para('text-thai-para-justify', { text: THAI_PARA, font: 'LeelawadeeUI', size: 18, composer: 'single', justify: 'justifyLeft' });
para('text-thai-para-narrow', { text: THAI_PARA, font: 'Tahoma', size: 16, composer: 'single', box: [180, 400] });
para('text-thai-mixed', { text: THAI_MIXED, font: 'Tahoma', size: 18, composer: 'single' });
textCase('text-thai-marks-tahoma', 900, 140, { text: THAI_MARKS, font: 'Tahoma', size: 40, x: 20, y: 80 });
textCase('text-thai-marks-leelawadee', 900, 140, { text: THAI_MARKS, font: 'LeelawadeeUI', size: 40, x: 20, y: 80 });

// Anti-aliasing modes: the same text at a small and a large size in each of Photoshop's modes.
var AA = ['none', 'sharp', 'crisp', 'strong', 'smooth'];
for (var ai = 0; ai < AA.length; ai++) {
  textCase('text-aa-' + AA[ai] + '-small', 520, 60, { text: 'Hamburgefonstiv 0123 กำลังใจ', font: 'Tahoma', size: 14, x: 10, y: 34, aa: AA[ai] });
  textCase('text-aa-' + AA[ai] + '-large', 900, 120, { text: 'Hamburgefonstiv 0123 กำลังใจ', font: 'Tahoma', size: 40, x: 10, y: 80, aa: AA[ai] });
}

// Vertical text.
textCase('text-vertical-point', 160, 700, { text: 'Vertical text', font: 'ArialMT', size: 36, x: 80, y: 40, vertical: true });
textCase('text-vertical-para', 400, 420, { text: PARA2, font: 'ArialMT', size: 20, x: 20, y: 20, box: [360, 380], vertical: true });

// Thai line-fitting probes (not part of the test corpus): one paragraph in many box widths.
function widthProbe(name, text, font, size, widths, extra) {
  add(name, function () {
    newDoc('t', 520, 400);
    for (var i = 0; i < widths.length; i++) {
      var o = { text: text, font: font, size: size, x: 20, y: 20, box: [widths[i], 360], composer: 'single' };
      for (var k in extra || {}) o[k] = extra[k];
      textLayer('w' + widths[i], o);
    }
  });
}
var TW = []; for (var tw = 240; tw <= 480; tw += 6) TW.push(tw);
widthProbe('probe-thai-tahoma', THAI_PARA, 'Tahoma', 18, TW);
widthProbe('probe-thai-leelawadee', THAI_PARA, 'LeelawadeeUI', 18, TW);
widthProbe('probe-thai-mixed', THAI_MIXED, 'Tahoma', 18, TW);
widthProbe('probe-latin-arial', PARA, 'ArialMT', 16, TW);
// One word repeated without spaces: how far a line may run past the box before Photoshop squeezes it.
var CAT = ''; for (var ci = 0; ci < 40; ci++) CAT += 'แมว';
var CW = []; for (var cw = 100; cw <= 300; cw += 2) CW.push(cw);
widthProbe('probe-thai-cat', CAT, 'Tahoma', 18, CW);
var TI = ''; for (var ti = 0; ti < 40; ti++) TI += 'ที่';
widthProbe('probe-thai-ti', TI, 'Tahoma', 18, CW);
widthProbe('probe-thai-justify-tahoma', THAI_PARA, 'Tahoma', 18, TW, { justify: 'justifyLeft' });
widthProbe('probe-thai-justify-leelawadee', THAI_PARA, 'LeelawadeeUI', 18, TW, { justify: 'justifyLeft' });
widthProbe('probe-thai-justify-cat', CAT, 'Tahoma', 18, CW, { justify: 'justifyLeft' });
widthProbe('probe-thai-every-tahoma', THAI_PARA, 'Tahoma', 18, TW, { composer: 'every' });
widthProbe('probe-thai-every-leelawadee', THAI_PARA, 'LeelawadeeUI', 18, TW, { composer: 'every' });
widthProbe('probe-thai-every-cat', CAT, 'Tahoma', 18, CW, { composer: 'every' });
// Every-line composer probes: Latin paragraphs in many widths, ragged and justified, with and without hyphenation.
widthProbe('probe-every-left', PARA, 'ArialMT', 16, TW, { composer: 'every' });
widthProbe('probe-every-left-hyphen', PARA, 'ArialMT', 16, TW, { composer: 'every', hyphenate: true });
widthProbe('probe-every-justify', PARA, 'ArialMT', 16, TW, { composer: 'every', justify: 'justifyLeft' });
widthProbe('probe-every-justify-hyphen', PARA, 'ArialMT', 16, TW, { composer: 'every', justify: 'justifyLeft', hyphenate: true });
widthProbe('probe-every-justify-times', PARA, 'TimesNewRomanPSMT', 18, TW, { composer: 'every', justify: 'justifyLeft', hyphenate: true });
widthProbe('probe-every-left-georgia', PARA, 'Georgia', 15, TW, { composer: 'every' });
var TW2 = []; for (var tw2 = 400; tw2 <= 720; tw2 += 8) TW2.push(tw2);
widthProbe('probe-thai-justify-cordia44', THAI_PARA, 'CordiaNew', 44, TW2, { justify: 'justifyLeft' });
widthProbe('probe-thai-ragged-cordia44', THAI_PARA, 'CordiaNew', 44, TW2, {});
widthProbe('probe-thai-justify-tahoma36', THAI_PARA, 'Tahoma', 36, TW2, { justify: 'justifyLeft' });
widthProbe('probe-thai-ragged-tahoma36', THAI_PARA, 'Tahoma', 36, TW2, {});

// First-baseline probes (not part of the test corpus): one box per size, Thai and Latin.
function sizeProbe(name, text, font) {
  add(name, function () {
    newDoc('t', 600, 400);
    for (var sz = 12; sz <= 48; sz += 2) textLayer('s' + sz, { text: text, font: font, size: sz, x: 20, y: 20, box: [500, 300], composer: 'single' });
  });
}
sizeProbe('probe-first-thai-tahoma', 'เซเลนน์สตูดิโอเป็นโปรแกรมแต่งภาพ', 'Tahoma');
sizeProbe('probe-first-latin-tahoma', 'Celenne lays out every paragraph', 'Tahoma');
sizeProbe('probe-first-thai-leelawadee', 'เซเลนน์สตูดิโอเป็นโปรแกรมแต่งภาพ', 'LeelawadeeUI');
sizeProbe('probe-first-ko-tahoma', 'กกกก', 'Tahoma');

// Overflow probes (not part of the test corpus): which lines Photoshop keeps as the box gets shorter.
function overflowProbe(name, font, size, heights) {
  add(name, function () {
    newDoc('t', 400, 400);
    for (var i = 0; i < heights.length; i++) textLayer('h' + heights[i], { text: PARA, font: font, size: size, x: 20, y: 20, box: [340, heights[i]] });
  });
}
var OH = []; for (var oh = 30; oh <= 90; oh++) OH.push(oh);
overflowProbe('probe-overflow-arial', 'ArialMT', 30, OH);
overflowProbe('probe-overflow-courier', 'CourierNewPSMT', 30, OH);
overflowProbe('probe-overflow-times', 'TimesNewRomanPSMT', 30, OH);
