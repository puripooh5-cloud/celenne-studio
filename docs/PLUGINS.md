# Plugins

Plugins add filters, exporters, importers, tools, scripts, panels and AI tasks. Manage them under **Edit ▸ Plugins…**, which has *Install from File…* and *Install Sample Plugin*. A ready-to-install example is at [`samples/plugins/vignette.lplugin.json`](../samples/plugins/vignette.lplugin.json).

## Security model

A plugin **cannot compromise the application or the user's files**:

- **Code runs in a dedicated Web Worker** created from a Blob. It has no DOM, no Node.js, no Electron bridge and no access to documents; it only sees the pixels and parameters the host sends it.
- **Before plugin code runs**, the bootstrap removes network, storage and code-loading APIs (`fetch`, `XMLHttpRequest`, `WebSocket`, `WebTransport`, `EventSource`, `importScripts`, `indexedDB`, `caches`, `BroadcastChannel`, `Worker`, `SharedWorker`, `navigator`). They are removed from the global object *and every prototype on its chain*. If any remain reachable, the plugin refuses to start.
- **The app's CSP also applies to the worker:** no `eval` in production, and scripts load only from the app itself.
- **Timeouts:** a call that takes longer than 120 s terminates the worker. Crashes reject the pending call without affecting the app.
- **Panels** render in `<iframe sandbox="allow-scripts">` *without* `allow-same-origin`. They can't read app storage, cookies or the DOM.
- **Validation:** the manifest id must match `^[a-z0-9][a-z0-9.-]{1,63}$`, the code is limited to 2 MB and the package file to 4 MB, and the API version is checked.
- **Consent:** installing shows what the plugin contributes and asks for confirmation. Plugins can be disabled or removed at any time.
- Plugin output is validated: filters and tools must return a `Float32Array` of the exact input size (values are clamped to 0..1), exporters a `Uint8Array`, and importers an RGBA image of at most 300 megapixels.
- **Scripts never touch the document.** A script receives a read-only description (size, mode, layer tree, selection bounds) and returns a list of app actions. The host rejects unknown actions and anything that saves, exports, opens or places files, quits, or changes preferences or plugins, then shows the steps and asks before running them. Every step is a normal, undoable command.
- **Tools** get only the stroke and the pixels of the active layer under it; the host applies the result as one undoable step and respects the selection and layer locks.

## Package format

A plugin is one JSON file (`*.lplugin.json`):

```json
{
  "manifest": {
    "id": "com.example.vignette",
    "name": "Vignette",
    "version": "1.0.0",
    "author": "Example",
    "description": "Darkens the corners.",
    "apiVersion": 1,
    "contributes": {
      "filters":   [{ "id": "vignette", "name": "Vignette", "category": "Other",
                      "params": [{ "type": "number", "id": "amount", "label": "Amount", "min": 0, "max": 100, "default": 50, "unit": "%" }] }],
      "exporters": [{ "id": "ppm", "label": "Portable Pixmap (PPM)", "extension": "ppm" }],
      "panels":    [{ "id": "about", "title": "About", "html": "<body>…</body>" }],
      "importers": [{ "id": "ppm", "label": "Portable Pixmap (PPM)", "extensions": ["ppm", "pnm"] }],
      "tools":     [{ "id": "spray", "name": "Spray", "padding": 40,
                      "params": [{ "type": "number", "id": "radius", "label": "Radius", "min": 2, "max": 200, "default": 24, "unit": "px" }] }],
      "scripts":   [{ "id": "dupHide", "name": "Duplicate and Hide Original" }],
      "aiTasks":   ["select-subject"]
    }
  },
  "code": "celenne.registerFilter('vignette', (img, params, ctx) => { … return img; });"
}
```

`params` use the same schema as built-in filters: `number` (min, max, step, default, unit), `angle`, `select` (options), `boolean` and `seed`.

## Runtime API (inside `code`)

A frozen global `celenne` object is available:

| Function | Handler signature | Notes |
|---|---|---|
| `celenne.registerFilter(id, fn)` | `fn(img, params, ctx) → img \| Promise<img>` | `img = { width, height, channels, data: Float32Array }`, straight RGBA 0..1. Modify `img.data` in place or return a new object with the same size. `ctx.progress(0..1)` reports progress. |
| `celenne.registerExporter(id, fn)` | `fn(img, options) → Uint8Array` | `img.data` is the flattened document, 8-bit RGBA (`Uint8ClampedArray`). |
| `celenne.registerImporter(id, fn)` | `fn(bytes, fileName) → { width, height, data }` | `bytes` is the file (`Uint8Array`); return 8-bit straight RGBA (`Uint8ClampedArray`). The importer is offered for its manifest `extensions` in **File ▸ Open**. |
| `celenne.registerTool(id, fn)` | `fn(img, ctx) → img` | Called when a stroke ends. `img = { width, height, data: Float32Array }` is the active layer under the stroke's bounds plus `padding` (straight RGBA 0..1). `ctx = { points: [{ x, y, pressure }], region, colorMode, foreground, background, params }`; points are relative to the region, colors are RGB 0..1. In CMYK and Lab documents a tool receives the RGB appearance unless its manifest entry sets `"nativeColor": true`: it then gets `colorMode: "cmyk"` with `img.channels = 5` (C, M, Y, K ink amounts and alpha, 0..1) or `colorMode: "lab"` (L/100, (a+128)/255, (b+128)/255, alpha), and colours in the same layout. For RGB-only tools, pixels the tool leaves unchanged keep their exact inks. |
| `celenne.registerScript(id, fn)` | `fn(document) → [{ action, args? }]` | `document = { name, width, height, resolution, colorMode, bitDepth, layers, activeLayerId, selection }`. Return app action ids (the same records macros use, e.g. `layer.duplicate`, `image.flip`). At most 500 steps. |
| `celenne.registerAITask(task, fn)` | `fn(payload) → result` | Implements a task for the *Plugin models* AI provider; payload and result follow [AI_PROVIDERS.md](AI_PROVIDERS.md) with raw arrays instead of base64 PNG. |

Registered filters appear under **Filter ▸ *category*** as `plugin:<plugin id>:<filter id>`. They are destructive filters with a dialog; live preview and use as smart filters are not available for plugin filters. Exporters appear in **File ▸ Export As**, importers in **File ▸ Open**, tools as the **Plugin Tool** in the toolbar (choose the tool and its parameters in the options bar), and scripts under **File ▸ Scripts**.
