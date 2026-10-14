// Bundles the Electron main + preload processes with esbuild.
// Release settings (update address, release public key, error-report destination) come from
// celenne.release.json and the git-ignored celenne.release.local.json (your own values, which win),
// overridable with CELENNE_UPDATE_URL / CELENNE_REPORT_DSN /
// CELENNE_DOWNLOAD_PAGE / CELENNE_UPDATE_ALLOW_LOCAL=1, and are baked into the main bundle.
import { build } from 'esbuild';
import fs from 'node:fs';

const readCfg = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
const file = { ...readCfg('celenne.release.json'), ...readCfg('celenne.release.local.json') };
const keyFile = process.env.CELENNE_UPDATE_PUBLIC_KEY_FILE || file.updatePublicKeyFile || 'build/update-signing.pub.pem';
const config = {
  updateUrl: process.env.CELENNE_UPDATE_URL ?? file.updateUrl ?? '',
  updatePublicKey: fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : '',
  allowLocalUpdates: process.env.CELENNE_UPDATE_ALLOW_LOCAL === '1',
  reportDsn: process.env.CELENNE_REPORT_DSN ?? file.reportDsn ?? '',
  downloadPage: process.env.CELENNE_DOWNLOAD_PAGE ?? file.downloadPage ?? '',
};

const common = { bundle: true, platform: 'node', target: 'node22', external: ['electron'], sourcemap: true, format: 'cjs' };
await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs', define: { __CELENNE_BUILD__: JSON.stringify(config) } });
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' });
console.log('electron bundles written to dist-electron/');
console.log(`  updates: ${config.updateUrl && config.updatePublicKey ? config.updateUrl : 'off (no update address or release key)'}${config.allowLocalUpdates ? ' [local test build]' : ''}`);
let dsnHost = "";
try { dsnHost = config.reportDsn ? new URL(config.reportDsn).host : ""; } catch { dsnHost = "invalid DSN (ignored by the app)"; }
console.log(`  error reports: ${dsnHost || "kept on the computer (no destination)"}`);
