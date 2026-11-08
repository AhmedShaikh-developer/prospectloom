import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Specs share one app database and run in phase order.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'tests/.tmp/report' }]],
  use: {
    baseURL: 'http://127.0.0.1:4400',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  outputDir: 'tests/.tmp/results',
  webServer: [
    { command: 'node tests/mocks/mock-server.js', port: 4501, reuseExistingServer: false, timeout: 20_000 },
    { command: 'node --disable-warning=ExperimentalWarning tests/e2e-server.js', url: 'http://127.0.0.1:4400/api/meta', reuseExistingServer: false, timeout: 30_000 },
  ],
});
