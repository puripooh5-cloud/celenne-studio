// Measurement probes (not part of the test corpus): small documents that isolate one formula.

function grayRampFill() {
  var s = new ActionDescriptor();
  s.putObject(cT('Grad'), cT('Grdn'), (function () { var g = gradientDesc([[0, [0, 0, 0]], [4096, [255, 255, 255]]]); g.putDouble(cT('Intr'), 0); return g; })());
  s.putEnumerated(cT('Type'), cT('GrdT'), cT('Lnr '));
  s.putUnitDouble(cT('Angl'), cT('#Ang'), 0);
  fillLayer('Ramp', 'gradientLayer', s);
}
function gmapDesc(stops, smooth) {
  var d = new ActionDescriptor();
  var g = gradientDesc(stops); g.putDouble(cT('Intr'), smooth);
  d.putObject(cT('Grad'), cT('Grdn'), g); d.putBoolean(cT('Rvrs'), false); d.putBoolean(cT('Dthr'), false);
  return d;
}
add('probe-gmap-ramp', function () {
  var d = newDoc('c', 256, 8); dropBackground(d);
  grayRampFill();
  adjustmentLayer('Map', 'GdMp', gmapDesc([[0, [255, 0, 0]], [1500, [255, 255, 0]], [4096, [0, 0, 255]]], 4096));
});
add('probe-gmap-lum', function () {
  var d = newDoc('c', 256, 8); dropBackground(d);
  newLayer('Patches');
  var cols = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 255, 255], [255, 0, 255], [255, 255, 0], [128, 64, 200], [30, 200, 90]];
  for (var i = 0; i < cols.length; i++) { selectRect(i * 32, 0, 32, 8); fillSel(cols[i]); }
  d.selection.deselect();
  adjustmentLayer('Map', 'GdMp', gmapDesc([[0, [0, 0, 0]], [4096, [255, 255, 255]]], 0));
});
// Gradient fill geometry: black→white Classic 0 % on 128 x 96 (non-square) documents.
function geomProbe(type, angle, scale) {
  return function () {
    var d = newDoc('c', 128, 96); dropBackground(d);
    var s = new ActionDescriptor();
    var g = gradientDesc([[0, [0, 0, 0]], [4096, [255, 255, 255]]]); g.putDouble(cT('Intr'), 0);
    s.putObject(cT('Grad'), cT('Grdn'), g);
    s.putEnumerated(cT('Type'), cT('GrdT'), cT(type));
    s.putUnitDouble(cT('Angl'), cT('#Ang'), angle);
    if (scale) s.putUnitDouble(cT('Scl '), cT('#Prc'), scale);
    fillLayer('Geometry', 'gradientLayer', s);
  };
}
add('probe-geom-lin-0', geomProbe('Lnr ', 0));
add('probe-geom-lin-30', geomProbe('Lnr ', 30));
add('probe-geom-lin-90', geomProbe('Lnr ', 90));
add('probe-geom-lin-135', geomProbe('Lnr ', 135));
add('probe-geom-lin-30-s60', geomProbe('Lnr ', 30, 60));
add('probe-geom-rad-0', geomProbe('Rdl ', 0));
add('probe-geom-rad-0-s60', geomProbe('Rdl ', 0, 60));
add('probe-geom-ang-0', geomProbe('Angl', 0));
add('probe-geom-ang-45', geomProbe('Angl', 45));
add('probe-geom-rfl-30', geomProbe('Rflc', 30));
add('probe-geom-dmd-0', geomProbe('Dmnd', 0));
add('probe-geom-dmd-30', geomProbe('Dmnd', 30));

// Fill opacity in the "special eight" modes: base = gray ramp along x, top = gray ramp along y.
function rampLayer(angle, name) {
  var s = new ActionDescriptor();
  var g = gradientDesc([[0, [0, 0, 0]], [4096, [255, 255, 255]]]); g.putDouble(cT('Intr'), 0);
  s.putObject(cT('Grad'), cT('Grdn'), g);
  s.putEnumerated(cT('Type'), cT('GrdT'), cT('Lnr '));
  s.putUnitDouble(cT('Angl'), cT('#Ang'), angle);
  var l = fillLayer(name, 'gradientLayer', s);
  var d = new ActionDescriptor(), r = new ActionReference();
  r.putEnumerated(cT('Lyr '), cT('Ordn'), cT('Trgt')); d.putReference(cT('null'), r);
  executeAction(sT('rasterizeLayer'), d, DialogModes.NO);
  return app.activeDocument.activeLayer;
}
function fillProbe(mode, fill) {
  return function () {
    var d = newDoc('c', 256, 256); dropBackground(d);
    rampLayer(0, 'Base');
    var t = rampLayer(-90, 'Top');
    t.blendMode = BLEND[mode]; t.fillOpacity = fill;
  };
}
var SPECIAL8 = ['colorBurn', 'linearBurn', 'colorDodge', 'linearDodge', 'vividLight', 'linearLight', 'hardMix', 'difference'];
for (var q = 0; q < SPECIAL8.length; q++) { add('probe-fill50-' + SPECIAL8[q], fillProbe(SPECIAL8[q], 50)); add('probe-fill100-' + SPECIAL8[q], fillProbe(SPECIAL8[q], 100)); }
add('probe-fill20-hardMix', fillProbe('hardMix', 20));
add('probe-fill20-colorDodge', fillProbe('colorDodge', 20));
add('probe-fill50-multiply', fillProbe('multiply', 50));
