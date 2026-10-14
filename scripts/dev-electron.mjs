// Starts the Vite dev server and launches Electron against it.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';

execSync('node scripts/build-electron.mjs', { stdio: 'inherit' });
const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = server.resolvedUrls.local[0];
const electronPath = (await import('electron')).default;
const child = spawn(electronPath, ['.'], { stdio: 'inherit', env: { ...process.env, CELENNE_DEV_SERVER_URL: url } });
child.on('exit', async (code) => { await server.close(); process.exit(code ?? 0); });
