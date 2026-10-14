/**
 * Built-in filters. All operate on FloatImage buffers and scale pixel-based parameters by
 * ctx.scale so previews at reduced zoom match the full-resolution result.
 */
import type { FilterDef, FloatImage, FilterContext, FilterParams } from './types';
import { num } from './types';
import { boxBlur, convolveSeparable, gaussianBlur, minMaxFilter } from '../image-engine/blur';
import { GALLERY_FILTERS } from './gallery';

const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Bilinear sample with edge mode. */
function sampleAt(img: FloatImage, u: number, v: number, out: Float32Array, o: number, edge: 'transparent' | 'repeat' | 'wrap') {
  const { w, h, ch, data } = img;
  const fetch = (x: number, y: number, c: number) => {
    if (edge === 'wrap') { x = ((x % w) + w) % w; y = ((y % h) + h) % h; }
    else if (edge === 'repeat') { x = x < 0 ? 0 : x >= w ? w - 1 : x; y = y < 0 ? 0 : y >= h ? h - 1 : y; }
    else if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    return data[(y * w + x) * ch + c];
  };
  const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
  for (let c = 0; c < ch; c++) {
    const a = fetch(x0, y0, c), b = fetch(x0 + 1, y0, c), cc = fetch(x0, y0 + 1, c), d = fetch(x0 + 1, y0 + 1, c);
    out[o + c] = a + (b - a) * fx + (cc - a) * fy + (a - b - cc + d) * fx * fy;
  }
}

/** Inverse-mapped distortion helper: `map(x, y)` returns the source position for an output pixel. */
function remap(img: FloatImage, ctx: FilterContext, map: (x: number, y: number) => [number, number] | null, edge: 'transparent' | 'repeat' | 'wrap' = 'repeat'): FloatImage {
  const out = new Float32Array(img.data.length);
  for (let y = 0; y < img.h; y++) {
    if ((y & 31) === 0) { if (ctx.cancelled()) break; ctx.progress(y / img.h); }
    for (let x = 0; x < img.w; x++) {
      const m = map(x + 0.5, y + 0.5);
      const o = (y * img.w + x) * img.ch;
      if (!m) { for (let c = 0; c < img.ch; c++) out[o + c] = img.data[o + c]; continue; }
      sampleAt(img, m[0] - 0.5, m[1] - 0.5, out, o, edge);
    }
  }
  return { ...img, data: out };
}

/** Center of the reference bounds in buffer coordinates. */
function center(ctx: FilterContext): [number, number, number] {
  const cx = ctx.bounds.x + ctx.bounds.w / 2 - ctx.originX, cy = ctx.bounds.y + ctx.bounds.h / 2 - ctx.originY;
  return [cx, cy, Math.min(ctx.bounds.w, ctx.bounds.h) / 2];
}

const select = (id: string, label: string, options: [string, string][], def: string) => ({ type: 'select' as const, id, label, options: options.map(([value, l]) => ({ value, label: l })), default: def });
const number = (id: string, label: string, min: number, max: number, def: number, unit?: string, step?: number) => ({ type: 'number' as const, id, label, min, max, default: def, unit, step });

export const BUILTIN_FILTERS: FilterDef[] = [
  // ------------------------------------------------------------------------- Blur
  {
    id: 'gaussianBlur', name: 'Gaussian Blur…', category: 'Blur', space: 'premultiplied', psdName: 'gaussian blur',
    params: [number('radius', 'Radius', 0.1, 1000, 4, 'px', 0.1)],
    padding: (p) => Math.ceil(num(p, 'radius') * 3) + 2,
    apply(img, p, ctx) { gaussianBlur(img.data, img.w, img.h, img.ch, num(p, 'radius') * ctx.scale, ctx.cancelled); return img; },
  },
  {
    id: 'boxBlur', name: 'Box Blur…', category: 'Blur', space: 'premultiplied', psdName: 'box blur',
    params: [number('radius', 'Radius', 1, 999, 5, 'px')],
    padding: (p) => Math.ceil(num(p, 'radius')) + 2,
    apply(img, p, ctx) { boxBlur(img.data, img.w, img.h, img.ch, num(p, 'radius') * ctx.scale, ctx.cancelled); return img; },
  },
  {
    id: 'motionBlur', name: 'Motion Blur…', category: 'Blur', space: 'premultiplied', psdName: 'motion blur',
    params: [{ type: 'angle', id: 'angle', label: 'Angle', default: 0 }, number('distance', 'Distance', 1, 2000, 20, 'px')],
    padding: (p) => Math.ceil(num(p, 'distance')) + 2,
    apply(img, p, ctx) {
      const d = Math.max(1, num(p, 'distance') * ctx.scale);
      const a = (num(p, 'angle') * Math.PI) / 180;
      const dx = Math.cos(a), dy = -Math.sin(a);
      const steps = Math.max(2, Math.ceil(d));
      const out = new Float32Array(img.data.length);
      const tmp = new Float32Array(4);
      for (let y = 0; y < img.h; y++) {
        if ((y & 15) === 0) { if (ctx.cancelled()) break; ctx.progress(y / img.h); }
        for (let x = 0; x < img.w; x++) {
          const o = (y * img.w + x) * img.ch;
          for (let s = 0; s < steps; s++) {
            const t = (s / (steps - 1) - 0.5) * d;
            sampleAt(img, x + dx * t, y + dy * t, tmp, 0, 'repeat');
            for (let c = 0; c < img.ch; c++) out[o + c] += tmp[c] / steps;
          }
        }
      }
      return { ...img, data: out };
    },
  },
  {
    id: 'radialBlur', name: 'Radial Blur…', category: 'Blur', space: 'premultiplied', global: true, psdName: 'radial blur',
    params: [number('amount', 'Amount', 1, 100, 10), select('method', 'Blur Method', [['spin', 'Spin'], ['zoom', 'Zoom']], 'spin'), select('quality', 'Quality', [['draft', 'Draft'], ['good', 'Good'], ['best', 'Best']], 'good')],
    padding: () => 0,
    apply(img, p, ctx) {
      const [cx, cy] = center(ctx);
      const amount = num(p, 'amount') / 100;
      const q = p.quality === 'draft' ? 8 : p.quality === 'best' ? 48 : 20;
      const zoom = p.method === 'zoom';
      const out = new Float32Array(img.data.length);
      const tmp = new Float32Array(4);
      for (let y = 0; y < img.h; y++) {
        if ((y & 15) === 0) { if (ctx.cancelled()) break; ctx.progress(y / img.h); }
        for (let x = 0; x < img.w; x++) {
          const o = (y * img.w + x) * img.ch;
          const rx = x - cx, ry = y - cy;
          for (let s = 0; s < q; s++) {
            const t = s / (q - 1) - 0.5;
            let u: number, v: number;
            if (zoom) { const k = 1 + t * amount * 0.6; u = cx + rx * k; v = cy + ry * k; }
            else { const ang = t * amount * 0.6; const c = Math.cos(ang), sn = Math.sin(ang); u = cx + rx * c - ry * sn; v = cy + rx * sn + ry * c; }
            sampleAt(img, u, v, tmp, 0, 'repeat');
            for (let c = 0; c < img.ch; c++) out[o + c] += tmp[c] / q;
          }
        }
      }
      return { ...img, data: out };
    },
  },
  {
    id: 'surfaceBlur', name: 'Surface Blur…', category: 'Blur', space: 'straight', psdName: 'surface blur',
    params: [number('radius', 'Radius', 1, 100, 5, 'px'), number('threshold', 'Threshold', 2, 255, 15, 'levels')],
    padding: (p) => Math.ceil(num(p, 'radius')) + 1,
    apply(img, p, ctx) { return bilateral(img, Math.max(1, Math.round(num(p, 'radius') * ctx.scale)), num(p, 'threshold') / 255, ctx); },
  },
  {
    id: 'lensBlur', name: 'Lens Blur…', category: 'Blur', space: 'premultiplied',
    params: [number('radius', 'Radius', 1, 100, 10, 'px'), number('brightness', 'Specular Brightness', 0, 100, 0), number('threshold', 'Specular Threshold', 0, 255, 255)],
    padding: (p) => Math.ceil(num(p, 'radius')) + 2,
    apply(img, p, ctx) {
      const r = Math.max(1, Math.round(num(p, 'radius') * ctx.scale));
      const bright = num(p, 'brightness') / 100 * 4, thr = num(p, 'threshold') / 255;
      const { w, h, ch } = img;
      const src = img.data.slice();
      if (bright > 0 && ch === 4) for (let i = 0; i < w * h; i++) { const L = lum(src[i * 4], src[i * 4 + 1], src[i * 4 + 2]); if (L >= thr) for (let c = 0; c < 3; c++) src[i * 4 + c] *= 1 + bright; }
      // Disc kernel as horizontal spans, accumulated with row prefix sums.
      const out = new Float32Array(src.length);
      const spans: number[] = [];
      let count = 0;
      for (let dy = -r; dy <= r; dy++) { const hw = Math.floor(Math.sqrt(r * r - dy * dy)); spans.push(hw); count += hw * 2 + 1; }
      const rowPrefix: Float64Array[] = [];
      for (let y = 0; y < h; y++) {
        const pr = new Float64Array((w + 1) * ch);
        for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) pr[(x + 1) * ch + c] = pr[x * ch + c] + src[(y * w + x) * ch + c];
        rowPrefix.push(pr);
      }
      for (let y = 0; y < h; y++) {
        if ((y & 15) === 0) { if (ctx.cancelled()) break; ctx.progress(y / h); }
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * ch;
          for (let k = 0; k < spans.length; k++) {
            const yy = Math.min(h - 1, Math.max(0, y + k - r));
            const pr = rowPrefix[yy];
            const x0 = Math.max(0, x - spans[k]), x1 = Math.min(w - 1, x + spans[k]);
            const missingL = (x - spans[k]) < 0 ? -(x - spans[k]) : 0, missingR = (x + spans[k]) > w - 1 ? x + spans[k] - (w - 1) : 0;
            for (let c = 0; c < ch; c++) {
              let s = pr[(x1 + 1) * ch + c] - pr[x0 * ch + c];
              s += missingL * src[(yy * w) * ch + c] + missingR * src[(yy * w + w - 1) * ch + c];
              out[o + c] += s;
            }
          }
          for (let c = 0; c < ch; c++) out[o + c] = Math.min(ch === 4 && c < 3 ? out[o + 3] / count : 1, out[o + c] / count);
        }
      }
      return { ...img, data: out };
    },
  },
  // ------------------------------------------------------------------------- Sharpen
  {
    id: 'sharpen', name: 'Sharpen', category: 'Sharpen', space: 'straight', psdName: 'sharpen', params: [],
    padding: () => 2,
    apply(img) { return unsharp(img, 1, 0.6, 0); },
  },
  {
    id: 'unsharpMask', name: 'Unsharp Mask…', category: 'Sharpen', space: 'straight', psdName: 'unsharp mask',
    params: [number('amount', 'Amount', 1, 500, 100, '%'), number('radius', 'Radius', 0.1, 1000, 1.5, 'px', 0.1), number('threshold', 'Threshold', 0, 255, 0, 'levels')],
    padding: (p) => Math.ceil(num(p, 'radius') * 3) + 2,
    apply(img, p, ctx) { return unsharp(img, num(p, 'radius') * ctx.scale, num(p, 'amount') / 100, num(p, 'threshold') / 255); },
  },
  {
    id: 'smartSharpen', name: 'Smart Sharpen…', category: 'Sharpen', space: 'straight', psdName: 'smart sharpen',
    params: [number('amount', 'Amount', 1, 500, 200, '%'), number('radius', 'Radius', 0.1, 64, 1, 'px', 0.1), number('noise', 'Reduce Noise', 0, 100, 10, '%'), select('remove', 'Remove', [['gaussian', 'Gaussian Blur'], ['lens', 'Lens Blur'], ['motion', 'Motion Blur']], 'lens'), { type: 'angle', id: 'angle', label: 'Angle', default: 0 }],
    padding: (p) => Math.ceil(num(p, 'radius') * 3) + 3,
    apply(img, p, ctx) {
      const r = num(p, 'radius') * ctx.scale;
      const blurred = img.data.slice();
      if (p.remove === 'motion') {
        // Directional blur along the given angle (the blur being corrected).
        const motion = BUILTIN_FILTERS.find((f) => f.id === 'motionBlur')!;
        const mb = motion.apply({ ...img, data: blurred }, { angle: num(p, 'angle'), distance: Math.max(1, (r * 2) / ctx.scale) }, ctx);
        blurred.set(mb.data);
      } else if (p.remove === 'lens') {
        boxBlur(blurred, img.w, img.h, img.ch, r);
        gaussianBlur(blurred, img.w, img.h, img.ch, r * 0.5);
      } else gaussianBlur(blurred, img.w, img.h, img.ch, r);
      const amount = num(p, 'amount') / 100, noise = num(p, 'noise') / 100 * 0.08;
      const out = img.data.slice();
      for (let i = 0; i < img.w * img.h; i++)
        for (let c = 0; c < Math.min(3, img.ch); c++) {
          const o = i * img.ch + c;
          let d = img.data[o] - blurred[o];
          if (Math.abs(d) < noise) d *= Math.abs(d) / noise;
          out[o] = clamp(img.data[o] + d * amount);
        }
      return { ...img, data: out };
    },
  },
  {
    id: 'highPass', name: 'High Pass…', category: 'Other', space: 'straight', psdName: 'high pass',
    params: [number('radius', 'Radius', 0.1, 1000, 10, 'px', 0.1)],
    padding: (p) => Math.ceil(num(p, 'radius') * 3) + 2,
    apply(img, p, ctx) {
      const b = img.data.slice();
      gaussianBlur(b, img.w, img.h, img.ch, num(p, 'radius') * ctx.scale, ctx.cancelled);
      const out = img.data.slice();
      for (let i = 0; i < img.w * img.h; i++) for (let c = 0; c < Math.min(3, img.ch); c++) out[i * img.ch + c] = clamp(0.5 + img.data[i * img.ch + c] - b[i * img.ch + c]);
      return { ...img, data: out };
    },
  },
  // ------------------------------------------------------------------------- Distort
  {
    id: 'wave', name: 'Wave…', category: 'Distort', space: 'premultiplied', global: true, psdName: 'wave',
    params: [number('generators', 'Number of Generators', 1, 999, 5), number('wlMin', 'Wavelength Min', 1, 998, 10), number('wlMax', 'Wavelength Max', 2, 999, 120), number('ampMin', 'Amplitude Min', 1, 998, 5), number('ampMax', 'Amplitude Max', 2, 999, 35), number('scaleX', 'Scale Horiz.', 1, 100, 100, '%'), number('scaleY', 'Scale Vert.', 1, 100, 100, '%'), select('type', 'Type', [['sine', 'Sine'], ['triangle', 'Triangle'], ['square', 'Square']], 'sine'), select('edge', 'Undefined Areas', [['wrap', 'Wrap Around'], ['repeat', 'Repeat Edge Pixels']], 'repeat'), { type: 'seed', id: 'seed', label: 'Randomize', default: 1 }],
    padding: () => 0,
    apply(img, p, ctx) {
      const R = rng(num(p, 'seed', 1));
      const n = Math.max(1, Math.min(50, Math.round(num(p, 'generators'))));
      const gens = Array.from({ length: n }, () => ({ wl: (num(p, 'wlMin') + R() * (num(p, 'wlMax') - num(p, 'wlMin'))) * ctx.scale, amp: (num(p, 'ampMin') + R() * (num(p, 'ampMax') - num(p, 'ampMin'))) * ctx.scale / n, phase: R() * Math.PI * 2, dir: R() < 0.5 }));
      const wave = (t: number) => (p.type === 'triangle' ? (2 / Math.PI) * Math.asin(Math.sin(t)) : p.type === 'square' ? Math.sign(Math.sin(t)) : Math.sin(t));
      const sx = num(p, 'scaleX') / 100, sy = num(p, 'scaleY') / 100;
      return remap(img, ctx, (x, y) => {
        let dx = 0, dy = 0;
        for (const g of gens) {
          const t = ((g.dir ? y : x) + ctx.originY * 0) / g.wl * Math.PI * 2 + g.phase;
          const v = wave(t) * g.amp;
          if (g.dir) dx += v; else dy += v;
        }
        return [x + dx * sx, y + dy * sy];
      }, p.edge === 'wrap' ? 'wrap' : 'repeat');
    },
  },
  {
    id: 'ripple', name: 'Ripple…', category: 'Distort', space: 'premultiplied', global: true, psdName: 'ripple',
    params: [number('amount', 'Amount', -999, 999, 100, '%'), select('size', 'Size', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], 'medium')],
    padding: () => 0,
    apply(img, p, ctx) {
      const a = num(p, 'amount') / 100 * 4 * ctx.scale;
      const wl = (p.size === 'small' ? 6 : p.size === 'large' ? 28 : 14) * ctx.scale;
      return remap(img, ctx, (x, y) => [x + Math.sin(((y + ctx.originY) / wl) * Math.PI * 2) * a, y + Math.sin(((x + ctx.originX) / wl) * Math.PI * 2) * a]);
    },
  },
  {
    id: 'twirl', name: 'Twirl…', category: 'Distort', space: 'premultiplied', global: true, psdName: 'twirl',
    params: [number('angle', 'Angle', -999, 999, 50, '°')],
    padding: () => 0,
    apply(img, p, ctx) {
      const [cx, cy, R] = center(ctx);
      const ang = (num(p, 'angle') * Math.PI) / 180;
      return remap(img, ctx, (x, y) => {
        const dx = x - cx, dy = y - cy;
        const r = Math.hypot(dx, dy);
        if (r >= R) return null;
        const t = ang * (1 - r / R) * (1 - r / R);
        const c = Math.cos(t), s = Math.sin(t);
        return [cx + dx * c - dy * s, cy + dx * s + dy * c];
      });
    },
  },
  {
    id: 'spherize', name: 'Spherize…', category: 'Distort', space: 'premultiplied', global: true, psdName: 'spherize',
    params: [number('amount', 'Amount', -100, 100, 100, '%'), select('mode', 'Mode', [['normal', 'Normal'], ['horizontal', 'Horizontal Only'], ['vertical', 'Vertical Only']], 'normal')],
    padding: () => 0,
    apply(img, p, ctx) {
      const [cx, cy] = center(ctx);
      const rx = ctx.bounds.w / 2, ry = ctx.bounds.h / 2;
      const amt = num(p, 'amount') / 100;
      // Positive = bulge (sample closer to the center), negative = concave.
      const warp = (r: number) => (amt >= 0 ? Math.pow(r, 1 + amt) : Math.pow(r, 1 / (1 - amt)));
      return remap(img, ctx, (x, y) => {
        const nx = (x - cx) / rx, ny = (y - cy) / ry;
        if (p.mode === 'horizontal') {
          const r = Math.abs(nx);
          return r >= 1 || r === 0 ? null : [cx + (x - cx) * (warp(r) / r), y];
        }
        if (p.mode === 'vertical') {
          const r = Math.abs(ny);
          return r >= 1 || r === 0 ? null : [x, cy + (y - cy) * (warp(r) / r)];
        }
        const r = Math.hypot(nx, ny);
        if (r >= 1 || r === 0) return null;
        const k = warp(r) / r;
        return [cx + (x - cx) * k, cy + (y - cy) * k];
      });
    },
  },
  {
    id: 'pinch', name: 'Pinch…', category: 'Distort', space: 'premultiplied', global: true, psdName: 'pinch',
    params: [number('amount', 'Amount', -100, 100, 50, '%')],
    padding: () => 0,
    apply(img, p, ctx) {
      const [cx, cy, R] = center(ctx);
      const amt = num(p, 'amount') / 100;
      return remap(img, ctx, (x, y) => {
        const dx = x - cx, dy = y - cy;
        const r = Math.hypot(dx, dy) / R;
        if (r >= 1 || r === 0) return null;
        const k = Math.pow(Math.sin((Math.PI * r) / 2), -amt);
        return [cx + dx * k, cy + dy * k];
      });
    },
  },
  {
    id: 'offset', name: 'Offset…', category: 'Other', space: 'straight', global: true, psdName: 'offset',
    params: [number('horizontal', 'Horizontal', -30000, 30000, 0, 'px'), number('vertical', 'Vertical', -30000, 30000, 0, 'px'), select('edge', 'Undefined Areas', [['transparent', 'Set to Transparent'], ['repeat', 'Repeat Edge Pixels'], ['wrap', 'Wrap Around']], 'wrap')],
    padding: () => 0,
    apply(img, p, ctx) {
      const dx = num(p, 'horizontal') * ctx.scale, dy = num(p, 'vertical') * ctx.scale;
      return remap(img, ctx, (x, y) => [x - dx, y - dy], p.edge as 'transparent' | 'repeat' | 'wrap');
    },
  },
  // ------------------------------------------------------------------------- Noise
  {
    id: 'addNoise', name: 'Add Noise…', category: 'Noise', space: 'straight', psdName: 'add noise',
    params: [number('amount', 'Amount', 0.1, 400, 12.5, '%', 0.1), select('distribution', 'Distribution', [['uniform', 'Uniform'], ['gaussian', 'Gaussian']], 'gaussian'), { type: 'boolean', id: 'mono', label: 'Monochromatic', default: false }, { type: 'seed', id: 'seed', label: 'Randomize', default: 1 }],
    padding: () => 0,
    apply(img, p, ctx) {
      const amt = num(p, 'amount') / 100;
      const gauss = p.distribution === 'gaussian';
      const hash = (x: number, y: number, c: number) => {
        let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(c + num(p, 'seed', 1) * 7, 83492791);
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
      };
      const out = img.data.slice();
      for (let y = 0; y < img.h; y++)
        for (let x = 0; x < img.w; x++) {
          const gx = Math.round(x / ctx.scale + ctx.originX / ctx.scale), gy = Math.round(y / ctx.scale + ctx.originY / ctx.scale);
          const noise = (c: number) => {
            if (!gauss) return (hash(gx, gy, c) - 0.5) * 2 * amt;
            const u1 = Math.max(1e-9, hash(gx, gy, c)), u2 = hash(gx, gy, c + 17);
            return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * amt * 0.5;
          };
          const o = (y * img.w + x) * img.ch;
          if (p.mono) { const n = noise(0); for (let c = 0; c < Math.min(3, img.ch); c++) out[o + c] = clamp(out[o + c] + n); }
          else for (let c = 0; c < Math.min(3, img.ch); c++) out[o + c] = clamp(out[o + c] + noise(c));
        }
      return { ...img, data: out };
    },
  },
  {
    id: 'reduceNoise', name: 'Reduce Noise…', category: 'Noise', space: 'straight', psdName: 'reduce noise',
    params: [number('strength', 'Strength', 0, 10, 6), number('details', 'Preserve Details', 0, 100, 60, '%'), number('color', 'Reduce Color Noise', 0, 100, 45, '%')],
    padding: () => 6,
    apply(img, p, ctx) {
      const s = num(p, 'strength');
      const thr = (0.02 + s * 0.02) * (1 - num(p, 'details') / 150);
      let out = bilateral(img, Math.max(1, Math.round(2 * ctx.scale + s * 0.3)), thr, ctx);
      const cn = num(p, 'color') / 100;
      if (cn > 0 && img.ch === 4) {
        // Chroma smoothing: blur color differences, keep luminance.
        const chroma = out.data.slice();
        for (let i = 0; i < img.w * img.h; i++) { const L = lum(chroma[i * 4], chroma[i * 4 + 1], chroma[i * 4 + 2]); chroma[i * 4] -= L; chroma[i * 4 + 1] -= L; chroma[i * 4 + 2] -= L; }
        gaussianBlur(chroma, img.w, img.h, 4, 1 + cn * 3 * ctx.scale);
        const d = out.data.slice();
        for (let i = 0; i < img.w * img.h; i++) {
          const L = lum(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
          for (let c = 0; c < 3; c++) d[i * 4 + c] = clamp(d[i * 4 + c] + (L + chroma[i * 4 + c] - d[i * 4 + c]) * cn);
        }
        out = { ...out, data: d };
      }
      return out;
    },
  },
  {
    id: 'median', name: 'Median…', category: 'Noise', space: 'straight', psdName: 'median',
    params: [number('radius', 'Radius', 1, 500, 2, 'px')],
    padding: (p) => Math.ceil(num(p, 'radius')) + 1,
    apply(img, p, ctx) { return median(img, Math.max(1, Math.round(num(p, 'radius') * ctx.scale)), ctx); },
  },
  // ------------------------------------------------------------------------- Stylize
  {
    id: 'findEdges', name: 'Find Edges', category: 'Stylize', space: 'straight', psdName: 'find edges', params: [],
    padding: () => 2,
    apply(img) {
      const { w, h, ch, data } = img;
      const out = data.slice();
      const at = (x: number, y: number, c: number) => data[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * ch + c];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          for (let c = 0; c < Math.min(3, ch); c++) {
            const gx = at(x + 1, y - 1, c) + 2 * at(x + 1, y, c) + at(x + 1, y + 1, c) - at(x - 1, y - 1, c) - 2 * at(x - 1, y, c) - at(x - 1, y + 1, c);
            const gy = at(x - 1, y + 1, c) + 2 * at(x, y + 1, c) + at(x + 1, y + 1, c) - at(x - 1, y - 1, c) - 2 * at(x, y - 1, c) - at(x + 1, y - 1, c);
            out[(y * w + x) * ch + c] = clamp(1 - Math.hypot(gx, gy) * 0.5);
          }
      return { ...img, data: out };
    },
  },
  {
    id: 'emboss', name: 'Emboss…', category: 'Stylize', space: 'straight', psdName: 'emboss',
    params: [{ type: 'angle', id: 'angle', label: 'Angle', default: 135 }, number('height', 'Height', 1, 100, 3, 'px'), number('amount', 'Amount', 1, 500, 100, '%')],
    padding: (p) => Math.ceil(num(p, 'height')) + 2,
    apply(img, p, ctx) {
      const a = (num(p, 'angle') * Math.PI) / 180;
      const hgt = num(p, 'height') * ctx.scale;
      const dx = Math.cos(a) * hgt, dy = -Math.sin(a) * hgt;
      const amt = num(p, 'amount') / 100;
      const out = img.data.slice();
      const t1 = new Float32Array(4), t2 = new Float32Array(4);
      for (let y = 0; y < img.h; y++)
        for (let x = 0; x < img.w; x++) {
          sampleAt(img, x + dx, y + dy, t1, 0, 'repeat');
          sampleAt(img, x - dx, y - dy, t2, 0, 'repeat');
          const o = (y * img.w + x) * img.ch;
          const d = img.ch === 4 ? lum(t1[0], t1[1], t1[2]) - lum(t2[0], t2[1], t2[2]) : t1[0] - t2[0];
          for (let c = 0; c < Math.min(3, img.ch); c++) out[o + c] = clamp(0.5 + d * amt);
        }
      return { ...img, data: out };
    },
  },
  {
    id: 'solarize', name: 'Solarize', category: 'Stylize', space: 'straight', psdName: 'solarize', params: [],
    padding: () => 0,
    apply(img) {
      const out = img.data.slice();
      for (let i = 0; i < img.w * img.h; i++) for (let c = 0; c < Math.min(3, img.ch); c++) { const v = out[i * img.ch + c]; out[i * img.ch + c] = v > 0.5 ? 1 - v : v; }
      return { ...img, data: out };
    },
  },
  // ------------------------------------------------------------------------- Other
  {
    id: 'minimum', name: 'Minimum…', category: 'Other', space: 'straight', psdName: 'minimum',
    params: [number('radius', 'Radius', 1, 500, 1, 'px')],
    padding: (p) => Math.ceil(num(p, 'radius')) + 1,
    apply(img, p, ctx) { minMaxFilter(img.data, img.w, img.h, img.ch, Math.max(1, Math.round(num(p, 'radius') * ctx.scale)), false); return img; },
  },
  {
    id: 'maximum', name: 'Maximum…', category: 'Other', space: 'straight', psdName: 'maximum',
    params: [number('radius', 'Radius', 1, 500, 1, 'px')],
    padding: (p) => Math.ceil(num(p, 'radius')) + 1,
    apply(img, p, ctx) { minMaxFilter(img.data, img.w, img.h, img.ch, Math.max(1, Math.round(num(p, 'radius') * ctx.scale)), true); return img; },
  },
];

function unsharp(img: FloatImage, radius: number, amount: number, threshold: number): FloatImage {
  const b = img.data.slice();
  gaussianBlur(b, img.w, img.h, img.ch, Math.max(0.3, radius));
  const out = img.data.slice();
  for (let i = 0; i < img.w * img.h; i++)
    for (let c = 0; c < Math.min(3, img.ch); c++) {
      const o = i * img.ch + c;
      const d = img.data[o] - b[o];
      if (Math.abs(d) * 255 < threshold * 255) continue;
      out[o] = clamp(img.data[o] + d * amount);
    }
  return { ...img, data: out };
}

function bilateral(img: FloatImage, r: number, threshold: number, ctx: FilterContext): FloatImage {
  const { w, h, ch, data } = img;
  const out = new Float32Array(data.length);
  const step = r > 12 ? Math.ceil(r / 12) : 1;
  const t = Math.max(1e-4, threshold * 2.5);
  for (let y = 0; y < h; y++) {
    if ((y & 15) === 0) { if (ctx.cancelled()) break; ctx.progress(y / h); }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * ch;
      const cL = ch === 4 ? lum(data[o], data[o + 1], data[o + 2]) : data[o];
      const acc = [0, 0, 0, 0];
      let ws = 0;
      for (let dy = -r; dy <= r; dy += step) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx += step) {
          if (dx * dx + dy * dy > r * r) continue;
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const i = (yy * w + xx) * ch;
          const L = ch === 4 ? lum(data[i], data[i + 1], data[i + 2]) : data[i];
          const wgt = Math.max(0, 1 - Math.abs(L - cL) / t);
          if (wgt <= 0) continue;
          for (let c = 0; c < ch; c++) acc[c] += data[i + c] * wgt;
          ws += wgt;
        }
      }
      for (let c = 0; c < ch; c++) out[o + c] = ws > 0 ? acc[c] / ws : data[o + c];
      if (ch === 4) out[o + 3] = data[o + 3];
    }
  }
  return { ...img, data: out };
}

function median(img: FloatImage, r: number, ctx: FilterContext): FloatImage {
  const { w, h, ch, data } = img;
  const out = data.slice();
  const BINS = 256;
  const channels = ch === 4 ? 3 : 1;
  for (let c = 0; c < channels; c++) {
    for (let y = 0; y < h; y++) {
      if ((y & 15) === 0 && ctx.cancelled()) return img;
      const hist = new Int32Array(BINS);
      let count = 0;
      const add = (xx: number, sign: number) => {
        for (let dy = -r; dy <= r; dy++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const x2 = Math.min(w - 1, Math.max(0, xx));
          hist[Math.min(255, Math.max(0, Math.round(data[(yy * w + x2) * ch + c] * 255)))] += sign;
          count += sign;
        }
      };
      for (let dx = -r; dx <= r; dx++) add(dx, 1);
      for (let x = 0; x < w; x++) {
        let s = 0, m = 0;
        const half = count / 2;
        while (m < BINS && s + hist[m] < half) s += hist[m++];
        out[(y * w + x) * ch + c] = m / 255;
        add(x - r, -1);
        add(x + r + 1, 1);
      }
    }
    ctx.progress((c + 1) / channels);
  }
  return { ...img, data: out };
}

BUILTIN_FILTERS.push(...GALLERY_FILTERS);

export function filterById(id: string): FilterDef | undefined {
  return BUILTIN_FILTERS.find((f) => f.id === id) ?? extraFilters.find((f) => f.id === id);
}

/** Filters registered by plugins. */
export const extraFilters: FilterDef[] = [];

export function allFilters(): FilterDef[] {
  return [...BUILTIN_FILTERS, ...extraFilters];
}

export type { FilterParams };
