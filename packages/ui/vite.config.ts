import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const protocolSrc = fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url));

/**
 * The UI is a pure client of the Celeste daemon.
 *
 * `VITE_CELESTE_API` points at the daemon (default http://127.0.0.1:9126).
 * When it is left relative ("/") the dev-server proxy below is used instead,
 * which keeps the browser on a single origin and avoids CORS entirely.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@celeste/protocol': protocolSrc,
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:9126',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:9126',
        ws: true,
      },
    },
  },
  preview: {
    port: 4173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
