import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';
import { resolve } from 'path';

export default defineConfig({
  // hot: false keeps vite-plugin-solid from injecting the /@solid-refresh virtual
  // module, which vite-node cannot resolve as a file URL on Windows.
  plugins: [solid({ hot: false })],
  resolve: {
    alias: {
      vscode: resolve(__dirname, 'src/test/vscode.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      reportsDirectory: './tmp/coverage',
      thresholds: {
        statements: 80,
        branches: 71,
        functions: 82,
        lines: 83,
      },
    },
  },
});
