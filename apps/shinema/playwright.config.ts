import { defineConfig, devices } from '@playwright/test';

// The exported web app (npm run export:web) against the mock server.
// PLAYWRIGHT_CHANNEL=msedge uses an installed browser instead of a download.
const channel = process.env.PLAYWRIGHT_CHANNEL;
const video = process.env.SHINEMA_MOCK_VIDEO ?? '';

export default defineConfig({
  testDir: 'e2e',
  timeout: 30000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    ...devices['Desktop Chrome'],
    ...(channel ? { channel } : {}),
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'tv',
      testIgnore: 'phone.spec.ts',
      use: { viewport: { width: 960, height: 540 } },
    },
    {
      name: 'desktop',
      testIgnore: 'phone.spec.ts',
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'phone',
      testMatch: 'phone.spec.ts',
      use: { ...devices['Pixel 7'], ...(channel ? { channel } : {}) },
    },
  ],
  webServer: [
    {
      command: 'node tests/mock-server.mjs 8791',
      port: 8791,
      env: { SHINEMA_MOCK_VIDEO: video },
      reuseExistingServer: false,
    },
    {
      command: 'node tests/mock-server.mjs 8792',
      port: 8792,
      env: { SHINEMA_MOCK_VIDEO: video, SHINEMA_MOCK_PAIRING: '1' },
      reuseExistingServer: false,
    },
  ],
});
