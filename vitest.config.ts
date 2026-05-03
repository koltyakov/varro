import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';
import { resolve } from 'path';

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      vscode: resolve(__dirname, 'src/test/vscode.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      reportsDirectory: './tmp/coverage',
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 75,
        lines: 75,
      },
    },
  },
});
