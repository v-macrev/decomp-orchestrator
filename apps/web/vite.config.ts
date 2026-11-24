// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwind()],
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } } },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1600 },
});
