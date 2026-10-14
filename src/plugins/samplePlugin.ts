/**
 * Sample plugin shipped with the app (Edit ▸ Plugins ▸ Install Sample). It demonstrates the
 * runtime contribution points: a filter, an exporter, an importer, a tool, a script and a panel. The same package is
 * available as samples/plugins/vignette.lplugin.json.
 */
import type { PluginPackage } from './pluginHost';

export const SAMPLE_PLUGIN: PluginPackage = {
  manifest: {
    id: 'celenne.sample.vignette',
    name: 'Vignette & PPM (sample)',
    version: '1.0.0',
    author: 'Celenne Studio',
    description: 'Adds Filter ▸ Other ▸ Vignette, a PPM exporter and importer, a Spray tool, a "Duplicate and Hide Original" script and an info panel.',
    apiVersion: 1,
    contributes: {
      filters: [
        {
          id: 'vignette',
          name: 'Vignette',
          category: 'Other',
          params: [
            { type: 'number', id: 'amount', label: 'Amount', min: 0, max: 100, default: 50, unit: '%' },
            { type: 'number', id: 'radius', label: 'Radius', min: 10, max: 150, default: 80, unit: '%' },
            { type: 'number', id: 'softness', label: 'Softness', min: 1, max: 100, default: 60, unit: '%' },
          ],
        },
      ],
      exporters: [{ id: 'ppm', label: 'Portable Pixmap (PPM)', extension: 'ppm' }],
      importers: [{ id: 'ppm', label: 'Portable Pixmap (PPM)', extensions: ['ppm', 'pnm'] }],
      tools: [
        {
          id: 'spray',
          name: 'Spray',
          padding: 40,
          params: [
            { type: 'number', id: 'radius', label: 'Radius', min: 2, max: 200, default: 24, unit: 'px' },
            { type: 'number', id: 'density', label: 'Density', min: 1, max: 100, default: 30, unit: '%' },
          ],
        },
      ],
      scripts: [{ id: 'dupHide', name: 'Duplicate and Hide Original', description: 'Duplicates the active layer and hides the original.' }],
      panels: [{ id: 'about', title: 'Sample Plugin', html: '<body style="font:12px system-ui;color:#ddd;background:#2b2b2b;margin:12px"><h3 style="margin:0 0 8px">Sample plugin panel</h3><p>This panel runs in a sandboxed iframe with no access to the app, the file system or the network.</p><button onclick="document.getElementById(\'n\').textContent=++window.c||(window.c=1)">Click</button> <span id="n">0</span></body>' }],
    },
  },
  code: `
celenne.registerFilter('vignette', (img, p, ctx) => {
  const { width: w, height: h, data } = img;
  const amount = (p.amount ?? 50) / 100, radius = (p.radius ?? 80) / 100, soft = Math.max(0.01, (p.softness ?? 60) / 100);
  const cx = w / 2, cy = h / 2, maxR = Math.hypot(cx, cy) * radius;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy) / maxR;
      const t = Math.min(1, Math.max(0, (d - (1 - soft)) / soft));
      const k = 1 - amount * t * t * (3 - 2 * t);
      const i = (y * w + x) * 4;
      data[i] *= k; data[i + 1] *= k; data[i + 2] *= k;
    }
    if ((y & 63) === 0) ctx.progress(y / h);
  }
  return img;
});

celenne.registerExporter('ppm', (img) => {
  const header = 'P6\\n' + img.width + ' ' + img.height + '\\n255\\n';
  const out = new Uint8Array(header.length + img.width * img.height * 3);
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
  let o = header.length;
  for (let i = 0; i < img.width * img.height; i++) {
    const a = img.data[i * 4 + 3] / 255;
    // Composite over white.
    out[o++] = img.data[i * 4] * a + 255 * (1 - a);
    out[o++] = img.data[i * 4 + 1] * a + 255 * (1 - a);
    out[o++] = img.data[i * 4 + 2] * a + 255 * (1 - a);
  }
  return out;
});

// Binary PPM (P6, 8-bit) importer. Plain-text PNM is rejected with a clear message.
celenne.registerImporter('ppm', (bytes) => {
  let p = 0;
  const ws = (c) => c === 32 || c === 9 || c === 10 || c === 13;
  const token = () => {
    for (;;) {
      while (p < bytes.length && ws(bytes[p])) p++;
      if (bytes[p] === 35) { while (p < bytes.length && bytes[p] !== 10) p++; continue; }
      break;
    }
    let s = '';
    while (p < bytes.length && !ws(bytes[p])) s += String.fromCharCode(bytes[p++]);
    return s;
  };
  if (token() !== 'P6') throw new Error('Only binary PPM (P6) files are supported');
  const w = parseInt(token(), 10), h = parseInt(token(), 10), max = parseInt(token(), 10);
  p++;
  if (!(w > 0 && h > 0 && max > 0 && max < 256)) throw new Error('Unsupported PPM header');
  if (bytes.length - p < w * h * 3) throw new Error('PPM file is truncated');
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = bytes[p++] * 255 / max; data[i * 4 + 1] = bytes[p++] * 255 / max; data[i * 4 + 2] = bytes[p++] * 255 / max; data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
});

// Spray tool: scatters foreground-colored dots along the stroke.
celenne.registerTool('spray', (img, ctx) => {
  const { width: w, height: h, data } = img;
  const r = ctx.params.radius ?? 24, n = Math.max(1, Math.round((ctx.params.density ?? 30) / 4));
  const [fr, fg, fb] = ctx.foreground;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (const pt of ctx.points) {
    for (let k = 0; k < n; k++) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r * pt.pressure;
      const x = Math.round(pt.x + Math.cos(a) * d), y = Math.round(pt.y + Math.sin(a) * d);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = (y * w + x) * 4;
      data[i] = fr; data[i + 1] = fg; data[i + 2] = fb; data[i + 3] = 1;
    }
  }
  return img;
});

// Scripts see a read-only description of the document and return app actions to run.
celenne.registerScript('dupHide', (doc) => {
  if (!doc.activeLayerId) return [];
  return [
    { action: 'layer.duplicate' },
    { action: 'layer.selectBelow' },
    { action: 'layer.toggleVisibility' },
  ];
});
`,
};
