import { availableParallelism } from 'node:os';
import { defineConfig, devices } from '@playwright/test';

const playback = process.env.VARRO_E2E_MODE === 'playback';
const raster = process.env.VARRO_E2E_MODE === 'raster';
const port = process.env.VARRO_E2E_PORT ?? '4174';
const baseURL = `http://127.0.0.1:${port}`;

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
  // Leave CPU headroom for Chromium's frame-sensitive scroll and layout checks.
  workers:
    playback || raster
      ? 1
      : process.env.CI
        ? 2
        : Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2))),
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
    baseURL,
    trace: playback ? 'retain-on-failure' : 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npm exec vite -- --mode e2e --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${baseURL}/e2e/harness/index.html`,
    reuseExistingServer: playback,
    timeout: 120_000,
  },
});
