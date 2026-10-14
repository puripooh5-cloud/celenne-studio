// Opens every PSD in IN with Photoshop and saves it (with Photoshop's composite) to OUT.
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
      var o = new PhotoshopSaveOptions(); o.layers = true; o.alphaChannels = true; o.spotColors = true; o.embedColorProfile = true;
      d.saveAs(new File(OUT + '/' + files[i].name), o, true, Extension.LOWERCASE);
      d.close(SaveOptions.DONOTSAVECHANGES);
      log.push('ok ' + files[i].name);
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
