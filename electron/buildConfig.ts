/**
 * Release settings baked into the main-process bundle by scripts/build-electron.mjs, from
 * celenne.release.json (overridable with environment variables). Empty values switch the matching
 * feature off: a build without an update address or release key never checks for updates, and a
 * build without a report destination keeps error reports on the computer.
 */
export interface BuildConfig {
  /** HTTPS folder holding latest.yml, the installers and the signed manifest. */
  updateUrl: string;
  /** Ed25519 public key (PEM) that release manifests must be signed with. */
  updatePublicKey: string;
  /** Test builds only: accept an http://127.0.0.1 update address. */
  allowLocalUpdates: boolean;
  /** Sentry / GlitchTip DSN for error reports. */
  reportDsn: string;
  /** Web page for manual downloads (shown to the portable build), optional. */
  downloadPage: string;
}

declare const __CELENNE_BUILD__: BuildConfig | undefined;

export const BUILD: BuildConfig = typeof __CELENNE_BUILD__ !== 'undefined' && __CELENNE_BUILD__
  ? __CELENNE_BUILD__
  : { updateUrl: '', updatePublicKey: '', allowLocalUpdates: false, reportDsn: '', downloadPage: '' };
