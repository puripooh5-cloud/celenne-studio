/**
 * Brush engine.
 *
 *  Input samples (pointer events with pressure/tilt/twist) → smoothing (pulled string) →
 *  dab emission at `spacing` → dynamics (pressure, tilt, rotation, velocity, jitter, scatter) →
 *  dab coverage (round/sampled tip × hardness × roundness × texture).
 *
 * Paint operations then combine dab coverage with a per-stroke coverage buffer so that flow
 * accumulates within a stroke while opacity caps the stroke (the professional model where a
 * single stroke never exceeds its opacity no matter how often it overlaps itself).
 */
import type { BrushSettings } from '../tools/toolTypes';
import type { Rect } from '../image-engine/rect';
import { roundOut } from '../image-engine/rect';

export interface InputSample {
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  twist: number;
  time: number;
}

export interface Dab {
  x: number;
  y: number;
  radius: number;
  angle: number; // radians
  roundness: number;
  /** Flow-like per-dab strength (0..1). */
  flow: number;
  /** Opacity cap for this position (0..1). */
  opacity: number;
  pressure: number;
}

class Rng {
  constructor(private s = 0x9e3779b9) {}
  next(): number {
    this.s ^= this.s << 13;
    this.s ^= this.s >>> 17;
    this.s ^= this.s << 5;
    return (this.s >>> 0) / 4294967296;
  }
}

export class DabEmitter {
  private last: InputSample | null = null;
  private smoothed: { x: number; y: number } | null = null;
  private residue = 0;
  private rng = new Rng((Math.random() * 0xffffffff) >>> 0);
  private lastDir = 0;
  private velocity = 0;

  constructor(private b: BrushSettings) {}

  /** Lazy radius in document px derived from the smoothing setting. */
  private lazyRadius(): number {
    return this.b.smoothing * Math.max(4, this.b.size * 0.5);
  }

  private smooth(p: InputSample): InputSample {
    if (!this.smoothed) {
      this.smoothed = { x: p.x, y: p.y };
      return p;
    }
    const R = this.lazyRadius();
    const dx = p.x - this.smoothed.x, dy = p.y - this.smoothed.y;
    const d = Math.hypot(dx, dy);
    if (d > R) {
      const k = (d - R) / d;
      this.smoothed.x += dx * k;
      this.smoothed.y += dy * k;
    }
    return { ...p, x: this.smoothed.x, y: this.smoothed.y };
  }

  begin(p: InputSample): Dab[] {
    this.last = p;
    this.smoothed = { x: p.x, y: p.y };
    this.residue = 0;
    return this.makeDabs(p);
  }

  move(raw: InputSample): Dab[] {
    if (!this.last) return this.begin(raw);
    const p = this.smooth(raw);
    return this.stepTo(p);
  }

  /** Flushes the smoothing lag at the end of a stroke. */
  end(raw: InputSample): Dab[] {
    if (!this.last) return [];
    if (this.b.smoothing <= 0) return [];
    return this.stepTo({ ...raw });
  }

  /** Airbrush build-up: repeats a dab at the current position. */
  repeat(): Dab[] {
    return this.last ? this.makeDabs(this.last) : [];
  }

  private stepTo(p: InputSample): Dab[] {
    const a = this.last!;
    const dx = p.x - a.x, dy = p.y - a.y;
    const dist = Math.hypot(dx, dy);
    const dt = Math.max(1, p.time - a.time);
    this.velocity = this.velocity * 0.7 + (dist / dt) * 0.3;
    if (dist > 0.01) this.lastDir = Math.atan2(dy, dx);
    const out: Dab[] = [];
    if (dist === 0) return out;
    const spacingFor = (pressure: number) => Math.max(0.5, this.b.spacing * this.sizeAt(pressure));
    // `residue` = distance travelled since the last dab. The next dab is due after `step`.
    let step = spacingFor(a.pressure);
    let next = step - this.residue;
    let lastDabAt = -this.residue;
    while (next <= dist) {
      const t = Math.max(0, next) / dist;
      const s: InputSample = {
        x: a.x + dx * t,
        y: a.y + dy * t,
        pressure: a.pressure + (p.pressure - a.pressure) * t,
        tiltX: a.tiltX + (p.tiltX - a.tiltX) * t,
        tiltY: a.tiltY + (p.tiltY - a.tiltY) * t,
        twist: a.twist + (p.twist - a.twist) * t,
        time: a.time + (p.time - a.time) * t,
      };
      out.push(...this.makeDabs(s));
      lastDabAt = next;
      step = spacingFor(s.pressure);
      next += step;
    }
    this.residue = dist - lastDabAt;
    this.last = p;
    return out;
  }

  private sizeAt(pressure: number): number {
    const dyn = this.b.dynamics;
    let s = this.b.size;
    if (dyn.sizePressure) s *= dyn.minSize + (1 - dyn.minSize) * pressure;
    return Math.max(0.5, s);
  }

  private makeDabs(p: InputSample): Dab[] {
    const b = this.b, dyn = b.dynamics;
    const out: Dab[] = [];
    for (let i = 0; i < Math.max(1, b.count); i++) {
      let size = this.sizeAt(p.pressure);
      if (dyn.sizeFromVelocity) size *= Math.max(0.1, 1 + dyn.sizeFromVelocity * Math.min(1, this.velocity / 3));
      if (dyn.sizeJitter) size *= 1 - dyn.sizeJitter * this.rng.next();
      let angle = (b.angle * Math.PI) / 180;
      if (dyn.angleControl === 'direction') angle += this.lastDir;
      else if (dyn.angleControl === 'tilt' && (p.tiltX || p.tiltY)) angle += Math.atan2(p.tiltY, p.tiltX);
      else if (dyn.angleControl === 'rotation') angle += (p.twist * Math.PI) / 180;
      if (dyn.angleJitter) angle += (this.rng.next() - 0.5) * 2 * Math.PI * dyn.angleJitter;
      let roundness = b.roundness;
      if (dyn.roundnessFromTilt) roundness *= Math.max(0.1, 1 - Math.min(1, Math.hypot(p.tiltX, p.tiltY) / 90));
      let flow = b.flow;
      if (dyn.flowPressure) flow *= p.pressure;
      if (dyn.flowJitter) flow *= 1 - dyn.flowJitter * this.rng.next();
      let opacity = b.opacity;
      if (dyn.opacityPressure) opacity *= p.pressure;
      if (dyn.opacityJitter) opacity *= 1 - dyn.opacityJitter * this.rng.next();
      let x = p.x, y = p.y;
      if (b.scatter > 0) {
        const r = (this.rng.next() - 0.5) * 2 * b.scatter * size;
        x += -Math.sin(this.lastDir) * r;
        y += Math.cos(this.lastDir) * r;
      }
      out.push({ x, y, radius: size / 2, angle, roundness: Math.max(0.01, roundness), flow: Math.max(0, Math.min(1, flow)), opacity: Math.max(0, Math.min(1, opacity)), pressure: p.pressure });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Dab coverage
// ---------------------------------------------------------------------------------------------
export function dabBounds(d: Dab): Rect {
  const r = d.radius + 1.5;
  return roundOut(d.x - r, d.y - r, d.x + r, d.y + r);
}

function hash2(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca77);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Procedural brush textures (document-space, so texture stays fixed while painting). */
export function textureValue(kind: BrushSettings['texture'], x: number, y: number, scale: number): number {
  const s = Math.max(0.1, scale);
  switch (kind) {
    case 'noise':
      return hash2(Math.floor(x / s), Math.floor(y / s));
    case 'chalk': {
      const n = valueNoise(x / (1.5 * s), y / (1.5 * s)) * 0.6 + valueNoise(x / (5 * s), y / (5 * s)) * 0.4;
      return n > 0.45 ? 1 : n / 0.45 * 0.3;
    }
    case 'charcoal': {
      const n = valueNoise(x / (1.2 * s), y / (6 * s)) * 0.7 + hash2(Math.floor(x / s), Math.floor(y / s)) * 0.3;
      return Math.min(1, Math.max(0, (n - 0.25) * 1.8));
    }
    case 'canvas': {
      const w = Math.sin((x / (3 * s)) * Math.PI) * Math.sin((y / (3 * s)) * Math.PI);
      return 0.6 + 0.4 * Math.abs(w);
    }
    case 'ink':
      return 0.85 + 0.15 * valueNoise(x / (8 * s), y / (8 * s));
    default:
      return 1;
  }
}

export interface TipSampler {
  (u: number, v: number): number;
}

export function makeTipSampler(b: BrushSettings): TipSampler | null {
  const img = b.tipImage;
  if (b.tip !== 'sampled' || !img) return null;
  const { width: w, height: h, data } = img;
  return (u, v) => {
    // u,v in [-1,1]
    const fx = (u * 0.5 + 0.5) * (w - 1), fy = (v * 0.5 + 0.5) * (h - 1);
    if (fx < 0 || fy < 0 || fx > w - 1 || fy > h - 1) return 0;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const a = data[y0 * w + x0], bb = data[y0 * w + x1], c = data[y1 * w + x0], d = data[y1 * w + x1];
    return (a + (bb - a) * tx + (c - a) * ty + (a - bb - c + d) * tx * ty) / 255;
  };
}

/** Dab coverage for rect `r` (document px). */
export function dabCoverage(d: Dab, r: Rect, b: BrushSettings, tip: TipSampler | null, out?: Float32Array): Float32Array {
  const cov = out && out.length >= r.w * r.h ? out : new Float32Array(r.w * r.h);
  const cos = Math.cos(-d.angle), sin = Math.sin(-d.angle);
  const R = Math.max(0.25, d.radius);
  const invR = 1 / R;
  const invRound = 1 / d.roundness;
  const hard = Math.max(0, Math.min(1, b.hardness));
  // Soft falloff region; hard brushes still get ~1px of anti-aliasing.
  const edge = Math.max(1 - hard, Math.min(1, 1.2 * invR));
  const inner = 1 - edge;
  const aliased = b.aliased;
  const texOn = b.texture !== 'none';
  for (let y = 0; y < r.h; y++) {
    const py = r.y + y + 0.5 - d.y;
    for (let x = 0; x < r.w; x++) {
      const px = r.x + x + 0.5 - d.x;
      const rx = px * cos - py * sin;
      const ry = (px * sin + py * cos) * invRound;
      let c: number;
      if (tip) {
        c = tip(rx * invR, ry * invR);
      } else {
        const dist = Math.sqrt(rx * rx + ry * ry) * invR;
        if (aliased) c = dist <= 1 ? 1 : 0;
        else if (dist >= 1) c = 0;
        else if (dist <= inner) c = 1;
        else {
          const t = (dist - inner) / edge;
          c = hard >= 0.99 ? 1 - t : 1 - t * t * (3 - 2 * t);
          if (hard < 0.5) c = c * c * (1.5 - 0.5 * c);
        }
      }
      if (c > 0 && texOn) c *= 1 - b.textureDepth * (1 - textureValue(b.texture, r.x + x, r.y + y, b.textureScale));
      cov[y * r.w + x] = c;
    }
  }
  return cov;
}
