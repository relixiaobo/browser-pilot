import { chromium } from 'playwright';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function chromeProfile(testHome) {
  if (process.platform === 'darwin') {
    return join(testHome, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (process.platform === 'win32') {
    return join(testHome, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  }
  return join(testHome, '.config', 'google-chrome');
}

async function waitForDevToolsPort(profile) {
  const portFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const [port, path] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
      const parsedPort = Number.parseInt(port, 10);
      if (Number.isSafeInteger(parsedPort) && parsedPort > 0 && path?.startsWith('/')) return;
    } catch { /* Chrome has not finished starting. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`isolated Chrome did not create ${portFile}`);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readBrokerPid(brokerHome) {
  for (const name of ['broker-locator.json', 'daemon.pid']) {
    try {
      const record = JSON.parse(await readFile(join(brokerHome, name), 'utf8'));
      const value = typeof record === 'number' ? record : record?.pid;
      if (Number.isSafeInteger(value) && value > 0) return value;
    } catch { /* Try the next owner-only metadata file. */ }
  }
  return undefined;
}

async function terminateTestBroker(brokerHome) {
  const pid = await readBrokerPid(brokerHome);
  if (!pid || pid === process.pid || !processAlive(pid)) return;
  process.kill(pid, 'SIGTERM');
  for (let attempt = 0; attempt < 50 && processAlive(pid); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (processAlive(pid)) process.kill(pid, 'SIGKILL');
}

export async function startIsolatedChromeFixture(prefix = 'browser-pilot-test-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const testHome = join(root, 'home');
  const brokerHome = join(root, 'broker');
  const profile = chromeProfile(testHome);
  const environment = {
    HOME: testHome,
    BROWSER_PILOT_HOME: brokerHome,
    BROWSER_PILOT_TEST_ROOT: root,
    ...(process.platform === 'win32' ? {
      USERPROFILE: testHome,
      LOCALAPPDATA: join(testHome, 'AppData', 'Local'),
    } : {}),
  };
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chrome',
      headless: true,
      args: ['--remote-debugging-port=0'],
    });
    await waitForDevToolsPort(profile);
  } catch (error) {
    await context?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  let stopped = false;
  return {
    root,
    brokerHome,
    profile,
    environment,
    async stop() {
      if (stopped) return;
      stopped = true;
      await terminateTestBroker(brokerHome);
      await context.close().catch(error => {
        process.stderr.write(`[browser-pilot test] Chrome shutdown failed: ${String(error)}\n`);
      });
      await rm(root, { recursive: true, force: true });
    },
  };
}
