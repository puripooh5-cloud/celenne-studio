# API reference

Internal APIs for extending Celenne Studio from inside the codebase. For third-party extensions use the sandboxed [plugin API](PLUGINS.md). Paths are relative to `src/`.

## Document model — `document/`

```ts
const doc = new CelenneDocument('Name', { width, height, resolution: 72, colorMode: 'rgb', bitDepth: 8 });
doc.insertLayer(layer, parent = doc.root, index?);   // emits 'structure'
doc.removeLayer(layer);
doc.getLayer(id); doc.allLayers(); doc.walk();       // lookup / iteration (walk = depth-first)
doc.batch(() => { … });                              // coalesces change events
doc.on((changes: DocumentChange[]) => { … });        // subscribe; returns unsubscribe
doc.emit({ type: 'pixels', layerId, rect });         // after direct raster writes
```

Layer factories (`document/layerFactory.ts`):

```
createPixelLayer   createGroupLayer   createAdjustmentLayer   createFillLayer
createTextLayer    createShapeLayer   createSmartObjectLayer  createMask
```

`cloneLayer(layer, freshIds?)` deep-copies a layer, sharing raster tiles copy-on-write. `captureState(doc)` and `restoreState(doc, state)` snapshot a whole document cheaply.

After changing a text, shape, fill or smart-object layer's parameters, call `updateAppearance(doc, layer)` (`layers/appearance.ts`) to re-render its cached pixels.

## Pixels — `image-engine/`

```ts
const r = new TiledRaster(channels /*1|4*/, depth /*8|16|32*/, fill = 0);
r.readFloat(rect, level = 0): Float32Array    // normalized 0..1, straight alpha, level = pyramid level
r.writeFloat(rect, data)                      // copy-on-write per tile
r.snapshot() / r.restore(snap) / r.clone()    // O(tiles), shares storage
r.contentBounds() / r.compact() / r.byteSize()
TiledRaster.fromPixels(w, h, channels, depth, typedArray)
```

Blend modes: `BLEND_MODES` (ids plus labels), `compositeSpan(mode, dstPremul, dOff, srcStraight, sOff, n, { opacity, mask })`.

## Rendering — `rendering/`

```ts
compositeRegion(doc, rect, { level, overrides?, noEffects?, root?, stopAt? }): Float32Array  // premultiplied RGBA
flattenToPixels(doc, { depth?, region?, premultiplied? })                                    // full-resolution export
engine.setOverride(layerId, override, dirtyRect)   // live previews without touching the document
```

## History and commands — `history/`, `commands/`

```ts
interface Command {
  label: string;
  do(doc): void; undo(doc): void;
  mergeWith?(next: Command): boolean;   // coalesce slider drags
  memoryBytes?(): number;
  record?: { action: string; args?: Record<string, unknown> };   // macro recording
}
session.push(cmd, alreadyApplied = false);
```

Helpers:
- `editRaster(doc, target, label, (raster, ox, oy) => dirtyRect, record?)` runs a raster edit and returns an undoable `RasterEditCommand`. The target is a layer, mask, channel or selection.
- `editLayer(doc, layerId, label, (layer) => { … }, record?)` changes any layer property and returns a `ReplaceLayerCommand`.
- `recordStateChange(doc, history, label, mutate, record?)` wraps structural whole-document changes (canvas size, profile conversion, flatten).
- Ready-made commands: `CreateLayerCommand`, `DeleteLayerCommand`, `MoveLayerCommand`, `SetLayerPropsCommand`, `TranslateLayersCommand`, `SetEffectsCommand`, `SetMaskCommand`, `CompositeCommand`, `LambdaCommand` (for guides, channels and paths).

Never mutate the document for user-visible edits outside a command; history, auto-save and macro recording all depend on commands.

## Actions — `app/actions.ts`

Actions are the single entry point used by menus, shortcuts, the command palette and macros:

```ts
register({ id: 'image.myThing', label: 'My Thing…', run: (args) => …, enabled?: () => boolean, checked?, shortcut?: 'Ctrl+Alt+M', comingSoon?, category? });
await run('image.myThing', { amount: 3 });
```

Menus reference action ids (`app/menus.ts`). Default shortcuts come from `shortcut` and are user-overridable (`app/shortcuts.ts`). A command whose `record` is `{ action, args }` replays through `run(action, args)`; register a matching action (`category: 'replay'` hides it from menus and the palette).

## Operations — `app/ops/*`

High-level operations used by actions, one module per menu area:

| Module | Covers |
|---|---|
| `layerOps` | new, duplicate, delete, group, merge, masks, smart objects, align/distribute, styles |
| `selectOps` | select all/inverse, modify, color range, subject/sky, channels ↔ selection, paths ↔ selection |
| `imageOps` | image/canvas size, rotate/flip, crop/trim, bit depth, mode, profiles, pixel adjustments |
| `editOps` | undo/redo, copy/paste, fill/stroke, content-aware and generative fill, patterns |
| `filterOps` | apply (worker), smart filters, preview |
| `viewOps` | zoom, fit, guides, view toggles |

They operate on the active session (`editor.active`) and show user-facing errors as toasts.

## Filters — `filters/`

```ts
const myFilter: FilterDef = {
  id: 'myFilter', name: 'My Filter…', category: 'Stylize',
  params: [{ type: 'number', id: 'amount', label: 'Amount', min: 0, max: 100, default: 50 }],
  space: 'straight',                 // or 'premultiplied' (blurs)
  padding: (p) => 0,                 // extra source pixels needed around the output
  global: false,                     // true = needs the whole layer (distortions)
  apply(img, params, ctx) { … return img; },   // img: { w, h, ch, data: Float32Array }
};
```

Add it to `BUILTIN_FILTERS` (`filters/builtin.ts`) and the worker (`filters/worker.ts`) picks it up by id. The filter menu, dialog, live preview, smart-filter support and macro recording follow automatically.

## Tools — `tools/`

Implement `Tool` (`tools/tool.ts`): `down`/`move`/`up`, optionally `keyDown`, `drawOverlay`, `cursor`, `activate`/`deactivate`. Register it in `tools/registry.ts` and add a `TOOLS` entry (`tools/toolTypes.ts`) for the toolbar, flyout group and shortcut. Tools receive a `ToolHost` (session, view, redraw and snapping helpers) and push commands.

## Formats — `formats/registry.ts`

```ts
registerImporter({ id, label, extensions, available: true, accepts(bytes, name) → boolean, import(bytes, name, opts) → Promise<{ doc, warnings, issues }> });
registerExporter({ id, label, extension, available: true, layered: false, supports16: false, export(doc, opts) → Uint8Array });
```

## AI — `ai/provider.ts`

Implement `AIProvider` (subject/sky selection, background removal, inpainting, upscale, edge refinement plus `capabilities()`), and add it to `providers()` and `aiProvider()`. UI features query `aiProvider().capabilities()` and explain unavailable tasks instead of failing.

## Platform — `app/platform/`

`platform()` returns the Electron or browser implementation:
- opening and saving files: `openFiles`, `readPath`, `writePath`, `chooseSavePath`;
- confirmation dialogs, the window title, and close handling;
- the recovery and scratch stores.

The Electron bridge (`window.celenne`, typed in `app/platform/bridge.ts`) is the only way the renderer reaches the OS.
