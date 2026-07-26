import { startIsolatedChromeFixture } from '../scripts/isolated-chrome-fixture.mjs';
import { bp, connect, disconnect } from './bp.js';

const USER_CHROME_OPT_IN = 'BROWSER_PILOT_TEST_USER_CHROME';

async function cleanup(fixture: Awaited<ReturnType<typeof startIsolatedChromeFixture>>, connected: boolean): Promise<void> {
  if (connected) {
    const result = disconnect();
    if (!result.ok) process.stderr.write(`[browser-pilot test] Broker shutdown failed: ${result.error ?? 'unknown error'}\n`);
  }
  await fixture.stop();
}

export default async function globalSetup(): Promise<void | (() => Promise<void>)> {
  if (process.env[USER_CHROME_OPT_IN] === '1') {
    process.stderr.write('[browser-pilot test] Explicit user-Chrome mode enabled; tests may modify open tabs.\n');
    const check = bp('snapshot --limit 1');
    if (check.ok) return;
    const result = connect();
    if (!result.ok) throw new Error(`bp connect failed: ${result.error}`);
    return;
  }

  const fixture = await startIsolatedChromeFixture('browser-pilot-playwright-');
  Object.assign(process.env, fixture.environment);
  let connected = false;
  try {
    const result = connect();
    if (!result.ok) throw new Error(`isolated bp connect failed: ${result.error}`);
    connected = true;

    const browsers = bp('browsers');
    const isolated = browsers.browsers?.find((candidate: { profile?: string }) => (
      candidate.profile === fixture.profile
    ));
    if (!isolated || isolated.remoteDebuggingState !== 'enabled') {
      throw new Error('Browser Pilot did not discover the isolated test profile');
    }
    process.stdout.write(`[browser-pilot test] isolated Chrome ready at ${fixture.profile}\n`);
  } catch (error) {
    await cleanup(fixture, connected);
    throw error;
  }

  return async () => cleanup(fixture, connected);
}
