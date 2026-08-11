import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repository = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } })
  .process?.env?.PAGES_REPO;

export default defineConfig({
  base: repository ? `/${repository}/` : './',
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
  server: {
    watch: {
      // Aegisub 源码、native/（含 boost 17 万文件）不参与监听，避免拖垮 dev server
      ignored: ['**/Aegisub/**', '**/native/**', '**/test-results/**'],
    },
  },
});
