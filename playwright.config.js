import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  timeout: 75_000,
  reporter: 'list',
  webServer: {
    command: 'node apps/server/src/index.js',
    env: { HOST: '127.0.0.1', PORT: '4031', DATA_DIR: 'test-results/server-data' },
    url: 'http://127.0.0.1:4031/api/health',
    reuseExistingServer: false,
  },
});
