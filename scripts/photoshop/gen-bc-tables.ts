/**
 * Generates src/adjustments/brightnessContrastTables.ts from Photoshop's renderings of the gray
 * ramp (0..255) through Brightness/Contrast (modern) at brightness −150..150 and contrast
 * −50..100 in steps of 10 (files written by cases-adjprobes.jsx, "bcsweep-*").
 *   node scripts/run-ts.mjs scripts/photoshop/gen-bc-tables.ts <folder with bcsweep-*.psd>
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseContainer, decodeMergedChannels } from '../../src/psd/container';

const dir = process.argv[2];
if (!dir) { console.error('usage: gen-bc-tables <folder>'); process.exit(2); }
const curve = (name: string): number[] => {
  const c = parseContainer(new Uint8Array(fs.readFileSync(path.join(dir, `${name}.psd`))));
  if (c.depth !== 8 || c.width !== 256) throw new Error(`${name}: expected an 8-bit 256-px ramp`);
  return Array.from(decodeMergedChannels(c)[0].subarray(0, 256));
};
const ident = Array.from({ length: 256 }, (_, i) => i);
const bright: number[][] = [], contrast: number[][] = [];
for (let b = -150; b <= 150; b += 10) bright.push(b === 0 ? ident : curve(`bcsweep-b${b}`));
for (let c = -50; c <= 100; c += 10) contrast.push(c === 0 ? ident : curve(`bcsweep-c${c}`));
const enc = (rows: number[][]) => rows.map((r) => `  '${Buffer.from(Uint8Array.from(r)).toString('base64')}',`).join('\n');
const out = `/**
 * Photoshop's Brightness/Contrast (modern) as measured curves: the 8-bit output for every input
 * level, from Photoshop 26.5 rendering a gray ramp at brightness −150..150 and contrast −50..100
 * in steps of 10 (scripts/photoshop/gen-bc-tables.ts). Brightness is applied first, then
 * contrast; values between the steps interpolate (within 1/255 of Photoshop at the values
 * checked). Generated file — do not edit.
 */
export const BRIGHTNESS_STEP = 10;
export const BRIGHTNESS_MIN = -150;
export const CONTRAST_MIN = -50;
/** base64 rows of 256 bytes, brightness −150, −140, …, 150. */
export const BRIGHTNESS_CURVES = [
${enc(bright)}
];
/** base64 rows of 256 bytes, contrast −50, −40, …, 100. */
export const CONTRAST_CURVES = [
${enc(contrast)}
];
`;
fs.writeFileSync('src/adjustments/brightnessContrastTables.ts', out);
console.log(`wrote ${bright.length} brightness and ${contrast.length} contrast curves`);
