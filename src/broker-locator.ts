import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  BROWSER_PILOT_PATHS,
  type BrowserPilotPaths,
  type BrokerTransportKind,
} from './paths.js';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_METADATA_BYTES = 16 * 1024;

export interface BrokerLocator {
  schemaVersion: 1;
  pid: number;
  endpoint: string;
  transport: BrokerTransportKind;
  startedAt: number;
  brokerProcessIdentity: string;
}

interface StartupLockRecord {
  schemaVersion: 1;
  pid: number;
  createdAt: number;
  token: string;
}

export interface BrokerStartupLock {
  release(): void;
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

function parseJsonFile(path: string): unknown {
  validateOwnedPath(path, false);
  const stats = statSync(path);
  if (stats.size < 2 || stats.size > MAX_METADATA_BYTES) throw new Error('Broker metadata has an invalid size');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isSafePid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validLocator(value: unknown, paths: BrowserPilotPaths): value is BrokerLocator {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1 &&
    isSafePid(record.pid) &&
    record.endpoint === paths.endpoint &&
    record.transport === paths.transport &&
    typeof record.startedAt === 'number' && Number.isSafeInteger(record.startedAt) && record.startedAt > 0 &&
    typeof record.brokerProcessIdentity === 'string' && record.brokerProcessIdentity.length > 0 &&
    record.brokerProcessIdentity.length <= 256;
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

export function removeStaleBrokerFilesSync(paths: BrowserPilotPaths = BROWSER_PILOT_PATHS): void {
  const pid = readBrokerPidSync(paths);
  if (pid && processIsAlive(pid)) return;
  for (const path of [paths.locatorFile, paths.pidFile]) {
    try { unlinkSync(path); } catch { /* absent */ }
  }
  if (paths.transport === 'unix_socket') {
    try { unlinkSync(paths.endpoint); } catch { /* absent */ }
  }
}
