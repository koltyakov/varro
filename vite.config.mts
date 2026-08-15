import tailwindcss from '@tailwindcss/vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import solid from 'vite-plugin-solid';
import { defineConfig } from 'vite';

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [solid(), tailwindcss()],
  optimizeDeps: {
    entries: ['preview.html', 'e2e/harness/index.html'],
  },
  server: mode === 'e2e' ? { hmr: false, watch: null } : undefined,
  build: {
    outDir: resolve(projectRoot, 'dist/webview'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(projectRoot, 'src/webview/index.tsx'),
      output: {
        entryFileNames: 'webview.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'webview.[ext]',
      },
    },
    minify: 'oxc',
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
}));
