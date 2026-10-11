import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import solid from 'vite-plugin-solid';
import { configDefaults, defineConfig } from 'vitest/config';

const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8'));
const windowsNativeTest = 'src/extension/windows-process-inspector.integration.test.ts';
const backendTests = ['src/{extension,shared}/**/*.test.{ts,tsx}'];
const jsdomBackendTests = [
  'src/extension/about-view.test.ts',
  'src/extension/commands.test.ts',
  'src/extension/opencode-v2.integration.test.ts',
  // These legacy filesystem mocks depend on jsdom's builtin-module resolution.
  'src/extension/server.test.ts',
  'src/extension/sidebar-provider.export.test.ts',
  'src/shared/attention-contract.test.ts',
];

export default defineConfig({
  define: { __VARRO_VERSION__: JSON.stringify(version) },
  // hot: false keeps vite-plugin-solid from injecting the /@solid-refresh virtual
  // module, which vite-node cannot resolve as a file URL on Windows.
  plugins: [solid({ hot: false })],
  resolve: {
    alias: {
      vscode: resolve(import.meta.dirname, 'src/test/vscode.ts'),
    },
  },
  test: {
    pool: 'forks',
    // Leave CPU headroom for cold runtime imports and large jsdom fixtures.
    maxWorkers: Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2))),
    projects: [
      {
        extends: true,
        test: {
          name: 'backend',
          environment: 'node',
          include: backendTests,
          exclude: [...configDefaults.exclude, windowsNativeTest, ...jsdomBackendTests],
        },
      },
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          include: ['src/{webview,test}/**/*.test.{ts,tsx}', ...jsdomBackendTests],
          setupFiles: ['./vitest.setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'windows-native',
          environment: 'node',
          include: [windowsNativeTest],
          // PowerShell startup and Add-Type must not compete with parallel unit workers.
          // Keep the production five-second bound rather than relaxing it for CI.
          sequence: { groupOrder: 1 },
        },
      },
    ],
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
      // Kept within ~2 points of the measured numbers so an actual regression
      // fails CI. Raise these alongside coverage rather than leaving slack.
      thresholds: {
        statements: 86,
        branches: 78,
        functions: 89,
        lines: 89,
      },
    },
  },
});
