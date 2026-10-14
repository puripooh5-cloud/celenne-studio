// Adjustment probes: Photoshop opens Celenne-written reference images (OUT/ramp.psd: gray 0..255;
// OUT/chart.psd: the RGB cube in 32 steps) and adds one adjustment layer. Needs cases-content.jsx.
function onImage(img, name, cls, settings) {
  return function () {
    app.open(new File(OUT + '/' + img + '.psd'));
    adjustmentLayer(name, cls, settings());
  };
}
function bc(b, c, legacy) { return function () { var d = new ActionDescriptor(); d.putInteger(cT('Brgh'), b); d.putInteger(cT('Cntr'), c); d.putBoolean(sT('useLegacy'), !!legacy); return d; }; }
function expo(e, o, g) { return function () { var d = new ActionDescriptor(); d.putDouble(cT('Exps'), e); d.putDouble(cT('Ofst'), o); d.putDouble(sT('gammaCorrection'), g); return d; }; }
function vib(v, s) { return function () { var d = new ActionDescriptor(); d.putInteger(sT('vibrance'), v); d.putInteger(cT('Strt'), s); return d; }; }
function hs(h, s, l, colorize) {
  return function () {
    var d = new ActionDescriptor(); d.putBoolean(cT('Clrz'), !!colorize);
    var lst = new ActionList(), m = new ActionDescriptor();
    m.putInteger(cT('H   '), h); m.putInteger(cT('Strt'), s); m.putInteger(cT('Lght'), l); lst.putObject(cT('Hst2'), m);
    d.putList(cT('Adjs'), lst); return d;
  };
}
function cb(sh, mid, hi, pres) { return function () { var d = new ActionDescriptor(); d.putList(cT('ShdL'), intList(sh)); d.putList(cT('MdtL'), intList(mid)); d.putList(cT('HghL'), intList(hi)); d.putBoolean(cT('PrsL'), pres); return d; }; }
function pf(c, dens, pres) { return function () { var d = new ActionDescriptor(); putColor(d, cT('Clr '), c); d.putInteger(cT('Dnst'), dens); d.putBoolean(sT('preserveLuminosity'), pres); return d; }; }
function post(n) { return function () { var d = new ActionDescriptor(); d.putInteger(cT('Lvls'), n); return d; }; }

add('aprobe-bc-b50', onImage('ramp', 'BC', 'BrgC', bc(50, 0)));
add('aprobe-bc-bm50', onImage('ramp', 'BC', 'BrgC', bc(-50, 0)));
add('aprobe-bc-b150', onImage('ramp', 'BC', 'BrgC', bc(150, 0)));
add('aprobe-bc-c50', onImage('ramp', 'BC', 'BrgC', bc(0, 50)));
add('aprobe-bc-cm50', onImage('ramp', 'BC', 'BrgC', bc(0, -50)));
add('aprobe-bc-c100', onImage('ramp', 'BC', 'BrgC', bc(0, 100)));
add('aprobe-bc-b35c40', onImage('ramp', 'BC', 'BrgC', bc(35, 40)));
add('aprobe-bc-chart', onImage('chart', 'BC', 'BrgC', bc(35, 40)));
add('aprobe-exp-e08', onImage('ramp', 'Exposure', sT('exposure'), expo(0.8, 0, 1)));
add('aprobe-exp-em1', onImage('ramp', 'Exposure', sT('exposure'), expo(-1, 0, 1)));
add('aprobe-exp-o', onImage('ramp', 'Exposure', sT('exposure'), expo(0, -0.03, 1)));
add('aprobe-exp-g', onImage('ramp', 'Exposure', sT('exposure'), expo(0, 0, 1.2)));
add('aprobe-exp-all', onImage('ramp', 'Exposure', sT('exposure'), expo(0.8, -0.03, 1.2)));
add('aprobe-vib-60', onImage('chart', 'Vibrance', sT('vibrance'), vib(60, 0)));
add('aprobe-vib-m60', onImage('chart', 'Vibrance', sT('vibrance'), vib(-60, 0)));
add('aprobe-vib-s40', onImage('chart', 'Vibrance', sT('vibrance'), vib(0, 40)));
add('aprobe-vib-sm40', onImage('chart', 'Vibrance', sT('vibrance'), vib(0, -40)));
add('aprobe-hs-h40', onImage('chart', 'HS', 'HStr', hs(40, 0, 0)));
add('aprobe-hs-s25', onImage('chart', 'HS', 'HStr', hs(0, 25, 0)));
add('aprobe-hs-sm50', onImage('chart', 'HS', 'HStr', hs(0, -50, 0)));
add('aprobe-hs-l30', onImage('chart', 'HS', 'HStr', hs(0, 0, 30)));
add('aprobe-hs-lm30', onImage('chart', 'HS', 'HStr', hs(0, 0, -30)));
add('aprobe-hs-colorize', onImage('chart', 'HS', 'HStr', hs(200, 50, 10, true)));
add('aprobe-cb-mid', onImage('chart', 'CB', 'ClrB', cb([0, 0, 0], [-15, 25, 10], [0, 0, 0], false)));
add('aprobe-cb-mid-pres', onImage('chart', 'CB', 'ClrB', cb([0, 0, 0], [-15, 25, 10], [0, 0, 0], true)));
add('aprobe-cb-sh', onImage('chart', 'CB', 'ClrB', cb([20, -10, 5], [0, 0, 0], [0, 0, 0], false)));
add('aprobe-cb-hi', onImage('chart', 'CB', 'ClrB', cb([0, 0, 0], [0, 0, 0], [0, 0, -30], false)));
add('aprobe-pf-nopres', onImage('chart', 'PF', sT('photoFilter'), pf([236, 138, 0], 40, false)));
add('aprobe-pf-pres', onImage('chart', 'PF', sT('photoFilter'), pf([236, 138, 0], 40, true)));
add('aprobe-post-5', onImage('ramp', 'Posterize', 'Pstr', post(5)));
add('aprobe-post-2', onImage('ramp', 'Posterize', 'Pstr', post(2)));
// Colour Balance transfer curves: three values per probe (R, G, B channels), on the gray ramp.
var CBV = [[-100, -50, -25], [25, 50, 100], [-10, 10, 75]];
for (var ci = 0; ci < CBV.length; ci++) {
  var v = CBV[ci], z = [0, 0, 0];
  add('cbprobe-sh-' + ci, onImage('ramp', 'CB', 'ClrB', cb(v, z, z, false)));
  add('cbprobe-mid-' + ci, onImage('ramp', 'CB', 'ClrB', cb(z, v, z, false)));
  add('cbprobe-hi-' + ci, onImage('ramp', 'CB', 'ClrB', cb(z, z, v, false)));
}
add('cbprobe-combo-0', onImage('ramp', 'CB', 'ClrB', cb([30, 0, -20], [30, -40, 0], [0, 40, -60], false)));
add('cbprobe-combo-1', onImage('ramp', 'CB', 'ClrB', cb([-50, 60, 20], [50, 20, -70], [-30, -30, 30], false)));
// Colour Balance "Preserve Luminosity": one channel at a time, and the corpus settings.
add('cbpres-r40', onImage('chart', 'CB', 'ClrB', cb([0, 0, 0], [40, 0, 0], [0, 0, 0], true)));
add('cbpres-g40', onImage('chart', 'CB', 'ClrB', cb([0, 0, 0], [0, 40, 0], [0, 0, 0], true)));
add('cbpres-b40', onImage('chart', 'CB', 'ClrB', cb([0, 0, 0], [0, 0, 40], [0, 0, 0], true)));
add('cbpres-rm60', onImage('chart', 'CB', 'ClrB', cb([0, 0, 0], [-60, 0, 0], [0, 0, 0], true)));
add('cbpres-corpus', onImage('chart', 'CB', 'ClrB', cb([20, -10, 5], [-15, 25, 10], [0, 0, -30], true)));
add('cbpres-corpus-off', onImage('chart', 'CB', 'ClrB', cb([20, -10, 5], [-15, 25, 10], [0, 0, -30], false)));
// Brightness / Contrast (modern) sweeps on the gray ramp.
for (var bv = -150; bv <= 150; bv += 10) if (bv) add('bcsweep-b' + bv, onImage('ramp', 'BC', 'BrgC', bc(bv, 0)));
for (var cv = -50; cv <= 100; cv += 10) if (cv) add('bcsweep-c' + cv, onImage('ramp', 'BC', 'BrgC', bc(0, cv)));
add('bcsweep-b40c40', onImage('ramp', 'BC', 'BrgC', bc(40, 40)));
add('bcsweep-b-60c50', onImage('ramp', 'BC', 'BrgC', bc(-60, 50)));
add('bcsweep-b100c-30', onImage('ramp', 'BC', 'BrgC', bc(100, -30)));
add('bcsweep-b-100c-40', onImage('ramp', 'BC', 'BrgC', bc(-100, -40)));
