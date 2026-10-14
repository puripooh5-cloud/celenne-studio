import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json' with { type: 'json' };

// Renderer build. The same bundle runs inside Electron and in a plain browser
// (browser mode is used for fast UI iteration and automated UI tests).
export default defineConfig({
  plugins: [react()],
  // Only the version is embedded (not the whole package.json).
  // CELENNE_VERSION: set by scripts/release/release.ts for test builds with another version number.
  define: { __APP_VERSION__: JSON.stringify(process.env.CELENNE_VERSION || pkg.version) },
  base: './',
  server: { port: 5183, strictPort: true },
  worker: { format: 'es' },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 4000,
  },
  optimizeDeps: { exclude: ['lcms-wasm'] },
});
