// Corpus cases: adjustment layers, fill layers, smart objects, blending options, depths and modes.

// --- Adjustment layers (over base + top) ------------------------------------------------------------
function withAdjustment(name, cls, settings, after) {
  return function () {
    var d = newDoc('c', W, H); dropBackground(d);
    baseLayer(d); topLayer(d);
    adjustmentLayer(name, cls, settings ? settings() : undefined);
    if (after) after(d);
  };
}
function chRef(ch) { var r = new ActionReference(); r.putEnumerated(cT('Chnl'), cT('Chnl'), cT(ch)); return r; }
function intList(a) { var l = new ActionList(); for (var i = 0; i < a.length; i++) l.putInteger(a[i]); return l; }
function levels() {
  var d = new ActionDescriptor(), l = new ActionList();
  var a = new ActionDescriptor(); a.putReference(cT('Chnl'), chRef('Cmps')); a.putList(cT('Inpt'), intList([20, 230])); a.putDouble(cT('Gmm '), 1.35); a.putList(cT('Otpt'), intList([10, 245])); l.putObject(cT('LvlA'), a);
  var b = new ActionDescriptor(); b.putReference(cT('Chnl'), chRef('Bl  ')); b.putList(cT('Inpt'), intList([0, 200])); b.putDouble(cT('Gmm '), 0.8); l.putObject(cT('LvlA'), b);
  d.putList(cT('Adjs'), l);
  return d;
}
function curvePoints(pts) { var l = new ActionList(); for (var i = 0; i < pts.length; i++) { var p = new ActionDescriptor(); p.putDouble(cT('Hrzn'), pts[i][0]); p.putDouble(cT('Vrtc'), pts[i][1]); l.putObject(cT('Pnt '), p); } return l; }
function curves(second) {
  var d = new ActionDescriptor(), l = new ActionList();
  var a = new ActionDescriptor(); a.putReference(cT('Chnl'), chRef('Cmps')); a.putList(cT('Crv '), curvePoints([[0, 0], [64, 40], [128, 150], [255, 255]])); l.putObject(cT('CrvA'), a);
  var b = new ActionDescriptor(); b.putReference(cT('Chnl'), chRef(second || 'Rd  ')); b.putList(cT('Crv '), curvePoints([[0, 30], [255, 220]])); l.putObject(cT('CrvA'), b);
  d.putList(cT('Adjs'), l);
  return d;
}
function brightness() { var d = new ActionDescriptor(); d.putInteger(cT('Brgh'), 35); d.putInteger(cT('Cntr'), 40); d.putBoolean(sT('useLegacy'), false); return d; }
function brightnessLegacy() { var d = new ActionDescriptor(); d.putInteger(cT('Brgh'), 35); d.putInteger(cT('Cntr'), 40); d.putBoolean(sT('useLegacy'), true); return d; }
function exposure() { var d = new ActionDescriptor(); d.putDouble(cT('Exps'), 0.8); d.putDouble(cT('Ofst'), -0.03); d.putDouble(sT('gammaCorrection'), 1.2); return d; }
function vibrance() { var d = new ActionDescriptor(); d.putInteger(sT('vibrance'), 60); d.putInteger(cT('Strt'), -20); return d; }
function hueSat(colorize) {
  var d = new ActionDescriptor();
  d.putBoolean(cT('Clrz'), !!colorize);
  var l = new ActionList(), m = new ActionDescriptor();
  m.putInteger(cT('H   '), colorize ? 200 : 40); m.putInteger(cT('Strt'), colorize ? 50 : 25); m.putInteger(cT('Lght'), colorize ? 10 : -10);
  l.putObject(cT('Hst2'), m);
  if (!colorize) {
    var r = new ActionDescriptor();
    r.putInteger(cT('LclR'), 1); r.putInteger(cT('BgnR'), 315); r.putInteger(cT('BgnS'), 345); r.putInteger(cT('EndS'), 15); r.putInteger(cT('EndR'), 45);
    r.putInteger(cT('H   '), -30); r.putInteger(cT('Strt'), 40); r.putInteger(cT('Lght'), 0);
    l.putObject(cT('Hst2'), r);
  }
  d.putList(cT('Adjs'), l);
  return d;
}
function colorBalance() { var d = new ActionDescriptor(); d.putList(cT('ShdL'), intList([20, -10, 5])); d.putList(cT('MdtL'), intList([-15, 25, 10])); d.putList(cT('HghL'), intList([0, 0, -30])); d.putBoolean(cT('PrsL'), true); return d; }
function blackWhite(tint) {
  var d = new ActionDescriptor();
  d.putInteger(cT('Rd  '), 50); d.putInteger(cT('Yllw'), 70); d.putInteger(cT('Grn '), 30); d.putInteger(cT('Cyn '), 60); d.putInteger(cT('Bl  '), 10); d.putInteger(cT('Mgnt'), 90);
  d.putBoolean(sT('useTint'), !!tint);
  if (tint) putColor(d, sT('tintColor'), [225, 211, 179]);
  return d;
}
function photoFilter() { var d = new ActionDescriptor(); putColor(d, cT('Clr '), [236, 138, 0]); d.putInteger(cT('Dnst'), 40); d.putBoolean(sT('preserveLuminosity'), true); return d; }
function mixRow(r, g, b, k) { var d = new ActionDescriptor(); d.putUnitDouble(cT('Rd  '), cT('#Prc'), r); d.putUnitDouble(cT('Grn '), cT('#Prc'), g); d.putUnitDouble(cT('Bl  '), cT('#Prc'), b); d.putUnitDouble(cT('Cnst'), cT('#Prc'), k); return d; }
function channelMixer() { var d = new ActionDescriptor(); d.putBoolean(cT('Mnch'), false); d.putObject(cT('Rd  '), cT('ChMx'), mixRow(80, 30, -10, 0)); d.putObject(cT('Grn '), cT('ChMx'), mixRow(10, 90, 0, 5)); d.putObject(cT('Bl  '), cT('ChMx'), mixRow(-20, 20, 100, 0)); return d; }
function posterize() { var d = new ActionDescriptor(); d.putInteger(cT('Lvls'), 5); return d; }
function threshold() { var d = new ActionDescriptor(); d.putInteger(cT('Lvl '), 140); return d; }
function gradientMap() { var d = new ActionDescriptor(); d.putObject(cT('Grad'), cT('Grdn'), gradientDesc([[0, [20, 0, 60]], [2048, [220, 60, 40]], [4096, [255, 240, 180]]])); d.putBoolean(cT('Rvrs'), false); d.putBoolean(cT('Dthr'), false); return d; }
function selectiveColor() {
  var d = new ActionDescriptor(), l = new ActionList();
  d.putEnumerated(cT('Mthd'), cT('CrcM'), cT('Rltv'));
  var groups = [['Rds ', 20, -30, 10, 0], ['Ylws', -40, 10, 30, 0], ['Ntrl', 0, 0, 0, 15], ['Bls ', 10, 0, -20, 0]];
  for (var i = 0; i < groups.length; i++) {
    var g = new ActionDescriptor();
    g.putEnumerated(cT('Clrs'), cT('Clrs'), cT(groups[i][0]));
    g.putUnitDouble(cT('Cyn '), cT('#Prc'), groups[i][1]); g.putUnitDouble(cT('Mgnt'), cT('#Prc'), groups[i][2]); g.putUnitDouble(cT('Ylw '), cT('#Prc'), groups[i][3]); g.putUnitDouble(cT('Blck'), cT('#Prc'), groups[i][4]);
    l.putObject(cT('ClrC'), g);
  }
  d.putList(cT('ClrC'), l);
  return d;
}
add('adj-levels', withAdjustment('Levels', 'Lvls', levels));
add('adj-curves', withAdjustment('Curves', 'Crvs', function () { return curves(); }));
add('adj-brightness', withAdjustment('Brightness/Contrast', 'BrgC', brightness));
add('adj-brightness-legacy', withAdjustment('Brightness/Contrast legacy', 'BrgC', brightnessLegacy));
add('adj-exposure', withAdjustment('Exposure', sT('exposure'), exposure));
add('adj-vibrance', withAdjustment('Vibrance', sT('vibrance'), vibrance));
add('adj-huesat', withAdjustment('Hue/Saturation', 'HStr', function () { return hueSat(false); }));
add('adj-huesat-colorize', withAdjustment('Hue/Saturation colorize', 'HStr', function () { return hueSat(true); }));
add('adj-colorbalance', withAdjustment('Color Balance', 'ClrB', colorBalance));
add('adj-blackwhite', withAdjustment('Black & White', 'BanW', function () { return blackWhite(false); }));
add('adj-blackwhite-tint', withAdjustment('Black & White tint', 'BanW', function () { return blackWhite(true); }));
add('adj-photofilter', withAdjustment('Photo Filter', sT('photoFilter'), photoFilter));
add('adj-channelmixer', withAdjustment('Channel Mixer', 'ChnM', channelMixer));
add('adj-invert', withAdjustment('Invert', 'Invr'));
add('adj-posterize', withAdjustment('Posterize', 'Pstr', posterize));
add('adj-threshold', withAdjustment('Threshold', 'Thrs', threshold));
add('adj-gradientmap', withAdjustment('Gradient Map', 'GdMp', gradientMap));
add('adj-selectivecolor', withAdjustment('Selective Color', 'SlcC', selectiveColor));
add('adj-masked-opacity', withAdjustment('Curves masked', 'Crvs', function () { return curves(); }, function (d) {
  d.activeLayer.opacity = 70; d.activeLayer.blendMode = BlendMode.LUMINOSITY;
  // Adjustment layers come with a white mask: paint black outside an ellipse.
  selectEllipse(10, 10, 80, 100, 10);
  d.selection.invert(); d.selection.fill(rgb(0, 0, 0)); d.selection.deselect();
}));
add('adj-clipped', function () {
  var d = newDoc('c', W, H); dropBackground(d);
  baseLayer(d); topLayer(d);
  var a = adjustmentLayer('Hue clipped', 'HStr', hueSat(false)); a.grouped = true;
});
add('adj-in-group', function () {
  var d = newDoc('c', W, H); dropBackground(d);
  baseLayer(d);
  var g = d.layerSets.add(); g.name = 'Group'; g.blendMode = BlendMode.NORMAL;
  var t = topLayer(d); t.move(g, ElementPlacement.INSIDE);
  d.activeLayer = t;
  var a = adjustmentLayer('Levels in group', 'Lvls', levels()); a.move(t, ElementPlacement.PLACEBEFORE);
});

// --- Fill layers --------------------------------------------------------------------------------------
function solidDesc(c) { var d = new ActionDescriptor(); putColor(d, cT('Clr '), c); return d; }
function gradFill(type, angle, extra) {
  return function () {
    var d = new ActionDescriptor();
    d.putObject(cT('Grad'), cT('Grdn'), gradientDesc([[0, [255, 60, 0]], [1500, [255, 255, 0]], [4096, [0, 60, 255]]]));
    d.putEnumerated(cT('Type'), cT('GrdT'), cT(type));
    d.putUnitDouble(cT('Angl'), cT('#Ang'), angle);
    if (extra) extra(d);
    return d;
  };
}
function withFill(kind, settings, mode, opacity) {
  return function () {
    var d = newDoc('c', W, H); dropBackground(d);
    baseLayer(d);
    var l = fillLayer('Fill', kind, settings());
    if (mode) l.blendMode = BLEND[mode];
    if (opacity) l.opacity = opacity;
  };
}
add('fill-solid', withFill('solidColorLayer', function () { return solidDesc([40, 160, 120]); }, 'overlay', 80));
add('fillgrad-linear', withFill('gradientLayer', gradFill('Lnr ', 30), 'normal', 70));
add('fillgrad-radial', withFill('gradientLayer', gradFill('Rdl ', 0), 'normal', 70));
add('fillgrad-angle', withFill('gradientLayer', gradFill('Angl', 45), 'normal', 70));
add('fillgrad-reflected', withFill('gradientLayer', gradFill('Rflc', 90), 'normal', 70));
add('fillgrad-diamond', withFill('gradientLayer', gradFill('Dmnd', 10), 'normal', 70));
add('fillgrad-scaled-reversed', withFill('gradientLayer', gradFill('Lnr ', 120, function (d) { d.putUnitDouble(cT('Scl '), cT('#Prc'), 60); d.putBoolean(cT('Rvrs'), true); }), 'normal', 70));

// --- Smart objects ---------------------------------------------------------------------------------
add('smart-plain', function () {
  var d = newDoc('c', W, H); dropBackground(d);
  baseLayer(d); topLayer(d); toSmartObject();
});
add('smart-transformed', function () {
  var d = newDoc('c', W, H); dropBackground(d);
  baseLayer(d); topLayer(d); toSmartObject();
  d.activeLayer.resize(70, 55, AnchorPosition.MIDDLECENTER);
  d.activeLayer.rotate(20, AnchorPosition.MIDDLECENTER);
  d.activeLayer.blendMode = BlendMode.HARDLIGHT;
});

// --- Blending options ------------------------------------------------------------------------------
function blendRange(ch, src, dst) {
  var b = new ActionDescriptor();
  b.putReference(cT('Chnl'), chRef(ch));
  b.putInteger(cT('SrcB'), src[0]); b.putInteger(cT('Srcl'), src[1]); b.putInteger(cT('SrcW'), src[2]); b.putInteger(cT('Srcm'), src[3]);
  b.putInteger(cT('DstB'), dst[0]); b.putInteger(cT('Dstl'), dst[1]); b.putInteger(cT('DstW'), dst[2]); b.putInteger(cT('Dstm'), dst[3]);
  return b;
}
// Blend If cannot be set through Action Manager in Photoshop 26.5 (every variant fails with a
// program error); those files are written by Celenne and re-saved by Photoshop (roundtrip cases).
add('channels-restricted', function () {
  var d = newDoc('c', W, H); dropBackground(d);
  baseLayer(d); topLayer(d);
  setLayerProps(function (p) { var l = new ActionList(); l.putEnumerated(cT('Chnl'), cT('Rd  ')); l.putEnumerated(cT('Chnl'), cT('Bl  ')); p.putList(sT('channelRestrictions'), l); });
});
add('knockout-shallow', function () {
  var d = newDoc('c', W, H); dropBackground(d);
  baseLayer(d);
  var g = d.layerSets.add(); g.name = 'Group'; g.blendMode = BlendMode.NORMAL;
  var mid = cloudBlob('Mid', [255, 0, 120], [60, 0, 40], 0, 30, 128, 70, 4); mid.move(g, ElementPlacement.INSIDE);
  var t = topLayer(d, 'Knockout'); t.move(g, ElementPlacement.INSIDE);
  d.activeLayer = t;
  setLayerProps(function (p) { p.putEnumerated(sT('knockout'), sT('knockout'), sT('shallow')); p.putUnitDouble(sT('fillOpacity'), cT('#Prc'), 30); });
});

// --- Depths and colour modes ----------------------------------------------------------------------
function modeDoc(mode, bits, build) {
  return function () { var d = newDoc('c', W, H, mode, bits); dropBackground(d); build(d); };
}
function mixedStack(d) {
  baseLayer(d);
  var t = topLayer(d); t.blendMode = BlendMode.OVERLAY; t.opacity = 85;
  selectEllipse(20, 20, 80, 80, 10); addMask('sel'); d.selection.deselect();
  var b = cloudBlob('Multiply', [255, 128, 0], [40, 80, 255], 50, 0, 78, 90, 6); b.blendMode = BlendMode.MULTIPLY;
}
add('depth16-stack', modeDoc('rgb', 16, mixedStack));
add('depth16-curves', modeDoc('rgb', 16, function (d) { baseLayer(d); topLayer(d); adjustmentLayer('Curves', 'Crvs', curves()); }));
add('depth32-stack', modeDoc('rgb', 32, function (d) { baseLayer(d); var t = topLayer(d); t.blendMode = BlendMode.MULTIPLY; t.opacity = 80; var b = cloudBlob('Linear Dodge', [255, 128, 0], [40, 80, 255], 50, 0, 78, 90, 6); b.blendMode = BlendMode.LINEARDODGE; b.opacity = 50; }));
add('depth32-exposure', modeDoc('rgb', 32, function (d) { baseLayer(d); topLayer(d); adjustmentLayer('Exposure', sT('exposure'), exposure()); }));
add('gray-stack', modeDoc('gray', 8, mixedStack));
add('cmyk-stack', modeDoc('cmyk', 8, mixedStack));
add('cmyk-adjustments', modeDoc('cmyk', 8, function (d) { baseLayer(d); topLayer(d); adjustmentLayer('Curves', 'Crvs', curves('Cyn ')); adjustmentLayer('Hue/Saturation', 'HStr', hueSat(false)); }));
add('cmyk16-stack', modeDoc('cmyk', 16, mixedStack));
add('lab-stack', modeDoc('lab', 8, mixedStack));
add('lab16-stack', modeDoc('lab', 16, mixedStack));
