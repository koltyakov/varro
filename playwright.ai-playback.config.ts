import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

const webServer = baseConfig.webServer;
if (!webServer || Array.isArray(webServer)) {
  throw new Error('Local playback requires the single web server from playwright.config.ts');
}

// defineConfig(base, overrides) concatenates web servers instead of replacing them.
export default defineConfig({
  ...baseConfig,
  testDir: './e2e/local',
  testMatch: 'session-playback.spec.ts',
  outputDir: './tmp/playwright-playback',
  retries: 0,
  workers: 1,
  use: {
    ...baseConfig.use,
    trace: 'retain-on-failure',
  },
  webServer: {
    ...webServer,
    reuseExistingServer: true,
  },
});
