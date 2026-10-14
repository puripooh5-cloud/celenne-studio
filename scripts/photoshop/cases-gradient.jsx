// Gradient probes: 256 x 8 horizontal linear gradient fill layers, to measure Photoshop's
// interpolation (smoothness, midpoints, Classic / Perceptual / Linear methods) row by row.
function gradProbe(stops, smooth, method, mids) {
  return function () {
    var d = newDoc('c', 256, 8); dropBackground(d);
    var s = new ActionDescriptor();
    var g = gradientDesc(stops);
    g.putDouble(cT('Intr'), smooth);
    if (mids) {
      // Rebuild colour stops with custom midpoints.
      var cl = new ActionList();
      for (var i = 0; i < stops.length; i++) {
        var st = new ActionDescriptor();
        putColor(st, cT('Clr '), stops[i][1]);
        st.putEnumerated(cT('Type'), cT('Clry'), cT('UsrS'));
        st.putInteger(cT('Lctn'), stops[i][0]);
        st.putInteger(cT('Mdpn'), mids[i]);
        cl.putObject(cT('Clrt'), st);
      }
      g.putList(cT('Clrs'), cl);
    }
    if (method) s.putEnumerated(sT('gradientsInterpolationMethod'), sT('gradientInterpolationMethodType'), sT(method));
    s.putObject(cT('Grad'), cT('Grdn'), g);
    s.putEnumerated(cT('Type'), cT('GrdT'), cT('Lnr '));
    s.putUnitDouble(cT('Angl'), cT('#Ang'), 0);
    fillLayer('Gradient', 'gradientLayer', s);
  };
}
var BW = [[0, [0, 0, 0]], [4096, [255, 255, 255]]];
var RYB = [[0, [255, 0, 0]], [1500, [255, 255, 0]], [4096, [0, 0, 255]]];
add('probe-grad-bw-s0', gradProbe(BW, 0));
add('probe-grad-bw-s50', gradProbe(BW, 2048));
add('probe-grad-bw-s100', gradProbe(BW, 4096));
add('probe-grad-bw-mid25-s0', gradProbe(BW, 0, null, [25, 50]));
add('probe-grad-bw-mid25-s100', gradProbe(BW, 4096, null, [25, 50]));
add('probe-grad-bw-mid80-s0', gradProbe(BW, 0, null, [80, 50]));
add('probe-grad-bw-rmid25-s0', gradProbe(BW, 0, null, [50, 25]));
add('probe-grad-bw-rmid80-s0', gradProbe(BW, 0, null, [50, 80]));
add('probe-grad-bw-rmid10-s0', gradProbe(BW, 0, null, [50, 10]));
add('probe-grad-bw-rmid25-s100', gradProbe(BW, 4096, null, [50, 25]));
add('probe-grad-ryb-rmid30-perceptual', gradProbe(RYB, 2048, 'perceptual', [50, 30, 70]));
add('probe-grad-ryb-rmid30-s0', gradProbe(RYB, 0, null, [50, 30, 70]));
add('probe-grad-ryb-s0', gradProbe(RYB, 0));
add('probe-grad-ryb-s50', gradProbe(RYB, 2048));
add('probe-grad-mono3-s100', gradProbe([[0, [0, 0, 0]], [2048, [64, 64, 64]], [4096, [255, 255, 255]]], 4096));
add('probe-grad-mono3b-s100', gradProbe([[0, [0, 0, 0]], [1200, [200, 200, 200]], [4096, [255, 255, 255]]], 4096));
add('probe-grad-peak3-s50', gradProbe([[0, [0, 0, 0]], [2048, [255, 255, 255]], [4096, [0, 0, 0]]], 2048));
add('probe-grad-mono4-s100', gradProbe([[0, [0, 0, 0]], [1000, [100, 100, 100]], [2500, [120, 120, 120]], [4096, [255, 255, 255]]], 4096));
add('probe-grad-ryb-s100', gradProbe(RYB, 4096));
add('probe-grad-ryb-perceptual', gradProbe(RYB, 4096, 'perceptual'));
add('probe-grad-ryb-linear', gradProbe(RYB, 4096, 'linear'));
add('probe-grad-bw-perceptual', gradProbe(BW, 4096, 'perceptual'));
add('probe-grad-bw-linear', gradProbe(BW, 4096, 'linear'));
add('probe-perc-rb-s0', gradProbe([[0, [255, 0, 0]], [4096, [0, 0, 255]]], 0, 'perceptual'));
add('probe-perc-yb-s0', gradProbe([[0, [255, 255, 0]], [4096, [0, 0, 255]]], 0, 'perceptual'));
add('probe-perc-gm-s0', gradProbe([[0, [0, 255, 0]], [4096, [255, 0, 255]]], 0, 'perceptual'));
add('probe-perc-yb-s100', gradProbe([[0, [255, 255, 0]], [4096, [0, 0, 255]]], 4096, 'perceptual'));
add('probe-perc-ryb-s0', gradProbe(RYB, 0, 'perceptual'));
