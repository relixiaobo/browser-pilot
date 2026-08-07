import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const forceKillSignal = process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL';

// Chrome startup competes with everything else on a CI runner, and a cold
// runner image can leave it well short of a tight budget. The old 15s deadline
// began expiring on hosted runners while Chrome was still alive and starting,
// so allow for a genuinely slow start.
const CHROME_STARTUP_TIMEOUT_MS = 60_000;

// A Chrome that never finishes starting is indistinguishable from a slow one
// unless its stderr survives, so keep a bounded tail for the failure message.
const CHROME_STDERR_CAPTURE_BYTES = 8_192;

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

// Drains Chrome's stderr so its pipe cannot fill and stall startup, while
// retaining only the tail needed to explain a failure.
function captureStderr(child) {
  const chunks = [];
  let size = 0;
  child.stderr?.on('data', chunk => {
    chunks.push(chunk);
    size += chunk.length;
    while (size > CHROME_STDERR_CAPTURE_BYTES && chunks.length > 1) {
      size -= chunks.shift().length;
    }
  });
  return () => Buffer.concat(chunks).toString('utf8').trim();
}

function describeStderr(readStderr) {
  const stderr = readStderr?.() ?? '';
  return stderr ? `; Chrome stderr tail: ${stderr}` : '; Chrome wrote nothing to stderr';
}

async function describeProfile(profile) {
  try {
    const entries = await readdir(profile);
    return entries.length ? entries.sort().join(', ') : '(empty)';
  } catch (error) {
    return `(unreadable: ${error?.code ?? error})`;
  }
}

async function waitForDevToolsPort(profile, chrome, readStderr) {
  const portFile = join(profile, 'DevToolsActivePort');
  const startedAt = Date.now();
  const deadline = startedAt + CHROME_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (chrome.exitCode !== null || chrome.signalCode !== null) {
      throw new Error(
        `isolated Chrome exited before creating ${portFile} ` +
        `(code ${chrome.exitCode}, signal ${chrome.signalCode})${describeStderr(readStderr)}`,
      );
    }
    try {
      const [port, path] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
      const parsedPort = Number.parseInt(port, 10);
      if (Number.isSafeInteger(parsedPort) && parsedPort > 0 && path?.startsWith('/')) return;
    } catch { /* Chrome has not finished starting. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // Reaching here means Chrome stayed alive for the whole budget without
  // publishing a port, so report what it was doing rather than only the path.
  throw new Error(
    `isolated Chrome did not create ${portFile} within ${Date.now() - startedAt}ms ` +
    `(pid ${chrome.pid} still running; profile contains ${await describeProfile(profile)})` +
    describeStderr(readStderr),
  );
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
  child.kill(forceKillSignal);
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
  if (processAlive(pid)) process.kill(pid, forceKillSignal);
}

export async function startIsolatedChromeFixture(prefix = 'browser-pilot-test-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const testHome = join(root, 'home');
  const brokerHome = join(root, 'broker');
  const profile = chromeProfile(testHome);
  const downloadDirectory = join(root, 'downloads');
  await mkdir(join(profile, 'Default'), { recursive: true });
  await mkdir(downloadDirectory, { recursive: true });
  await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({
    download: {
      default_directory: downloadDirectory,
      directory_upgrade: true,
      prompt_for_download: false,
    },
  }), { mode: 0o600 });
  const environment = {
    HOME: testHome,
    BROWSER_PILOT_HOME: brokerHome,
    BROWSER_PILOT_TEST_ROOT: root,
    BROWSER_PILOT_TEST_DOWNLOAD_DIR: downloadDirectory,
    ...(process.platform === 'win32' ? {
      USERPROFILE: testHome,
      LOCALAPPDATA: join(testHome, 'AppData', 'Local'),
    } : {}),
  };
  const executable = await chromeExecutable();
  let chrome;
  let stopped = false;

  const startBrowser = async () => {
    if (stopped) throw new Error('Cannot restart a stopped isolated Chrome fixture');
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) return;
    await unlink(join(profile, 'DevToolsActivePort')).catch(error => {
      if (error?.code !== 'ENOENT') throw error;
    });
    chrome = spawn(executable, [
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
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    await waitForDevToolsPort(profile, chrome, captureStderr(chrome));
  };

  const stopBrowser = async () => {
    await terminateChild(chrome);
    chrome = undefined;
  };

  try {
    await startBrowser();
  } catch (error) {
    await terminateChild(chrome);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    throw error;
  }

  return {
    root,
    brokerHome,
    profile,
    downloadDirectory,
    environment,
    startBrowser,
    stopBrowser,
    async stop() {
      if (stopped) return;
      stopped = true;
      await terminateTestBroker(brokerHome);
      await stopBrowser();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
