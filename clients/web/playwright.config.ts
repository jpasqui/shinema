import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: './tests/e2e/diagnostics-reporter.ts',
  outputDir: '.local/playback-results',
  use: {
    baseURL: 'http://127.0.0.1:4187',
    browserName: 'chromium',
    channel: 'chromium',
    serviceWorkers: 'block',
    viewport: { width: 1280, height: 900 },
    screenshot: { mode: 'only-on-failure', fullPage: false, timeout: 5000 },
    trace: 'off',
    video: 'off',
    launchOptions: { args: ['--mute-audio'] },
  },
  webServer: {
    command: 'node tests/e2e/serve.mjs',
    url: 'http://127.0.0.1:4187',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
