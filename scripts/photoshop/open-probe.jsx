// Reports the text layers Photoshop sees in FILE (editable text, font, size) and closes it without saving.
var result = [];
var dialogs = app.displayDialogs;
try {
  // The document was opened by Photoshop itself (open-probe.ps1 passes it to Photoshop.exe, so
  // any prompt shows as it would for a user); find it, or open it without dialogs.
  app.displayDialogs = DialogModes.NO;
  var d = null, target = new File(FILE).fsName.toLowerCase();
  for (var k = 0; k < app.documents.length; k++) { try { if (app.documents[k].fullName.fsName.toLowerCase() === target) d = app.documents[k]; } catch (e) { /* unsaved */ } }
  if (!d) d = app.open(new File(FILE));
  var walk = function (layers) {
    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      if (l.typename === 'LayerSet') { walk(l.layers); continue; }
      if (l.kind !== LayerKind.TEXT) continue;
      var t = l.textItem, info = { name: l.name };
      try { info.contents = t.contents; } catch (e) { info.contents = 'ERR ' + e.message; }
      try { info.font = t.font; } catch (e) { info.font = 'ERR'; }
      try { info.size = Math.round(t.size.as('px') * 100) / 100; } catch (e) { info.size = 'ERR'; }
      try { info.kind = String(t.kind); } catch (e) { info.kind = 'ERR'; }
      try { var b = l.bounds; info.bounds = [b[0].as('px'), b[1].as('px'), b[2].as('px'), b[3].as('px')]; } catch (e) { info.bounds = 'ERR'; }
      result.push(info);
    }
  };
  walk(d.layers);
  d.close(SaveOptions.DONOTSAVECHANGES);
} catch (e) {
  result.push({ error: e.message });
} finally {
  app.displayDialogs = dialogs;
}
var json = '[';
for (var k = 0; k < result.length; k++) {
  var o = result[k], parts = [];
  for (var p in o) parts.push('"' + p + '":' + (typeof o[p] === 'string' ? '"' + o[p].replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"' : (o[p] instanceof Array ? '[' + o[p].join(',') + ']' : o[p])));
  json += (k ? ',' : '') + '{' + parts.join(',') + '}';
}
json + ']';
