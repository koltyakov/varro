import tailwindcss from '@tailwindcss/vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import solid from 'vite-plugin-solid';
import { defineConfig } from 'vite';

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  optimizeDeps: {
    entries: ['preview.html', 'e2e/harness/index.html'],
  },
  build: {
    lib: {
      entry: resolve(projectRoot, 'src/webview/index.tsx'),
      name: 'varroWebview',
      formats: ['iife'],
      fileName: () => 'webview.js',
    },
    outDir: resolve(projectRoot, 'dist/webview'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        assetFileNames: 'webview.[ext]',
      },
    },
    minify: 'esbuild',
    sourcemap: false,
    target: 'es2022',
  },
});
