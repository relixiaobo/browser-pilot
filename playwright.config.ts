import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 0,
  workers: 1, // bp uses a single browser session — must be serial
  globalSetup: './tests/global-setup.ts',
  globalTeardown: './tests/global-teardown.ts',
  use: {
    baseURL: 'http://127.0.0.1:18274',
  },
  webServer: {
    command: 'node tests/server.mjs 18274',
    port: 18274,
    reuseExistingServer: true,
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
