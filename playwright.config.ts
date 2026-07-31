import { defineConfig } from '@playwright/test';
import { createServer } from 'node:net';

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to allocate test server port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

const testServerPort = process.env.BROWSER_PILOT_TEST_SERVER_PORT
  ? Number(process.env.BROWSER_PILOT_TEST_SERVER_PORT)
  : await allocatePort();
if (!Number.isInteger(testServerPort) || testServerPort <= 0) {
  throw new Error('BROWSER_PILOT_TEST_SERVER_PORT must be a positive integer');
}
process.env.BROWSER_PILOT_TEST_SERVER_PORT = String(testServerPort);
const testServerUrl = `http://127.0.0.1:${testServerPort}`;

export default defineConfig({
  testDir: './tests',
  // Individual CLI calls allow the Broker's 30s navigation watchdog to fire.
  timeout: 45_000,
  retries: 0,
  workers: 1, // bp uses a single browser session — must be serial
  globalSetup: './tests/global-setup.ts',
  use: {
    baseURL: testServerUrl,
  },
  webServer: {
    command: 'node tests/server.mjs',
    url: `${testServerUrl}/health`,
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
