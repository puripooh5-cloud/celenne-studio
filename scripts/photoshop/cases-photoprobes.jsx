// Photo adjustment probes (Phase 4.1): Photoshop opens Celenne-written reference images and adds one
// adjustment layer. OUT/cube.psd holds the RGB cube in 32 steps (pixel i: r = i & 31, g = (i >> 5) & 31,
// b = i >> 10, value = round(k · 255 / 31)); OUT/ramp.psd is a gray ramp 0..255. Both are written by
// scripts/photoshop/photoprobe-images.ts. Needs cases.jsx (add) and cases-content.jsx (intList).
function ppOn(img, name, cls, settings) {
  return function () {
    app.open(new File(OUT + '/' + img + '.psd'));
    adjustmentLayer(name, cls, settings());
  };
}
function ppVib(v, s) { return function () { var d = new ActionDescriptor(); d.putInteger(sT('vibrance'), v); d.putInteger(cT('Strt'), s); return d; }; }
function ppPf(c, dens, pres) { return function () { var d = new ActionDescriptor(); putColor(d, cT('Clr '), c); d.putInteger(cT('Dnst'), dens); d.putBoolean(sT('preserveLuminosity'), pres); return d; }; }
function ppCb(sh, mid, hi, pres) { return function () { var d = new ActionDescriptor(); d.putList(cT('ShdL'), intList(sh)); d.putList(cT('MdtL'), intList(mid)); d.putList(cT('HghL'), intList(hi)); d.putBoolean(cT('PrsL'), pres); return d; }; }
function ppSc(group, cmyk, relative) {
  return function () {
    var d = new ActionDescriptor(), l = new ActionList(), g = new ActionDescriptor();
    d.putEnumerated(cT('Mthd'), cT('CrcM'), cT(relative ? 'Rltv' : 'Absl'));
    g.putEnumerated(cT('Clrs'), cT('Clrs'), cT(group));
    g.putUnitDouble(cT('Cyn '), cT('#Prc'), cmyk[0]); g.putUnitDouble(cT('Mgnt'), cT('#Prc'), cmyk[1]);
    g.putUnitDouble(cT('Ylw '), cT('#Prc'), cmyk[2]); g.putUnitDouble(cT('Blck'), cT('#Prc'), cmyk[3]);
    l.putObject(cT('ClrC'), g);
    d.putList(cT('ClrC'), l);
    return d;
  };
}
// Hue/Saturation with one colour range (index 1..6 = reds..magentas, Photoshop's default range
// points) and optionally a master edit.
var PP_RANGES = [[315, 345, 15, 45], [15, 45, 75, 105], [75, 105, 135, 165], [135, 165, 195, 225], [195, 225, 255, 285], [255, 285, 315, 345]];
function ppHs(idx, pts, h, s, l, master) {
  return function () {
    var d = new ActionDescriptor(), lst = new ActionList(), m = new ActionDescriptor();
    d.putBoolean(cT('Clrz'), false);
    m.putInteger(cT('H   '), master ? master[0] : 0); m.putInteger(cT('Strt'), master ? master[1] : 0); m.putInteger(cT('Lght'), master ? master[2] : 0);
    lst.putObject(cT('Hst2'), m);
    var r = new ActionDescriptor();
    r.putInteger(cT('LclR'), idx); r.putInteger(cT('BgnR'), pts[0]); r.putInteger(cT('BgnS'), pts[1]); r.putInteger(cT('EndS'), pts[2]); r.putInteger(cT('EndR'), pts[3]);
    r.putInteger(cT('H   '), h); r.putInteger(cT('Strt'), s); r.putInteger(cT('Lght'), l);
    lst.putObject(cT('Hst2'), r);
    d.putList(cT('Adjs'), lst);
    return d;
  };
}

// Vibrance and saturation, separately and together.
var PPV = [-100, -75, -50, -25, -10, 10, 25, 50, 75, 100];
for (var i = 0; i < PPV.length; i++) add('pp-vib-v' + PPV[i], ppOn('cube', 'Vibrance', sT('vibrance'), ppVib(PPV[i], 0)));
var PPS = [-100, -50, 50, 100];
for (var i = 0; i < PPS.length; i++) add('pp-vib-s' + PPS[i], ppOn('cube', 'Vibrance', sT('vibrance'), ppVib(0, PPS[i])));
add('pp-vib-v60s-20', ppOn('cube', 'Vibrance', sT('vibrance'), ppVib(60, -20)));
add('pp-vib-v-40s30', ppOn('cube', 'Vibrance', sT('vibrance'), ppVib(-40, 30)));

// Photo Filter: four filter colours, three densities, with and without Preserve Luminosity.
var PPC = [['warm', [236, 138, 0]], ['cool', [0, 109, 255]], ['red', [234, 26, 26]], ['green', [25, 201, 25]]];
var PPD = [25, 50, 100];
for (var i = 0; i < PPC.length; i++)
  for (var j = 0; j < PPD.length; j++) {
    add('pp-pf-' + PPC[i][0] + '-d' + PPD[j], ppOn('cube', 'PF', sT('photoFilter'), ppPf(PPC[i][1], PPD[j], false)));
    add('pp-pf-' + PPC[i][0] + '-d' + PPD[j] + '-pres', ppOn('cube', 'PF', sT('photoFilter'), ppPf(PPC[i][1], PPD[j], true)));
  }
for (var i = 0; i < PPC.length; i++) add('pp-pf-ramp-' + PPC[i][0], ppOn('ramp', 'PF', sT('photoFilter'), ppPf(PPC[i][1], 100, false)));

// Colour Balance with Preserve Luminosity (without it, it already matches within 4/255).
var Z = [0, 0, 0];
var PPB = [['sh', [20, -10, 5], Z, Z], ['sh2', [-50, 30, 0], Z, Z], ['mid', Z, [-15, 25, 10], Z], ['hi', Z, Z, [0, 0, -30]], ['hi2', Z, Z, [40, -20, 10]],
  ['all', [20, -10, 5], [-15, 25, 10], [0, 0, -30]], ['big', [-100, 0, 100], [60, -60, 0], [0, 100, -100]]];
for (var i = 0; i < PPB.length; i++) {
  add('pp-cb-' + PPB[i][0] + '-pres', ppOn('cube', 'CB', 'ClrB', ppCb(PPB[i][1], PPB[i][2], PPB[i][3], true)));
  add('pp-cb-' + PPB[i][0], ppOn('cube', 'CB', 'ClrB', ppCb(PPB[i][1], PPB[i][2], PPB[i][3], false)));
}

// Selective Color: every colour group, one ink at a time, relative and absolute.
var PPG = [['reds', 'Rds '], ['yellows', 'Ylws'], ['greens', 'Grns'], ['cyans', 'Cyns'], ['blues', 'Bls '], ['magentas', 'Mgnt'], ['whites', 'Whts'], ['neutrals', 'Ntrl'], ['blacks', 'Blks']];
var PPI = [['c60', [60, 0, 0, 0]], ['cm60', [-60, 0, 0, 0]], ['m60', [0, 60, 0, 0]], ['k60', [0, 0, 0, 60]], ['km60', [0, 0, 0, -60]]];
for (var i = 0; i < PPG.length; i++)
  for (var j = 0; j < PPI.length; j++) {
    add('pp-sc-' + PPG[i][0] + '-' + PPI[j][0] + '-rel', ppOn('cube', 'SC', 'SlcC', ppSc(PPG[i][1], PPI[j][1], true)));
    add('pp-sc-' + PPG[i][0] + '-' + PPI[j][0] + '-abs', ppOn('cube', 'SC', 'SlcC', ppSc(PPG[i][1], PPI[j][1], false)));
  }

// Hue/Saturation colour ranges: each default range with one edit, plus a narrow custom range and a
// range edit together with a master edit.
var PPH = [['h40', 40, 0, 0], ['s40', 0, 40, 0], ['sm60', 0, -60, 0], ['l40', 0, 0, 40], ['lm40', 0, 0, -40]];
var PPN = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'];
for (var i = 0; i < 6; i++)
  for (var j = 0; j < PPH.length; j++)
    add('pp-hs-' + PPN[i] + '-' + PPH[j][0], ppOn('cube', 'HS', 'HStr', ppHs(i + 1, PP_RANGES[i], PPH[j][1], PPH[j][2], PPH[j][3])));
add('pp-hs-narrow', ppOn('cube', 'HS', 'HStr', ppHs(3, [100, 110, 120, 130], 60, 50, 0)));
add('pp-hs-wide', ppOn('cube', 'HS', 'HStr', ppHs(5, [150, 210, 250, 330], -30, 30, 10)));
add('pp-hs-master', ppOn('cube', 'HS', 'HStr', ppHs(1, PP_RANGES[0], -30, 40, 0, [40, 25, -10])));

// Validation on rand.psd (random colours, not on the cube grid): pv- probes.
var PVV = [[-60, 0], [35, 0], [85, 0], [-90, 40], [60, -20], [0, 30], [0, -70], [-15, -35]];
for (var i = 0; i < PVV.length; i++) add('pv-vib-v' + PVV[i][0] + 's' + PVV[i][1], ppOn('rand', 'Vibrance', sT('vibrance'), ppVib(PVV[i][0], PVV[i][1])));
