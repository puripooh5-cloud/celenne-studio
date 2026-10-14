// For every PSD in IN: Photoshop converts a copy of each text layer to a shape layer (named
// "<name> outline", hidden) using its own layout of the text, and saves the result to OUT.
// (Converting needs Photoshop to lay the text out itself, so the outline is Photoshop's layout of
// whatever text data the file carries.) Only documents this script opened are closed.
// Set by the caller: IN, OUT (folder paths with forward slashes).
function cT(s) { return charIDToTypeID(s); }
function sT(s) { return stringIDToTypeID(s); }
var files = new Folder(IN).getFiles('*.psd'), done = [];
var prev = app.displayDialogs;
app.displayDialogs = DialogModes.NO;
for (var i = 0; i < files.length; i++) {
  var doc = app.open(files[i]);
  var texts = [];
  for (var k = 0; k < doc.artLayers.length; k++) if (doc.artLayers[k].kind == LayerKind.TEXT) texts.push(doc.artLayers[k]);
  for (var j = 0; j < texts.length; j++) {
    var src = texts[j];
    doc.activeLayer = src;
    var dup = src.duplicate();
    doc.activeLayer = dup;
    try {
      var d = new ActionDescriptor(), r = new ActionReference(), r2 = new ActionReference();
      r.putClass(sT('contentLayer'));
      d.putReference(cT('null'), r);
      r2.putEnumerated(cT('TxLr'), cT('Ordn'), cT('Trgt'));
      d.putReference(cT('Usng'), r2);
      executeAction(cT('Mk  '), d, DialogModes.NO);
      doc.activeLayer.name = src.name + ' outline';
      doc.activeLayer.visible = false;
    } catch (e) { done.push('  ' + src.name + ': ' + e); try { dup.remove(); } catch (e2) { } }
  }
  var o = new PhotoshopSaveOptions(); o.layers = true;
  doc.saveAs(new File(OUT + '/' + doc.name), o, true);
  done.push('ok ' + doc.name + ' (' + texts.length + ' text layers)');
  doc.close(SaveOptions.DONOTSAVECHANGES);
}
app.displayDialogs = prev;
done.join('\n');
