import tailwindcss from '@tailwindcss/vite';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import solid from 'vite-plugin-solid';
import { defineConfig, type Plugin } from 'vite';

const projectRoot = dirname(fileURLToPath(import.meta.url));

const webviewAssetVersionPlugin: Plugin = {
  name: 'varro-webview-asset-version',
  generateBundle(_options, bundle) {
    const hash = createHash('sha256');
    for (const fileName of Object.keys(bundle).toSorted()) {
      const output = bundle[fileName]!;
      hash.update(fileName);
      hash.update(output.type === 'chunk' ? output.code : output.source);
    }
    this.emitFile({
      type: 'asset',
      fileName: 'webview.version',
      source: hash.digest('hex').slice(0, 16),
    });
  },
};

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [solid(), tailwindcss(), webviewAssetVersionPlugin],
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
        entryFileNames: 'webview.mjs',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'webview.[ext]',
      },
    },
    minify: 'oxc',
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 2048,
  },
}));
