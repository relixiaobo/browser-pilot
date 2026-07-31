import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  BROWSER_PILOT_PATHS,
  type BrowserPilotPaths,
  type BrokerTransportKind,
} from './paths.js';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_METADATA_BYTES = 16 * 1024;

interface BrokerLocatorBase {
  pid: number;
  endpoint: string;
  transport: BrokerTransportKind;
  startedAt: number;
  brokerProcessIdentity: string;
}

export interface LegacyBrokerLocator extends BrokerLocatorBase {
  schemaVersion: 1;
}

export interface CurrentBrokerLocator extends BrokerLocatorBase {
  schemaVersion: 2;
  serviceVersion: string;
  executable: BrokerExecutableMetadata;
  protocol: BrokerProtocolRange;
  token?: string;
  previousExecutable?: BrokerExecutableMetadata;
}

export type BrokerLocator = LegacyBrokerLocator | CurrentBrokerLocator;

export interface BrokerExecutableMetadata {
  version: string;
  path: string;
  identity: string;
}

export interface BrokerProtocolRange {
  min: { major: number; minor: number };
  max: { major: number; minor: number };
}

export interface BrokerVersionHistoryEntry extends BrokerExecutableMetadata {
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface BrokerVersionHistory {
  schemaVersion: 1;
  current: BrokerVersionHistoryEntry;
  previous?: BrokerVersionHistoryEntry;
}

interface StartupLockRecord {
  schemaVersion: 1;
  pid: number;
  createdAt: number;
  token: string;
}

export interface DaemonOwnerRecord {
  schemaVersion: 1;
  pid: number;
  processStartIdentity: string;
  createdAt: number;
  token: string;
}

export interface DaemonOwnerLock {
  readonly record: DaemonOwnerRecord;
  ownsLock(): boolean;
  assertOwnership(): void;
  clearStaleBrokerState(): void;
  cleanup(brokerProcessIdentity: string): void;
  release(): void;
}

export interface BrokerStartupLock {
  release(): void;
}

export interface BrokerStartingRecord {
  schemaVersion: 2;
  pid: number;
  startedAt: number;
  brokerProcessIdentity: string;
  state: 'starting';
}

export interface AcquireBrokerStartupLockOptions {
  paths?: BrowserPilotPaths;
  timeoutMs?: number;
  staleAfterMs?: number;
  pollMs?: number;
  now?: () => number;
  pid?: number;
  processAlive?: (pid: number) => boolean;
}

export interface AcquireDaemonOwnerLockOptions {
  paths?: BrowserPilotPaths;
  now?: () => number;
  pid?: number;
  processAlive?: (pid: number) => boolean;
  processStartIdentity?: (pid: number) => string | undefined;
}

export class DaemonOwnerError extends Error {
  constructor(
    readonly code: 'daemon_already_running' | 'daemon_owner_unverifiable',
    message: string,
  ) {
    super(message);
    this.name = 'DaemonOwnerError';
  }
}

function currentUid(): number | undefined {
  return process.getuid?.();
}

function validateOwnedPath(path: string, expectDirectory: boolean): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`Browser Pilot path must not be a symbolic link: ${path}`);
  if (expectDirectory ? !stats.isDirectory() : !stats.isFile()) {
    throw new Error(`Browser Pilot path has an unexpected type: ${path}`);
  }
  const uid = currentUid();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`Browser Pilot path is not owned by the current user: ${path}`);
  }
  if (!expectDirectory && process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new Error(`Browser Pilot metadata is accessible by another OS user: ${path}`);
  }
}

export function ensurePrivateDirectorySync(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  validateOwnedPath(path, true);
  if (process.platform !== 'win32') chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

export function ensureBrokerDirectoriesSync(paths: BrowserPilotPaths = BROWSER_PILOT_PATHS): void {
  ensurePrivateDirectorySync(paths.stateDir);
  if (paths.runtimeDir !== paths.stateDir) ensurePrivateDirectorySync(paths.runtimeDir);
}

function windowsSystemExecutable(name: string): string {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  return join(systemRoot, 'System32', name);
}

function currentWindowsUserSidSync(): string {
  const result = spawnSync(windowsSystemExecutable('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const sid = result.status === 0 ? result.stdout.match(/S-\d+(?:-\d+)+/i)?.[0] : undefined;
  if (!sid) throw new Error('Cannot resolve the current Windows user SID for Broker state protection');
  return sid;
}

function restrictWindowsPathAclSync(path: string, directory: boolean, userSid: string): void {
  const inherited = directory ? '(OI)(CI)' : '';
  const result = spawnSync(windowsSystemExecutable('icacls.exe'), [
    path,
    '/inheritance:r',
    '/grant:r',
    `*${userSid}:${inherited}F`,
    `*S-1-5-18:${inherited}F`,
    `*S-1-5-32-544:${inherited}F`,
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || result.error?.message;
    throw new Error(`Cannot restrict Windows ACL for Browser Pilot path ${path}${detail ? `: ${detail}` : ''}`);
  }
}

export function restrictWindowsBrokerStateSync(
  paths: BrowserPilotPaths = BROWSER_PILOT_PATHS,
): void {
  if (process.platform !== 'win32') return;
  ensurePrivateDirectorySync(paths.stateDir);
  const userSid = currentWindowsUserSidSync();
  restrictWindowsPathAclSync(paths.stateDir, true, userSid);
  if (existsSync(paths.locatorFile)) restrictWindowsPathAclSync(paths.locatorFile, false, userSid);
}

function parseJsonFile(path: string): unknown {
  validateOwnedPath(path, false);
  const stats = statSync(path);
  if (stats.size < 2 || stats.size > MAX_METADATA_BYTES) throw new Error('Broker metadata has an invalid size');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isSafePid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validExecutable(value: unknown): value is BrokerExecutableMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.version === 'string' && record.version.length > 0 && record.version.length <= 128 &&
    typeof record.path === 'string' && record.path.length > 0 && record.path.length <= 4096 &&
    isAbsolute(record.path) &&
    typeof record.identity === 'string' && /^executable:[a-f0-9]{64}$/.test(record.identity);
}

function validProtocolVersion(value: unknown): value is { major: number; minor: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Number.isSafeInteger(record.major) && Number(record.major) >= 0 &&
    Number.isSafeInteger(record.minor) && Number(record.minor) >= 0;
}

function validProtocolRange(value: unknown): value is BrokerProtocolRange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!validProtocolVersion(record.min) || !validProtocolVersion(record.max)) return false;
  return record.min.major < record.max.major ||
    (record.min.major === record.max.major && record.min.minor <= record.max.minor);
}

function validEndpointToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value);
}

function validLocator(value: unknown, paths: BrowserPilotPaths): value is BrokerLocator {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const common = (record.schemaVersion === 1 || record.schemaVersion === 2) &&
    isSafePid(record.pid) &&
    record.endpoint === paths.endpoint &&
    record.transport === paths.transport &&
    isSafeTimestamp(record.startedAt) &&
    typeof record.brokerProcessIdentity === 'string' && record.brokerProcessIdentity.length > 0 &&
    record.brokerProcessIdentity.length <= 256;
  if (!common) return false;
  if (record.schemaVersion === 1) return true;
  return typeof record.serviceVersion === 'string' && record.serviceVersion.length > 0 &&
    record.serviceVersion.length <= 128 && validExecutable(record.executable) &&
    validProtocolRange(record.protocol) &&
    (record.token === undefined || validEndpointToken(record.token)) &&
    (record.previousExecutable === undefined || validExecutable(record.previousExecutable));
}

function validVersionHistoryEntry(value: unknown): value is BrokerVersionHistoryEntry {
  if (!validExecutable(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  return isSafeTimestamp(record.firstSeenAt) && isSafeTimestamp(record.lastSeenAt) &&
    Number(record.firstSeenAt) <= Number(record.lastSeenAt);
}

function validVersionHistory(value: unknown): value is BrokerVersionHistory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1 && validVersionHistoryEntry(record.current) &&
    (record.previous === undefined || validVersionHistoryEntry(record.previous));
}

export function createExecutableMetadataSync(version: string, path: string): BrokerExecutableMetadata {
  if (!version || version.length > 128) throw new Error('Invalid Browser Pilot executable version');
  const resolvedPath = realpathSync(path);
  const digest = createHash('sha256').update(`${resolvedPath}\0${version}\0`);
  for (const artifactPath of [
    resolvedPath,
    join(dirname(resolvedPath), 'daemon.js'),
    join(dirname(resolvedPath), 'managed-target-janitor.js'),
  ]) {
    if (!existsSync(artifactPath)) continue;
    digest.update(basename(artifactPath)).update('\0').update(readFileSync(artifactPath)).update('\0');
  }
  return {
    version,
    path: resolvedPath,
    identity: `executable:${digest.digest('hex')}`,
  };
}

export function readBrokerVersionHistorySync(
  paths: BrowserPilotPaths = BROWSER_PILOT_PATHS,
): BrokerVersionHistory | undefined {
  if (!existsSync(paths.versionHistoryFile)) return undefined;
  try {
    const value = parseJsonFile(paths.versionHistoryFile);
    return validVersionHistory(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function updateBrokerVersionHistorySync(
  executable: BrokerExecutableMetadata,
  now = Date.now(),
  paths: BrowserPilotPaths = BROWSER_PILOT_PATHS,
): BrokerVersionHistory {
  if (!validExecutable(executable) || !isSafeTimestamp(now)) {
    throw new Error('Invalid Broker executable history update');
  }
  const existing = readBrokerVersionHistorySync(paths);
  if (existsSync(paths.versionHistoryFile) && !existing) {
    throw new Error('Existing Broker version history is invalid or inaccessible');
  }
  const current: BrokerVersionHistoryEntry = existing?.current.identity === executable.identity
    ? { ...existing.current, ...executable, lastSeenAt: Math.max(existing.current.lastSeenAt, now) }
    : { ...executable, firstSeenAt: now, lastSeenAt: now };
  const previous = existing?.current.identity === executable.identity
    ? existing.previous
    : existing?.current;
  const history: BrokerVersionHistory = {
    schemaVersion: 1,
    current,
    ...(previous ? { previous: { ...previous } } : {}),
  };
  atomicWriteJson(paths.versionHistoryFile, history);
  return history;
}

export function readBrokerLocatorSync(paths: BrowserPilotPaths = BROWSER_PILOT_PATHS): BrokerLocator | undefined {
  if (!existsSync(paths.locatorFile)) return undefined;
  try {
    const value = parseJsonFile(paths.locatorFile);
    return validLocator(value, paths) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function readBrokerPidSync(paths: BrowserPilotPaths = BROWSER_PILOT_PATHS): number | undefined {
  const locator = readBrokerLocatorSync(paths);
  if (locator) return locator.pid;
  if (!existsSync(paths.pidFile)) return undefined;
  try {
    const value = parseJsonFile(paths.pidFile);
    if (isSafePid(value)) return value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const pid = (value as Record<string, unknown>).pid;
      return isSafePid(pid) ? pid : undefined;
    }
  } catch {
    try {
      validateOwnedPath(paths.pidFile, false);
      const pid = Number.parseInt(readFileSync(paths.pidFile, 'utf8').trim(), 10);
      return isSafePid(pid) ? pid : undefined;
    } catch { /* invalid */ }
  }
  return undefined;
}

function atomicWriteJson(path: string, value: object): void {
  ensurePrivateDirectorySync(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
    if (process.platform !== 'win32') chmodSync(temporary, PRIVATE_FILE_MODE);
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed or absent */ }
  }
}

export function writeBrokerStartingSync(
  record: Omit<BrokerStartingRecord, 'schemaVersion' | 'state'>,
  paths: BrowserPilotPaths = BROWSER_PILOT_PATHS,
): void {
  if (
    !isSafePid(record.pid) ||
    !isSafeTimestamp(record.startedAt) ||
    typeof record.brokerProcessIdentity !== 'string' ||
    record.brokerProcessIdentity.length === 0 ||
    record.brokerProcessIdentity.length > 256
  ) {
    throw new Error('Invalid starting Broker record');
  }
  atomicWriteJson(paths.pidFile, {
    schemaVersion: 2,
    ...record,
    state: 'starting',
  } satisfies BrokerStartingRecord);
}

export function readBrokerStartingSync(
  paths: BrowserPilotPaths = BROWSER_PILOT_PATHS,
): BrokerStartingRecord | undefined {
  if (!existsSync(paths.pidFile) || existsSync(paths.locatorFile)) return undefined;
  try {
    const value = parseJsonFile(paths.pidFile);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (
      record.schemaVersion !== 2 ||
      record.state !== 'starting' ||
      !isSafePid(record.pid) ||
      !isSafeTimestamp(record.startedAt) ||
      typeof record.brokerProcessIdentity !== 'string' ||
      record.brokerProcessIdentity.length === 0 ||
      record.brokerProcessIdentity.length > 256
    ) return undefined;
    return record as unknown as BrokerStartingRecord;
  } catch {
    return undefined;
  }
}

export function writeBrokerLocatorSync(
  locator: BrokerLocator,
  paths: BrowserPilotPaths = BROWSER_PILOT_PATHS,
): void {
  if (!validLocator(locator, paths)) throw new Error('Invalid Broker locator');
  atomicWriteJson(paths.locatorFile, locator);
  atomicWriteJson(paths.pidFile, { schemaVersion: 1, pid: locator.pid, startedAt: locator.startedAt });
}

export function removeBrokerLocatorSync(
  brokerProcessIdentity: string,
  paths: BrowserPilotPaths = BROWSER_PILOT_PATHS,
): void {
  const locatorExists = existsSync(paths.locatorFile);
  const current = readBrokerLocatorSync(paths);
  if (locatorExists && (!current || current.brokerProcessIdentity !== brokerProcessIdentity)) return;
  for (const path of [paths.locatorFile, paths.pidFile]) {
    try { unlinkSync(path); } catch { /* absent */ }
  }
}

export function processIsAlive(pid: number): boolean {
  if (!isSafePid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function normalizeProcessStartIdentity(platform: NodeJS.Platform, value: string): string | undefined {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized ? `${platform}:${normalized}` : undefined;
}

export function readProcessStartIdentitySync(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!isSafePid(pid)) return undefined;
  try {
    if (platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const commandEnd = stat.lastIndexOf(')');
      if (commandEnd < 0) return undefined;
      const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/);
      const startTicks = fieldsAfterCommand[19];
      return /^\d+$/.test(startTicks ?? '') ? `linux:${startTicks}` : undefined;
    }

    if (platform === 'win32') {
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
      const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const command = [
        `$process = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"`,
        "if ($null -ne $process) { $process.CreationDate.ToUniversalTime().ToString('O') }",
      ].join('; ');
      const result = spawnSync(executable, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command,
      ], { encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) return undefined;
      return normalizeProcessStartIdentity(platform, result.stdout);
    }

    const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      windowsHide: true,
    });
    if (result.status !== 0) return undefined;
    return normalizeProcessStartIdentity(platform, result.stdout);
  } catch {
    return undefined;
  }
}

function validDaemonOwner(value: unknown): value is DaemonOwnerRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1 &&
    isSafePid(record.pid) &&
    typeof record.processStartIdentity === 'string' &&
    record.processStartIdentity.length > 0 && record.processStartIdentity.length <= 256 &&
    isSafeTimestamp(record.createdAt) &&
    typeof record.token === 'string' && record.token.length >= 8 && record.token.length <= 128;
}

export function readDaemonOwnerSync(
  paths: BrowserPilotPaths = BROWSER_PILOT_PATHS,
): DaemonOwnerRecord | undefined {
  if (!existsSync(paths.daemonOwnerLockFile)) return undefined;
  try {
    const value = parseJsonFile(paths.daemonOwnerLockFile);
    return validDaemonOwner(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function sameDaemonOwner(left: DaemonOwnerRecord, right: DaemonOwnerRecord): boolean {
  return left.pid === right.pid &&
    left.processStartIdentity === right.processStartIdentity &&
    left.token === right.token;
}

function removeDaemonOwnerLock(
  paths: BrowserPilotPaths,
  expected: DaemonOwnerRecord,
): boolean {
  const current = readDaemonOwnerSync(paths);
  if (!current || !sameDaemonOwner(current, expected)) return false;
  try {
    unlinkSync(paths.daemonOwnerLockFile);
    return true;
  } catch {
    return false;
  }
}

function removeBrokerStateFilesSync(paths: BrowserPilotPaths): void {
  for (const path of [
    paths.locatorFile,
    paths.pidFile,
    join(paths.stateDir, 'state.json'),
    join(paths.stateDir, 'refs.json'),
  ]) {
    try { unlinkSync(path); } catch { /* absent */ }
  }
  if (paths.transport === 'unix_socket') {
    try { unlinkSync(paths.endpoint); } catch { /* absent */ }
  }
}

function createDaemonOwnerLock(
  paths: BrowserPilotPaths,
  record: DaemonOwnerRecord,
): DaemonOwnerLock | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(paths.daemonOwnerLockFile, 'wx', PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }
  try {
    writeSync(descriptor, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(descriptor);
  }

  let released = false;
  const ownsLock = (): boolean => {
    if (released) return false;
    const current = readDaemonOwnerSync(paths);
    return current !== undefined && sameDaemonOwner(current, record);
  };
  const assertOwnership = (): void => {
    if (!ownsLock()) {
      throw new Error('Browser Pilot daemon no longer owns its lifetime lock');
    }
  };
  const release = (): void => {
    if (released) return;
    released = true;
    removeDaemonOwnerLock(paths, record);
  };
  return {
    record,
    ownsLock,
    assertOwnership,
    clearStaleBrokerState() {
      assertOwnership();
      removeBrokerStateFilesSync(paths);
    },
    cleanup(brokerProcessIdentity: string) {
      if (!ownsLock()) return;
      if (paths.transport === 'unix_socket') {
        try { unlinkSync(paths.endpoint); } catch { /* absent */ }
      }
      removeBrokerLocatorSync(brokerProcessIdentity, paths);
      release();
    },
    release,
  };
}

function unverifiableDaemonOwner(message: string): DaemonOwnerError {
  return new DaemonOwnerError(
    'daemon_owner_unverifiable',
    `${message} Inspect or stop the recorded process, or set BROWSER_PILOT_HOME to a separate directory before retrying.`,
  );
}

export function acquireDaemonOwnerLockSync(
  options: AcquireDaemonOwnerLockOptions = {},
): DaemonOwnerLock {
  const paths = options.paths ?? BROWSER_PILOT_PATHS;
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const alive = options.processAlive ?? processIsAlive;
  const processStartIdentity = options.processStartIdentity ?? readProcessStartIdentitySync;
  ensureBrokerDirectoriesSync(paths);

  const currentStartIdentity = processStartIdentity(pid);
  if (!currentStartIdentity) {
    throw unverifiableDaemonOwner(`Cannot read the start identity of Browser Pilot daemon pid ${pid}.`);
  }

  for (;;) {
    const record: DaemonOwnerRecord = {
      schemaVersion: 1,
      pid,
      processStartIdentity: currentStartIdentity,
      createdAt: now(),
      token: randomUUID(),
    };
    const lock = createDaemonOwnerLock(paths, record);
    if (lock) return lock;

    const owner = readDaemonOwnerSync(paths);
    if (!owner) {
      throw unverifiableDaemonOwner(
        `The Browser Pilot daemon owner lock at ${paths.daemonOwnerLockFile} is invalid or inaccessible.`,
      );
    }
    if (alive(owner.pid)) {
      const actualStartIdentity = processStartIdentity(owner.pid);
      if (!actualStartIdentity) {
        throw unverifiableDaemonOwner(
          `Cannot verify the start identity of the live Browser Pilot daemon owner pid ${owner.pid}.`,
        );
      }
      if (actualStartIdentity === owner.processStartIdentity) {
        throw new DaemonOwnerError(
          'daemon_already_running',
          `Another Browser Pilot daemon already owns this home (pid ${owner.pid}).`,
        );
      }
    }
    if (!removeDaemonOwnerLock(paths, owner)) continue;
  }
}

function readStartupLock(path: string): StartupLockRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = parseJsonFile(path);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (
      record.schemaVersion !== 1 ||
      !isSafePid(record.pid) ||
      typeof record.createdAt !== 'number' || !Number.isSafeInteger(record.createdAt) ||
      typeof record.token !== 'string' || record.token.length < 8 || record.token.length > 128
    ) return undefined;
    return record as unknown as StartupLockRecord;
  } catch {
    return undefined;
  }
}

function removeStartupLock(path: string, expectedToken?: string): boolean {
  if (expectedToken) {
    const current = readStartupLock(path);
    if (!current || current.token !== expectedToken) return false;
  }
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function createStartupLock(path: string, record: StartupLockRecord): BrokerStartupLock | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, 'wx', PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }
  try {
    writeSync(descriptor, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(descriptor);
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      removeStartupLock(path, record.token);
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

export async function acquireBrokerStartupLock(
  options: AcquireBrokerStartupLockOptions = {},
): Promise<BrokerStartupLock> {
  const paths = options.paths ?? BROWSER_PILOT_PATHS;
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const alive = options.processAlive ?? processIsAlive;
  const timeoutMs = options.timeoutMs ?? 65_000;
  const staleAfterMs = options.staleAfterMs ?? 120_000;
  const pollMs = options.pollMs ?? 100;
  ensureBrokerDirectoriesSync(paths);
  const deadline = now() + timeoutMs;

  while (now() < deadline) {
    const record: StartupLockRecord = {
      schemaVersion: 1,
      pid,
      createdAt: now(),
      token: randomUUID(),
    };
    const lock = createStartupLock(paths.startupLockFile, record);
    if (lock) return lock;

    const owner = readStartupLock(paths.startupLockFile);
    let stale = false;
    if (owner) {
      stale = !alive(owner.pid);
    } else {
      try {
        stale = now() - lstatSync(paths.startupLockFile).mtimeMs > staleAfterMs;
      } catch {
        stale = true;
      }
    }
    if (stale && removeStartupLock(paths.startupLockFile, owner?.token)) continue;
    await delay(pollMs);
  }
  throw new Error('Timed out waiting for another Browser Pilot process to finish Broker startup');
}
