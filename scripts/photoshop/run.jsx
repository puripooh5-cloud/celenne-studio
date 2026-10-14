// Builds the corpus: OUT (folder) and ONLY (comma-separated name prefixes, or '') are set by the caller.
var log = [];
var prefs = app.preferences.maximizeCompatibility;
var units = app.preferences.rulerUnits;
var dialogs = app.displayDialogs;
try {
  app.preferences.maximizeCompatibility = QueryStateType.ALWAYS; // store Photoshop's composite (restored below)
  app.preferences.rulerUnits = Units.PIXELS;
  app.displayDialogs = DialogModes.NO;
  var only = ONLY ? ONLY.split(',') : [];
  for (var i = 0; i < CASES.length; i++) {
    var c = CASES[i];
    var want = !only.length;
    for (var k = 0; k < only.length; k++) if (c.name.indexOf(only[k]) === 0) want = true;
    if (!want) continue;
    var before = app.documents.length;
    try {
      c.build();
      savePsd(OUT + '/' + c.name + '.psd');
      log.push('ok ' + c.name);
    } catch (e) {
      log.push('FAIL ' + c.name + ': ' + e.message + ' (line ' + e.line + ')');
      // Close only the documents this case created (never the user's own).
      while (app.documents.length > before) app.documents[app.documents.length - 1].close(SaveOptions.DONOTSAVECHANGES);
    }
  }
} finally {
  app.preferences.maximizeCompatibility = prefs;
  app.preferences.rulerUnits = units;
  app.displayDialogs = dialogs;
}
log.join('\n');
