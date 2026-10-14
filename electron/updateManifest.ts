/**
 * Signed release manifest (`celenne-update.json` + `celenne-update.json.sig`).
 *
 * Every release published by `scripts/release/release.ts` carries a small JSON manifest with the
 * SHA-512 of each download, signed with the project's Ed25519 release key. The app only installs
 * an update whose downloaded file matches a manifest signed by that key, so a compromised or
 * spoofed download server cannot push a different installer, signed with a code-signing
 * certificate or not. Pure Node code (no Electron) so it is unit-tested directly.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

export const MANIFEST_NAME = 'celenne-update.json';
export const SIGNATURE_NAME = `${MANIFEST_NAME}.sig`;
export const PRODUCT_ID = 'celenne-studio';

export interface ManifestFile {
  name: string;
  kind: 'setup' | 'portable' | 'store';
  sha512: string; // base64
  size: number;
}

export interface ReleaseManifest {
  product: string;
  version: string;
  released: string; // ISO date
  notes: string; // plain text, shown as text (never as HTML)
  files: ManifestFile[];
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Checks the signature and shape of a manifest. Throws with a readable reason on failure. */
export function verifyManifest(bytes: Uint8Array, signatureBase64: string, publicKeyPem: string): ReleaseManifest {
  const sig = Buffer.from(signatureBase64.trim(), 'base64');
  if (sig.length !== 64) throw new Error('Release signature is malformed');
  const key = crypto.createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Release key is not an Ed25519 key');
  if (!crypto.verify(null, bytes, key, sig)) throw new Error('Release manifest signature is not valid');
  let m: ReleaseManifest;
  try { m = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new Error('Release manifest is not valid JSON'); }
  if (m?.product !== PRODUCT_ID) throw new Error('Release manifest is for a different product');
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) throw new Error('Release manifest has no valid version');
  if (!Array.isArray(m.files) || !m.files.length) throw new Error('Release manifest lists no files');
  for (const f of m.files) {
    if (typeof f?.name !== 'string' || !/^[\w.-]+$/.test(f.name)) throw new Error('Release manifest has an invalid file name');
    if (typeof f.sha512 !== 'string' || Buffer.from(f.sha512, 'base64').length !== 64) throw new Error(`Release manifest has no valid SHA-512 for ${f.name}`);
    if (!Number.isSafeInteger(f.size) || f.size <= 0) throw new Error(`Release manifest has no valid size for ${f.name}`);
  }
  if (typeof m.notes !== 'string') m.notes = '';
  return m;
}

export function signManifest(bytes: Uint8Array, privateKeyPem: string): string {
  return crypto.sign(null, bytes, crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

export async function sha512OfFile(file: string): Promise<{ sha512: string; size: number }> {
  const h = crypto.createHash('sha512');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) { h.update(chunk as Buffer); size += (chunk as Buffer).length; }
  return { sha512: h.digest('base64'), size };
}

/** Confirms that a downloaded file is the one the manifest lists for `kind`. */
export async function fileMatchesManifest(file: string, m: ReleaseManifest, kind: ManifestFile['kind']): Promise<boolean> {
  const entry = m.files.find((f) => f.kind === kind);
  if (!entry) return false;
  const { sha512, size } = await sha512OfFile(file);
  return size === entry.size && sha512 === entry.sha512;
}

/** Numeric semver comparison (pre-release versions sort before the release). */
export function compareVersions(a: string, b: string): number {
  const [ma, pa = ''] = a.split('-', 2), [mb, pb = ''] = b.split('-', 2);
  const na = ma.split('.').map(Number), nb = mb.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) - (nb[i] ?? 0);
  if (pa === pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return pa < pb ? -1 : 1;
}

/**
 * The update feed must be HTTPS. Plain HTTP is accepted only for a loopback test server and only
 * in builds made with CELENNE_UPDATE_ALLOW_LOCAL=1.
 */
export function feedUrlProblem(url: string, allowLocal: boolean): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return 'The update address is not a valid URL'; }
  if (u.username || u.password) return 'The update address must not contain credentials';
  if (u.search || u.hash) return 'The update address must not contain a query or fragment';
  if (u.protocol === 'https:') return null;
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.protocol === 'http:' && loopback && allowLocal) return null;
  return 'The update address must use HTTPS';
}

export const joinUrl = (base: string, name: string) => `${base.replace(/\/+$/, '')}/${encodeURIComponent(name)}`;
