import tailwindcss from '@tailwindcss/vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import solid from 'vite-plugin-solid';
import { defineConfig } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/webview/index.tsx'),
      name: 'varroWebview',
      formats: ['iife'],
      fileName: () => 'webview.js',
    },
    outDir: resolve(__dirname, 'dist/webview'),
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
  define: {
    'process.env': {},
  },
});
