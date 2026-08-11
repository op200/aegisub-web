import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm preview --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  workers: 2,
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', channel: 'chrome', viewport: { width: 1440, height: 900 } } },
    { name: 'firefox', use: { browserName: 'firefox', viewport: { width: 1440, height: 900 }, trace: 'off' } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], channel: 'chrome' } },
  ],
});
