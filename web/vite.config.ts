import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => ({
  root,
  define: { __PUBLIC_REPLAY__: JSON.stringify(mode === 'public') },
  // Relative base: the built viewer works from any path (file server, GitHub Pages subfolder).
  base: './',
  build: { outDir: fileURLToPath(new URL('../dist/web', import.meta.url)), emptyOutDir: true, target: 'es2022' },
  server: {
    host: '127.0.0.1',
    port: 4173,
    // Live mode only: same-origin proxy to the local API, so no CORS surface is added to the API.
    proxy: { '/v1': { target: `http://127.0.0.1:${process.env.PRL_API_PORT ?? '4010'}`, changeOrigin: false } },
  },
  preview: { host: '127.0.0.1', port: 4173 },
}));
