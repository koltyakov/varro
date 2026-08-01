import { resolve } from 'node:path';
import solid from 'vite-plugin-solid';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // hot: false keeps vite-plugin-solid from injecting the /@solid-refresh virtual
  // module, which vite-node cannot resolve as a file URL on Windows.
  plugins: [solid({ hot: false })],
  resolve: {
    alias: {
      vscode: resolve(import.meta.dirname, 'src/test/vscode.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    pool: 'forks',
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      reportsDirectory: './tmp/coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.{ts,tsx}',
        'src/**/*.test-support.{ts,tsx}',
        'src/test/**',
        'src/webview/perf/harness.ts',
      ],
      thresholds: {
        statements: 80,
        branches: 71,
        functions: 82,
        lines: 83,
      },
    },
  },
});
