// For every PSD in IN: opens it, makes Photoshop re-lay-out and redraw every text layer with its
// own type engine ("Update All Text Layers"), and saves the result to OUT, so Celenne's rendering
// of the same text can be compared with Photoshop's (scripts/photoshop/retype-compare.ts).
var log = [];
var prefs = app.preferences.maximizeCompatibility, dialogs = app.displayDialogs;
try {
  app.preferences.maximizeCompatibility = QueryStateType.ALWAYS;
  app.displayDialogs = DialogModes.NO;
  var files = new Folder(IN).getFiles('*.psd');
  for (var i = 0; i < files.length; i++) {
    var d = null;
    try {
      d = app.open(files[i]);
      // Touch every text layer so Photoshop re-composes it (setting the same contents re-lays it out).
      var n = 0;
      var walk = function (layers) {
        for (var k = 0; k < layers.length; k++) {
          var l = layers[k];
          if (l.typename === 'LayerSet') { walk(l.layers); continue; }
          if (l.kind === LayerKind.TEXT) { var c = l.textItem.contents; l.textItem.contents = c; n++; }
        }
      };
      walk(d.layers);
      var o = new PhotoshopSaveOptions(); o.layers = true;
      d.saveAs(new File(OUT + '/' + files[i].name), o, true, Extension.LOWERCASE);
      d.close(SaveOptions.DONOTSAVECHANGES);
      log.push('ok ' + files[i].name + ' (' + n + ' text layers)');
    } catch (e) {
      log.push('FAIL ' + files[i].name + ': ' + e.message);
      // Close only the document this script opened (never the user's own).
      if (d) try { d.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) { /* already closed */ }
    }
  }
} finally {
  app.preferences.maximizeCompatibility = prefs;
  app.displayDialogs = dialogs;
}
log.join('\n');
