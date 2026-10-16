import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: 'list',
  outputDir: '.local/playback-results',
  use: {
    baseURL: 'http://127.0.0.1:4187',
    browserName: 'chromium',
    channel: 'chromium',
    serviceWorkers: 'block',
    launchOptions: { args: ['--mute-audio'] },
  },
  webServer: {
    command: 'node tests/e2e/serve.mjs',
    url: 'http://127.0.0.1:4187',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
