import assert from 'node:assert/strict';
import { access, chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { testTempPrefix } from './helpers/platform.mjs';
import {
  acquireBrokerStartupLock,
  acquireDaemonOwnerLockSync,
  createExecutableMetadataSync,
  ensureBrokerDirectoriesSync,
  readBrokerLocatorSync,
  readDaemonOwnerSync,
  readProcessStartIdentitySync,
  readBrokerVersionHistorySync,
  removeBrokerLocatorSync,
  resolveBrowserPilotPaths,
  updateBrokerVersionHistorySync,
  writeBrokerLocatorSync,
} from '../dist/services.js';

function testPaths(root) {
  return resolveBrowserPilotPaths({
    platform: process.platform,
    homeDir: root,
    tempDir: tmpdir(),
    env: { BROWSER_PILOT_HOME: join(root, '.browser-pilot') },
    uid: 501,
    username: 'browser-pilot-test',
  });
}

test('platform path resolution uses a private short Unix endpoint and a per-user Windows pipe', () => {
  if (process.platform !== 'win32') {
    const short = resolveBrowserPilotPaths({
      platform: 'darwin', homeDir: '/Users/alice', tempDir: '/tmp', env: {}, uid: 501,
    });
    assert.equal(short.stateDir, '/Users/alice/.browser-pilot');
    assert.equal(short.endpoint, '/Users/alice/.browser-pilot/daemon.sock');
    assert.equal(short.transport, 'unix_socket');
    assert.equal(short.daemonOwnerLockFile, '/Users/alice/.browser-pilot/daemon-owner.lock');

    const longHome = `/Users/${'a'.repeat(100)}`;
    const long = resolveBrowserPilotPaths({
      platform: 'darwin', homeDir: longHome, tempDir: '/tmp', env: {}, uid: 501,
    });
    assert.match(long.runtimeDir, /^\/tmp\/browser-pilot-501-[a-f0-9]{16}$/);
    assert.equal(Buffer.byteLength(long.endpoint) < 96, true);
    assert.equal(long.stateDir, join(longHome, '.browser-pilot'));

    const linux = resolveBrowserPilotPaths({
      platform: 'linux', homeDir: '/home/alice', tempDir: '/tmp',
      env: { BROWSER_PILOT_HOME: '/srv/alice/browser-pilot' }, uid: 1000,
    });
    assert.equal(linux.stateDir, '/srv/alice/browser-pilot');
    assert.equal(linux.endpoint, '/srv/alice/browser-pilot/daemon.sock');
  }

  const windows = resolveBrowserPilotPaths({
    platform: 'win32', homeDir: 'C:\\Users\\Alice', tempDir: 'C:\\Temp',
    env: { LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local' }, username: 'Alice',
  });
  assert.equal(windows.stateDir, 'C:\\Users\\Alice\\AppData\\Local\\Browser Pilot');
  assert.match(windows.endpoint, /^\\\\\.\\pipe\\browser-pilot-[a-f0-9]{16}$/);
  assert.equal(windows.transport, 'windows_pipe');
  assert.equal(
    windows.daemonOwnerLockFile,
    'C:\\Users\\Alice\\AppData\\Local\\Browser Pilot\\daemon-owner.lock',
  );

  const isolatedWindows = resolveBrowserPilotPaths({
    platform: 'win32', homeDir: 'C:\\Users\\Alice', tempDir: 'C:\\Temp',
    env: { BROWSER_PILOT_HOME: 'D:\\Agents\\browser-pilot-v2' }, username: 'Alice',
  });
  assert.equal(isolatedWindows.stateDir, 'D:\\Agents\\browser-pilot-v2');
  assert.notEqual(isolatedWindows.endpoint, windows.endpoint);
  assert.throws(() => resolveBrowserPilotPaths({
    platform: 'win32', homeDir: 'C:\\Users\\Alice',
    env: { BROWSER_PILOT_HOME: 'relative\\broker' }, username: 'Alice',
  }), /must be absolute/);
});

test('Broker locator files are private, validated, and removed only by their owner', async t => {
  const root = await mkdtemp(testTempPrefix('bp-locator-'));
  const paths = testPaths(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  ensureBrokerDirectoriesSync(paths);
  const locator = {
    schemaVersion: 1,
    pid: process.pid,
    endpoint: paths.endpoint,
    transport: paths.transport,
    startedAt: 1234,
    brokerProcessIdentity: 'broker:test-owner',
  };
  writeBrokerLocatorSync(locator, paths);

  assert.deepEqual(readBrokerLocatorSync(paths), locator);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(paths.stateDir)).mode & 0o777, 0o700);
    assert.equal((await lstat(paths.locatorFile)).mode & 0o777, 0o600);
    assert.equal((await lstat(paths.pidFile)).mode & 0o777, 0o600);
  }
  assert.equal(JSON.parse(await readFile(paths.pidFile, 'utf8')).pid, process.pid);

  if (process.platform !== 'win32') {
    await chmod(paths.locatorFile, 0o644);
    assert.equal(readBrokerLocatorSync(paths), undefined);
    removeBrokerLocatorSync(locator.brokerProcessIdentity, paths);
    await lstat(paths.locatorFile);
    await chmod(paths.locatorFile, 0o600);
  }
  removeBrokerLocatorSync('broker:other-owner', paths);
  assert.deepEqual(readBrokerLocatorSync(paths), locator);
  removeBrokerLocatorSync(locator.brokerProcessIdentity, paths);
  assert.equal(readBrokerLocatorSync(paths), undefined);
});

test('Broker version history is private, bounded, and excludes transient browser state', async t => {
  const root = await mkdtemp(testTempPrefix('bp-version-history-'));
  const paths = testPaths(root);
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = createExecutableMetadataSync('1.0.0', process.execPath);
  const second = createExecutableMetadataSync('2.0.0', process.execPath);
  const third = createExecutableMetadataSync('3.0.0', process.execPath);
  updateBrokerVersionHistorySync(first, 100, paths);
  updateBrokerVersionHistorySync(second, 200, paths);
  const history = updateBrokerVersionHistorySync(third, 300, paths);

  assert.equal(history.current.version, '3.0.0');
  assert.equal(history.previous.version, '2.0.0');
  assert.equal(history.current.firstSeenAt, 300);
  assert.equal(Object.keys(history).sort().join(','), 'current,previous,schemaVersion');
  assert.equal(/target|workspace|lease|ref|cookie|browserId/.test(JSON.stringify(history)), false);
  assert.deepEqual(readBrokerVersionHistorySync(paths), history);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(paths.versionHistoryFile)).mode & 0o777, 0o600);
    const original = await readFile(paths.versionHistoryFile, 'utf8');
    await chmod(paths.versionHistoryFile, 0o644);
    assert.throws(
      () => updateBrokerVersionHistorySync(first, 400, paths),
      /invalid or inaccessible/,
    );
    assert.equal(await readFile(paths.versionHistoryFile, 'utf8'), original);
  }
});

test('startup lock serializes contenders and safely reclaims a dead owner', async t => {
  const root = await mkdtemp(testTempPrefix('bp-start-lock-'));
  const paths = testPaths(root);
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await acquireBrokerStartupLock({ paths, timeoutMs: 1_000, pollMs: 5 });
  let secondAcquired = false;
  const secondTask = acquireBrokerStartupLock({ paths, timeoutMs: 1_000, pollMs: 5 })
    .then(lock => {
      secondAcquired = true;
      return lock;
    });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(secondAcquired, false);
  first.release();
  const second = await secondTask;
  assert.equal(secondAcquired, true);
  second.release();

  const abandoned = await acquireBrokerStartupLock({
    paths, pid: 999_999, timeoutMs: 1_000, pollMs: 5,
  });
  const recovered = await acquireBrokerStartupLock({
    paths,
    pid: process.pid,
    timeoutMs: 1_000,
    pollMs: 5,
    processAlive: pid => pid !== 999_999,
  });
  recovered.release();
  abandoned.release();
});

test('daemon owner lock binds the live process start identity', async t => {
  const root = await mkdtemp(testTempPrefix('bp-daemon-owner-'));
  const paths = testPaths(root);
  t.after(() => rm(root, { recursive: true, force: true }));

  const processStartIdentity = readProcessStartIdentitySync(process.pid);
  assert.equal(typeof processStartIdentity, 'string');
  const owner = acquireDaemonOwnerLockSync({ paths });
  assert.equal(owner.record.pid, process.pid);
  assert.equal(owner.record.processStartIdentity, processStartIdentity);
  assert.deepEqual(readDaemonOwnerSync(paths), owner.record);
  assert.throws(
    () => acquireDaemonOwnerLockSync({ paths }),
    error => error?.code === 'daemon_already_running' && /already owns/.test(error.message),
  );
  owner.release();
  await assert.rejects(access(paths.daemonOwnerLockFile));
});

test('daemon owner reclaims a recycled live pid without signaling it', async t => {
  const root = await mkdtemp(testTempPrefix('bp-recycled-daemon-owner-'));
  const paths = testPaths(root);
  const foreignPid = 41_001;
  const replacementPid = 41_002;
  t.after(() => rm(root, { recursive: true, force: true }));

  const abandoned = acquireDaemonOwnerLockSync({
    paths,
    pid: foreignPid,
    processStartIdentity: () => 'test:start:original',
  });
  const livenessChecks = [];
  const replacement = acquireDaemonOwnerLockSync({
    paths,
    pid: replacementPid,
    processAlive: pid => {
      livenessChecks.push(pid);
      return pid === foreignPid;
    },
    processStartIdentity: pid => (
      pid === replacementPid ? 'test:start:replacement' : 'test:start:recycled'
    ),
  });

  assert.deepEqual(livenessChecks, [foreignPid]);
  assert.equal(replacement.record.pid, replacementPid);
  assert.equal(readDaemonOwnerSync(paths).token, replacement.record.token);
  abandoned.release();
  assert.equal(readDaemonOwnerSync(paths).token, replacement.record.token);
  replacement.release();
});

test('daemon owner fails closed when a live owner start identity is unreadable', async t => {
  const root = await mkdtemp(testTempPrefix('bp-unreadable-daemon-owner-'));
  const paths = testPaths(root);
  const ownerPid = 42_001;
  const contenderPid = 42_002;
  t.after(() => rm(root, { recursive: true, force: true }));

  const owner = acquireDaemonOwnerLockSync({
    paths,
    pid: ownerPid,
    processStartIdentity: () => 'test:start:owner',
  });
  await writeFile(paths.pidFile, 'owner state\n', { mode: 0o600 });
  assert.throws(
    () => acquireDaemonOwnerLockSync({
      paths,
      pid: contenderPid,
      processAlive: pid => pid === ownerPid,
      processStartIdentity: pid => (
        pid === contenderPid ? 'test:start:contender' : undefined
      ),
    }),
    error => error?.code === 'daemon_owner_unverifiable' &&
      /Inspect or stop the recorded process/.test(error.message) &&
      /BROWSER_PILOT_HOME/.test(error.message),
  );
  assert.equal(readDaemonOwnerSync(paths).token, owner.record.token);
  assert.equal(await readFile(paths.pidFile, 'utf8'), 'owner state\n');
  owner.release();
});

test('late stale daemon cleanup preserves replacement state and endpoint', async t => {
  const root = await mkdtemp(testTempPrefix('bp-late-daemon-cleanup-'));
  const paths = testPaths(root);
  const stale = acquireDaemonOwnerLockSync({
    paths,
    pid: 43_001,
    processStartIdentity: () => 'test:start:stale',
  });
  const replacement = acquireDaemonOwnerLockSync({
    paths,
    pid: 43_002,
    processAlive: () => false,
    processStartIdentity: () => 'test:start:replacement',
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  replacement.clearStaleBrokerState();
  const locator = {
    schemaVersion: 1,
    pid: replacement.record.pid,
    endpoint: paths.endpoint,
    transport: paths.transport,
    startedAt: 1_234,
    brokerProcessIdentity: 'broker:replacement',
  };
  writeBrokerLocatorSync(locator, paths);
  if (paths.transport === 'unix_socket') {
    await writeFile(paths.endpoint, 'replacement endpoint\n', { mode: 0o600 });
  }

  stale.cleanup('broker:stale');

  assert.equal(readDaemonOwnerSync(paths).token, replacement.record.token);
  assert.deepEqual(readBrokerLocatorSync(paths), locator);
  if (paths.transport === 'unix_socket') {
    assert.equal(await readFile(paths.endpoint, 'utf8'), 'replacement endpoint\n');
  }
  replacement.cleanup(locator.brokerProcessIdentity);
});
