import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

const webServer = baseConfig.webServer;
if (!webServer || Array.isArray(webServer)) {
  throw new Error('Local playback requires the single web server from playwright.config.ts');
}

export default defineConfig(baseConfig, {
  testDir: './e2e/local',
  testMatch: 'session-playback.spec.ts',
  retries: 0,
  workers: 1,
  webServer: {
    ...webServer,
    reuseExistingServer: true,
  },
});
