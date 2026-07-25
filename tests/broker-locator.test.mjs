import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  acquireBrokerStartupLock,
  ensureBrokerDirectoriesSync,
  readBrokerLocatorSync,
  removeBrokerLocatorSync,
  resolveBrowserPilotPaths,
  writeBrokerLocatorSync,
} from '../dist/services.js';

function testPaths(root) {
  return resolveBrowserPilotPaths({
    platform: 'darwin',
    homeDir: root,
    tempDir: '/tmp',
    env: { BROWSER_PILOT_HOME: join(root, '.browser-pilot') },
    uid: 501,
  });
}

test('platform path resolution uses a private short Unix endpoint and a per-user Windows pipe', () => {
  const short = resolveBrowserPilotPaths({
    platform: 'darwin', homeDir: '/Users/alice', tempDir: '/tmp', env: {}, uid: 501,
  });
  assert.equal(short.stateDir, '/Users/alice/.browser-pilot');
  assert.equal(short.endpoint, '/Users/alice/.browser-pilot/daemon.sock');
  assert.equal(short.transport, 'unix_socket');

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

  const windows = resolveBrowserPilotPaths({
    platform: 'win32', homeDir: 'C:\\Users\\Alice', tempDir: 'C:\\Temp',
    env: { LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local' }, username: 'Alice',
  });
  assert.equal(windows.stateDir, 'C:\\Users\\Alice\\AppData\\Local\\Browser Pilot');
  assert.match(windows.endpoint, /^\\\\\.\\pipe\\browser-pilot-[a-f0-9]{16}$/);
  assert.equal(windows.transport, 'windows_pipe');
});

test('Broker locator files are private, validated, and removed only by their owner', async t => {
  const root = await mkdtemp('/tmp/bp-locator-');
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

test('startup lock serializes contenders and safely reclaims a dead owner', async t => {
  const root = await mkdtemp('/tmp/bp-start-lock-');
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
