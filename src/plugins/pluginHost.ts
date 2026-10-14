/**
 * Plugin host.
 *
 * A plugin package (.lplugin.json) = { manifest, code }. The code runs inside a dedicated
 * Web Worker created from a Blob: before the plugin code executes, the bootstrap removes network
 * and script-loading APIs (fetch, XMLHttpRequest, WebSocket, EventSource, importScripts,
 * indexedDB, caches), and the application CSP applies to the worker as well. Plugins cannot touch
 * the DOM, the document model or the file system; they exchange pixels and parameters with the
 * host through postMessage only. Panels contributed by plugins render in `sandbox="allow-scripts"`
 * iframes without same-origin access.
 *
 * Contribution points: filters, exporters, importers, panels, AI models (task handlers for the
 * CustomAIProvider), tools and scripts:
 *  - tools receive the stroke path, the pixels under it and the colors, and return new pixels
 *    for that region (applied by the host as one undoable step);
 *  - scripts receive a read-only description of the document and return a list of app actions
 *    (the same records macros use), which the host validates and runs after confirmation.
 */
import { extraFilters } from '../filters/builtin';
import type { FilterDef, FilterParams, FloatImage, ParamDef } from '../filters/types';
import { documentFromImage, registerExporter, registerImporter, unregisterFormats } from '../formats/registry';
import { flattenToPixels } from '../rendering/flatten';
import { loadJSON, saveJSON } from '../app/settings';
import { customProvider } from '../ai/provider';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  apiVersion: 1;
  contributes: {
    filters?: { id: string; name: string; category?: FilterDef['category']; params?: ParamDef[]; padding?: number }[];
    exporters?: { id: string; label: string; extension: string }[];
    panels?: { id: string; title: string; html: string }[];
    aiTasks?: string[];
    importers?: { id: string; label: string; extensions: string[] }[];
    /**
     * `nativeColor`: the tool understands CMYK and Lab documents' own channels (it then receives
     * C, M, Y, K, A ink amounts or encoded L a b A instead of an RGB view; see docs/PLUGINS.md).
     */
    tools?: { id: string; name: string; params?: ParamDef[]; padding?: number; nativeColor?: boolean }[];
    scripts?: { id: string; name: string; description?: string }[];
  };
}

/** A tool contributed by a plugin. */
export interface PluginToolDef {
  fullId: string;
  pluginId: string;
  name: string;
  params: ParamDef[];
  padding: number;
  nativeColor: boolean;
}

/** Channel layout handed to a plugin tool. */
export type PluginColorMode = 'rgb' | 'cmyk' | 'lab';

/** Input of a plugin tool invocation (region in document px). */
export interface PluginToolInput {
  points: { x: number; y: number; pressure: number }[];
  region: { x: number; y: number; w: number; h: number };
  /**
   * Straight floats of the active layer in `region`: RGBA (`rgb`), C M Y K A ink amounts
   * (`cmyk`) or L/100, (a+128)/255, (b+128)/255, A (`lab`).
   */
  data: Float32Array;
  colorMode: PluginColorMode;
  /** Values per pixel in `data` (4, or 5 for cmyk). */
  channels: number;
  /** In the same layout as a pixel of `data`, without alpha. */
  foreground: number[];
  background: number[];
  params: FilterParams;
}

export interface PluginScriptDef {
  fullId: string;
  pluginId: string;
  name: string;
  description?: string;
}

export interface PluginPackage {
  manifest: PluginManifest;
  code: string;
}

interface Installed {
  pkg: PluginPackage;
  enabled: boolean;
}

const KEY = 'celenne.plugins.v1';

const BOOTSTRAP = `
"use strict";
(() => {
  // Network, storage and code-loading APIs are removed from the global object AND every object on
  // its prototype chain (fetch lives on WorkerGlobalScope.prototype, so shadowing it on self alone
  // would leave it reachable through Object.getPrototypeOf(self)).
  const blocked = ['fetch','XMLHttpRequest','WebSocket','WebSocketStream','WebTransport','EventSource','importScripts','indexedDB','caches','BroadcastChannel','SharedWorker','Worker','Request','Response','navigator'];
  const chain = [];
  for (let o = self; o; o = Object.getPrototypeOf(o)) chain.push(o);
  for (const o of chain) for (const k of blocked) {
    if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
    try { Object.defineProperty(o, k, { value: undefined, configurable: false, writable: false }); } catch (e) { try { delete o[k]; } catch (e2) {} }
  }
  for (const k of blocked) {
    try { Object.defineProperty(self, k, { value: undefined, configurable: false, writable: false }); } catch (e) {}
  }
  // Refuse to run at all if anything is still reachable.
  for (const o of chain) for (const k of ['fetch','XMLHttpRequest','WebSocket','WebTransport','importScripts']) {
    if (typeof o[k] === 'function') throw new Error('Plugin sandbox could not be established');
  }
})();
const __handlers = { filter: {}, exporter: {}, ai: {}, importer: {}, tool: {}, script: {} };
const celenne = Object.freeze({
  apiVersion: 1,
  registerFilter(id, fn) { __handlers.filter[id] = fn; },
  registerExporter(id, fn) { __handlers.exporter[id] = fn; },
  registerAITask(task, fn) { __handlers.ai[task] = fn; },
  registerImporter(id, fn) { __handlers.importer[id] = fn; },
  registerTool(id, fn) { __handlers.tool[id] = fn; },
  registerScript(id, fn) { __handlers.script[id] = fn; },
});
const lumen = celenne; // the API's name up to 0.1.0, kept so older plugins still load
self.onmessage = async (e) => {
  const m = e.data;
  try {
    let result;
    if (m.kind === 'filter') {
      const fn = __handlers.filter[m.id];
      if (!fn) throw new Error('Filter not registered: ' + m.id);
      const img = { width: m.w, height: m.h, channels: m.ch, data: m.data };
      const out = await fn(img, m.params, { progress: (f) => self.postMessage({ seq: m.seq, progress: f }) });
      result = { data: (out && out.data) || img.data };
      self.postMessage({ seq: m.seq, ok: true, result }, [result.data.buffer]);
      return;
    }
    if (m.kind === 'exporter') {
      const fn = __handlers.exporter[m.id];
      if (!fn) throw new Error('Exporter not registered: ' + m.id);
      const bytes = await fn({ width: m.w, height: m.h, data: m.data }, m.options || {});
      if (!(bytes instanceof Uint8Array)) throw new Error('Exporter must return a Uint8Array');
      self.postMessage({ seq: m.seq, ok: true, result: { bytes } }, [bytes.buffer]);
      return;
    }
    if (m.kind === 'importer') {
      const fn = __handlers.importer[m.id];
      if (!fn) throw new Error('Importer not registered: ' + m.id);
      const img = await fn(m.bytes, m.name);
      if (!img || !(img.data instanceof Uint8ClampedArray || img.data instanceof Uint8Array)) throw new Error('Importer must return { width, height, data: Uint8ClampedArray (RGBA) }');
      self.postMessage({ seq: m.seq, ok: true, result: { width: img.width, height: img.height, data: img.data } }, [img.data.buffer]);
      return;
    }
    if (m.kind === 'tool') {
      const fn = __handlers.tool[m.id];
      if (!fn) throw new Error('Tool not registered: ' + m.id);
      const img = { width: m.region.w, height: m.region.h, channels: m.channels, colorMode: m.colorMode, data: m.data };
      const out = await fn(img, { points: m.points, region: m.region, colorMode: m.colorMode, foreground: m.foreground, background: m.background, params: m.params });
      const data = (out && out.data) || img.data;
      self.postMessage({ seq: m.seq, ok: true, result: { data } }, [data.buffer]);
      return;
    }
    if (m.kind === 'script') {
      const fn = __handlers.script[m.id];
      if (!fn) throw new Error('Script not registered: ' + m.id);
      const actions = await fn(m.document);
      self.postMessage({ seq: m.seq, ok: true, result: { actions: JSON.parse(JSON.stringify(actions || [])) } });
      return;
    }
    if (m.kind === 'ai') {
      const fn = __handlers.ai[m.task];
      if (!fn) throw new Error('AI task not registered: ' + m.task);
      result = await fn(m.payload);
      self.postMessage({ seq: m.seq, ok: true, result });
      return;
    }
  } catch (err) {
    self.postMessage({ seq: m.seq, ok: false, error: String(err && err.message || err) });
  }
};
`;

function validate(pkg: PluginPackage): void {
  const m = pkg?.manifest;
  if (!m || typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,63}$/.test(m.id)) throw new Error('Invalid plugin id');
  if (m.apiVersion !== 1) throw new Error('Unsupported plugin API version');
  if (typeof pkg.code !== 'string' || pkg.code.length > 2_000_000) throw new Error('Invalid plugin code');
  const ids = [...(m.contributes?.filters ?? []), ...(m.contributes?.importers ?? []), ...(m.contributes?.tools ?? []), ...(m.contributes?.scripts ?? []), ...(m.contributes?.exporters ?? [])];
  for (const f of ids) if (!/^[a-zA-Z0-9_-]+$/.test(f.id)) throw new Error(`Invalid contribution id ${f.id}`);
  for (const i of m.contributes?.importers ?? []) if (!Array.isArray(i.extensions) || !i.extensions.every((e) => /^[a-z0-9]{1,8}$/i.test(e))) throw new Error(`Invalid importer extensions for ${i.id}`);
}

/** Largest image a plugin importer may produce (pixels). */
const MAX_IMPORT_PIXELS = 300_000_000;

class PluginHost {
  private installed = new Map<string, Installed>();
  private workers = new Map<string, Worker>();
  private seq = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; progress?: (f: number) => void }>();
  private listeners = new Set<() => void>();

  constructor() {
    for (const i of loadJSON<Installed[]>(KEY, [])) this.installed.set(i.pkg.manifest.id, i);
  }

  on(l: () => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
  private changed() {
    saveJSON(KEY, [...this.installed.values()]);
    for (const l of this.listeners) l();
  }

  list(): Installed[] {
    return [...this.installed.values()];
  }

  /** Activates all enabled plugins (called at startup). */
  activateAll(): void {
    for (const i of this.installed.values()) if (i.enabled) this.activate(i.pkg);
  }

  install(pkg: PluginPackage): void {
    validate(pkg);
    this.deactivate(pkg.manifest.id);
    this.installed.set(pkg.manifest.id, { pkg, enabled: true });
    this.activate(pkg);
    this.changed();
  }

  remove(id: string): void {
    this.deactivate(id);
    this.installed.delete(id);
    this.changed();
  }

  setEnabled(id: string, enabled: boolean): void {
    const i = this.installed.get(id);
    if (!i) return;
    i.enabled = enabled;
    if (enabled) this.activate(i.pkg);
    else this.deactivate(id);
    this.changed();
  }

  tools(): PluginToolDef[] {
    return this.list().filter((i) => i.enabled).flatMap((i) => (i.pkg.manifest.contributes.tools ?? []).map((t) => ({ fullId: `plugin:${i.pkg.manifest.id}:${t.id}`, pluginId: i.pkg.manifest.id, name: t.name, params: t.params ?? [], padding: Math.max(0, Math.min(512, t.padding ?? 16)), nativeColor: t.nativeColor === true })));
  }

  scripts(): PluginScriptDef[] {
    return this.list().filter((i) => i.enabled).flatMap((i) => (i.pkg.manifest.contributes.scripts ?? []).map((s) => ({ fullId: `plugin:${i.pkg.manifest.id}:${s.id}`, pluginId: i.pkg.manifest.id, name: s.name, description: s.description })));
  }

  /** Runs a plugin tool on a region; returns the new straight RGBA pixels for it. */
  async runTool(fullId: string, input: PluginToolInput): Promise<Float32Array> {
    const [, pluginId, id] = fullId.split(':');
    const n = input.region.w * input.region.h * input.channels;
    const r = (await this.call(pluginId, { kind: 'tool', id, points: input.points, region: input.region, data: input.data, colorMode: input.colorMode, channels: input.channels, foreground: input.foreground, background: input.background, params: input.params }, [input.data.buffer])) as { data: Float32Array };
    if (!(r.data instanceof Float32Array) || r.data.length !== n) throw new Error('Plugin tool returned invalid pixel data');
    for (let i = 0; i < n; i++) { const v = r.data[i]; r.data[i] = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; }
    return r.data;
  }

  /** Runs a plugin script with a read-only document description; returns the actions it asks for. */
  async runScript(fullId: string, document: Record<string, unknown>): Promise<{ action: string; args?: Record<string, unknown> }[]> {
    const [, pluginId, id] = fullId.split(':');
    const r = (await this.call(pluginId, { kind: 'script', id, document })) as { actions: unknown };
    if (!Array.isArray(r.actions) || r.actions.length > 500) throw new Error('Script must return an array of at most 500 actions');
    return r.actions.map((a) => {
      const o = a as { action?: unknown; args?: unknown };
      if (typeof o?.action !== 'string' || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(o.action)) throw new Error('Script returned an invalid action');
      return { action: o.action, args: o.args && typeof o.args === 'object' ? (o.args as Record<string, unknown>) : undefined };
    });
  }

  panels(): { pluginId: string; id: string; title: string; html: string }[] {
    return this.list().filter((i) => i.enabled).flatMap((i) => (i.pkg.manifest.contributes.panels ?? []).map((p) => ({ pluginId: i.pkg.manifest.id, ...p })));
  }

  private worker(id: string): Worker {
    let w = this.workers.get(id);
    if (w) return w;
    const pkg = this.installed.get(id)!.pkg;
    const blob = new Blob([BOOTSTRAP, '\n;(function(){\n', pkg.code, '\n})();\n'], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    w = new Worker(url);
    URL.revokeObjectURL(url);
    w.onmessage = (e) => {
      const m = e.data;
      const p = this.pending.get(m.seq);
      if (!p) return;
      if (m.progress !== undefined) { p.progress?.(m.progress); return; }
      this.pending.delete(m.seq);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error));
    };
    w.onerror = (e) => {
      for (const [k, p] of this.pending) { p.reject(new Error(`Plugin "${id}" crashed: ${e.message}`)); this.pending.delete(k); }
    };
    this.workers.set(id, w);
    return w;
  }

  private call(id: string, msg: Record<string, unknown>, transfer: Transferable[] = [], progress?: (f: number) => void, timeoutMs = 120000): Promise<unknown> {
    const seq = this.seq++;
    const w = this.worker(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(seq)) return;
        this.pending.delete(seq);
        // A runaway plugin is terminated (it will be re-created on next use).
        this.workers.get(id)?.terminate();
        this.workers.delete(id);
        reject(new Error(`Plugin "${id}" timed out`));
      }, timeoutMs);
      this.pending.set(seq, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); }, progress });
      w.postMessage({ ...msg, seq }, transfer);
    });
  }

  private activate(pkg: PluginPackage) {
    const m = pkg.manifest;
    for (const f of m.contributes.filters ?? []) {
      const fullId = `plugin:${m.id}:${f.id}`;
      if (extraFilters.some((x) => x.id === fullId)) continue;
      const def: FilterDef = {
        id: fullId,
        name: `${f.name}…`,
        category: f.category ?? 'Other',
        params: f.params ?? [],
        space: 'straight',
        padding: () => f.padding ?? 0,
        global: true,
        apply: () => {
          throw new Error('Plugin filters run asynchronously');
        },
        runAsync: async (img: FloatImage, params: FilterParams, progress: (f: number) => void) => {
          const r = (await this.call(m.id, { kind: 'filter', id: f.id, w: img.w, h: img.h, ch: img.ch, data: img.data, params }, [img.data.buffer], progress)) as { data: Float32Array };
          if (!(r.data instanceof Float32Array) || r.data.length !== img.w * img.h * img.ch) throw new Error('Plugin returned invalid pixel data');
          return { ...img, data: r.data };
        },
      };
      extraFilters.push(def);
    }
    for (const e of m.contributes.exporters ?? []) {
      registerExporter({
        id: `plugin:${m.id}:${e.id}`,
        label: `${e.label} (plugin)`,
        extension: e.extension,
        available: true,
        layered: false,
        supports16: false,
        export: async (doc) => {
          const f = flattenToPixels(doc, { depth: 8 });
          const r = (await this.call(m.id, { kind: 'exporter', id: e.id, w: f.width, h: f.height, data: f.data })) as { bytes: Uint8Array };
          return r.bytes;
        },
      });
    }
    for (const task of m.contributes.aiTasks ?? []) customProvider.register(task, async (payload) => (await this.call(m.id, { kind: 'ai', task, payload })) as Record<string, unknown>);
    for (const imp of m.contributes.importers ?? []) {
      const exts = imp.extensions.map((e) => e.toLowerCase());
      registerImporter({
        id: `plugin:${m.id}:${imp.id}`,
        label: `${imp.label} (plugin)`,
        extensions: exts,
        available: true,
        accepts: (_bytes, name) => exts.includes(name.toLowerCase().split('.').pop() ?? ''),
        import: async (bytes, name) => {
          const r = (await this.call(m.id, { kind: 'importer', id: imp.id, bytes: bytes.slice(), name })) as { width: number; height: number; data: Uint8ClampedArray };
          const { width: w, height: h } = r;
          if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w * h > MAX_IMPORT_PIXELS || r.data.length !== w * h * 4) throw new Error('Plugin importer returned an invalid image');
          const doc = documentFromImage(name, w, h, 8, new Uint8ClampedArray(r.data.buffer, r.data.byteOffset, r.data.length));
          return { doc, warnings: [`Opened by the "${m.name}" plugin.`], issues: [] };
        },
      });
    }
  }

  private deactivate(id: string) {
    this.workers.get(id)?.terminate();
    this.workers.delete(id);
    for (let i = extraFilters.length - 1; i >= 0; i--) if (extraFilters[i].id.startsWith(`plugin:${id}:`)) extraFilters.splice(i, 1);
    unregisterFormats(`plugin:${id}:`);
  }
}

export const plugins = new PluginHost();
