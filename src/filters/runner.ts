/**
 * Filter execution: synchronous (smart filters, tests, small previews) or in a worker thread
 * with progress reporting and cancellation (the worker is terminated on cancel).
 */
import type { FilterContext, FilterDef, FilterParams, FloatImage } from './types';

export type FilterContextBase = Omit<FilterContext, 'cancelled' | 'progress'>;

function toPremultiplied(img: FloatImage) {
  if (img.ch !== 4) return;
  const d = img.data;
  for (let i = 0; i < img.w * img.h; i++) {
    const a = d[i * 4 + 3];
    d[i * 4] *= a; d[i * 4 + 1] *= a; d[i * 4 + 2] *= a;
  }
}

function toStraight(img: FloatImage) {
  if (img.ch !== 4) return;
  const d = img.data;
  for (let i = 0; i < img.w * img.h; i++) {
    const a = d[i * 4 + 3];
    if (a > 1e-7) { const k = 1 / a; d[i * 4] = Math.min(1, d[i * 4] * k); d[i * 4 + 1] = Math.min(1, d[i * 4 + 1] * k); d[i * 4 + 2] = Math.min(1, d[i * 4 + 2] * k); }
    else d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 0;
  }
}

/** Runs a filter on a straight-alpha image (in its declared processing space). */
export function runFilterSync(def: FilterDef, params: FilterParams, img: FloatImage, base: FilterContextBase, cancelled: () => boolean = () => false, progress: (f: number) => void = () => {}): FloatImage {
  const pre = def.space === 'premultiplied' && img.ch === 4;
  if (pre) toPremultiplied(img);
  const out = def.apply(img, params, { ...base, cancelled, progress });
  if (pre) {
    toStraight(out);
    if (out !== img) toStraight(img);
  }
  return out;
}

export interface FilterTask {
  promise: Promise<FloatImage>;
  cancel(): void;
}

/** Runs a built-in filter in a worker. Falls back to the main thread when workers are unavailable. */
export function runFilterAsync(def: FilterDef, params: FilterParams, img: FloatImage, base: FilterContextBase, onProgress: (f: number) => void, builtin = true): FilterTask {
  let cancelled = false;
  if (def.runAsync) {
    const run = def.runAsync.bind(def);
    const promise = new Promise<FloatImage>((resolve, reject) => {
      run(img, params, onProgress).then((r) => (cancelled ? reject(new Error('Cancelled')) : resolve(r)), reject);
    });
    return { promise, cancel: () => { cancelled = true; } };
  }
  if (typeof Worker === 'undefined' || !builtin) {
    const promise = new Promise<FloatImage>((resolve, reject) => {
      setTimeout(() => {
        try {
          const r = runFilterSync(def, params, img, base, () => cancelled, onProgress);
          if (cancelled) reject(new Error('Cancelled'));
          else resolve(r);
        } catch (e) {
          reject(e);
        }
      }, 0);
    });
    return { promise, cancel: () => { cancelled = true; } };
  }
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const promise = new Promise<FloatImage>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.value);
      else if (m.type === 'done') {
        resolve({ w: m.w, h: m.h, ch: m.ch, data: m.data });
        worker.terminate();
      } else if (m.type === 'error') {
        reject(new Error(m.message));
        worker.terminate();
      }
    };
    worker.onerror = (e) => {
      reject(new Error(e.message || 'Filter worker failed'));
      worker.terminate();
    };
    worker.postMessage({ filterId: def.id, params, w: img.w, h: img.h, ch: img.ch, data: img.data, base }, [img.data.buffer]);
  });
  return {
    promise,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      worker.terminate();
    },
  };
}
