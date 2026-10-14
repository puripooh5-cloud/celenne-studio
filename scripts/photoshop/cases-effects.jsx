// Layer-effect corpus: one effect (or a few) on a shape layer over a light background.
var EW = 160, EH = 160;
function pct(d, k, v) { d.putUnitDouble(cT(k), cT('#Prc'), v); }
function pxu(d, k, v) { d.putUnitDouble(cT(k), cT('#Pxl'), v); }
function ang(d, k, v) { d.putUnitDouble(cT(k), cT('#Ang'), v); }
function mode(d, m) { d.putEnumerated(cT('Md  '), cT('BlnM'), cT(m)); }
function linearContour(d, key) {
  var c = new ActionDescriptor(); c.putString(cT('Nm  '), 'Linear');
  var l = new ActionList();
  var p0 = new ActionDescriptor(); p0.putDouble(cT('Hrzn'), 0); p0.putDouble(cT('Vrtc'), 0); l.putObject(cT('CrPt'), p0);
  var p1 = new ActionDescriptor(); p1.putDouble(cT('Hrzn'), 255); p1.putDouble(cT('Vrtc'), 255); l.putObject(cT('CrPt'), p1);
  c.putList(cT('Crv '), l);
  d.putObject(cT(key || 'TrnS'), cT('ShpC'), c);
}
/** Base: light gradient-free background; shape: blue rectangle + anti-aliased orange circle. */
function effectDoc() {
  var d = newDoc('c', EW, EH);
  var bg = newLayer('Paper'); selectRect(0, 0, EW, EH); fillSel([232, 226, 214]); d.selection.deselect();
  var s = newLayer('Shape');
  selectRect(30, 30, 50, 40); fillSel([40, 90, 200]);
  selectEllipse(70, 70, 60, 60); fillSel([240, 140, 30]);
  d.selection.deselect();
  void bg;
  return s;
}
function shadowDesc(o) {
  var d = new ActionDescriptor();
  d.putBoolean(cT('enab'), true); mode(d, o.mode || 'Mltp'); putColor(d, cT('Clr '), o.color || [0, 0, 0]);
  pct(d, 'Opct', o.opacity === undefined ? 75 : o.opacity); d.putBoolean(cT('uglg'), false); ang(d, 'lagl', o.angle === undefined ? 120 : o.angle);
  pxu(d, 'Dstn', o.distance === undefined ? 8 : o.distance); pxu(d, 'Ckmt', o.spread || 0); pxu(d, 'blur', o.size === undefined ? 6 : o.size);
  pct(d, 'Nose', 0); d.putBoolean(cT('AntA'), false); linearContour(d);
  if (o.knocks !== undefined) d.putBoolean(sT('layerConceals'), o.knocks);
  return d;
}
function glowDesc(o) {
  var d = new ActionDescriptor();
  d.putBoolean(cT('enab'), true); mode(d, o.mode || 'Scrn'); putColor(d, cT('Clr '), o.color || [255, 230, 90]);
  pct(d, 'Opct', o.opacity === undefined ? 75 : o.opacity);
  d.putEnumerated(cT('GlwT'), cT('BETE'), cT(o.precise ? 'PrBL' : 'SfBL'));
  pxu(d, 'Ckmt', o.spread || 0); pxu(d, 'blur', o.size === undefined ? 10 : o.size);
  pct(d, 'Nose', 0); pct(d, 'ShdN', 0); d.putBoolean(cT('AntA'), false); linearContour(d); pct(d, 'Inpr', o.range === undefined ? 50 : o.range);
  if (o.source) d.putEnumerated(cT('glwS'), cT('IGSr'), cT(o.source));
  return d;
}
function bevelDesc(o) {
  var d = new ActionDescriptor();
  d.putBoolean(cT('enab'), true);
  d.putEnumerated(cT('hglM'), cT('BlnM'), cT('Scrn')); putColor(d, cT('hglC'), [255, 255, 255]); pct(d, 'hglO', 75);
  d.putEnumerated(cT('sdwM'), cT('BlnM'), cT('Mltp')); putColor(d, cT('sdwC'), [0, 0, 0]); pct(d, 'sdwO', 75);
  d.putEnumerated(cT('bvlT'), cT('bvlT'), cT(o.technique || 'SfBL'));
  d.putEnumerated(cT('bvlS'), cT('BESl'), cT(o.style || 'InrB'));
  d.putBoolean(cT('uglg'), false); ang(d, 'lagl', o.angle === undefined ? 120 : o.angle); ang(d, 'Lald', o.altitude === undefined ? 30 : o.altitude);
  pct(d, 'srgR', o.depth === undefined ? 100 : o.depth); pxu(d, 'blur', o.size === undefined ? 5 : o.size);
  d.putEnumerated(cT('bvlD'), cT('BESs'), cT(o.down ? 'Out ' : 'In  '));
  linearContour(d); d.putBoolean(sT('antialiasGloss'), false); pxu(d, 'Sftn', o.soften || 0);
  d.putBoolean(sT('useShape'), false); d.putBoolean(sT('useTexture'), false);
  return d;
}
function strokeDesc(o) {
  var d = new ActionDescriptor();
  d.putBoolean(cT('enab'), true);
  d.putEnumerated(cT('Styl'), cT('FStl'), cT(o.position || 'OutF'));
  d.putEnumerated(cT('PntT'), cT('FrFl'), cT('SClr'));
  mode(d, 'Nrml'); pct(d, 'Opct', o.opacity === undefined ? 100 : o.opacity); pxu(d, 'Sz  ', o.size === undefined ? 3 : o.size);
  putColor(d, cT('Clr '), o.color || [200, 20, 60]);
  return d;
}
function fx(name, build) {
  add('fx-' + name, function () { effectDoc(); setEffects(build); });
}
fx('dropshadow', function (e) { e.putObject(cT('DrSh'), cT('DrSh'), shadowDesc({})); });
fx('dropshadow-hard', function (e) { e.putObject(cT('DrSh'), cT('DrSh'), shadowDesc({ size: 0, distance: 6 })); });
fx('dropshadow-big', function (e) { e.putObject(cT('DrSh'), cT('DrSh'), shadowDesc({ size: 20, distance: 14, angle: 45 })); });
fx('dropshadow-spread', function (e) { e.putObject(cT('DrSh'), cT('DrSh'), shadowDesc({ size: 10, spread: 50 })); });
fx('dropshadow-color', function (e) { e.putObject(cT('DrSh'), cT('DrSh'), shadowDesc({ mode: 'Nrml', color: [200, 30, 120], opacity: 100, size: 4, distance: 10, angle: 0 })); });
fx('innershadow', function (e) { e.putObject(cT('IrSh'), cT('IrSh'), shadowDesc({ size: 6, distance: 6 })); });
fx('innershadow-choke', function (e) { e.putObject(cT('IrSh'), cT('IrSh'), shadowDesc({ size: 10, distance: 4, spread: 40, angle: -60 })); });
fx('outerglow', function (e) { e.putObject(cT('OrGl'), cT('OrGl'), glowDesc({})); });
fx('outerglow-spread', function (e) { e.putObject(cT('OrGl'), cT('OrGl'), glowDesc({ size: 14, spread: 30, color: [40, 200, 255], mode: 'Nrml' })); });
fx('outerglow-precise', function (e) { e.putObject(cT('OrGl'), cT('OrGl'), glowDesc({ size: 8, precise: true })); });
fx('innerglow-edge', function (e) { e.putObject(cT('IrGl'), cT('IrGl'), glowDesc({ size: 8, source: 'SrcE', mode: 'Nrml', color: [255, 255, 255] })); });
fx('innerglow-center', function (e) { e.putObject(cT('IrGl'), cT('IrGl'), glowDesc({ size: 12, source: 'SrcC', mode: 'Nrml', color: [255, 255, 255] })); });
fx('bevel-inner', function (e) { e.putObject(cT('ebbl'), cT('ebbl'), bevelDesc({})); });
fx('bevel-inner-big', function (e) { e.putObject(cT('ebbl'), cT('ebbl'), bevelDesc({ size: 12, depth: 200, angle: 45, altitude: 40 })); });
fx('bevel-outer', function (e) { e.putObject(cT('ebbl'), cT('ebbl'), bevelDesc({ style: 'OtrB', size: 6 })); });
fx('bevel-emboss', function (e) { e.putObject(cT('ebbl'), cT('ebbl'), bevelDesc({ style: 'Embs', size: 6 })); });
fx('bevel-pillow', function (e) { e.putObject(cT('ebbl'), cT('ebbl'), bevelDesc({ style: 'PlEb', size: 6 })); });
fx('bevel-chisel', function (e) { e.putObject(cT('ebbl'), cT('ebbl'), bevelDesc({ technique: 'PrBL', size: 6 })); });
fx('bevel-down-soften', function (e) { e.putObject(cT('ebbl'), cT('ebbl'), bevelDesc({ down: true, size: 8, soften: 3 })); });
fx('satin', function (e) {
  var d = new ActionDescriptor(); d.putBoolean(cT('enab'), true); mode(d, 'Mltp'); putColor(d, cT('Clr '), [0, 0, 0]); d.putBoolean(cT('AntA'), false); d.putBoolean(cT('Invr'), true);
  pct(d, 'Opct', 50); ang(d, 'lagl', 19); pxu(d, 'Dstn', 11); pxu(d, 'blur', 14); linearContour(d, 'MpgS');
  e.putObject(cT('ChFX'), cT('ChFX'), d);
});
fx('coloroverlay', function (e) { var d = new ActionDescriptor(); d.putBoolean(cT('enab'), true); mode(d, 'Nrml'); pct(d, 'Opct', 70); putColor(d, cT('Clr '), [30, 160, 90]); e.putObject(cT('SoFi'), cT('SoFi'), d); });
function gradOverlay(type, angle) {
  return function (e) {
    var d = new ActionDescriptor(); d.putBoolean(cT('enab'), true); mode(d, 'Nrml'); pct(d, 'Opct', 100);
    d.putObject(cT('Grad'), cT('Grdn'), gradientDesc([[0, [255, 255, 255]], [4096, [120, 0, 160]]]));
    ang(d, 'Angl', angle); d.putEnumerated(cT('Type'), cT('GrdT'), cT(type)); d.putBoolean(cT('Rvrs'), false); d.putBoolean(cT('Algn'), true); pct(d, 'Scl ', 100);
    e.putObject(cT('GrFl'), cT('GrFl'), d);
  };
}
fx('gradientoverlay', gradOverlay('Lnr ', 90));
fx('gradientoverlay-radial', gradOverlay('Rdl ', 0));
fx('stroke-outside', function (e) { e.putObject(cT('FrFX'), cT('FrFX'), strokeDesc({})); });
fx('stroke-inside', function (e) { e.putObject(cT('FrFX'), cT('FrFX'), strokeDesc({ position: 'InsF', size: 4 })); });
fx('stroke-center', function (e) { e.putObject(cT('FrFX'), cT('FrFX'), strokeDesc({ position: 'CtrF', size: 5 })); });
fx('stroke-thin', function (e) { e.putObject(cT('FrFX'), cT('FrFX'), strokeDesc({ size: 1, color: [0, 0, 0] })); });
fx('combo', function (e) {
  e.putObject(cT('DrSh'), cT('DrSh'), shadowDesc({}));
  e.putObject(cT('FrFX'), cT('FrFX'), strokeDesc({ size: 2, color: [255, 255, 255] }));
  e.putObject(cT('OrGl'), cT('OrGl'), glowDesc({ size: 6 }));
});

// Effect profile probes: a half-plane shape (x >= 64) on white paper, black effect at 100 %.
function edgeDoc() {
  var d = newDoc('c', 160, 32);
  var bg = newLayer('Paper'); selectRect(0, 0, 160, 32); fillSel([255, 255, 255]); d.selection.deselect();
  var s = newLayer('Shape'); selectRect(64, 0, 96, 32); fillSel([255, 255, 255]); d.selection.deselect();
  void bg; return s;
}
function edgeProbe(name, build) { add('fxp-' + name, function () { edgeDoc(); setEffects(build); }); }
var SZ = [4, 10, 20];
for (var si = 0; si < SZ.length; si++) {
  (function (sz) {
    edgeProbe('ds-' + sz, function (e) { e.putObject(cT('DrSh'), cT('DrSh'), shadowDesc({ mode: 'Nrml', opacity: 100, distance: 0, size: sz, knocks: false })); });
    edgeProbe('og-' + sz, function (e) { e.putObject(cT('OrGl'), cT('OrGl'), glowDesc({ mode: 'Nrml', opacity: 100, size: sz, color: [0, 0, 0] })); });
    edgeProbe('ogp-' + sz, function (e) { e.putObject(cT('OrGl'), cT('OrGl'), glowDesc({ mode: 'Nrml', opacity: 100, size: sz, color: [0, 0, 0], precise: true })); });
    edgeProbe('ig-' + sz, function (e) { e.putObject(cT('IrGl'), cT('IrGl'), glowDesc({ mode: 'Nrml', opacity: 100, size: sz, color: [0, 0, 0], source: 'SrcE' })); });
    edgeProbe('is-' + sz, function (e) { e.putObject(cT('IrSh'), cT('IrSh'), shadowDesc({ mode: 'Nrml', opacity: 100, distance: 0, size: sz })); });
  })(SZ[si]);
}
edgeProbe('ds-10-spread50', function (e) { e.putObject(cT('DrSh'), cT('DrSh'), shadowDesc({ mode: 'Nrml', opacity: 100, distance: 0, size: 10, spread: 50, knocks: false })); });
edgeProbe('og-10-spread50', function (e) { e.putObject(cT('OrGl'), cT('OrGl'), glowDesc({ mode: 'Nrml', opacity: 100, size: 10, spread: 50, color: [0, 0, 0] })); });
edgeProbe('og-10-range25', function (e) { e.putObject(cT('OrGl'), cT('OrGl'), glowDesc({ mode: 'Nrml', opacity: 100, size: 10, range: 25, color: [0, 0, 0] })); });
edgeProbe('st-out-3', function (e) { e.putObject(cT('FrFX'), cT('FrFX'), strokeDesc({ size: 3, color: [0, 0, 0] })); });
edgeProbe('st-in-3', function (e) { e.putObject(cT('FrFX'), cT('FrFX'), strokeDesc({ size: 3, color: [0, 0, 0], position: 'InsF' })); });
edgeProbe('st-ctr-4', function (e) { e.putObject(cT('FrFX'), cT('FrFX'), strokeDesc({ size: 4, color: [0, 0, 0], position: 'CtrF' })); });
var SZ2 = [1, 2, 3, 5, 6, 8, 12, 14, 16, 18, 25, 30, 40, 50, 60];
for (var sj = 0; sj < SZ2.length; sj++) {
  (function (sz) { edgeProbe('ds-' + sz, function (e) { e.putObject(cT('DrSh'), cT('DrSh'), shadowDesc({ mode: 'Nrml', opacity: 100, distance: 0, size: sz, knocks: false })); }); })(SZ2[sj]);
}
// Bevel profiles on the straight edge (shape x >= 64, light along x).
function grayEdgeDoc() {
  var d = newDoc('c', 160, 32);
  var bg = newLayer('Paper'); selectRect(0, 0, 160, 32); fillSel([128, 128, 128]); d.selection.deselect();
  var s = newLayer('Shape'); selectRect(64, 0, 96, 32); fillSel([128, 128, 128]); d.selection.deselect();
  void bg; return s;
}
function bevelProbe(name, o) { add('fxp-bv-' + name, function () { grayEdgeDoc(); setEffects(function (e) { e.putObject(cT('ebbl'), cT('ebbl'), bevelDesc(o)); }); }); }
bevelProbe('smooth-10-lit', { size: 10, angle: 180, altitude: 30 });
bevelProbe('smooth-10-shade', { size: 10, angle: 0, altitude: 30 });
bevelProbe('smooth-4-lit', { size: 4, angle: 180, altitude: 30 });
bevelProbe('smooth-20-lit', { size: 20, angle: 180, altitude: 30 });
bevelProbe('smooth-10-lit-alt60', { size: 10, angle: 180, altitude: 60 });
bevelProbe('smooth-10-lit-alt10', { size: 10, angle: 180, altitude: 10 });
bevelProbe('smooth-10-lit-depth300', { size: 10, angle: 180, altitude: 30, depth: 300 });
bevelProbe('smooth-10-lit-depth30', { size: 10, angle: 180, altitude: 30, depth: 30 });
bevelProbe('chisel-10-lit', { size: 10, angle: 180, altitude: 30, technique: 'PrBL' });
bevelProbe('chisel-10-shade', { size: 10, angle: 0, altitude: 30, technique: 'PrBL' });
bevelProbe('outer-10-lit', { size: 10, angle: 180, altitude: 30, style: 'OtrB' });
bevelProbe('emboss-10-lit', { size: 10, angle: 180, altitude: 30, style: 'Embs' });
bevelProbe('pillow-10-lit', { size: 10, angle: 180, altitude: 30, style: 'PlEb' });
bevelProbe('smooth-10-lit-soften3', { size: 10, angle: 180, altitude: 30, soften: 3 });
bevelProbe('smooth-10-down-lit', { size: 10, angle: 180, altitude: 30, down: true });
bevelProbe('chisel-4-lit', { size: 4, angle: 180, altitude: 30, technique: 'PrBL' });
bevelProbe('chisel-20-lit', { size: 20, angle: 180, altitude: 30, technique: 'PrBL' });
bevelProbe('chisel-10-lit-depth200', { size: 10, angle: 180, altitude: 30, technique: 'PrBL', depth: 200 });
bevelProbe('chisel-10-lit-depth50', { size: 10, angle: 180, altitude: 30, technique: 'PrBL', depth: 50 });
bevelProbe('chiselsoft-10-lit', { size: 10, angle: 180, altitude: 30, technique: 'Slmt' });
bevelProbe('pillow-10-shade', { size: 10, angle: 0, altitude: 30, style: 'PlEb' });
bevelProbe('emboss-10-shade', { size: 10, angle: 0, altitude: 30, style: 'Embs' });
