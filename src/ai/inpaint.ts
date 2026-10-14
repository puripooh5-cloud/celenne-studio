/**
 * Exemplar-based inpainting (multi-scale PatchMatch with EM voting, after Wexler et al. and
 * Barnes et al.). Used by Content-Aware Fill, Spot Healing, the Remove tool and the Patch tool.
 */
export interface InpaintOptions {
  patchSize?: number;
  iterations?: number;
  cancelled?: () => boolean;
  progress?: (f: number) => void;
  seed?: number;
}

interface Level {
  w: number;
  h: number;
  img: Float32Array; // RGB (3 per pixel)
  hole: Uint8Array;
}

function downsample(l: Level): Level {
  const w = Math.max(1, l.w >> 1), h = Math.max(1, l.h >> 1);
  const img = new Float32Array(w * h * 3);
  const hole = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let n = 0;
      const acc = [0, 0, 0];
      let anyHole = 0;
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(l.w - 1, x * 2 + dx), sy = Math.min(l.h - 1, y * 2 + dy);
          const i = sy * l.w + sx;
          if (l.hole[i]) { anyHole = 1; continue; }
          acc[0] += l.img[i * 3]; acc[1] += l.img[i * 3 + 1]; acc[2] += l.img[i * 3 + 2];
          n++;
        }
      const o = y * w + x;
      hole[o] = anyHole && n < 4 ? 1 : 0;
      if (n) { img[o * 3] = acc[0] / n; img[o * 3 + 1] = acc[1] / n; img[o * 3 + 2] = acc[2] / n; }
    }
  return { w, h, img, hole };
}

/** Fills hole pixels by iterative neighbor diffusion (initial guess at the coarsest level). */
function diffuse(l: Level) {
  const { w, h, img, hole } = l;
  const known = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) known[i] = hole[i] ? 0 : 1;
  let remaining = hole.reduce((a, b) => a + b, 0);
  let guard = 0;
  while (remaining > 0 && guard++ < w + h) {
    const next = known.slice();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (known[i]) continue;
        let n = 0;
        const acc = [0, 0, 0];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (!known[j]) continue;
          acc[0] += img[j * 3]; acc[1] += img[j * 3 + 1]; acc[2] += img[j * 3 + 2];
          n++;
        }
        if (n) {
          img[i * 3] = acc[0] / n; img[i * 3 + 1] = acc[1] / n; img[i * 3 + 2] = acc[2] / n;
          next[i] = 1;
          remaining--;
        }
      }
    known.set(next);
  }
}

class Rng {
  constructor(private s: number) {}
  next() {
    this.s ^= this.s << 13; this.s ^= this.s >>> 17; this.s ^= this.s << 5;
    return (this.s >>> 0) / 4294967296;
  }
}

interface Match { targets: number[]; cost: Float32Array }

function patchMatchLevel(l: Level, nnfX: Int32Array, nnfY: Int32Array, P: number, iters: number, rng: Rng, cancelled?: () => boolean): Match | null {
  const { w, h, img, hole } = l;
  const r = P >> 1;
  // Valid source centers: patch fully inside the image and outside the hole.
  const validSrc = new Uint8Array(w * h);
  const holeIntegral = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) holeIntegral[(y + 1) * (w + 1) + x + 1] = hole[y * w + x] + holeIntegral[y * (w + 1) + x + 1] + holeIntegral[(y + 1) * (w + 1) + x] - holeIntegral[y * (w + 1) + x];
  const holeCount = (x0: number, y0: number, x1: number, y1: number) => holeIntegral[y1 * (w + 1) + x1] - holeIntegral[y0 * (w + 1) + x1] - holeIntegral[y1 * (w + 1) + x0] + holeIntegral[y0 * (w + 1) + x0];
  const validList: number[] = [];
  for (let y = r; y < h - r; y++)
    for (let x = r; x < w - r; x++)
      if (holeCount(x - r, y - r, x + r + 1, y + r + 1) === 0) { validSrc[y * w + x] = 1; validList.push(y * w + x); }
  if (!validList.length) return null;
  // Target pixels: hole pixels (and a ring around them for coherent patches).
  const targets: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (holeCount(Math.max(0, x - r), Math.max(0, y - r), Math.min(w, x + r + 1), Math.min(h, y + r + 1)) > 0) targets.push(y * w + x);
  const dist = (tx: number, ty: number, sx: number, sy: number, best: number) => {
    let d = 0;
    for (let dy = -r; dy <= r; dy++) {
      const yy = ty + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = tx + dx;
        if (xx < 0 || xx >= w) continue;
        const ti = (yy * w + xx) * 3, si = ((sy + dy) * w + (sx + dx)) * 3;
        const a = img[ti] - img[si], b = img[ti + 1] - img[si + 1], c = img[ti + 2] - img[si + 2];
        d += a * a + b * b + c * c;
        if (d >= best) return d;
      }
    }
    return d;
  };
  const cost = new Float32Array(w * h).fill(Infinity);
  for (const t of targets) {
    let sx = nnfX[t], sy = nnfY[t];
    if (sx < 0 || !validSrc[sy * w + sx]) {
      const v = validList[Math.floor(rng.next() * validList.length)];
      sx = v % w; sy = Math.floor(v / w);
    }
    nnfX[t] = sx; nnfY[t] = sy;
    cost[t] = dist(t % w, Math.floor(t / w), sx, sy, Infinity);
  }
  const isTarget = new Uint8Array(w * h);
  for (const t of targets) isTarget[t] = 1;
  const tryCandidate = (t: number, sx: number, sy: number) => {
    if (sx < r || sy < r || sx >= w - r || sy >= h - r || !validSrc[sy * w + sx]) return;
    const d = dist(t % w, Math.floor(t / w), sx, sy, cost[t]);
    if (d < cost[t]) { cost[t] = d; nnfX[t] = sx; nnfY[t] = sy; }
  };
  for (let it = 0; it < iters; it++) {
    if (cancelled?.()) return { targets, cost };
    const forward = it % 2 === 0;
    const order = forward ? targets : [...targets].reverse();
    const s = forward ? -1 : 1;
    for (const t of order) {
      const x = t % w, y = Math.floor(t / w);
      // Propagation from already-visited neighbors.
      const nx = x + s, ny = y + s;
      if (nx >= 0 && nx < w && isTarget[y * w + nx]) tryCandidate(t, nnfX[y * w + nx] - s, nnfY[y * w + nx]);
      if (ny >= 0 && ny < h && isTarget[ny * w + x]) tryCandidate(t, nnfX[ny * w + x], nnfY[ny * w + x] - s);
      // Random search with exponentially shrinking radius.
      let rad = Math.max(w, h);
      while (rad >= 1) {
        tryCandidate(t, Math.round(nnfX[t] + (rng.next() * 2 - 1) * rad), Math.round(nnfY[t] + (rng.next() * 2 - 1) * rad));
        rad *= 0.5;
      }
    }
    // Voting: reconstruct hole pixels from overlapping source patches.
    const acc = new Float32Array(w * h * 3), wsum = new Float32Array(w * h);
    for (const t of targets) {
      const x = t % w, y = Math.floor(t / w);
      const sx = nnfX[t], sy = nnfY[t];
      const wt = Math.exp(-cost[t] / (P * P * 0.02 + 1e-6));
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const i = yy * w + xx;
          if (!hole[i]) continue;
          const si = ((sy + dy) * w + (sx + dx)) * 3;
          acc[i * 3] += img[si] * wt; acc[i * 3 + 1] += img[si + 1] * wt; acc[i * 3 + 2] += img[si + 2] * wt;
          wsum[i] += wt;
        }
      }
    }
    for (let i = 0; i < w * h; i++) if (hole[i] && wsum[i] > 0) { img[i * 3] = acc[i * 3] / wsum[i]; img[i * 3 + 1] = acc[i * 3 + 1] / wsum[i]; img[i * 3 + 2] = acc[i * 3 + 2] / wsum[i]; }
  }
  return { targets, cost };
}

/**
 * Inpaints RGBA `img` (straight, w×h) where `hole[i] === 1`. Returns a new RGBA buffer.
 * Alpha inside the hole is set to the average surrounding alpha.
 */
export function inpaint(rgba: Float32Array, w: number, h: number, hole: Uint8Array, o: InpaintOptions = {}): Float32Array {
  return inpaintCarry(rgba, w, h, hole, [], o).image;
}

/**
 * Inpaints `rgba` (the guide) and synthesises every `carry` buffer (straight RGBA, same size —
 * e.g. the C'M'Y' and K' plates of a CMYK layer) from the same source patches, so the filled
 * area gets the inks that are really in the image instead of a re-separation of the RGB result.
 */
export function inpaintCarry(rgba: Float32Array, w: number, h: number, hole: Uint8Array, carry: Float32Array[], o: InpaintOptions = {}): { image: Float32Array; carried: Float32Array[] } {
  const P = o.patchSize ?? 7;
  const iters = o.iterations ?? 6;
  const rng = new Rng((o.seed ?? 12345) >>> 0 || 1);
  const base: Level = { w, h, img: new Float32Array(w * h * 3), hole: hole.slice() };
  for (let i = 0; i < w * h; i++) { base.img[i * 3] = rgba[i * 4]; base.img[i * 3 + 1] = rgba[i * 4 + 1]; base.img[i * 3 + 2] = rgba[i * 4 + 2]; }
  const levels: Level[] = [base];
  while (levels.length < 8) {
    const l = levels[levels.length - 1];
    if (Math.min(l.w, l.h) < P * 4) break;
    const holeFrac = l.hole.reduce((a, b) => a + b, 0) / (l.w * l.h);
    if (levels.length > 1 && holeFrac < 0.02 && Math.min(l.w, l.h) < 64) break;
    levels.push(downsample(l));
  }
  const coarsest = levels[levels.length - 1];
  diffuse(coarsest);
  let nnfX = new Int32Array(coarsest.w * coarsest.h).fill(-1), nnfY = new Int32Array(coarsest.w * coarsest.h).fill(-1);
  let finest: Match | null = null;
  for (let li = levels.length - 1; li >= 0; li--) {
    const l = levels[li];
    if (li < levels.length - 1) {
      // Upsample previous solution into this level's hole and NNF.
      const prev = levels[li + 1];
      const nx = new Int32Array(l.w * l.h).fill(-1), ny = new Int32Array(l.w * l.h).fill(-1);
      for (let y = 0; y < l.h; y++)
        for (let x = 0; x < l.w; x++) {
          const px = Math.min(prev.w - 1, x >> 1), py = Math.min(prev.h - 1, y >> 1);
          const pi = py * prev.w + px, i = y * l.w + x;
          if (l.hole[i]) { l.img[i * 3] = prev.img[pi * 3]; l.img[i * 3 + 1] = prev.img[pi * 3 + 1]; l.img[i * 3 + 2] = prev.img[pi * 3 + 2]; }
          if (nnfX[pi] >= 0) { nx[i] = Math.min(l.w - 1, nnfX[pi] * 2 + (x & 1)); ny[i] = Math.min(l.h - 1, nnfY[pi] * 2 + (y & 1)); }
        }
      nnfX = nx; nnfY = ny;
    }
    const ok = patchMatchLevel(l, nnfX, nnfY, P, li === 0 ? Math.max(2, iters - 2) : iters, rng, o.cancelled);
    if (li === 0) finest = ok;
    if (!ok && li === levels.length - 1) break;
    o.progress?.(1 - li / levels.length);
    if (o.cancelled?.()) break;
  }
  const out = rgba.slice();
  // Surrounding alpha for hole pixels.
  let aSum = 0, aN = 0;
  for (let i = 0; i < w * h; i++) if (!hole[i]) { aSum += rgba[i * 4 + 3]; aN++; }
  const aAvg = aN ? aSum / aN : 1;
  for (let i = 0; i < w * h; i++) {
    if (!hole[i]) continue;
    out[i * 4] = base.img[i * 3]; out[i * 4 + 1] = base.img[i * 3 + 1]; out[i * 4 + 2] = base.img[i * 3 + 2];
    out[i * 4 + 3] = Math.max(rgba[i * 4 + 3], aAvg);
  }
  const carried = carry.map((buf) => voteCarry(buf, w, h, hole, finest, nnfX, nnfY, P, out));
  return { image: out, carried };
}

/** Rebuilds `buf`'s hole pixels from the final patch correspondences (same weights as the guide). */
function voteCarry(buf: Float32Array, w: number, h: number, hole: Uint8Array, m: Match | null, nnfX: Int32Array, nnfY: Int32Array, P: number, guide: Float32Array): Float32Array {
  const out = buf.slice();
  const r = P >> 1;
  const acc = new Float32Array(w * h * 3), wsum = new Float32Array(w * h);
  if (m) {
    for (const t of m.targets) {
      const x = t % w, y = Math.floor(t / w);
      const sx = nnfX[t], sy = nnfY[t];
      if (sx < 0) continue;
      const wt = Math.exp(-m.cost[t] / (P * P * 0.02 + 1e-6));
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const i = yy * w + xx;
          if (!hole[i]) continue;
          const si = ((sy + dy) * w + (sx + dx)) * 4;
          acc[i * 3] += buf[si] * wt; acc[i * 3 + 1] += buf[si + 1] * wt; acc[i * 3 + 2] += buf[si + 2] * wt;
          wsum[i] += wt;
        }
      }
    }
  }
  // Pixels no patch reached (only when matching failed) take the nearest-known average.
  const lvl: Level = { w, h, img: new Float32Array(w * h * 3), hole: new Uint8Array(w * h) };
  let missing = 0;
  for (let i = 0; i < w * h; i++) {
    if (hole[i] && wsum[i] > 0) { lvl.img[i * 3] = acc[i * 3] / wsum[i]; lvl.img[i * 3 + 1] = acc[i * 3 + 1] / wsum[i]; lvl.img[i * 3 + 2] = acc[i * 3 + 2] / wsum[i]; }
    else if (hole[i]) { lvl.hole[i] = 1; missing++; }
    else { lvl.img[i * 3] = buf[i * 4]; lvl.img[i * 3 + 1] = buf[i * 4 + 1]; lvl.img[i * 3 + 2] = buf[i * 4 + 2]; }
  }
  if (missing) diffuse(lvl);
  for (let i = 0; i < w * h; i++) {
    if (!hole[i]) continue;
    out[i * 4] = lvl.img[i * 3]; out[i * 4 + 1] = lvl.img[i * 3 + 1]; out[i * 4 + 2] = lvl.img[i * 3 + 2];
    out[i * 4 + 3] = guide[i * 4 + 3];
  }
  return out;
}
