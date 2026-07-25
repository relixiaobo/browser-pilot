import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

async function firstExecutable(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch { /* Try the next installed Chrome candidate. */ }
  }
  return undefined;
}

function joinFrom(root, ...segments) {
  return root ? join(root, ...segments) : undefined;
}

async function chromeExecutable() {
  const override = process.env.BROWSER_PILOT_TEST_CHROME_EXECUTABLE;
  if (override) {
    const executable = await firstExecutable([override]);
    if (!executable) throw new Error(`BROWSER_PILOT_TEST_CHROME_EXECUTABLE is not executable: ${override}`);
    return executable;
  }

  if (process.platform === 'darwin') {
    const executable = await firstExecutable([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      joinFrom(process.env.HOME, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ]);
    if (executable) return executable;
  } else if (process.platform === 'win32') {
    const executable = await firstExecutable([
      joinFrom(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      joinFrom(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      joinFrom(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]);
    if (executable) return executable;
  } else {
    const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
    const executable = await firstExecutable(pathEntries.flatMap(directory => [
      join(directory, 'google-chrome'),
      join(directory, 'google-chrome-stable'),
    ]));
    if (executable) return executable;
  }

  throw new Error(
    'Google Chrome is required for isolated browser tests. ' +
    'Set BROWSER_PILOT_TEST_CHROME_EXECUTABLE to an installed Chrome executable.',
  );
}

function chromeProfile(testHome) {
  if (process.platform === 'darwin') {
    return join(testHome, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (process.platform === 'win32') {
    return join(testHome, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  }
  return join(testHome, '.config', 'google-chrome');
}

async function waitForDevToolsPort(profile, chrome) {
  const portFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (chrome.exitCode !== null || chrome.signalCode !== null) {
      throw new Error(`isolated Chrome exited before creating ${portFile}`);
    }
    try {
      const [port, path] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
      const parsedPort = Number.parseInt(port, 10);
      if (Number.isSafeInteger(parsedPort) && parsedPort > 0 && path?.startsWith('/')) return;
    } catch { /* Chrome has not finished starting. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`isolated Chrome did not create ${portFile}`);
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise(resolve => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForChildExit(child, 5_000)) return;
  child.kill('SIGKILL');
  await waitForChildExit(child, 1_000);
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
  let chrome;
  try {
    chrome = spawn(await chromeExecutable(), [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0
        ? ['--no-sandbox']
        : []),
      'about:blank',
    ], {
      // Chrome already has an explicit user-data-dir. Keep its real OS home;
      // the isolated HOME below is only for Browser Pilot discovery/state.
      env: process.env,
      stdio: 'ignore',
      windowsHide: true,
    });
    await waitForDevToolsPort(profile, chrome);
  } catch (error) {
    await terminateChild(chrome);
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
      await terminateChild(chrome);
      await rm(root, { recursive: true, force: true });
    },
  };
}
