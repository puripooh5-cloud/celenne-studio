/**
 * Blend If (Layer Style ▸ Blending Options) and channel restrictions.
 *
 * Blend If fades a layer's pixels out by the brightness of its own pixels ("This Layer") and of
 * the pixels below ("Underlying Layer"), per Gray / Red / Green / Blue channel. Each range is
 * [black low, black high, white low, white high] on 0..255: values below black-low or above
 * white-high are hidden, split handles ramp linearly in between (as in Photoshop).
 */
import type { AdvancedBlending, BlendIf, BlendIfRange } from '../document/types';

const isDefault = (r: BlendIfRange) => r[0] <= 0 && r[1] <= 0 && r[2] >= 255 && r[3] >= 255;

export function blendIfActive(bi: BlendIf | undefined): bi is BlendIf {
  if (!bi) return false;
  return [bi.gray, bi.red, bi.green, bi.blue].some((c) => !isDefault(c.thisLayer) || !isDefault(c.underlying));
}

export function blendIfUsesUnderlying(bi: BlendIf | undefined): boolean {
  return !!bi && [bi.gray, bi.red, bi.green, bi.blue].some((c) => !isDefault(c.underlying));
}

function factor(r: BlendIfRange, v: number): number {
  const [b0, b1, w0, w1] = r;
  if (v < b0 || v > w1) return 0;
  if (v < b1) return b1 > b0 ? (v - b0) / (b1 - b0) : 1;
  if (v > w0) return w1 > w0 ? (w1 - v) / (w1 - w0) : 1;
  return 1;
}

/**
 * Multiplies the alpha of `src` (straight RGBA) by the Blend If factors. `under` is the
 * premultiplied backdrop for the same pixels, or null to apply only the This Layer ranges.
 */
export function applyBlendIf(bi: BlendIf, src: Float32Array, under: Float32Array | null, n: number): void {
  const chans = [bi.gray, bi.red, bi.green, bi.blue];
  const thisOn = chans.map((c) => !isDefault(c.thisLayer));
  const underOn = under ? chans.map((c) => !isDefault(c.underlying)) : [false, false, false, false];
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = src[o + 3];
    if (a <= 0) continue;
    let f = 1;
    if (thisOn[0] || thisOn[1] || thisOn[2] || thisOn[3]) {
      const r = src[o] * 255, g = src[o + 1] * 255, b = src[o + 2] * 255;
      const vals = [0.3 * r + 0.59 * g + 0.11 * b, r, g, b];
      for (let c = 0; c < 4 && f > 0; c++) if (thisOn[c]) f *= factor(chans[c].thisLayer, vals[c]);
    }
    if (under && f > 0 && (underOn[0] || underOn[1] || underOn[2] || underOn[3])) {
      const ua = under[o + 3];
      const k = ua > 1e-6 ? 255 / ua : 0;
      const r = under[o] * k, g = under[o + 1] * k, b = under[o + 2] * k;
      const vals = [0.3 * r + 0.59 * g + 0.11 * b, r, g, b];
      for (let c = 0; c < 4 && f > 0; c++) if (underOn[c]) f *= factor(chans[c].underlying, vals[c]);
    }
    src[o + 3] = a * f;
  }
}

export function channelsRestricted(adv: AdvancedBlending): boolean {
  return !(adv.channels[0] && adv.channels[1] && adv.channels[2]);
}

/**
 * Channel restrictions: after compositing, disabled channels keep the backdrop's color (the
 * blend only writes the enabled R/G/B channels). Both buffers are premultiplied.
 */
export function restrictChannels(before: Float32Array, after: Float32Array, n: number, channels: [boolean, boolean, boolean]): void {
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const ba = before[o + 3];
    if (ba <= 1e-7) {
      // Nothing below: disabled channels are empty (black) where the layer adds coverage.
      for (let c = 0; c < 3; c++) if (!channels[c]) after[o + c] = 0;
      continue;
    }
    const na = after[o + 3];
    for (let c = 0; c < 3; c++) if (!channels[c]) after[o + c] = (before[o + c] / ba) * na;
  }
}
