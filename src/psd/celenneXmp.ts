/**
 * Celenne-only paragraph settings (Celenne's composer, optical margins) have no place in
 * Photoshop's text data, and an unknown layer block makes Photoshop ask to update text layers. They
 * are kept in the file's XMP metadata instead (Photoshop keeps XMP it does not know), per text
 * layer (by layer id) and paragraph run: <celenne:text> holds them as base64 JSON.
 */
import type { ParagraphStyle } from '../typography/types';

export type CelenneParagraphExtras = Pick<ParagraphStyle, 'composer' | 'opticalMargins'>;
/** Layer id → extras per paragraph run (null where a run has none). */
export type CelenneTextExtras = Record<number, (CelenneParagraphExtras | null)[]>;

const NS = 'https://celenne.app/ns/1.0/';
const ELEMENT = /<celenne:text>([A-Za-z0-9+/=]*)<\/celenne:text>/;
const MAX = 1 << 20;

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

/** Extras stored in an XMP packet, or {} (also for anything malformed). */
export function readCelenneText(xmp: string | undefined): CelenneTextExtras {
  const m = xmp && xmp.length < 64 * MAX ? ELEMENT.exec(xmp) : null;
  if (!m || m[1].length > MAX) return {};
  try {
    const v = JSON.parse(unb64(m[1])) as unknown;
    if (!v || typeof v !== 'object') return {};
    const out: CelenneTextExtras = {};
    for (const [k, runs] of Object.entries(v as Record<string, unknown>)) {
      const id = Number(k);
      if (!Number.isInteger(id) || !Array.isArray(runs) || runs.length > 10000) continue;
      out[id] = runs.map((r) => {
        if (!r || typeof r !== 'object') return null;
        const o = r as Record<string, unknown>;
        const e: CelenneParagraphExtras = {};
        if (o.composer === 'celenne') e.composer = 'celenne';
        if (o.opticalMargins === true) e.opticalMargins = true;
        return Object.keys(e).length ? e : null;
      });
    }
    return out;
  } catch {
    return {};
  }
}

/** The XMP packet with the extras written in (or removed when there are none). */
export function withCelenneText(xmp: string | undefined, extras: CelenneTextExtras): string | undefined {
  const has = Object.keys(extras).length > 0;
  const element = has ? `<celenne:text>${b64(JSON.stringify(extras))}</celenne:text>` : '';
  if (xmp && ELEMENT.test(xmp)) return xmp.replace(ELEMENT, element);
  if (!has) return xmp;
  const description = `<rdf:Description rdf:about="" xmlns:celenne="${NS}">${element}</rdf:Description>`;
  if (xmp && xmp.includes('</rdf:RDF>')) return xmp.replace('</rdf:RDF>', `${description}</rdf:RDF>`);
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${description}</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}

/** A paragraph style's Celenne-only settings, or null. */
export function extrasOf(p: ParagraphStyle): CelenneParagraphExtras | null {
  const e: CelenneParagraphExtras = {};
  if (p.composer === 'celenne') e.composer = 'celenne';
  if (p.opticalMargins) e.opticalMargins = true;
  return Object.keys(e).length ? e : null;
}
