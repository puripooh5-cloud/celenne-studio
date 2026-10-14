// Helpers for building Celenne's Photoshop reference corpus inside Adobe Photoshop (ExtendScript).
// Every document is made from scratch with generated content (clouds, shapes, gradients):
// no presets, samples or third-party images. Run through scripts/photoshop/build-corpus.ps1.

var cT = charIDToTypeID, sT = stringIDToTypeID;

function rgb(r, g, b) { var c = new SolidColor(); c.rgb.red = r; c.rgb.green = g; c.rgb.blue = b; return c; }
function colorDesc(r, g, b) { var d = new ActionDescriptor(); d.putDouble(cT('Rd  '), r); d.putDouble(cT('Grn '), g); d.putDouble(cT('Bl  '), b); return d; }
function putColor(desc, key, c) { desc.putObject(key, cT('RGBC'), colorDesc(c[0], c[1], c[2])); }

/** New document; mode 'rgb' | 'cmyk' | 'lab' | 'gray', bits 8 | 16 | 32. */
function newDoc(name, w, h, mode, bits) {
  var m = { rgb: NewDocumentMode.RGB, cmyk: NewDocumentMode.CMYK, lab: NewDocumentMode.LAB, gray: NewDocumentMode.GRAYSCALE }[mode || 'rgb'];
  var b = { 8: BitsPerChannelType.EIGHT, 16: BitsPerChannelType.SIXTEEN, 32: BitsPerChannelType.THIRTYTWO }[bits || 8];
  var profile = { rgb: 'sRGB IEC61966-2.1', gray: 'Dot Gain 20%', cmyk: 'U.S. Web Coated (SWOP) v2', lab: undefined }[mode || 'rgb'];
  var doc = profile ? app.documents.add(w, h, 72, name, m, DocumentFill.WHITE, 1, b, profile) : app.documents.add(w, h, 72, name, m, DocumentFill.WHITE, 1, b);
  return doc;
}

function setColors(fg, bg) { app.foregroundColor = rgb(fg[0], fg[1], fg[2]); app.backgroundColor = rgb(bg[0], bg[1], bg[2]); }

/** A new empty pixel layer on top. */
function newLayer(name) { var l = app.activeDocument.artLayers.add(); l.name = name; return l; }

/** Fills the active layer with clouds in the given colours (rich, varied tones). */
function clouds(fg, bg) { setColors(fg, bg); app.activeDocument.selection.deselect(); app.activeDocument.activeLayer.applyClouds(); }

function selectRect(x, y, w, h, feather) { app.activeDocument.selection.select([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], SelectionType.REPLACE, feather || 0, true); }

function selectEllipse(x, y, w, h, feather) {
  var d = new ActionDescriptor(), r = new ActionReference();
  r.putProperty(cT('Chnl'), cT('fsel'));
  d.putReference(cT('null'), r);
  var e = new ActionDescriptor();
  e.putUnitDouble(cT('Top '), cT('#Pxl'), y); e.putUnitDouble(cT('Left'), cT('#Pxl'), x);
  e.putUnitDouble(cT('Btom'), cT('#Pxl'), y + h); e.putUnitDouble(cT('Rght'), cT('#Pxl'), x + w);
  d.putObject(cT('T   '), cT('Elps'), e);
  d.putBoolean(cT('AntA'), true);
  if (feather) d.putUnitDouble(cT('Fthr'), cT('#Pxl'), feather);
  executeAction(cT('setd'), d, DialogModes.NO);
}

function fillSel(c, opacity) { app.activeDocument.selection.fill(rgb(c[0], c[1], c[2]), ColorBlendMode.NORMAL, opacity || 100, false); }
function clearOutsideSel() { var s = app.activeDocument.selection; s.invert(); s.clear(); s.deselect(); }

/** A layer of clouds cut to a soft ellipse (partial transparency at the edges). */
function cloudBlob(name, fg, bg, x, y, w, h, feather) {
  var l = newLayer(name);
  clouds(fg, bg);
  selectEllipse(x, y, w, h, feather);
  clearOutsideSel();
  return l;
}

/** Base content: opaque colourful clouds with a few hard shapes. */
function baseLayer(doc) {
  var l = newLayer('Base');
  clouds([220, 60, 40], [30, 90, 200]);
  selectRect(Math.round(doc.width * 0.1), Math.round(doc.height * 0.6), Math.round(doc.width * 0.3), Math.round(doc.height * 0.3)); fillSel([250, 250, 250]);
  selectRect(Math.round(doc.width * 0.6), Math.round(doc.height * 0.1), Math.round(doc.width * 0.3), Math.round(doc.height * 0.25)); fillSel([10, 10, 10]);
  app.activeDocument.selection.deselect();
  return l;
}

/** Top content: clouds in other colours inside a feathered ellipse. */
function topLayer(doc, name) {
  var w = doc.width.as('px'), h = doc.height.as('px');
  return cloudBlob(name || 'Top', [250, 220, 40], [20, 120, 60], Math.round(w * 0.15), Math.round(h * 0.15), Math.round(w * 0.7), Math.round(h * 0.7), Math.round(w * 0.06));
}

/** Removes the white Background so documents start from a layer we made. */
function dropBackground(doc) { try { doc.backgroundLayer.remove(); } catch (e) { } }

var BLEND = {
  normal: BlendMode.NORMAL, dissolve: BlendMode.DISSOLVE, darken: BlendMode.DARKEN, multiply: BlendMode.MULTIPLY, colorBurn: BlendMode.COLORBURN,
  linearBurn: BlendMode.LINEARBURN, darkerColor: BlendMode.DARKERCOLOR, lighten: BlendMode.LIGHTEN, screen: BlendMode.SCREEN, colorDodge: BlendMode.COLORDODGE,
  linearDodge: BlendMode.LINEARDODGE, lighterColor: BlendMode.LIGHTERCOLOR, overlay: BlendMode.OVERLAY, softLight: BlendMode.SOFTLIGHT, hardLight: BlendMode.HARDLIGHT,
  vividLight: BlendMode.VIVIDLIGHT, linearLight: BlendMode.LINEARLIGHT, pinLight: BlendMode.PINLIGHT, hardMix: BlendMode.HARDMIX, difference: BlendMode.DIFFERENCE,
  exclusion: BlendMode.EXCLUSION, subtract: BlendMode.SUBTRACT, divide: BlendMode.DIVIDE, hue: BlendMode.HUE, saturation: BlendMode.SATURATION,
  color: BlendMode.COLORBLEND, luminosity: BlendMode.LUMINOSITY, passThrough: BlendMode.PASSTHROUGH
};

/** Layer mask on the active layer: from the selection ('sel'), revealing all ('all') or hiding all ('none'). */
function addMask(from) {
  var d = new ActionDescriptor(), r = new ActionReference();
  d.putClass(cT('Nw  '), cT('Chnl'));
  r.putEnumerated(cT('Chnl'), cT('Chnl'), cT('Msk '));
  d.putReference(cT('At  '), r);
  d.putEnumerated(cT('Usng'), cT('UsrM'), from === 'sel' ? cT('RvlS') : from === 'none' ? cT('HdAl') : cT('RvlA'));
  executeAction(cT('Mk  '), d, DialogModes.NO);
}

/** Sets a layer property through Action Manager (mask enabled, density, feather, …). */
function setLayerProps(fill) {
  var d = new ActionDescriptor(), r = new ActionReference();
  r.putEnumerated(cT('Lyr '), cT('Ordn'), cT('Trgt'));
  d.putReference(cT('null'), r);
  var p = new ActionDescriptor();
  fill(p);
  d.putObject(cT('T   '), cT('Lyr '), p);
  executeAction(cT('setd'), d, DialogModes.NO);
}

/** Vector mask on the active layer from the current selection (via a work path). */
function addVectorMaskFromSelection() {
  app.activeDocument.selection.makeWorkPath(0.5);
  var d = new ActionDescriptor(), r = new ActionReference(), r2 = new ActionReference(), r3 = new ActionReference();
  r.putClass(cT('Path')); d.putReference(cT('null'), r);
  r2.putEnumerated(cT('Path'), cT('Path'), sT('vectorMask')); d.putReference(cT('At  '), r2);
  r3.putEnumerated(cT('Path'), cT('Ordn'), cT('Trgt')); d.putReference(cT('Usng'), r3);
  executeAction(cT('Mk  '), d, DialogModes.NO);
  try { app.activeDocument.pathItems.getByName('Work Path').remove(); } catch (e) { }
}

/** Adjustment layer of class `cls` (e.g. 'Lvls') with its settings descriptor. */
function adjustmentLayer(name, cls, settings) {
  var d = new ActionDescriptor(), r = new ActionReference();
  r.putClass(cT('AdjL'));
  d.putReference(cT('null'), r);
  var l = new ActionDescriptor();
  l.putObject(cT('Type'), typeof cls === 'number' ? cls : cT(cls), settings || new ActionDescriptor());
  d.putObject(cT('Usng'), cT('AdjL'), l);
  executeAction(cT('Mk  '), d, DialogModes.NO);
  app.activeDocument.activeLayer.name = name;
  return app.activeDocument.activeLayer;
}

/** Fill layer: kind 'solidColorLayer' | 'gradientLayer' | 'patternLayer' with its descriptor. */
function fillLayer(name, kind, settings) {
  var d = new ActionDescriptor(), r = new ActionReference();
  r.putClass(sT('contentLayer'));
  d.putReference(cT('null'), r);
  var l = new ActionDescriptor();
  l.putObject(cT('Type'), sT(kind), settings);
  d.putObject(cT('Usng'), sT('contentLayer'), l);
  executeAction(cT('Mk  '), d, DialogModes.NO);
  app.activeDocument.activeLayer.name = name;
  return app.activeDocument.activeLayer;
}

/** A two-or-more stop gradient descriptor: stops = [[location 0..4096, [r,g,b]], …]. */
function gradientDesc(stops, name) {
  var g = new ActionDescriptor();
  g.putString(cT('Nm  '), name || 'Corpus gradient');
  g.putEnumerated(cT('GrdF'), cT('GrdF'), cT('CstS'));
  g.putDouble(cT('Intr'), 4096);
  var cl = new ActionList();
  for (var i = 0; i < stops.length; i++) {
    var s = new ActionDescriptor();
    putColor(s, cT('Clr '), stops[i][1]);
    s.putEnumerated(cT('Type'), cT('Clry'), cT('UsrS'));
    s.putInteger(cT('Lctn'), stops[i][0]);
    s.putInteger(cT('Mdpn'), 50);
    cl.putObject(cT('Clrt'), s);
  }
  g.putList(cT('Clrs'), cl);
  var tl = new ActionList();
  var t0 = new ActionDescriptor(); t0.putUnitDouble(cT('Opct'), cT('#Prc'), 100); t0.putInteger(cT('Lctn'), 0); t0.putInteger(cT('Mdpn'), 50); tl.putObject(cT('TrnS'), t0);
  var t1 = new ActionDescriptor(); t1.putUnitDouble(cT('Opct'), cT('#Prc'), 100); t1.putInteger(cT('Lctn'), 4096); t1.putInteger(cT('Mdpn'), 50); tl.putObject(cT('TrnS'), t1);
  g.putList(cT('Trns'), tl);
  return g;
}

/** Converts the active layer to an embedded smart object. */
function toSmartObject() { executeAction(sT('newPlacedLayer'), new ActionDescriptor(), DialogModes.NO); }

/** Layer effects on the active layer: fill(desc) adds effect descriptors to the 'Lefx' object. */
function setEffects(fill) {
  var d = new ActionDescriptor(), r = new ActionReference();
  r.putProperty(cT('Prpr'), cT('Lefx'));
  r.putEnumerated(cT('Lyr '), cT('Ordn'), cT('Trgt'));
  d.putReference(cT('null'), r);
  var fx = new ActionDescriptor();
  fx.putUnitDouble(cT('Scl '), cT('#Prc'), 100);
  fill(fx);
  d.putObject(cT('T   '), cT('Lefx'), fx);
  executeAction(cT('setd'), d, DialogModes.NO);
}

/** Saves the active document as a PSD with Photoshop's composite, then closes it. */
function savePsd(path) {
  var o = new PhotoshopSaveOptions();
  o.layers = true; o.alphaChannels = true; o.spotColors = true; o.embedColorProfile = true;
  app.activeDocument.saveAs(new File(path), o, true, Extension.LOWERCASE);
  app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);
}
