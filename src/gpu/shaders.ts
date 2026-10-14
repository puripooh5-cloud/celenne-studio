/**
 * WGSL for the GPU tile compositor: a line-by-line port of the CPU reference compositor
 * (image-engine/blend.ts, adjustments/apply.ts, adjustments/docAdjust.ts, rendering/blendIf.ts and
 * the analytic Lab conversion of color/plates.ts). Backdrops are premultiplied RGBA f32 storage
 * buffers; layer pixels come from texture-array atlases (8-bit unorm, 16-bit uint, 32-bit float).
 */

/** Operation kinds (P.kind). */
export const OP = {
  clear: 0,
  copy: 1,
  /** compositeSpan: straight source onto the premultiplied backdrop. */
  span: 2,
  /** compositeAtopSpan (clipping groups). */
  atop: 3,
  /** applyAdjustedSpan: the adjustment evaluated on the backdrop itself. */
  adjust: 4,
  /** Pass-through group with opacity / mask: dst += (src − dst) · opacity · coverage. */
  lerp: 5,
  /** restrictChannels(before = src, after = dst). */
  restrict: 6,
} as const;

/** Source kinds (P.src). */
export const SRC = {
  none: 0,
  /** Layer raster tiles in the atlases (grid of slots in `data`). */
  atlas: 1,
  solid: 2,
  /** Straight RGBA in the `src` buffer (CPU-rendered content: gradients, patterns, previews). */
  straight: 3,
  /** Premultiplied RGBA in the `src` buffer (isolated group, clip group); un-premultiplied first. */
  premultiplied: 4,
} as const;

/** P.flags bits. */
export const FLAG = {
  /** Lab document, non-Normal blend: blend in RGB (blendSpan). */
  labBlend: 1,
  /** Blend If "Underlying" reads the destination itself. */
  underIsDst: 2,
  /** Un-premultiply threshold: a > 1e-7 (groups) instead of a > 0 (clip groups). */
  groupUnpremul: 4,
  /** Blend If is active. */
  blendIf: 8,
  /** 32-bit document: Linear Dodge and Divide are not clamped at 1. */
  hdr: 32,
} as const;

/** Adjustment wrappers (P.adjWrap), see docAdjust.ts. */
export const WRAP = { none: 0, neutral: 1, lOnly: 2, lOnlyThreshold: 3, viaRgb: 4 } as const;

/** Adjustment codes (P.adjCode). */
export const ADJ = {
  identity: 0, channelLuts: 1, toneLut: 2, vibrance: 3, hueSat: 4, colorBalance: 5, blackWhite: 6,
  photoFilter: 7, channelMixer: 8, colorLookup: 9, invert: 10, posterize: 11, threshold: 12,
  gradientMap: 13, selectiveColor: 14, exposureLinear: 15,
} as const;

export const BLEND_IDS: Record<string, number> = {
  passThrough: 0, normal: 0, dissolve: 1, darken: 2, multiply: 3, colorBurn: 4, linearBurn: 5, darkerColor: 6,
  lighten: 7, screen: 8, colorDodge: 9, linearDodge: 10, lighterColor: 11, overlay: 12, softLight: 13,
  hardLight: 14, vividLight: 15, linearLight: 16, pinLight: 17, hardMix: 18, difference: 19, exclusion: 20,
  subtract: 21, divide: 22, hue: 23, saturation: 24, color: 25, luminosity: 26,
};

/** Size of one parameter block (uniform dynamic offset alignment). */
export const PARAM_STRIDE = 256;

const COMMON = /* wgsl */ `
struct P {
  kind: u32, mode: u32, src: u32, flags: u32,
  w: u32, h: u32, x0: i32, y0: i32,
  opacity: f32, cov: u32, chan: u32, adjCode: u32,
  solid: vec4f,
  rx0: i32, ry0: i32, gx0: i32, gy0: i32,
  gw: u32, gh: u32, grid: u32, adjBase: u32,
  adjWrap: u32, biBase: u32, srcW: u32, srcOff: u32,
  fill: f32, pad0: u32, pad1: u32, pad2: u32,
};

@group(0) @binding(0) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(1) var<storage, read> srcBuf: array<vec4f>;
@group(0) @binding(2) var<storage, read> underBuf: array<vec4f>;
@group(0) @binding(3) var<uniform> p: P;
@group(0) @binding(4) var<storage, read> data: array<u32>;
@group(0) @binding(5) var atlas8a: texture_2d_array<f32>;
@group(0) @binding(6) var atlas8b: texture_2d_array<f32>;
@group(0) @binding(7) var atlas8c: texture_2d_array<f32>;
@group(0) @binding(8) var atlas16a: texture_2d_array<u32>;
@group(0) @binding(9) var atlas16b: texture_2d_array<u32>;
@group(0) @binding(10) var atlas32: texture_2d_array<f32>;
@group(0) @binding(11) var atlasCovA: texture_2d_array<f32>;
@group(0) @binding(12) var atlasCovB: texture_2d_array<f32>;

fn df(i: u32) -> f32 { return bitcast<f32>(data[i]); }
fn clamp01(v: f32) -> f32 { return clamp(v, 0.0, 1.0); }
fn lum(c: vec3f) -> f32 { return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b; }
`;

const BLEND = /* wgsl */ `
fn screenF(b: f32, s: f32) -> f32 { return b + s - b * s; }
fn colorDodge(b: f32, s: f32) -> f32 { if (b <= 0.0) { return 0.0; } if (s >= 1.0) { return 1.0; } return min(1.0, b / (1.0 - s)); }
fn colorBurn(b: f32, s: f32) -> f32 { if (b >= 1.0) { return 1.0; } if (s <= 0.0) { return 0.0; } return 1.0 - min(1.0, (1.0 - b) / s); }
fn hardLight(b: f32, s: f32) -> f32 { if (s <= 0.5) { return b * 2.0 * s; } return screenF(b, 2.0 * s - 1.0); }
fn softLight(b: f32, s: f32) -> f32 {
  if (s <= 0.5) { return b - (1.0 - 2.0 * s) * b * (1.0 - b); }
  var d: f32;
  if (b <= 0.25) { d = ((16.0 * b - 12.0) * b + 4.0) * b; } else { d = sqrt(b); }
  return b + (2.0 * s - 1.0) * (d - b);
}
fn sep(m: u32, b: f32, s: f32) -> f32 {
  switch m {
    case 2u: { if (b < s) { return b; } return s; }
    case 3u: { return b * s; }
    case 4u: { return colorBurn(b, s); }
    case 5u: { return clamp01(b + s - 1.0); }
    case 7u: { if (b > s) { return b; } return s; }
    case 8u: { return screenF(b, s); }
    case 9u: { return colorDodge(b, s); }
    case 10u: { return clamp01(b + s); }
    case 12u: { return hardLight(s, b); }
    case 13u: { return softLight(b, s); }
    case 14u: { return hardLight(b, s); }
    case 15u: { if (s <= 0.5) { return colorBurn(b, 2.0 * s); } return colorDodge(b, 2.0 * (s - 0.5)); }
    case 16u: { return clamp01(b + 2.0 * s - 1.0); }
    case 17u: { if (s <= 0.5) { return min(b, 2.0 * s); } return max(b, 2.0 * s - 1.0); }
    case 18u: { if (b + s >= 1.0) { return 1.0; } return 0.0; }
    case 19u: { return abs(b - s); }
    case 20u: { return b + s - 2.0 * b * s; }
    case 21u: { return clamp01(b - s); }
    case 22u: { if (s <= 0.0) { if (b <= 0.0) { return 0.0; } return 1.0; } return clamp01(b / s); }
    default: { return s; }
  }
}
fn clipColor(c0: vec3f) -> vec3f {
  var c = c0;
  let l = lum(c);
  let n = min(c.r, min(c.g, c.b));
  let x = max(c.r, max(c.g, c.b));
  if (n < 0.0) { var d = l - n; if (d == 0.0) { d = 1e-9; } c = vec3f(l) + (c - vec3f(l)) * l / d; }
  if (x > 1.0) { var d = x - l; if (d == 0.0) { d = 1e-9; } c = vec3f(l) + (c - vec3f(l)) * (1.0 - l) / d; }
  return c;
}
fn setLum(c: vec3f, l: f32) -> vec3f { let d = l - lum(c); return clipColor(c + vec3f(d)); }
fn satOf(c: vec3f) -> f32 { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
fn setSat(c: vec3f, s: f32) -> vec3f {
  var v = array<f32, 3>(c.r, c.g, c.b);
  var maxI = 0u; var minI = 0u;
  for (var i = 1u; i < 3u; i++) { if (v[i] > v[maxI]) { maxI = i; } if (v[i] < v[minI]) { minI = i; } }
  if (maxI == minI) { return vec3f(0.0); }
  let midI = 3u - maxI - minI;
  let range = v[maxI] - v[minI];
  v[midI] = ((v[midI] - v[minI]) * s) / range;
  v[maxI] = s;
  v[minI] = 0.0;
  return vec3f(v[0], v[1], v[2]);
}
fn blendRGB(m: u32, b: vec3f, s: vec3f) -> vec3f {
  switch m {
    case 23u: { return setLum(setSat(s, satOf(b)), lum(b)); }
    case 24u: { return setLum(setSat(b, satOf(s)), lum(b)); }
    case 25u: { return setLum(s, lum(b)); }
    case 26u: { return setLum(b, lum(s)); }
    case 6u: { if (lum(s) < lum(b)) { return s; } return b; }
    case 11u: { if (lum(s) > lum(b)) { return s; } return b; }
    default: { return vec3f(sep(m, b.r, s.r), sep(m, b.g, s.g), sep(m, b.b, s.b)); }
  }
}
/** blendRGB with Hard Mix fill and 32-bit (unclamped) Linear Dodge / Divide. */
fn blendX(m: u32, b: vec3f, s: vec3f) -> vec3f {
  if (m == 18u && p.fill < 1.0) { return clamp((b - vec3f(p.fill) * (vec3f(1.0) - s)) / (1.0 - p.fill), vec3f(0.0), vec3f(1.0)); }
  if ((p.flags & 32u) != 0u) {
    if (m == 10u) { return b + s; }
    if (m == 22u) {
      var o = vec3f(0.0);
      for (var c = 0u; c < 3u; c++) { if (s[c] > 0.0) { o[c] = b[c] / s[c]; } else if (b[c] > 0.0) { o[c] = 1.0; } }
      return o;
    }
  }
  return blendRGB(m, b, s);
}
fn dissolveNoise(x: i32, y: i32) -> f32 {
  var h: i32 = x * 374761393 + y * 668265263;
  h = (h ^ i32(u32(h) >> 13u)) * 1274126177;
  h = h ^ i32(u32(h) >> 16u);
  return f32(u32(h)) / 4294967296.0;
}
`;

/** sRGB (D65) ↔ CIE Lab (D50, Bradford), exactly as color/plates.ts (labToSrgb clamps). */
const LAB = /* wgsl */ `
fn srgbLin(v: f32) -> f32 { if (v <= 0.04045) { return v / 12.92; } return pow((v + 0.055) / 1.055, 2.4); }
fn linSrgb(v: f32) -> f32 { if (v <= 0.0031308) { return v * 12.92; } return 1.055 * pow(max(0.0, v), 1.0 / 2.4) - 0.055; }
fn cbrtS(t: f32) -> f32 { return sign(t) * pow(abs(t), 1.0 / 3.0); }
fn fLab(t: f32) -> f32 { if (t > 216.0 / 24389.0) { return cbrtS(t); } return (24389.0 / 27.0 * t + 16.0) / 116.0; }
fn fInv(t: f32) -> f32 { if (t * t * t > 216.0 / 24389.0) { return t * t * t; } return (116.0 * t - 16.0) / (24389.0 / 27.0); }
fn srgbToLabE(c: vec3f) -> vec3f {
  let R = srgbLin(c.r); let G = srgbLin(c.g); let B = srgbLin(c.b);
  let X = 0.4360747 * R + 0.3850649 * G + 0.1430804 * B;
  let Y = 0.2225045 * R + 0.7168786 * G + 0.0606169 * B;
  let Z = 0.0139322 * R + 0.0971045 * G + 0.7141733 * B;
  let fx = fLab(X / 0.9642); let fy = fLab(Y); let fz = fLab(Z / 0.8249);
  let L = 116.0 * fy - 16.0; let a = 500.0 * (fx - fy); let b = 200.0 * (fy - fz);
  return vec3f(clamp01(L / 100.0), clamp01((a + 128.0) / 255.0), clamp01((b + 128.0) / 255.0));
}
fn labEToSrgb(e: vec3f) -> vec3f {
  let L = e.x * 100.0; let a = e.y * 255.0 - 128.0; let b = e.z * 255.0 - 128.0;
  let fy = (L + 16.0) / 116.0; let fx = fy + a / 500.0; let fz = fy - b / 200.0;
  let X = fInv(fx) * 0.9642; let Y = fInv(fy); let Z = fInv(fz) * 0.8249;
  let R = 3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z;
  let G = -0.9787684 * X + 1.9161415 * Y + 0.033454 * Z;
  let B2 = 0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;
  return vec3f(clamp01(linSrgb(R)), clamp01(linSrgb(G)), clamp01(linSrgb(B2)));
}
`;

const ADJUST = /* wgsl */ `
fn lut(base: u32, v: f32) -> f32 {
  let x = clamp01(v) * 1023.0;
  let i = u32(x);
  let f = x - f32(i);
  if (i >= 1023u) { return df(base + 1023u); }
  let a = df(base + i);
  return a + (df(base + i + 1u) - a) * f;
}
fn rgbToHsl(c: vec3f) -> vec3f {
  let mx = max(c.r, max(c.g, c.b)); let mn = min(c.r, min(c.g, c.b));
  let l = (mx + mn) / 2.0;
  let d = mx - mn;
  if (d == 0.0) { return vec3f(0.0, 0.0, l); }
  var s: f32; if (l > 0.5) { s = d / (2.0 - mx - mn); } else { s = d / (mx + mn); }
  var h: f32;
  if (mx == c.r) { h = (c.g - c.b) / d; if (c.g < c.b) { h += 6.0; } }
  else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; }
  else { h = (c.r - c.g) / d + 4.0; }
  return vec3f(h * 60.0, s, l);
}
fn hue2rgb(p0: f32, q: f32, t0: f32) -> f32 {
  var t = t0;
  if (t < 0.0) { t += 1.0; }
  if (t > 1.0) { t -= 1.0; }
  if (t < 1.0 / 6.0) { return p0 + (q - p0) * 6.0 * t; }
  if (t < 1.0 / 2.0) { return q; }
  if (t < 2.0 / 3.0) { return p0 + (q - p0) * (2.0 / 3.0 - t) * 6.0; }
  return p0;
}
fn fmod(a: f32, b: f32) -> f32 { return a - b * trunc(a / b); }
fn hslToRgb(hsl: vec3f) -> vec3f {
  let h = hsl.x; let s = hsl.y; let l = hsl.z;
  if (s == 0.0) { return vec3f(l); }
  var q: f32; if (l < 0.5) { q = l * (1.0 + s); } else { q = l + s - l * s; }
  let p0 = 2.0 * l - q;
  let hh = fmod(fmod(h, 360.0) + 360.0, 360.0) / 360.0;
  return vec3f(hue2rgb(p0, q, hh + 1.0 / 3.0), hue2rgb(p0, q, hh), hue2rgb(p0, q, hh - 1.0 / 3.0));
}
// Saturation increase strength for a +sat (percent) edit: s / (1 − s) (satBoost on the CPU).
fn satBoost(sat: f32) -> f32 { if (sat >= 100.0) { return 1e6; } let s = sat / 100.0; return s / (1.0 - s); }
// As applyHueSat on the CPU: hue, saturation decrease, lightness (master: toward white / black;
// colour range: toward the brightest / darkest channel), then the saturation increase.
fn applyHueSat(c: vec3f, hue: f32, sat: f32, light: f32, boost: f32, range: bool) -> vec3f {
  var hsl = rgbToHsl(c);
  hsl.x += hue;
  let s = sat / 100.0;
  if (s < 0.0) { hsl.y = clamp01(hsl.y * (1.0 + s)); }
  var rgb = hslToRgb(hsl);
  let l = light / 100.0;
  if (range) {
    if (l > 0.0) { rgb = rgb + (vec3f(max(rgb.r, max(rgb.g, rgb.b))) - rgb) * l; }
    else if (l < 0.0) { rgb = rgb + (rgb - vec3f(min(rgb.r, min(rgb.g, rgb.b)))) * l; }
  } else if (l > 0.0) { rgb = rgb + (vec3f(1.0) - rgb) * l; } else if (l < 0.0) { rgb = rgb * (1.0 + l); }
  if (boost > 0.0) {
    let mx = max(rgb.r, max(rgb.g, rgb.b)); let mn = min(rgb.r, min(rgb.g, rgb.b));
    let L = (mx + mn) * 0.5;
    var S = 0.0; if (mx > mn) { S = (mx - mn) / max(1e-6, 1.0 - abs(2.0 * L - 1.0)); }
    let a = min(1.0 / max(1e-6, S) - 1.0, boost);
    rgb = clamp(rgb + (rgb - vec3f(L)) * a, vec3f(0.0), vec3f(1.0));
  }
  return rgb;
}
fn norm360(v: f32) -> f32 { return fmod(fmod(v, 360.0) + 360.0, 360.0); }
fn inArc(x: f32, a0: f32, a1: f32) -> bool { if (a0 <= a1) { return x >= a0 && x <= a1; } return x >= a0 || x <= a1; }
fn dist360(a0: f32, a1: f32) -> f32 { return norm360(a1 - a0); }
fn hueWeight(h: f32, r: vec4f) -> f32 {
  let a = norm360(r.x); let b = norm360(r.y); let c = norm360(r.z); let d = norm360(r.w);
  let x = norm360(h);
  if (inArc(x, b, c)) { return 1.0; }
  if (inArc(x, a, b)) { return dist360(a, x) / max(1e-6, dist360(a, b)); }
  if (inArc(x, c, d)) { return 1.0 - dist360(c, x) / max(1e-6, dist360(c, d)); }
  return 0.0;
}
fn setLuminanceA(c: vec3f, tl: f32) -> vec3f {
  let d = tl - lum(c);
  var v = c + vec3f(d);
  let l = lum(v); let n = min(v.r, min(v.g, v.b)); let x = max(v.r, max(v.g, v.b));
  if (n < 0.0) { var q = l - n; if (q == 0.0) { q = 1e-9; } let k = l / q; v = vec3f(l) + (v - vec3f(l)) * k; }
  if (x > 1.0) { var q = x - l; if (q == 0.0) { q = 1e-9; } let k = (1.0 - l) / q; v = vec3f(l) + (v - vec3f(l)) * k; }
  return v;
}
fn sample3d(base: u32, c: vec3f) -> vec3f {
  let n = data[base];
  let nf = f32(n - 1u);
  let fx = clamp01(c.r) * nf; let fy = clamp01(c.g) * nf; let fz = clamp01(c.b) * nf;
  let x0 = min(n - 2u, u32(fx)); let y0 = min(n - 2u, u32(fy)); let z0 = min(n - 2u, u32(fz));
  let tx = fx - f32(x0); let ty = fy - f32(y0); let tz = fz - f32(z0);
  var out = vec3f(0.0);
  for (var ch = 0u; ch < 3u; ch++) {
    let i000 = ((z0 * n + y0) * n + x0) * 3u + ch;
    let c000 = df(base + 1u + i000); let c100 = df(base + 1u + i000 + 3u);
    let i010 = ((z0 * n + y0 + 1u) * n + x0) * 3u + ch;
    let c010 = df(base + 1u + i010); let c110 = df(base + 1u + i010 + 3u);
    let i001 = (((z0 + 1u) * n + y0) * n + x0) * 3u + ch;
    let c001 = df(base + 1u + i001); let c101 = df(base + 1u + i001 + 3u);
    let i011 = (((z0 + 1u) * n + y0 + 1u) * n + x0) * 3u + ch;
    let c011 = df(base + 1u + i011); let c111 = df(base + 1u + i011 + 3u);
    let c00 = c000 + (c100 - c000) * tx; let c10 = c010 + (c110 - c010) * tx;
    let c01 = c001 + (c101 - c001) * tx; let c11 = c011 + (c111 - c011) * tx;
    let a0 = c00 + (c10 - c00) * ty; let a1 = c01 + (c11 - c01) * ty;
    out[ch] = a0 + (a1 - a0) * tz;
  }
  return out;
}
`;

const ADJ_CASES: Record<number, string> = {
  // 32-bit Exposure on linear values, unclamped (apply.ts exposureLinearPixel).
  15: `    case 15u: { return pow(max(c * df(b) + vec3f(df(b + 1u)), vec3f(0.0)), vec3f(df(b + 2u))); }
`,
  1: `    case 1u: {
      return vec3f(lut(b, lut(b + 1024u, c.r)), lut(b, lut(b + 2048u, c.g)), lut(b, lut(b + 3072u, c.b)));
    }
`,
  2: `    case 2u: { return vec3f(lut(b, c.r), lut(b, c.g), lut(b, c.b)); }
`,
  3: `    case 3u: {
      // Vibrance: Photoshop's measured table (vibranceLut), then Saturation in linear light
      // around ProPhoto-weighted luminance (vibranceSaturation).
      let s = df(b);
      var o = c;
      if (df(b + 1u) > 0.5) { o = sample3d(b + 2u, c); }
      if (s != 0.0) {
        let x = clamp(o, vec3f(0.0), vec3f(1.0));
        let l = vec3f(srgbLin(x.r), srgbLin(x.g), srgbLin(x.b));
        let Y = 0.288 * l.r + 0.7119 * l.g + 0.0001 * l.b;
        let m = clamp(vec3f(Y) + (l - vec3f(Y)) * (1.0 + s), vec3f(0.0), vec3f(1.0));
        o = vec3f(linSrgb(m.r), linSrgb(m.g), linSrgb(m.b));
      }
      return o;
    }
`,
  4: `    case 4u: {
      if (df(b) > 0.5) {
        // Colorize: h, sat, light.
        var L = (max(c.r, max(c.g, c.b)) + min(c.r, min(c.g, c.b))) * 0.5;
        let light = df(b + 3u);
        if (light > 0.0) { L += (1.0 - L) * light; } else { L *= 1.0 + light; }
        return hslToRgb(vec3f(df(b + 1u), df(b + 2u), L));
      }
      var o = c;
      let nr = data[b + 7u];
      if (nr > 0u && max(o.r, max(o.g, o.b)) > min(o.r, min(o.g, o.b))) {
        // Colour ranges (as the CPU path): grays untouched; the saturation increase is summed as
        // boosts by weight.
        let h = rgbToHsl(o).x;
        var dh = 0.0; var ds = 0.0; var dl = 0.0; var boost = 0.0;
        for (var i = 0u; i < nr; i++) {
          let q = b + 8u + i * 7u;
          let w = hueWeight(h, vec4f(df(q + 3u), df(q + 4u), df(q + 5u), df(q + 6u)));
          if (w > 0.0) {
            dh += df(q) * w; dl += df(q + 2u) * w;
            let rs = df(q + 1u);
            if (rs < 0.0) { ds += rs * w; } else { boost += w * satBoost(rs); }
          }
        }
        if (dh != 0.0 || ds != 0.0 || dl != 0.0 || boost != 0.0) { o = applyHueSat(o, dh, ds, dl, boost, true); }
      }
      let mh = df(b + 4u); let ms = df(b + 5u); let ml = df(b + 6u);
      var mb = 0.0; if (ms > 0.0) { mb = satBoost(ms); }
      if (mh != 0.0 || ms != 0.0 || ml != 0.0) { o = applyHueSat(o, mh, ms, ml, mb, false); }
      return o;
    }
`,
  5: `    case 5u: {
      // Per-channel Levels tables (colorBalanceLUTs, which include Preserve Luminosity).
      return vec3f(lut(b + 4u, c.r), lut(b + 4u + 1024u, c.g), lut(b + 4u + 2048u, c.b));
    }
`,
  6: `    case 6u: {
      let r = c.r; let g = c.g; let bl = c.b;
      let mx = max(r, max(g, bl)); let mn = min(r, min(g, bl));
      let mid = r + g + bl - mx - mn;
      var primary: f32; var secondary: f32;
      // weights: reds, yellows, greens, cyans, blues, magentas
      if (mx == r) { primary = df(b); if (mn == bl) { secondary = df(b + 1u); } else { secondary = df(b + 5u); } }
      else if (mx == g) { primary = df(b + 2u); if (mn == bl) { secondary = df(b + 1u); } else { secondary = df(b + 3u); } }
      else { primary = df(b + 4u); if (mn == r) { secondary = df(b + 5u); } else { secondary = df(b + 3u); } }
      let gray = clamp01(mn + (mid - mn) * secondary + (mx - mid) * primary);
      if (df(b + 6u) > 0.5) { return setLuminanceA(vec3f(df(b + 7u), df(b + 8u), df(b + 9u)), gray); }
      return vec3f(gray);
    }
`,
  7: `    case 7u: {
      // Photo Filter: one matrix on linear sRGB (photoFilterMatrix), then Preserve Luminosity.
      let L0 = lum(c);
      let x = clamp(c, vec3f(0.0), vec3f(1.0));
      let l = vec3f(srgbLin(x.r), srgbLin(x.g), srgbLin(x.b));
      let m = vec3f(
        clamp01(df(b + 1u) * l.r + df(b + 2u) * l.g + df(b + 3u) * l.b),
        clamp01(df(b + 4u) * l.r + df(b + 5u) * l.g + df(b + 6u) * l.b),
        clamp01(df(b + 7u) * l.r + df(b + 8u) * l.g + df(b + 9u) * l.b));
      var o = vec3f(linSrgb(m.r), linSrgb(m.g), linSrgb(m.b));
      if (df(b) > 0.5) { o = setLuminanceA(o, L0); }
      return o;
    }
`,
  8: `    case 8u: {
      let r = c.r; let g = c.g; let bl = c.b;
      if (df(b) > 0.5) {
        let v = clamp01(r * df(b + 13u) + g * df(b + 14u) + bl * df(b + 15u) + df(b + 16u));
        return vec3f(v);
      }
      return vec3f(
        clamp01(r * df(b + 1u) + g * df(b + 2u) + bl * df(b + 3u) + df(b + 4u)),
        clamp01(r * df(b + 5u) + g * df(b + 6u) + bl * df(b + 7u) + df(b + 8u)),
        clamp01(r * df(b + 9u) + g * df(b + 10u) + bl * df(b + 11u) + df(b + 12u)));
    }
`,
  9: `    case 9u: { return sample3d(b, c); }
`,
  10: `    case 10u: { return vec3f(1.0) - c; }
`,
  11: `    case 11u: { let n = df(b); let lv = min(vec3f(n - 1.0), floor((max(c, vec3f(0.0)) * 255.0 + vec3f(1e-4)) * n / 256.0)); return floor(lv * 255.0 / (n - 1.0) + vec3f(1e-6)) / 255.0; } // Photoshop's levels
`,
  12: `    case 12u: { var v = 0.0; if (lum(c) >= df(b)) { v = 1.0; } return vec3f(v); }
`,
  13: `    case 13u: {
      let i = u32(floor(clamp01(lum(c)) * 1023.0 + 0.5)) * 4u;
      return vec3f(df(b + i), df(b + i + 1u), df(b + i + 2u));
    }
`,
  14: `    case 14u: {
      let rel = df(b) > 0.5;
      let r = c.r; let g = c.g; let bl = c.b;
      let mx = max(r, max(g, bl)); let mn = min(r, min(g, bl)); let mid = r + g + bl - mx - mn;
      // colours: reds yellows greens cyans blues magentas whites neutrals blacks (c m y k each)
      var w = array<f32, 9>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
      if (mx == r && mx > mid) { w[0] = mx - mid; }
      if (mx == g && mx > mid) { w[2] = mx - mid; }
      if (mx == bl && mx > mid) { w[4] = mx - mid; }
      if (mn == bl && mid > mn) { w[1] = mid - mn; }
      if (mn == r && mid > mn) { w[3] = mid - mn; }
      if (mn == g && mid > mn) { w[5] = mid - mn; }
      if (mn > 0.5) { w[6] = (mn - 0.5) * 2.0; }
      if (mx < 0.5) { w[8] = (0.5 - mx) * 2.0; }
      w[7] = clamp01(1.0 - (abs(mx - 0.5) + abs(mn - 0.5)));
      // Each range's change in full, clipped, then blended by its weight (as the CPU path).
      let v = vec3f(r, g, bl);
      var o = v;
      for (var k = 0u; k < 9u; k++) {
        if (w[k] <= 0.0) { continue; }
        let q = b + 1u + k * 4u;
        let kk = df(q + 3u);
        for (var i = 0u; i < 3u; i++) {
          let a = df(q + i);
          var base = 1.0; if (rel) { base = 1.0 - v[i]; }
          let d = ((-1.0 - a) * kk - a) * base;
          o[i] += w[k] * (clamp01(v[i] + d) - v[i]);
        }
      }
      return vec3f(clamp01(o.r), clamp01(o.g), clamp01(o.b));
    }
`,
};

/** adjCore restricted to some adjustment codes (smaller shaders per pipeline). */
function adjCoreFor(codes: number[]): string {
  return `fn adjCore(code: u32, b: u32, c: vec3f) -> vec3f {
  switch code {
${codes.map((k) => ADJ_CASES[k]).join('')}    default: { return c; }
  }
}
`;
}

const ADJ_WRAP = /* wgsl */ `
/** docAdjustmentPixel: wrappers for the CMYK black plate and Lab documents. */
fn adjPixel(c: vec3f) -> vec3f {
  let code = p.adjCode; let b = p.adjBase;
  switch p.adjWrap {
    case 1u: { let o = adjCore(code, b, c); return vec3f(o.r, o.r, o.r); }
    case 2u: { let o = adjCore(code, b, vec3f(c.r)); return vec3f(o.r, c.g, c.b); }
    case 3u: { let o = adjCore(code, b, vec3f(c.r)); return vec3f(o.r, 128.0 / 255.0, 128.0 / 255.0); }
    case 4u: { return srgbToLabE(adjCore(code, b, labEToSrgb(c))); }
    default: { return adjCore(code, b, c); }
  }
}
`;

const BLENDIF = /* wgsl */ `
fn biFactor(q: u32, v: f32) -> f32 {
  let b0 = df(q); let b1 = df(q + 1u); let w0 = df(q + 2u); let w1 = df(q + 3u);
  if (v < b0 || v > w1) { return 0.0; }
  if (v < b1) { if (b1 > b0) { return (v - b0) / (b1 - b0); } return 1.0; }
  if (v > w0) { if (w1 > w0) { return (w1 - v) / (w1 - w0); } return 1.0; }
  return 1.0;
}
/** Blend If factor for straight source s over premultiplied under u (layout: 4 × [thisOn, underOn, this[4], under[4]]). */
fn blendIfFactor(s: vec4f, u: vec4f) -> f32 {
  var f = 1.0;
  let sv = vec4f(0.3 * s.r * 255.0 + 0.59 * s.g * 255.0 + 0.11 * s.b * 255.0, s.r * 255.0, s.g * 255.0, s.b * 255.0);
  for (var c = 0u; c < 4u; c++) {
    let q = p.biBase + c * 10u;
    if (df(q) > 0.5 && f > 0.0) { f *= biFactor(q + 2u, sv[c]); }
  }
  if (f > 0.0) {
    var k = 0.0; if (u.a > 1e-6) { k = 255.0 / u.a; }
    let r = u.r * k; let g = u.g * k; let b = u.b * k;
    let uv = vec4f(0.3 * r + 0.59 * g + 0.11 * b, r, g, b);
    for (var c = 0u; c < 4u; c++) {
      let q = p.biBase + c * 10u;
      if (df(q + 1u) > 0.5 && f > 0.0) { f *= biFactor(q + 6u, uv[c]); }
    }
  }
  return f;
}
`;

const MAIN = /* wgsl */ `
fn coverage(x: u32, y: u32) -> f32 {
  if (p.cov == 0xFFFFFFFFu) { return 1.0; }
  let layer = p.cov & 0xFFFFFFu;
  if ((p.cov >> 24u) == 0u) { return textureLoad(atlasCovA, vec2u(x, y), layer, 0).r; }
  return textureLoad(atlasCovB, vec2u(x, y), layer, 0).r;
}
fn atlasSample(x: u32, y: u32) -> vec4f {
  let sx = p.rx0 + i32(x); let sy = p.ry0 + i32(y);
  let tx = i32(floor(f32(sx) / 256.0)); let ty = i32(floor(f32(sy) / 256.0));
  let gx = tx - p.gx0; let gy = ty - p.gy0;
  if (gx < 0 || gy < 0 || gx >= i32(p.gw) || gy >= i32(p.gh)) { return vec4f(0.0); }
  let slot = data[p.grid + u32(gy) * p.gw + u32(gx)];
  if (slot == 0xFFFFFFFFu) { return vec4f(0.0); }
  let lx = u32(sx - tx * 256); let ly = u32(sy - ty * 256);
  let atlas = slot >> 24u; let layer = slot & 0xFFFFFFu;
  let q = vec2u(lx, ly);
  switch atlas {
    case 0u: { return textureLoad(atlas8a, q, layer, 0); }
    case 1u: { return textureLoad(atlas8b, q, layer, 0); }
    case 2u: { return textureLoad(atlas8c, q, layer, 0); }
    case 3u: { return vec4f(textureLoad(atlas16a, q, layer, 0)) / 65535.0; }
    case 4u: { return vec4f(textureLoad(atlas16b, q, layer, 0)) / 65535.0; }
    default: { return textureLoad(atlas32, q, layer, 0); }
  }
}
/** The (straight, masked) source pixel. */
fn source(x: u32, y: u32, i: u32) -> vec4f {
  var s: vec4f;
  switch p.src {
    case 1u: { s = atlasSample(x, y); }
    case 2u: { s = p.solid; }
    case 3u: { s = srcBuf[p.srcOff + y * p.srcW + x]; }
    case 4u: {
      s = srcBuf[p.srcOff + y * p.srcW + x];
      let a = s.a;
      var th = 0.0; if ((p.flags & 4u) != 0u) { th = 1e-7; }
      if (a > th) { s = vec4f(s.rgb / a, a); } else if ((p.flags & 4u) == 0u) { s = vec4f(0.0); }
    }
    default: { s = vec4f(0.0); }
  }
  s.a *= coverage(x, y);
  return s;
}
fn under(i: u32) -> vec4f { if ((p.flags & 2u) != 0u) { return dst[i]; } return underBuf[i]; }

`;

const LABPRE = /* wgsl */ `
fn toRgbPre(v: vec4f) -> vec4f { if (v.a <= 0.0) { return v; } return vec4f(labEToSrgb(v.rgb / v.a) * v.a, v.a); }
fn toLabPre(v: vec4f) -> vec4f { if (v.a <= 0.0) { return v; } return vec4f(srgbToLabE(v.rgb / v.a) * v.a, v.a); }
`;

const MISC_MAIN = /* wgsl */ `
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let x = id.x; let y = id.y;
  if (x >= p.w || y >= p.h) { return; }
  let i = y * p.w + x;
  switch p.kind {
    case 0u: { dst[i] = vec4f(0.0); }
    case 1u: { dst[i] = srcBuf[i]; }
    case 5u: {
      let k = p.opacity * coverage(x, y);
      if (k > 0.0) { let d = dst[i]; dst[i] = d + (srcBuf[i] - d) * k; }
    }
    case 6u: {
      let before = srcBuf[i];
      var after = dst[i];
      let ba = before.a;
      let on = vec3<bool>((p.chan & 1u) != 0u, (p.chan & 2u) != 0u, (p.chan & 4u) != 0u);
      var keep = vec3f(0.0);
      if (ba > 1e-7) { keep = (before.rgb / ba) * after.a; }
      after = vec4f(select(keep, after.rgb, on), after.a);
      dst[i] = after;
    }
    default: {}
  }
}
`;

const ADJUST_MAIN = /* wgsl */ `
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let x = id.x; let y = id.y;
  if (x >= p.w || y >= p.h) { return; }
  let i = y * p.w + x;
  // applyAdjustedSpan (Lab non-Normal modes evaluate the blend in RGB).
  var d = dst[i];
  let ab0 = d.a;
  if (ab0 <= 0.0) { return; }
  var adj = adjPixel(d.rgb / ab0);
  let lab = (p.flags & 1u) != 0u;
  if (lab) { d = toRgbPre(d); adj = labEToSrgb(adj); }
  let ab = d.a;
  let k = p.opacity * coverage(x, y);
  if (k > 0.0) {
    let br = d.rgb / ab;
    var rr = adj;
    if (p.mode > 1u) { rr = blendRGB(p.mode, br, adj); }
    d = vec4f((br + (rr - br) * k) * ab, ab);
  }
  if (lab) { d = toLabPre(d); }
  dst[i] = d;
}
`;

const SPAN_MAIN = /* wgsl */ `
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let x = id.x; let y = id.y;
  if (x >= p.w || y >= p.h) { return; }
  let i = y * p.w + x;
  // span / atop
  var s = source(x, y, i);
  let lab = (p.flags & 1u) != 0u;
  var d = dst[i];
  // Blend If reads the stored values (before a Lab document's RGB blend), as the CPU path does.
  if ((p.flags & 8u) != 0u && s.a > 0.0) { s.a *= blendIfFactor(s, under(i)); }
  if (lab) { d = toRgbPre(d); s = vec4f(labEToSrgb(s.rgb), s.a); }
  var sa = s.a * p.opacity;
  // Fill opacity in the special modes (see blend.ts FILL_NEUTRAL): colours move toward the
  // mode's neutral colour; Hard Mix uses its own formula below.
  let special = p.fill < 1.0 && (p.mode == 4u || p.mode == 5u || p.mode == 9u || p.mode == 10u || p.mode == 15u || p.mode == 16u || p.mode == 19u);
  if (special) {
    var nk = 0.0;
    if (p.mode == 4u || p.mode == 5u) { nk = 1.0; } else if (p.mode == 15u || p.mode == 16u) { nk = 0.5; }
    s = vec4f(s.rgb * p.fill + vec3f(nk * (1.0 - p.fill)), s.a);
  }
  if (sa > 0.0) {
    let ab = d.a;
    if (p.kind == 3u) {
      if (ab > 0.0) {
        let br = d.rgb / ab;
        var rr = s.rgb;
        if (p.mode > 1u) { rr = blendX(p.mode, br, s.rgb); }
        let k = 1.0 - sa;
        d = vec4f(sa * ab * rr + k * d.rgb, d.a);
      }
    } else {
      var write = true;
      if (p.mode == 1u) {
        if (dissolveNoise(p.x0 + i32(x), p.y0 + i32(y)) >= sa) { write = false; }
        sa = 1.0;
      }
      if (write) {
        if (p.mode <= 1u || ab <= 0.0) {
          let k = 1.0 - sa;
          d = vec4f(s.rgb * sa + d.rgb * k, sa + ab * k);
        } else {
          let br = d.rgb / ab;
          let rr = blendX(p.mode, br, s.rgb);
          let k1 = sa * (1.0 - ab); let k2 = sa * ab; let k3 = 1.0 - sa;
          d = vec4f(k1 * s.rgb + k2 * rr + k3 * d.rgb, sa + ab * k3);
        }
      }
    }
  }
  if (lab) { d = toLabPre(d); }
  dst[i] = d;
}
`;


/**
 * Live-preview filters (Gaussian Blur, Box Blur, Unsharp Mask): the same arithmetic as
 * image-engine/blur.ts and filters/builtin.ts on padded preview regions. Entry points:
 * gather, blurH, blurV, straighten, unsharp, crop, selmix.
 */
const FILTER_MAIN = /* wgsl */ `
fn clampX(x: i32) -> u32 { return u32(clamp(x, 0, i32(p.w) - 1)); }
fn clampY(y: i32) -> u32 { return u32(clamp(y, 0, i32(p.h) - 1)); }

@compute @workgroup_size(16, 16)
fn gather(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  var s = atlasSample(id.x, id.y);
  if ((p.flags & 16u) != 0u) { s = vec4f(s.rgb * s.a, s.a); }
  dst[id.y * p.w + id.x] = s;
}
fn tap(i: i32) -> f32 { return df(p.adjBase + u32(i)); }
@compute @workgroup_size(16, 16)
fn blurH(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let r = i32(p.chan);
  var acc = vec4f(0.0);
  let row = id.y * p.w;
  if (p.mode == 0u) {
    for (var i = -r; i <= r; i++) { acc += srcBuf[row + clampX(i32(id.x) + i)] * tap(i + r); }
  } else {
    for (var i = -r; i <= r; i++) { acc += srcBuf[row + clampX(i32(id.x) + i)]; }
    acc = acc / f32(2 * r + 1);
  }
  dst[row + id.x] = acc;
}
@compute @workgroup_size(16, 16)
fn blurV(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let r = i32(p.chan);
  var acc = vec4f(0.0);
  if (p.mode == 0u) {
    for (var i = -r; i <= r; i++) { acc += srcBuf[clampY(i32(id.y) + i) * p.w + id.x] * tap(i + r); }
  } else {
    for (var i = -r; i <= r; i++) { acc += srcBuf[clampY(i32(id.y) + i) * p.w + id.x]; }
    acc = acc / f32(2 * r + 1);
  }
  dst[id.y * p.w + id.x] = acc;
}
/** toStraight (filters/runner.ts). */
@compute @workgroup_size(16, 16)
fn straighten(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let i = id.y * p.w + id.x;
  let c = dst[i];
  if (c.a > 1e-7) { dst[i] = vec4f(min(vec3f(1.0), c.rgb / c.a), c.a); } else { dst[i] = vec4f(0.0, 0.0, 0.0, c.a); }
}
/** unsharp(): dst = src (original) + (src − under (blurred)) · amount where |d| ≥ threshold. */
@compute @workgroup_size(16, 16)
fn unsharp(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let i = id.y * p.w + id.x;
  let o = srcBuf[i]; let b = underBuf[i];
  var out = o;
  for (var c = 0u; c < 3u; c++) {
    let d = o[c] - b[c];
    if (abs(d) * 255.0 < p.solid.x * 255.0) { continue; }
    out[c] = clamp01(o[c] + d * p.opacity);
  }
  dst[i] = out;
}
@compute @workgroup_size(16, 16)
fn crop(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  dst[id.y * p.w + id.x] = srcBuf[p.srcOff + id.y * p.srcW + id.x];
}
/** Selection: filtered = original + (filtered − original) · selection (all four channels). */
@compute @workgroup_size(16, 16)
fn selmix(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let i = id.y * p.w + id.x;
  let o = srcBuf[i];
  dst[i] = o + (dst[i] - o) * coverage(id.x, id.y);
}
`;

/** Three pipelines (smaller shaders compile on every D3D12 shader compiler and run faster). */
export const WGSL_MODULES = {
  misc: COMMON + MAIN + MISC_MAIN,
  /** Adjustments in four groups, each compiled on first use. */
  adjustLut: COMMON + BLEND + LAB + ADJUST + adjCoreFor([1, 2, 10, 11, 12, 13, 15]) + ADJ_WRAP + MAIN + LABPRE + ADJUST_MAIN,
  adjustColor: COMMON + BLEND + LAB + ADJUST + adjCoreFor([3, 5, 6, 7, 8, 14]) + ADJ_WRAP + MAIN + LABPRE + ADJUST_MAIN,
  adjustHue: COMMON + BLEND + LAB + ADJUST + adjCoreFor([4]) + ADJ_WRAP + MAIN + LABPRE + ADJUST_MAIN,
  adjustLut3d: COMMON + BLEND + LAB + ADJUST + adjCoreFor([9]) + ADJ_WRAP + MAIN + LABPRE + ADJUST_MAIN,
  span: COMMON + BLEND + LAB + BLENDIF + MAIN + LABPRE + SPAN_MAIN,
  filter: COMMON + MAIN + FILTER_MAIN,
};
/** Which pipeline runs an operation kind. */
export const PIPELINE_OF: Record<number, keyof typeof WGSL_MODULES> = { 0: 'misc', 1: 'misc', 5: 'misc', 6: 'misc', 2: 'span', 3: 'span' };
/** The adjustment pipeline for an adjustment code. */
export function adjustPipeline(code: number): keyof typeof WGSL_MODULES {
  return code === 4 ? 'adjustHue' : code === 9 ? 'adjustLut3d' : [3, 5, 6, 7, 8, 14].includes(code) ? 'adjustColor' : 'adjustLut';
}


/**
 * Display output: premultiplied composite → straight RGBA8 tile texture. Mode 0 = stored values
 * (RGB / Gray / Lab), 1 = linear 32-bit (encoded to sRGB), 2 = CMYK plates through the 4D display
 * LUT (ink quantised to 8 bits as the CPU path does), 3 = CMYK without a profile (device formula).
 */
export const OUTPUT_WGSL = /* wgsl */ `
struct O { w: u32, h: u32, mode: u32, n: u32 };
@group(0) @binding(0) var<storage, read> p0: array<vec4f>;
@group(0) @binding(1) var<storage, read> p1: array<vec4f>;
@group(0) @binding(2) var<uniform> o: O;
@group(0) @binding(3) var outTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var lut4: texture_3d<f32>;

fn linSrgb(v: f32) -> f32 { if (v <= 0.0031308) { return v * 12.92; } return 1.055 * pow(v, 1.0 / 2.4) - 0.055; }
fn q8(v: f32) -> f32 { return floor(clamp(v, 0.0, 1.0) * 255.0 + 0.5) / 255.0; }

fn L4(i: vec3u, k: u32) -> vec3f { return textureLoad(lut4, vec3u(i.x, i.y, i.z + k * o.n), 0).rgb; }
/** Tetrahedral interpolation over C M Y in one K slice (as LittleCMS evaluates CMYK grids). */
fn tetra(i0: vec3u, t: vec3f, k: u32) -> vec3f {
  let c000 = L4(i0, k);
  let c111 = L4(i0 + vec3u(1u), k);
  if (t.x >= t.y) {
    if (t.y >= t.z) { let c1 = L4(i0 + vec3u(1u, 0u, 0u), k); let c2 = L4(i0 + vec3u(1u, 1u, 0u), k); return c000 + t.x * (c1 - c000) + t.y * (c2 - c1) + t.z * (c111 - c2); }
    if (t.x >= t.z) { let c1 = L4(i0 + vec3u(1u, 0u, 0u), k); let c2 = L4(i0 + vec3u(1u, 0u, 1u), k); return c000 + t.x * (c1 - c000) + t.z * (c2 - c1) + t.y * (c111 - c2); }
    let c1 = L4(i0 + vec3u(0u, 0u, 1u), k); let c2 = L4(i0 + vec3u(1u, 0u, 1u), k); return c000 + t.z * (c1 - c000) + t.x * (c2 - c1) + t.y * (c111 - c2);
  }
  if (t.z >= t.y) { let c1 = L4(i0 + vec3u(0u, 0u, 1u), k); let c2 = L4(i0 + vec3u(0u, 1u, 1u), k); return c000 + t.z * (c1 - c000) + t.y * (c2 - c1) + t.x * (c111 - c2); }
  if (t.z >= t.x) { let c1 = L4(i0 + vec3u(0u, 1u, 0u), k); let c2 = L4(i0 + vec3u(0u, 1u, 1u), k); return c000 + t.y * (c1 - c000) + t.z * (c2 - c1) + t.x * (c111 - c2); }
  let c1 = L4(i0 + vec3u(0u, 1u, 0u), k); let c2 = L4(i0 + vec3u(1u, 1u, 0u), k); return c000 + t.y * (c1 - c000) + t.x * (c2 - c1) + t.z * (c111 - c2);
}
/** CMYK ink bytes → RGB through the n⁴ grid (C fastest, then M; Y and K share the depth axis). */
fn cmykLut(ink: vec4f) -> vec3f {
  let n = o.n;
  let f = ink / 255.0 * f32(n - 1u);
  let i0 = vec4u(min(vec4f(f32(n - 2u)), floor(f)));
  let t = f - vec4f(i0);
  let a = tetra(i0.xyz, t.xyz, i0.w);
  let b = tetra(i0.xyz, t.xyz, i0.w + 1u);
  return a + (b - a) * t.w;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= o.w || id.y >= o.h) { return; }
  let i = id.y * o.w + id.x;
  let c = p0[i];
  let a = c.a;
  var rgb = vec3f(0.0);
  if (o.mode >= 2u) {
    if (a > 1e-6) {
      let k1 = p1[i];
      var kk = 0.0; if (k1.a > 1e-6) { kk = k1.r / k1.a; }
      // Ink bytes as in cmykToDisplay: (1 − value) · 255 + 0.5, truncated.
      let ink = floor(vec4f(1.0 - c.rgb / a, 1.0 - kk) * 255.0 + 0.5);
      if (o.mode == 2u) { rgb = cmykLut(clamp(ink, vec4f(0.0), vec4f(255.0))); }
      else {
        let k = 1.0 - ink.w / 255.0;
        rgb = floor((vec3f(255.0) - ink.xyz) * k) / 255.0;
      }
      rgb = vec3f(q8(rgb.r), q8(rgb.g), q8(rgb.b));
    }
  } else if (a > 1e-6) {
    rgb = c.rgb / a;
    if (o.mode == 1u) { rgb = vec3f(linSrgb(max(0.0, rgb.r)), linSrgb(max(0.0, rgb.g)), linSrgb(max(0.0, rgb.b))); }
  }
  var alpha = a;
  if (a <= 1e-6) { alpha = 0.0; rgb = vec3f(0.0); }
  textureStore(outTex, vec2u(id.x, id.y), vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), clamp(alpha, 0.0, 1.0)));
}
`;
