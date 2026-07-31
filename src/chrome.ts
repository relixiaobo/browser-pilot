import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { connect as connectTcp } from 'node:net';
import { delimiter, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import type {
  BrowserAuthorizationState,
  BrowserCandidate,
  BrowserProcessState,
  BrowserRemoteDebuggingState,
} from './protocol/model.js';

export interface ChromeInfo {
  port: number;
  wsPath: string;
  wsUrl: string;
  browser: string;
  dataDir: string;
}

export interface BrowserProfileDefinition {
  key: string;
  product: string;
  channel: string;
  dataDir: string;
  installPaths: string[];
  executableNames: string[];
}

export interface DiscoveredBrowser {
  candidate: BrowserCandidate;
  dataDir: string;
  endpoint?: ChromeInfo;
}

export type BrowserEndpointProbe =
  | 'ready'
  | 'authorization_required'
  | 'unreachable';

export interface BrowserDiscoveryOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  profiles?: readonly BrowserProfileDefinition[];
  runningCommands?: readonly string[] | null;
  runningProcesses?: readonly BrowserRunningProcess[] | null;
}

export interface BrowserRunningProcess {
  pid?: number;
  command: string;
}

const execFileAsync = promisify(execFile);

function readChromeInfo(browser: string, dataDir: string): ChromeInfo | null {
  const portFile = join(dataDir, 'DevToolsActivePort');
  if (!existsSync(portFile)) return null;

  try {
    const lines = readFileSync(portFile, 'utf-8').trim().split(/\r?\n/);
    if (lines.length < 2) return null;

    const port = Number.parseInt(lines[0], 10);
    const wsPath = lines[1];
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !wsPath.startsWith('/')) return null;

    return {
      port,
      wsPath,
      wsUrl: `ws://127.0.0.1:${port}${wsPath}`,
      browser,
      dataDir,
    };
  } catch {
    return null;
  }
}

function executablePaths(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? '').split(delimiter).filter(Boolean);
}

function linuxInstallPaths(env: NodeJS.ProcessEnv, names: readonly string[]): string[] {
  return executablePaths(env).flatMap(directory => names.map(name => join(directory, name)));
}

export function supportedBrowserProfiles(options: Pick<BrowserDiscoveryOptions, 'platform' | 'homeDir' | 'env'> = {}): BrowserProfileDefinition[] {
  const home = options.homeDir ?? homedir();
  const os = options.platform ?? platform();
  const env = options.env ?? process.env;

  if (os === 'darwin') {
    const base = join(home, 'Library', 'Application Support');
    const applications = ['/Applications', join(home, 'Applications')];
    const appPaths = (name: string): string[] => applications.map(directory => join(directory, name));
    return [
      {
        key: 'chrome-stable', product: 'Chrome', channel: 'stable',
        dataDir: join(base, 'Google', 'Chrome'),
        installPaths: appPaths('Google Chrome.app'), executableNames: ['Google Chrome'],
      },
      {
        key: 'chrome-beta', product: 'Chrome', channel: 'beta',
        dataDir: join(base, 'Google', 'Chrome Beta'),
        installPaths: appPaths('Google Chrome Beta.app'), executableNames: ['Google Chrome Beta'],
      },
      {
        key: 'chrome-canary', product: 'Chrome', channel: 'canary',
        dataDir: join(base, 'Google', 'Chrome Canary'),
        installPaths: appPaths('Google Chrome Canary.app'), executableNames: ['Google Chrome Canary'],
      },
      {
        key: 'brave-stable', product: 'Brave', channel: 'stable',
        dataDir: join(base, 'BraveSoftware', 'Brave-Browser'),
        installPaths: appPaths('Brave Browser.app'), executableNames: ['Brave Browser'],
      },
      {
        key: 'edge-stable', product: 'Edge', channel: 'stable',
        dataDir: join(base, 'Microsoft Edge'),
        installPaths: appPaths('Microsoft Edge.app'), executableNames: ['Microsoft Edge'],
      },
      {
        key: 'chromium-stable', product: 'Chromium', channel: 'stable',
        dataDir: join(base, 'Chromium'),
        installPaths: appPaths('Chromium.app'), executableNames: ['Chromium'],
      },
    ];
  }
  if (os === 'linux') {
    return [
      {
        key: 'chrome-stable', product: 'Chrome', channel: 'stable',
        dataDir: join(home, '.config', 'google-chrome'),
        installPaths: linuxInstallPaths(env, ['google-chrome', 'google-chrome-stable']),
        executableNames: ['google-chrome', 'google-chrome-stable'],
      },
      {
        key: 'chrome-beta', product: 'Chrome', channel: 'beta',
        dataDir: join(home, '.config', 'google-chrome-beta'),
        installPaths: linuxInstallPaths(env, ['google-chrome-beta']), executableNames: ['google-chrome-beta'],
      },
      {
        key: 'chromium-stable', product: 'Chromium', channel: 'stable',
        dataDir: join(home, '.config', 'chromium'),
        installPaths: linuxInstallPaths(env, ['chromium', 'chromium-browser']),
        executableNames: ['chromium', 'chromium-browser'],
      },
      {
        key: 'brave-stable', product: 'Brave', channel: 'stable',
        dataDir: join(home, '.config', 'BraveSoftware', 'Brave-Browser'),
        installPaths: linuxInstallPaths(env, ['brave-browser', 'brave-browser-stable']),
        executableNames: ['brave-browser', 'brave-browser-stable'],
      },
      {
        key: 'edge-stable', product: 'Edge', channel: 'stable',
        dataDir: join(home, '.config', 'microsoft-edge'),
        installPaths: linuxInstallPaths(env, ['microsoft-edge', 'microsoft-edge-stable']),
        executableNames: ['microsoft-edge', 'microsoft-edge-stable'],
      },
    ];
  }
  if (os === 'win32') {
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    const programFiles = [env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter((value): value is string => Boolean(value));
    return [
      {
        key: 'chrome-stable', product: 'Chrome', channel: 'stable',
        dataDir: join(local, 'Google', 'Chrome', 'User Data'),
        installPaths: [join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'), ...programFiles.map(path => join(path, 'Google', 'Chrome', 'Application', 'chrome.exe'))],
        executableNames: ['chrome.exe'],
      },
      {
        key: 'brave-stable', product: 'Brave', channel: 'stable',
        dataDir: join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
        installPaths: [join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), ...programFiles.map(path => join(path, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'))],
        executableNames: ['brave.exe'],
      },
      {
        key: 'edge-stable', product: 'Edge', channel: 'stable',
        dataDir: join(local, 'Microsoft', 'Edge', 'User Data'),
        installPaths: [join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), ...programFiles.map(path => join(path, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))],
        executableNames: ['msedge.exe'],
      },
    ];
  }
  return [];
}

function stableBrowserId(definition: BrowserProfileDefinition, os: NodeJS.Platform): string {
  const digest = createHash('sha256')
    .update(`${os}\0${definition.key}\0${definition.dataDir}`)
    .digest('base64url')
    .slice(0, 20);
  return `browser:${definition.key}:${digest}`;
}

function pathExistsWithoutFollowingSymlink(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function installed(definition: BrowserProfileDefinition): boolean {
  return pathExistsWithoutFollowingSymlink(definition.dataDir) ||
    definition.installPaths.some(pathExistsWithoutFollowingSymlink);
}

function parseProcessRows(output: string): BrowserRunningProcess[] {
  const processes: BrowserRunningProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (Number.isSafeInteger(pid) && pid > 0) processes.push({ pid, command: match[2] });
  }
  return processes;
}

async function readRunningProcesses(os: NodeJS.Platform): Promise<readonly BrowserRunningProcess[] | null> {
  try {
    if (os === 'win32') {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
      ], { encoding: 'utf8', timeout: 2_000, windowsHide: true });
      if (!stdout.trim()) return [];
      const parsed = JSON.parse(stdout) as unknown;
      const records = Array.isArray(parsed) ? parsed : [parsed];
      return records.flatMap(value => {
        if (!value || typeof value !== 'object') return [];
        const record = value as Record<string, unknown>;
        if (!Number.isSafeInteger(record.ProcessId) || Number(record.ProcessId) < 1) return [];
        if (typeof record.CommandLine !== 'string' || !record.CommandLine.trim()) return [];
        return [{ pid: Number(record.ProcessId), command: record.CommandLine }];
      });
    }
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8', timeout: 2_000,
    });
    return parseProcessRows(stdout);
  } catch {
    return null;
  }
}

function normalizedProfilePath(value: string, os: NodeJS.Platform): string {
  const normalized = value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '');
  return os === 'win32' ? normalized.toLowerCase() : normalized;
}

function commandUserDataDir(command: string): string | undefined {
  const match = command.match(/(?:^|\s)--user-data-dir(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s]+))/i);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function executableAliases(definition: BrowserProfileDefinition): string[] {
  const productAliases: Record<string, string[]> = {
    chrome: ['chrome', 'chrome.exe', 'google-chrome', 'google-chrome-stable'],
    chromium: ['chromium', 'chromium-browser', 'chrome'],
    brave: ['brave', 'brave.exe', 'brave-browser', 'brave-browser-stable'],
    edge: ['msedge', 'msedge.exe', 'microsoft-edge', 'microsoft-edge-stable'],
  };
  return [...new Set([
    ...definition.executableNames,
    ...definition.installPaths.map(path => path.split(/[\\/]/).at(-1) ?? ''),
    ...(productAliases[definition.product.toLowerCase()] ?? []),
  ].filter(Boolean).map(name => name.toLowerCase()))];
}

function commandMatchesProfile(
  definition: BrowserProfileDefinition,
  command: string,
  os: NodeJS.Platform,
  allowImplicitDataDir = false,
): boolean {
  if (/(?:^|\s)--type(?:=|\s)/i.test(command)) return false;
  const normalized = command.toLowerCase();
  const matchesExecutable = executableAliases(definition).some(name => {
    const macExecutable = `/${name}.app/contents/macos/${name}`;
    if (normalized.includes(macExecutable)) return true;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[/\\\\"'])${escaped}(?=$|[\\s"',])`, 'i').test(command);
  });
  if (!matchesExecutable) return false;
  const commandDataDir = commandUserDataDir(command);
  if (commandDataDir !== undefined) {
    return normalizedProfilePath(commandDataDir, os) === normalizedProfilePath(definition.dataDir, os);
  }
  return allowImplicitDataDir;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function linuxSingletonPid(definition: BrowserProfileDefinition): number | undefined {
  const lockPath = join(definition.dataDir, 'SingletonLock');
  try {
    if (!lstatSync(lockPath).isSymbolicLink()) return undefined;
    const match = readlinkSync(lockPath).match(/-(\d+)$/);
    const pid = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(pid) && pid > 0 && processAlive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function browserProcessState(
  definition: BrowserProfileDefinition,
  processes: readonly BrowserRunningProcess[] | null,
  os: NodeJS.Platform,
): BrowserProcessState {
  if (os === 'linux') {
    const lockPid = linuxSingletonPid(definition);
    if (lockPid !== undefined) {
      if (processes === null) return 'unknown';
      const owner = processes.find(process => process.pid === lockPid);
      if (owner && commandMatchesProfile(definition, owner.command, os, true)) return 'running';
    }
  } else if (os !== 'win32') {
    for (const lockName of ['SingletonLock', 'SingletonSocket', 'lockfile']) {
      if (pathExistsWithoutFollowingSymlink(join(definition.dataDir, lockName))) return 'running';
    }
  }
  if (processes === null) return 'unknown';
  return processes.some(process => commandMatchesProfile(definition, process.command, os))
    ? 'running'
    : 'not_running';
}

function tcpReachable(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connectTcp({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function probeBrowserEndpoint(
  endpoint: ChromeInfo,
  options: { tcpTimeoutMs?: number; websocketTimeoutMs?: number } = {},
): Promise<BrowserEndpointProbe> {
  if (!await tcpReachable(endpoint.port, options.tcpTimeoutMs ?? 350)) return 'unreachable';
  return new Promise(resolve => {
    const socket = new WebSocket(endpoint.wsUrl);
    let settled = false;
    const finish = (result: BrowserEndpointProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket.readyState === WebSocket.OPEN) socket.close();
      else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish('authorization_required'), options.websocketTimeoutMs ?? 1_000);
    timer.unref();
    socket.once('open', () => finish('ready'));
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      finish(response.statusCode === 401 || response.statusCode === 403
        ? 'authorization_required'
        : 'unreachable');
    });
    socket.once('error', error => {
      const message = error.message.toLowerCase();
      finish(message.includes('401') || message.includes('403')
        ? 'authorization_required'
        : 'unreachable');
    });
    socket.once('close', () => finish('unreachable'));
  });
}

function remediation(
  state: BrowserCandidate['state'],
  endpointAvailable = false,
): BrowserCandidate['remediation'] | undefined {
  switch (state) {
    case 'not_running':
      return {
        code: 'start_browser',
        message: 'Start this browser profile, then enable remote debugging from chrome://inspect/#remote-debugging.',
        actionRequired: true,
      };
    case 'remote_debugging_disabled':
      return {
        code: 'enable_remote_debugging',
        message: 'Open chrome://inspect/#remote-debugging in this browser and turn on remote debugging.',
        actionRequired: true,
      };
    case 'authorization_required':
      return {
        code: 'authorize_remote_debugging',
        message: 'Approve the browser\'s remote debugging authorization prompt.',
        actionRequired: true,
      };
    case 'disconnected':
      if (endpointAvailable) {
        return {
          code: 'connect_browser',
          message: 'Run an explicit browser connect operation to request remote debugging authorization.',
          actionRequired: true,
        };
      }
      return {
        code: 'restart_remote_debugging',
        message: 'The recorded remote debugging endpoint is stale. Restart this browser profile and enable remote debugging again.',
        actionRequired: true,
      };
    case 'ready': return undefined;
  }
}

export async function discoverBrowserCandidates(options: BrowserDiscoveryOptions = {}): Promise<DiscoveredBrowser[]> {
  const os = options.platform ?? platform();
  const definitions = options.profiles ?? supportedBrowserProfiles(options);
  const runningProcesses = options.runningProcesses !== undefined
    ? options.runningProcesses
    : options.runningCommands !== undefined
      ? options.runningCommands?.map(command => ({ command })) ?? null
      : await readRunningProcesses(os);
  const results: DiscoveredBrowser[] = [];

  for (const definition of definitions) {
    if (!installed(definition)) continue;
    const endpoint = readChromeInfo(definition.product, definition.dataDir);
    const processState = browserProcessState(definition, runningProcesses, os);
    let remoteDebuggingState: BrowserRemoteDebuggingState = 'disabled';
    let authorizationState: BrowserAuthorizationState = 'not_applicable';
    let state: BrowserCandidate['state'];

    if (!endpoint) {
      state = processState === 'running' ? 'remote_debugging_disabled' : 'not_running';
    } else if (processState === 'not_running') {
      remoteDebuggingState = 'stale';
      authorizationState = 'unknown';
      state = 'disconnected';
    } else {
      remoteDebuggingState = 'enabled';
      authorizationState = 'unknown';
      state = 'disconnected';
    }

    const candidate: BrowserCandidate = {
      id: stableBrowserId(definition, os),
      product: definition.product,
      channel: definition.channel,
      userDataRoot: definition.dataDir,
      processState,
      remoteDebuggingState,
      authorizationState,
      state,
      ...(remediation(state, endpoint !== null && remoteDebuggingState === 'enabled')
        ? { remediation: remediation(state, endpoint !== null && remoteDebuggingState === 'enabled') }
        : {}),
    };
    results.push({ candidate, dataDir: definition.dataDir, ...(endpoint ? { endpoint } : {}) });
  }
  return results;
}

export async function discoverChrome(browserFilter?: string): Promise<ChromeInfo | null> {
  const filter = browserFilter?.toLowerCase();
  const candidates = await discoverBrowserCandidates();
  const selected = candidates.find(({ candidate, endpoint }) => (
    candidate.processState === 'running' &&
    candidate.remoteDebuggingState === 'enabled' &&
    endpoint !== undefined &&
    (!filter || [candidate.id, candidate.product, candidate.channel]
      .some(value => value?.toLowerCase().includes(filter)))
  ));
  return selected?.endpoint ?? null;
}

export function discoverChromeAtDataDir(dataDir: string, browser: string): ChromeInfo | null {
  return readChromeInfo(browser, dataDir);
}
