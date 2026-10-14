/**
 * Filter Gallery effects (Artistic, Brush Strokes, Distort, Sketch, Stylize, Texture).
 * Celenne's own implementations with Photoshop's names and parameters; the looks are similar in
 * spirit, not pixel-identical. All pixel-sized parameters scale with ctx.scale.
 */
import type { FilterDef, FloatImage } from './types';
import { num } from './types';
import { boxBlur, gaussianBlur } from '../image-engine/blur';

const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;
const number = (id: string, label: string, min: number, max: number, def: number, unit?: string) => ({ type: 'number' as const, id, label, min, max, default: def, unit });
const select = (id: string, label: string, options: [string, string][], def: string) => ({ type: 'select' as const, id, label, options: options.map(([value, l]) => ({ value, label: l })), default: def });

/** Hash noise that depends on the document position (stable across tiles and zoom levels). */
function hash(x: number, y: number, seed = 0): number {
  let h = (Math.floor(x) * 374761393 + Math.floor(y) * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function luminance(img: FloatImage): Float32Array {
  const n = img.w * img.h;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = img.ch === 4 ? lum(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]) : img.data[i];
  return L;
}

/** Sobel gradient magnitude of a single-channel image. */
function edges(L: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const at = (x: number, y: number) => L[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      out[y * w + x] = Math.min(1, Math.hypot(gx, gy) / 4);
    }
  return out;
}

function forColor(img: FloatImage, f: (c: number, i: number, ch: number) => number): void {
  const n = img.w * img.h, cc = img.ch === 4 ? 3 : 1;
  for (let i = 0; i < n; i++) for (let c = 0; c < cc; c++) img.data[i * img.ch + c] = clamp(f(img.data[i * img.ch + c], i, c));
}

function blurred(img: FloatImage, r: number): Float32Array {
  const b = img.data.slice();
  if (r > 0.3) gaussianBlur(b, img.w, img.h, img.ch, r);
  return b;
}

const posterizeValue = (v: number, levels: number) => Math.round(v * (levels - 1)) / (levels - 1);

export const GALLERY_FILTERS: FilterDef[] = [
  // ------------------------------------------------------------------------- Artistic
  {
    id: 'cutout', name: 'Cutout…', category: 'Artistic', space: 'straight', gallery: true, psdName: 'cutout',
    params: [number('levels', 'Number of Levels', 2, 8, 4), number('simplicity', 'Edge Simplicity', 0, 10, 4), number('fidelity', 'Edge Fidelity', 1, 3, 2)],
    padding: (p) => Math.ceil(num(p, 'simplicity') * 2.5) + 2,
    apply(img, p, ctx) {
      const r = num(p, 'simplicity') * (4 - num(p, 'fidelity')) * 0.6 * ctx.scale;
      const b = blurred(img, r);
      const lv = Math.round(num(p, 'levels'));
      forColor(img, (_v, i, c) => posterizeValue(b[i * img.ch + c], lv));
      return img;
    },
  },
  {
    id: 'dryBrush', name: 'Dry Brush…', category: 'Artistic', space: 'straight', gallery: true, psdName: 'dry brush',
    params: [number('size', 'Brush Size', 0, 10, 2), number('detail', 'Brush Detail', 0, 10, 8), number('texture', 'Texture', 1, 3, 1)],
    padding: (p) => Math.ceil(num(p, 'size')) * 2 + 3,
    apply(img, p, ctx) {
      const r = Math.max(1, Math.round((num(p, 'size') + 1) * ctx.scale));
      // Mode-like smoothing: blur, then pull toward the local posterized value for flat brush areas.
      const b = blurred(img, r);
      const lv = 3 + Math.round(num(p, 'detail'));
      const tex = num(p, 'texture') * 0.04;
      forColor(img, (v, i, c) => {
        const x = (i % img.w) / ctx.scale + ctx.originX / ctx.scale, y = Math.floor(i / img.w) / ctx.scale + ctx.originY / ctx.scale;
        return posterizeValue(b[i * img.ch + c] * 0.7 + v * 0.3, lv) + (hash(x / 2, y / 6, c) - 0.5) * tex;
      });
      return img;
    },
  },
  {
    id: 'filmGrain', name: 'Film Grain…', category: 'Artistic', space: 'straight', gallery: true, psdName: 'film grain',
    params: [number('grain', 'Grain', 0, 20, 4), number('highlight', 'Highlight Area', 0, 20, 0), number('intensity', 'Intensity', 0, 10, 10)],
    padding: () => 0,
    apply(img, p, ctx) {
      const g = num(p, 'grain') / 20, ha = num(p, 'highlight') / 20, it = num(p, 'intensity') / 10;
      const L = luminance(img);
      forColor(img, (v, i) => {
        const x = (i % img.w + ctx.originX) / ctx.scale, y = (Math.floor(i / img.w) + ctx.originY) / ctx.scale;
        const n = (hash(x, y, 7) - 0.5) * g * (1 - L[i] * 0.6);
        const glow = ha > 0 ? Math.max(0, L[i] - (1 - ha)) * it : 0;
        return v + n + glow;
      });
      return img;
    },
  },
  {
    id: 'posterEdges', name: 'Poster Edges…', category: 'Artistic', space: 'straight', gallery: true, psdName: 'poster edges',
    params: [number('thickness', 'Edge Thickness', 0, 10, 2), number('intensity', 'Edge Intensity', 0, 10, 1), number('posterization', 'Posterization', 0, 6, 2)],
    padding: (p) => Math.ceil(num(p, 'thickness')) + 3,
    apply(img, p, ctx) {
      const L = luminance(img);
      const E = edges(L, img.w, img.h);
      const r = num(p, 'thickness') * 0.5 * ctx.scale;
      if (r > 0.3) gaussianBlur(E, img.w, img.h, 1, r);
      const k = 0.5 + num(p, 'intensity') * 0.6;
      const lv = 2 + Math.round(num(p, 'posterization'));
      forColor(img, (v, i) => posterizeValue(v, lv + 2) * (1 - Math.min(1, E[i] * k * 3)));
      return img;
    },
  },
  {
    id: 'watercolor', name: 'Watercolor…', category: 'Artistic', space: 'straight', gallery: true, psdName: 'watercolor',
    params: [number('detail', 'Brush Detail', 1, 14, 9), number('shadow', 'Shadow Intensity', 0, 10, 1), number('texture', 'Texture', 1, 3, 1)],
    padding: () => 8,
    apply(img, p, ctx) {
      const r = (15 - num(p, 'detail')) * 0.4 * ctx.scale;
      const b = blurred(img, r);
      const L = new Float32Array(img.w * img.h);
      for (let i = 0; i < L.length; i++) L[i] = img.ch === 4 ? lum(b[i * 4], b[i * 4 + 1], b[i * 4 + 2]) : b[i];
      const E = edges(L, img.w, img.h);
      const sh = num(p, 'shadow') * 0.08, tex = num(p, 'texture') * 0.03;
      forColor(img, (_v, i, c) => {
        const base = b[i * img.ch + c];
        const x = (i % img.w + ctx.originX) / ctx.scale, y = (Math.floor(i / img.w) + ctx.originY) / ctx.scale;
        // Pigment pooling: darker at edges, deeper in shadows.
        return base * (1 - E[i] * 1.5) - Math.max(0, 0.5 - L[i]) * sh + (hash(x / 3, y / 3, c) - 0.5) * tex;
      });
      return img;
    },
  },
  // ------------------------------------------------------------------------- Brush Strokes
  {
    id: 'inkOutlines', name: 'Ink Outlines…', category: 'Brush Strokes', space: 'straight', gallery: true, psdName: 'ink outlines',
    params: [number('length', 'Stroke Length', 1, 50, 4), number('dark', 'Dark Intensity', 0, 50, 20), number('light', 'Light Intensity', 0, 50, 10)],
    padding: (p) => Math.ceil(num(p, 'length')) + 2,
    apply(img, p, ctx) {
      const L = luminance(img);
      const E = edges(L, img.w, img.h);
      const len = Math.max(1, Math.round(num(p, 'length') * 0.5 * ctx.scale));
      boxBlur(E, img.w, img.h, 1, len);
      const d = num(p, 'dark') / 50, lt = num(p, 'light') / 50;
      forColor(img, (v, i) => (v + (L[i] > 0.5 ? lt * 0.3 : -d * 0.3)) * (1 - Math.min(1, E[i] * 6 * (0.3 + d))));
      return img;
    },
  },
  {
    id: 'spatter', name: 'Spatter…', category: 'Brush Strokes', space: 'straight', gallery: true, psdName: 'spatter',
    params: [number('radius', 'Spray Radius', 0, 25, 10), number('smoothness', 'Smoothness', 1, 15, 5)],
    padding: (p) => Math.ceil(num(p, 'radius')) + 1,
    apply(img, p, ctx) {
      const r = num(p, 'radius') * ctx.scale;
      const src = img.data.slice();
      const out = img.data;
      const sm = num(p, 'smoothness');
      for (let y = 0; y < img.h; y++)
        for (let x = 0; x < img.w; x++) {
          const gx = (x + ctx.originX) / ctx.scale, gy = (y + ctx.originY) / ctx.scale;
          const q = 1 / sm;
          const dx = Math.round((hash(gx * q, gy * q, 3) - 0.5) * 2 * r), dy = Math.round((hash(gx * q, gy * q, 5) - 0.5) * 2 * r);
          const sx = Math.min(img.w - 1, Math.max(0, x + dx)), sy = Math.min(img.h - 1, Math.max(0, y + dy));
          for (let c = 0; c < img.ch; c++) out[(y * img.w + x) * img.ch + c] = src[(sy * img.w + sx) * img.ch + c];
        }
      return img;
    },
  },
  // ------------------------------------------------------------------------- Distort
  {
    id: 'diffuseGlow', name: 'Diffuse Glow…', category: 'Distort', space: 'straight', gallery: true, psdName: 'diffuse glow',
    params: [number('graininess', 'Graininess', 0, 10, 6), number('glow', 'Glow Amount', 0, 20, 10), number('clear', 'Clear Amount', 0, 20, 15)],
    padding: () => 10,
    apply(img, p, ctx) {
      const b = blurred(img, 6 * ctx.scale);
      const L = luminance({ ...img, data: b });
      const glow = num(p, 'glow') / 20, clear = num(p, 'clear') / 20, gr = num(p, 'graininess') / 10;
      const bg = ctx.background;
      forColor(img, (v, i, c) => {
        const x = (i % img.w + ctx.originX) / ctx.scale, y = (Math.floor(i / img.w) + ctx.originY) / ctx.scale;
        const g = Math.max(0, L[i] - clear * 0.8) * glow * 2 * (1 - gr * 0.5 + hash(x, y, 11) * gr);
        const tint = img.ch === 4 ? bg[c] : lum(bg[0], bg[1], bg[2]);
        return v + (tint - v) * Math.min(1, g);
      });
      return img;
    },
  },
  // ------------------------------------------------------------------------- Sketch
  {
    id: 'halftonePattern', name: 'Halftone Pattern…', category: 'Sketch', space: 'straight', gallery: true, psdName: 'halftone pattern',
    params: [number('size', 'Size', 1, 12, 1), number('contrast', 'Contrast', 0, 50, 5), select('type', 'Pattern Type', [['dot', 'Dot'], ['circle', 'Circle'], ['line', 'Line']], 'dot')],
    padding: () => 0,
    apply(img, p, ctx) {
      const cell = Math.max(2, (num(p, 'size') + 2) * 2);
      const con = 1 + num(p, 'contrast') / 10;
      const type = String(p.type);
      const fg = ctx.foreground, bg = ctx.background;
      const L = luminance(img);
      const n = img.w * img.h;
      for (let i = 0; i < n; i++) {
        const x = (i % img.w + ctx.originX) / ctx.scale, y = (Math.floor(i / img.w) + ctx.originY) / ctx.scale;
        const dark = clamp((0.5 - L[i]) * con + 0.5);
        let ink: number;
        if (type === 'line') ink = Math.abs(((y / cell) % 1) - 0.5) * 2 < dark ? 1 : 0;
        else {
          const u = ((x / cell) % 1) - 0.5, v = ((y / cell) % 1) - 0.5;
          const d = Math.hypot(u, v) * 2;
          ink = type === 'circle' ? (Math.abs(d - dark) < 0.18 ? 1 : 0) : d < Math.sqrt(dark) * 1.1 ? 1 : 0;
        }
        const o = i * img.ch;
        if (img.ch === 4) for (let c = 0; c < 3; c++) img.data[o + c] = ink ? fg[c] : bg[c];
        else img.data[o] = ink ? lum(fg[0], fg[1], fg[2]) : lum(bg[0], bg[1], bg[2]);
      }
      return img;
    },
  },
  {
    id: 'stamp', name: 'Stamp…', category: 'Sketch', space: 'straight', gallery: true, psdName: 'stamp',
    params: [number('balance', 'Light/Dark Balance', 0, 50, 25), number('smoothness', 'Smoothness', 1, 50, 5)],
    padding: (p) => Math.ceil(num(p, 'smoothness') * 0.5) + 2,
    apply(img, p, ctx) {
      const b = blurred(img, num(p, 'smoothness') * 0.3 * ctx.scale);
      const L = luminance({ ...img, data: b });
      const t = num(p, 'balance') / 50;
      const fg = ctx.foreground, bg = ctx.background;
      forColor(img, (_v, i, c) => {
        const ink = clamp((t - L[i]) * 12 + 0.5);
        const f = img.ch === 4 ? fg[c] : lum(fg[0], fg[1], fg[2]), k = img.ch === 4 ? bg[c] : lum(bg[0], bg[1], bg[2]);
        return k + (f - k) * ink;
      });
      return img;
    },
  },
  {
    id: 'photocopy', name: 'Photocopy…', category: 'Sketch', space: 'straight', gallery: true, psdName: 'photocopy',
    params: [number('detail', 'Detail', 1, 24, 7), number('darkness', 'Darkness', 1, 50, 8)],
    padding: (p) => Math.ceil(25 - num(p, 'detail')) + 2,
    apply(img, p, ctx) {
      const L = luminance(img);
      const B = L.slice();
      gaussianBlur(B, img.w, img.h, 1, (25 - num(p, 'detail')) * 0.35 * ctx.scale + 0.5);
      const dk = num(p, 'darkness') / 8;
      const fg = ctx.foreground, bg = ctx.background;
      forColor(img, (_v, i, c) => {
        const ink = clamp((B[i] - L[i]) * 8 * dk);
        const f = img.ch === 4 ? fg[c] : lum(fg[0], fg[1], fg[2]), k = img.ch === 4 ? bg[c] : lum(bg[0], bg[1], bg[2]);
        return k + (f - k) * ink;
      });
      return img;
    },
  },
  // ------------------------------------------------------------------------- Stylize
  {
    id: 'glowingEdges', name: 'Glowing Edges…', category: 'Stylize', space: 'straight', gallery: true, psdName: 'glowing edges',
    params: [number('width', 'Edge Width', 1, 14, 2), number('brightness', 'Edge Brightness', 0, 20, 6), number('smoothness', 'Smoothness', 1, 15, 5)],
    padding: (p) => Math.ceil(num(p, 'width') + num(p, 'smoothness')) + 2,
    apply(img, p, ctx) {
      const src = blurred(img, num(p, 'smoothness') * 0.25 * ctx.scale);
      const cc = img.ch === 4 ? 3 : 1;
      const br = num(p, 'brightness') / 4;
      const wr = num(p, 'width') * 0.4 * ctx.scale;
      for (let c = 0; c < cc; c++) {
        const ch = new Float32Array(img.w * img.h);
        for (let i = 0; i < ch.length; i++) ch[i] = src[i * img.ch + c];
        const E = edges(ch, img.w, img.h);
        if (wr > 0.3) gaussianBlur(E, img.w, img.h, 1, wr);
        for (let i = 0; i < ch.length; i++) img.data[i * img.ch + c] = clamp(E[i] * br * 2);
      }
      return img;
    },
  },
  // ------------------------------------------------------------------------- Texture
  {
    id: 'grain', name: 'Grain…', category: 'Texture', space: 'straight', gallery: true, psdName: 'grain',
    params: [number('intensity', 'Intensity', 0, 100, 40), number('contrast', 'Contrast', 0, 100, 50), select('type', 'Grain Type', [['regular', 'Regular'], ['soft', 'Soft'], ['sprinkles', 'Sprinkles'], ['clumped', 'Clumped'], ['speckle', 'Speckle'], ['horizontal', 'Horizontal'], ['vertical', 'Vertical']], 'regular')],
    padding: () => 0,
    apply(img, p, ctx) {
      const it = num(p, 'intensity') / 100, con = 0.5 + num(p, 'contrast') / 100;
      const t = String(p.type);
      forColor(img, (v, i, c) => {
        const x = (i % img.w + ctx.originX) / ctx.scale, y = (Math.floor(i / img.w) + ctx.originY) / ctx.scale;
        const hx = t === 'vertical' ? x : t === 'horizontal' ? 0 : x, hy = t === 'horizontal' ? y : t === 'vertical' ? 0 : y;
        const scale = t === 'soft' ? 2 : t === 'clumped' ? 3 : 1;
        let n = hash(hx / scale, hy / scale, t === 'regular' ? c : 0) - 0.5;
        if (t === 'sprinkles' || t === 'speckle') n = n > 0.45 - it * 0.3 ? (t === 'speckle' ? -0.5 : 0.5) : 0;
        return (v - 0.5) * con + 0.5 + n * it;
      });
      return img;
    },
  },
  {
    id: 'mosaicTiles', name: 'Mosaic Tiles…', category: 'Texture', space: 'straight', gallery: true, psdName: 'mosaic tiles',
    params: [number('size', 'Tile Size', 2, 100, 12), number('grout', 'Grout Width', 1, 15, 3), number('lighten', 'Lighten Grout', 0, 10, 9)],
    padding: () => 0,
    apply(img, p, ctx) {
      const size = num(p, 'size'), grout = num(p, 'grout'), lg = num(p, 'lighten') / 10;
      forColor(img, (v, i) => {
        const x = (i % img.w + ctx.originX) / ctx.scale, y = (Math.floor(i / img.w) + ctx.originY) / ctx.scale;
        // Slightly irregular tiles.
        const ty = Math.floor(y / size), off = hash(ty, 0, 1) * size * 0.5;
        const tx = Math.floor((x + off) / size);
        const lx = (x + off) - tx * size, ly = y - ty * size;
        const inGrout = lx < grout || ly < grout;
        const shade = 0.92 + hash(tx, ty, 2) * 0.16;
        return inGrout ? v * 0.5 + lg * 0.5 : v * shade;
      });
      return img;
    },
  },
  {
    id: 'texturizer', name: 'Texturizer…', category: 'Texture', space: 'straight', gallery: true, psdName: 'texturizer',
    params: [select('texture', 'Texture', [['canvas', 'Canvas'], ['brick', 'Brick'], ['burlap', 'Burlap'], ['sandstone', 'Sandstone']], 'canvas'), number('scaling', 'Scaling', 50, 200, 100, '%'), number('relief', 'Relief', 0, 50, 4), select('light', 'Light', [['top', 'Top'], ['topLeft', 'Top Left'], ['left', 'Left'], ['bottomLeft', 'Bottom Left'], ['bottom', 'Bottom'], ['bottomRight', 'Bottom Right'], ['right', 'Right'], ['topRight', 'Top Right']], 'topLeft')],
    padding: () => 0,
    apply(img, p, ctx) {
      const sc = num(p, 'scaling') / 100;
      const kind = String(p.texture);
      const height = (x: number, y: number): number => {
        x /= sc; y /= sc;
        switch (kind) {
          case 'brick': {
            const row = Math.floor(y / 24), bx = x + (row % 2) * 30;
            const lx = ((bx % 60) + 60) % 60, ly = ((y % 24) + 24) % 24;
            return (lx < 3 || ly < 3 ? 0 : 1) * (0.9 + hash(x / 2, y / 2, 3) * 0.1);
          }
          case 'burlap': return 0.5 + 0.25 * Math.sin(x * 0.9) * Math.sin(y * 0.2) + 0.25 * Math.sin(y * 0.9) * Math.sin(x * 0.25) + (hash(x, y, 4) - 0.5) * 0.2;
          case 'sandstone': return hash(x / 2, y / 2, 5) * 0.6 + hash(x / 5, y / 5, 6) * 0.4;
          default: return 0.5 + 0.3 * Math.sin(x * 1.6) * (0.5 + 0.5 * Math.sin(y * 0.4)) + 0.3 * Math.sin(y * 1.6) * (0.5 + 0.5 * Math.sin(x * 0.4));
        }
      };
      const dir: Record<string, [number, number]> = { top: [0, -1], topLeft: [-1, -1], left: [-1, 0], bottomLeft: [-1, 1], bottom: [0, 1], bottomRight: [1, 1], right: [1, 0], topRight: [1, -1] };
      const [lx, ly] = dir[String(p.light)] ?? [-1, -1];
      const rel = num(p, 'relief') / 10;
      forColor(img, (v, i) => {
        const x = (i % img.w + ctx.originX) / ctx.scale, y = (Math.floor(i / img.w) + ctx.originY) / ctx.scale;
        const d = (height(x + lx, y + ly) - height(x - lx, y - ly)) * rel;
        return v * (1 - d * 0.5) - d * 0.1;
      });
      return img;
    },
  },
];
