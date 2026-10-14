/**
 * SVG export: shape layers become real vector paths (fill/stroke), all other visible content
 * is embedded as positioned PNG images, preserving layer order, opacity and blend modes.
 */
import type { CelenneDocument } from '../document/document';
import type { Layer, Paint } from '../document/types';
import { hasRaster } from '../document/types';
import type { VectorPath } from '../vector/types';
import { rasterContentBounds } from '../rendering/bounds';
import { encodePNG } from './codecs';
import { compositeRegion } from '../rendering/compositor';
import { fromFloat } from '../image-engine/pixels';

export function pathToSvgD(p: VectorPath): string {
  const parts: string[] = [];
  const f = (v: number) => Math.round(v * 1000) / 1000;
  for (const s of p.subpaths) {
    if (!s.knots.length) continue;
    const k = s.knots;
    parts.push(`M${f(k[0].x)} ${f(k[0].y)}`);
    const n = s.closed ? k.length : k.length - 1;
    for (let i = 0; i < n; i++) {
      const a = k[i], b = k[(i + 1) % k.length];
      parts.push(`C${f(a.outX)} ${f(a.outY)} ${f(b.inX)} ${f(b.inY)} ${f(b.x)} ${f(b.y)}`);
    }
    if (s.closed) parts.push('Z');
  }
  return parts.join(' ');
}

const css = (c: { r: number; g: number; b: number }) => `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
const BLEND_CSS: Record<string, string> = { multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', colorDodge: 'color-dodge', colorBurn: 'color-burn', hardLight: 'hard-light', softLight: 'soft-light', difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity' };

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return typeof btoa !== 'undefined' ? btoa(s) : Buffer.from(bytes).toString('base64');
}

function paintAttr(p: Paint, defs: string[], id: string): string {
  if (p.type === 'solid') return css(p.color);
  if (p.type === 'gradient') {
    const stops = p.gradient.colorStops.map((s) => `<stop offset="${s.location}" stop-color="${css(s.color)}"/>`).join('');
    const a = (p.angle * Math.PI) / 180;
    defs.push(`<linearGradient id="${id}" x1="${0.5 - Math.cos(a) / 2}" y1="${0.5 + Math.sin(a) / 2}" x2="${0.5 + Math.cos(a) / 2}" y2="${0.5 - Math.sin(a) / 2}">${stops}</linearGradient>`);
    return `url(#${id})`;
  }
  return 'none';
}

export function exportSVG(doc: CelenneDocument): Uint8Array {
  const defs: string[] = [];
  let gid = 0;
  const body = (layers: Layer[]): string => {
    const out: string[] = [];
    for (const l of layers) {
      if (!l.visible) continue;
      const style = `opacity:${l.opacity}${BLEND_CSS[l.blendMode] ? `;mix-blend-mode:${BLEND_CSS[l.blendMode]}` : ''}`;
      const name = l.name.replace(/[<>&"]/g, '');
      if (l.kind === 'group') {
        out.push(`<g id="${l.id}" data-name="${name}" style="${style}">${body(l.children)}</g>`);
      } else if (l.kind === 'shape' && !l.effects) {
        const fill = paintAttr(l.fill, defs, `g${gid++}`);
        const st = l.stroke.enabled ? ` stroke="${paintAttr(l.stroke.paint, defs, `g${gid++}`)}" stroke-width="${l.stroke.width}" stroke-linecap="${l.stroke.cap}" stroke-linejoin="${l.stroke.join}"${l.stroke.dash.length ? ` stroke-dasharray="${l.stroke.dash.join(' ')}"` : ''}` : '';
        out.push(`<path data-name="${name}" d="${pathToSvgD(l.path)}" fill="${fill}" fill-rule="${l.path.fillRule}"${st} style="${style}"/>`);
      } else {
        // Adjustment layers have no standalone appearance in SVG.
        if (l.kind === 'adjustment') continue;
        const b = hasRaster(l) ? rasterContentBounds(l.raster) : doc.bounds;
        if (!b) continue;
        const r = hasRaster(l) ? { x: b.x + l.x, y: b.y + l.y, w: b.w, h: b.h } : b;
        const buf = compositeRegion(doc, r, { level: 0, root: { ...doc.root, children: [l] } as never });
        for (let i = 0; i < r.w * r.h; i++) {
          const a = buf[i * 4 + 3];
          if (a > 0) { buf[i * 4] /= a; buf[i * 4 + 1] /= a; buf[i * 4 + 2] /= a; }
        }
        const px = new Uint8ClampedArray(buf.length);
        fromFloat(buf, px);
        const png = encodePNG(r.w, r.h, px, 8);
        out.push(`<image data-name="${name}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" style="opacity:1" href="data:image/png;base64,${b64(png)}"/>`);
      }
    }
    return out.join('\n');
  };
  const content = body(doc.root.children);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${doc.width}" height="${doc.height}" viewBox="0 0 ${doc.width} ${doc.height}">\n<defs>${defs.join('')}</defs>\n${content}\n</svg>\n`;
  return new TextEncoder().encode(svg);
}
