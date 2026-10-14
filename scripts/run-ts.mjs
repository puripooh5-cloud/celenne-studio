// Runs a TypeScript script by bundling it with esbuild (keeps scripts dependency-free).
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const entry = process.argv[2];
if (!entry) { console.error('usage: node scripts/run-ts.mjs <file.ts> [args]'); process.exit(1); }
const outDir = path.resolve('node_modules/.celenne-scripts');
fs.mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, path.basename(entry).replace(/\.ts$/, '.mjs'));
// Dependencies are bundled (some use extensionless deep imports Node ESM cannot resolve); WASM/native ones stay external.
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile, target: 'node22', external: ['lcms-wasm', 'electron', 'webgpu', 'harfbuzzjs', '*?url'], sourcemap: 'inline', logLevel: 'warning' });
process.argv.splice(2, 1);
await import(pathToFileURL(outfile).href);
