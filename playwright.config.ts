import { defineConfig, devices } from '@playwright/test';

const playback = process.env.VARRO_E2E_MODE === 'playback';
const raster = process.env.VARRO_E2E_MODE === 'raster';

export default defineConfig({
  testDir: playback ? './e2e/local' : './e2e/tests',
  testMatch: playback
    ? 'session-playback.spec.ts'
    : raster
      ? ['**/scroll-viewport-coverage.spec.ts', '**/diagnostics/viewport-raster.spec.ts']
      : undefined,
  testIgnore: raster ? [] : '**/diagnostics/**',
  grep: raster ? /native -720px|static native wheel raster diagnostic/ : undefined,
  metadata: { strictViewportRaster: raster },
  fullyParallel: true,
  workers: playback || raster ? 1 : 2,
  outputDir: playback
    ? './tmp/playwright-playback'
    : raster
      ? './tmp/viewport-raster-diagnostic'
      : './tmp/playwright',
  retries: !playback && !raster && process.env.CI ? 2 : 0,
  reporter: 'list',
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: playback ? 'retain-on-failure' : 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm exec vite -- --mode e2e --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174/e2e/harness/index.html',
    reuseExistingServer: playback,
    timeout: 120_000,
  },
});
