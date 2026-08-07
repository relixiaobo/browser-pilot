import { createHash } from 'node:crypto';
import { homedir, platform, tmpdir, userInfo } from 'node:os';
import { isAbsolute, join, win32 } from 'node:path';

export type BrokerTransportKind = 'unix_socket' | 'windows_pipe';

export interface BrowserPilotPaths {
  stateDir: string;
  runtimeDir: string;
  endpoint: string;
  transport: BrokerTransportKind;
  locatorFile: string;
  pidFile: string;
  startupLockFile: string;
  daemonOwnerLockFile: string;
  versionHistoryFile: string;
  artifactDir: string;
  downloadDir: string;
  sitesDir: string;
}

export interface BrowserPilotPathOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  tempDir?: string;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  username?: string;
}

const MAX_PORTABLE_UNIX_SOCKET_BYTES = 96;

function identityDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function resolveBrowserPilotPaths(options: BrowserPilotPathOptions = {}): BrowserPilotPaths {
  const os = options.platform ?? platform();
  const home = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  if (os === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? win32.join(home, 'AppData', 'Local');
    const stateDir = env.BROWSER_PILOT_HOME ?? win32.join(localAppData, 'Browser Pilot');
    if (!win32.isAbsolute(stateDir)) throw new Error('BROWSER_PILOT_HOME must be absolute');
    const username = options.username ?? (() => {
      try { return userInfo().username; } catch { return home; }
    })();
    const identity = identityDigest(
      `${username.toLowerCase()}\0${home.toLowerCase()}\0${stateDir.toLowerCase()}`,
    );
    return {
      stateDir,
      runtimeDir: stateDir,
      endpoint: `\\\\.\\pipe\\browser-pilot-${identity}`,
      transport: 'windows_pipe',
      locatorFile: win32.join(stateDir, 'broker-locator.json'),
      pidFile: win32.join(stateDir, 'daemon.pid'),
      startupLockFile: win32.join(stateDir, 'startup.lock'),
      daemonOwnerLockFile: win32.join(stateDir, 'daemon-owner.lock'),
      versionHistoryFile: win32.join(stateDir, 'broker-versions.json'),
      artifactDir: win32.join(stateDir, 'artifacts'),
      downloadDir: win32.join(stateDir, 'downloads'),
      sitesDir: win32.join(stateDir, 'sites'),
    };
  }

  const stateDir = env.BROWSER_PILOT_HOME ?? join(home, '.browser-pilot');
  if (!isAbsolute(stateDir)) throw new Error('BROWSER_PILOT_HOME must be absolute');
  const defaultEndpoint = join(stateDir, 'daemon.sock');
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const useShortRuntimePath = Buffer.byteLength(defaultEndpoint) > MAX_PORTABLE_UNIX_SOCKET_BYTES;
  let runtimeDir = useShortRuntimePath
    ? join(options.tempDir ?? tmpdir(), `browser-pilot-${uid}-${identityDigest(stateDir)}`)
    : stateDir;
  let endpoint = join(runtimeDir, 'daemon.sock');
  if (Buffer.byteLength(endpoint) > MAX_PORTABLE_UNIX_SOCKET_BYTES) {
    runtimeDir = join('/tmp', `browser-pilot-${uid}-${identityDigest(stateDir)}`);
    endpoint = join(runtimeDir, 'daemon.sock');
  }
  if (Buffer.byteLength(endpoint) > MAX_PORTABLE_UNIX_SOCKET_BYTES) {
    throw new Error('Browser Pilot cannot resolve a portable Unix socket path');
  }
  if (!isAbsolute(endpoint)) throw new Error('Browser Pilot endpoint must be absolute');
  return {
    stateDir,
    runtimeDir,
    endpoint,
    transport: 'unix_socket',
    locatorFile: join(stateDir, 'broker-locator.json'),
    pidFile: join(stateDir, 'daemon.pid'),
    startupLockFile: join(stateDir, 'startup.lock'),
    daemonOwnerLockFile: join(stateDir, 'daemon-owner.lock'),
    versionHistoryFile: join(stateDir, 'broker-versions.json'),
    artifactDir: join(stateDir, 'artifacts'),
    downloadDir: join(stateDir, 'downloads'),
    sitesDir: join(stateDir, 'sites'),
  };
}

export const BROWSER_PILOT_PATHS = resolveBrowserPilotPaths();
export const STATE_DIR = BROWSER_PILOT_PATHS.stateDir;
export const RUNTIME_DIR = BROWSER_PILOT_PATHS.runtimeDir;
export const SOCKET_PATH = BROWSER_PILOT_PATHS.endpoint;
export const BROKER_TRANSPORT = BROWSER_PILOT_PATHS.transport;
export const LOCATOR_FILE = BROWSER_PILOT_PATHS.locatorFile;
export const PID_FILE = BROWSER_PILOT_PATHS.pidFile;
export const STARTUP_LOCK_FILE = BROWSER_PILOT_PATHS.startupLockFile;
export const DAEMON_OWNER_LOCK_FILE = BROWSER_PILOT_PATHS.daemonOwnerLockFile;
export const ARTIFACT_DIR = BROWSER_PILOT_PATHS.artifactDir;
export const DOWNLOAD_DIR = BROWSER_PILOT_PATHS.downloadDir;
export const SITES_DIR = BROWSER_PILOT_PATHS.sitesDir;
