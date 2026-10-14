/** Generates the original application icon (build/icon.png, 512×512): a conic-gradient ring mark. */
import fs from 'node:fs';
import { encodePNG } from '../src/formats/codecs';
import { hsvToRgb } from '../src/color/convert';

const S = 512, px = new Uint8ClampedArray(S * S * 4);
const c = S / 2, rOuter = 236, rInner = 118, corner = 96;
for (let y = 0; y < S; y++)
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    // Rounded-square tile.
    const qx = Math.max(Math.abs(x + 0.5 - c) - (c - corner), 0), qy = Math.max(Math.abs(y + 0.5 - c) - (c - corner), 0);
    const tile = Math.min(1, Math.max(0, corner - Math.hypot(qx, qy) + 0.5));
    if (tile <= 0) continue;
    const dx = x + 0.5 - c, dy = y + 0.5 - c, d = Math.hypot(dx, dy);
    const ang = (Math.atan2(dy, dx) / (2 * Math.PI) + 1.08) % 1;
    const { r, g, b } = hsvToRgb({ h: ang * 360 + 210, s: 0.72, v: 1 });
    const ring = Math.min(1, Math.max(0, Math.min(rOuter - 40 - d, d - rInner) + 0.5));
    const bg = [0.09, 0.094, 0.106];
    const k = ring;
    px[i] = (bg[0] * (1 - k) + r * k) * 255;
    px[i + 1] = (bg[1] * (1 - k) + g * k) * 255;
    px[i + 2] = (bg[2] * (1 - k) + b * k) * 255;
    px[i + 3] = tile * 255;
  }
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/icon.png', encodePNG(S, S, px, 8));
console.log('Wrote build/icon.png');
