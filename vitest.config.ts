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
      thresholds: {
        statements: 55,
        branches: 45,
        functions: 58,
        lines: 58,
      },
    },
  },
});
