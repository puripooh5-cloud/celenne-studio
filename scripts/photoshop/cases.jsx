// Corpus cases: each builds one document in Photoshop. Names become file names.
var W = 128, H = 128;
var CASES = [];
function add(name, build) { CASES.push({ name: name, build: build }); }

function twoLayers(mode, opacity, fill) {
  return function () {
    var d = newDoc('c', W, H); dropBackground(d) ;
    baseLayer(d);
    var t = topLayer(d);
    t.blendMode = BLEND[mode];
    if (opacity !== undefined) t.opacity = opacity;
    if (fill !== undefined) t.fillOpacity = fill;
  };
}

// --- Blend modes (top layer at 75 % opacity over opaque base) ------------------------------------
var MODES = ['normal', 'dissolve', 'darken', 'multiply', 'colorBurn', 'linearBurn', 'darkerColor', 'lighten', 'screen', 'colorDodge', 'linearDodge', 'lighterColor',
  'overlay', 'softLight', 'hardLight', 'vividLight', 'linearLight', 'pinLight', 'hardMix', 'difference', 'exclusion', 'subtract', 'divide', 'hue', 'saturation', 'color', 'luminosity'];
for (var i = 0; i < MODES.length; i++) add('blend-' + MODES[i], twoLayers(MODES[i], 75));
// Fill opacity vs opacity: the "special eight" modes treat fill differently.
var SPECIAL = ['colorBurn', 'linearBurn', 'colorDodge', 'linearDodge', 'vividLight', 'linearLight', 'hardMix', 'difference', 'normal', 'multiply'];
for (var j = 0; j < SPECIAL.length; j++) add('fill-' + SPECIAL[j], twoLayers(SPECIAL[j], 100, 45));

// --- Groups ---------------------------------------------------------------------------------------
add('group-passthrough', function () {
  var d = newDoc('c', W, H); dropBackground(d);
  baseLayer(d);
  var g = d.layerSets.add(); g.name = 'Pass';
  var t = topLayer(d); t.blendMode = BlendMode.MULTIPLY; t.move(g, ElementPlacement.INSIDE);
  g.opacity = 80;
});
add('group-isolated', function () {
  var d = newDoc('c', W, H); dropBackground(d);
  baseLayer(d);
  var g = d.layerSets.add(); g.name = 'Isolated'; g.blendMode = BlendMode.NORMAL;
  var t = topLayer(d); t.blendMode = BlendMode.MULTIPLY; t.move(g, ElementPlacement.INSIDE);
  g.opacity = 80;
});
add('group-blend-screen', function () {
  var d = newDoc('c', W, H); dropBackground(d);
  baseLayer(d);
  var g = d.layerSets.add(); g.name = 'Screen group'; g.blendMode = BlendMode.SCREEN;
  var a = topLayer(d, 'A'); a.move(g, ElementPlacement.INSIDE);
  var b = cloudBlob('B', [200, 40, 200], [0, 0, 0], 50, 10, 70, 70, 6); b.blendMode = BlendMode.OVERLAY; b.move(g, ElementPlacement.INSIDE);
});
add('group-nested', function () {
  var d = newDoc('c', W, H); dropBackground(d);
  baseLayer(d);
  var outer = d.layerSets.add(); outer.name = 'Outer'; outer.opacity = 70;
  var inner = outer.layerSets.add(); inner.name = 'Inner'; inner.blendMode = BlendMode.NORMAL; inner.opacity = 60;
  var t = topLayer(d); t.blendMode = BlendMode.HARDLIGHT; t.move(inner, ElementPlacement.INSIDE);
  var b = cloudBlob('B', [40, 220, 220], [90, 0, 120], 0, 40, 80, 80, 8); b.move(outer, ElementPlacement.INSIDE);
});
add('group-mask', function () {
  var d = newDoc('c', W, H); dropBackground(d);
  baseLayer(d);
  var g = d.layerSets.add(); g.name = 'Masked group';
  var t = topLayer(d); t.move(g, ElementPlacement.INSIDE);
  d.activeLayer = g;
  selectRect(20, 0, 60, 128, 12); addMask('sel'); d.selection.deselect();
});

// --- Masks and clipping ---------------------------------------------------------------------------
add('mask-feathered', function () {
  var d = newDoc('c', W, H); dropBackground(d);
  baseLayer(d); topLayer(d);
  selectEllipse(30, 20, 70, 90, 15); addMask('sel'); d.selection.deselect();
});
add('mask-density-feather', function () {
  var d = newDoc('c', W, H); dropBackground(d);
  baseLayer(d); topLayer(d);
  selectRect(10, 10, 60, 100); addMask('sel'); d.selection.deselect();
  setLayerProps(function (p) { p.putUnitDouble(sT('userMaskDensity'), cT('#Prc'), 60); p.putUnitDouble(sT('userMaskFeather'), cT('#Pxl'), 6); });
});
add('mask-disabled', function () {
  var d = newDoc('c', W, H); dropBackground(d);
  baseLayer(d); topLayer(d);
  selectRect(10, 10, 60, 100); addMask('sel'); d.selection.deselect();
  setLayerProps(function (p) { p.putBoolean(cT('UsrM'), false); });
});
add('mask-vector', function () {
  var d = newDoc('c', W, H); dropBackground(d);
  baseLayer(d); topLayer(d);
  selectEllipse(20, 30, 90, 60); addVectorMaskFromSelection(); d.selection.deselect();
});
add('clip-chain', function () {
  var d = newDoc('c', W, H); dropBackground(d);
  baseLayer(d);
  var t = cloudBlob('Clip base', [255, 255, 255], [120, 120, 120], 20, 20, 90, 90, 4);
  var c1 = newLayer('Clipped 1'); clouds([255, 0, 80], [0, 40, 255]); c1.grouped = true; c1.blendMode = BlendMode.MULTIPLY;
  var c2 = newLayer('Clipped 2'); selectRect(0, 50, 128, 30); fillSel([0, 255, 120]); d.selection.deselect(); c2.grouped = true; c2.opacity = 60;
  void t;
});
