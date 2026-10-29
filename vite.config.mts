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
    const imports = new Set<string>();
    const visitImports = (fileName: string) => {
      const output = bundle[fileName];
      if (output?.type !== 'chunk') return;
      for (const imported of output.imports) {
        if (
          imported === 'webview.mjs' ||
          imports.has(imported) ||
          bundle[imported]?.type !== 'chunk'
        )
          continue;
        imports.add(imported);
        visitImports(imported);
      }
    };
    visitImports('webview.mjs');
    this.emitFile({
      type: 'asset',
      fileName: 'webview.imports.json',
      source: JSON.stringify([...imports].toSorted()),
    });
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
  // Independent E2E servers must not invalidate each other's optimized module URLs.
  cacheDir:
    mode === 'e2e'
      ? resolve(projectRoot, 'node_modules/.vite-e2e', process.env.VARRO_E2E_PORT ?? '4174')
      : undefined,
  plugins: [solid(), tailwindcss(), webviewAssetVersionPlugin],
  worker: { format: 'iife' },
  optimizeDeps: {
    // Workers are loaded after startup; discover their CJS dependencies before serving tests.
    entries: ['preview.html', 'e2e/harness/index.html', 'src/webview/lib/highlight-worker.ts'],
  },
  // Disabling HMR alone still lets Vite reload the page after a socket reconnect.
  server: mode === 'e2e' ? { hmr: false, ws: false, watch: null } : undefined,
  build: {
    outDir: resolve(projectRoot, 'dist/webview'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(projectRoot, 'src/webview/index.tsx'),
      output: {
        entryFileNames: 'webview.mjs',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'webview.[ext]',
        // Share diagram helpers without combining the lazy diagram renderers.
        codeSplitting: {
          groups: [
            {
              name: 'diagram-utils',
              test: /node_modules[\\/](?:d3(?:-|[\\/])|mermaid[\\/]dist[\\/]chunks[\\/]mermaid\.core[\\/]chunk-)/,
              includeDependenciesRecursively: false,
            },
            // Only the lazy agent-icon catalog query, so static status icons stay in their importer.
            ...['a-c', 'd-f', 'g-i', 'j-l', 'm-o', 'p-r', 's-u', 'v-z0-9'].map(
              (letters, index) => ({
                name: `agent-icons-${index}`,
                test: new RegExp(
                  `node_modules[/\\\\]iconoir[/\\\\]icons[/\\\\](?:regular|solid)[/\\\\][${letters}][^/\\\\]*\\.svg\\?raw&agent-icon$`
                ),
              })
            ),
          ],
        },
      },
    },
    minify: 'oxc',
    sourcemap: false,
    target: 'es2022',
    // Webviews run in the editor's Chromium. Older default targets lack :has(), so the CSS
    // minifier wrapped merged rules in :is(), which Chromium cannot index by class and which
    // raised their specificity above the authored rules that development builds serve.
    cssTarget: 'chrome120',
    chunkSizeWarningLimit: 2048,
  },
}));
