import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Individual CLI calls allow the Broker's 30s navigation watchdog to fire.
  timeout: 45_000,
  retries: 0,
  workers: 1, // bp uses a single browser session — must be serial
  globalSetup: './tests/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:18274',
  },
  webServer: {
    command: 'node tests/server.mjs 18274',
    port: 18274,
    reuseExistingServer: false,
  },
  projects: [
    {
      name: 'core',
      testMatch: /core\.spec/,
    },
    {
      name: 'compat',
      testMatch: /fill|click|snapshot/,
    },
    {
      name: 'network',
      testMatch: /network\.spec/,
    },
    {
      name: 'integration',
      testMatch: /real-site\.spec/,
    },
  ],
});
