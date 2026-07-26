import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { discoverBrowserCandidates } from '../dist/services.js';

async function definition(root, overrides = {}) {
  const dataDir = join(root, overrides.key ?? 'profile');
  const installPath = join(root, `${overrides.key ?? 'browser'}.app`);
  await mkdir(dataDir, { recursive: true });
  await mkdir(installPath, { recursive: true });
  return {
    key: overrides.key ?? 'chrome-stable',
    product: overrides.product ?? 'Chrome',
    channel: overrides.channel ?? 'stable',
    dataDir,
    installPaths: [installPath],
    executableNames: overrides.executableNames ?? ['Test Browser'],
  };
}

test('browser discovery passively returns stable structured candidates', async t => {
  const temp = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'browser-pilot-discovery-'));
  t.after(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  const ready = await definition(temp, { key: 'ready' });
  const disabled = await definition(temp, { key: 'disabled' });
  const stopped = await definition(temp, { key: 'stopped' });
  const authorization = await definition(temp, { key: 'authorization' });
  const stale = await definition(temp, { key: 'stale' });

  await writeFile(join(ready.dataDir, 'DevToolsActivePort'), '9222\n/devtools/browser/ready\n');
  await writeFile(join(authorization.dataDir, 'DevToolsActivePort'), '9223\n/devtools/browser/auth\n');
  await writeFile(join(stale.dataDir, 'DevToolsActivePort'), '9224\n/devtools/browser/stale\n');
  await symlink('host-102', join(ready.dataDir, 'SingletonLock'));
  await symlink('host-101', join(disabled.dataDir, 'SingletonLock'));
  await symlink('host-103', join(authorization.dataDir, 'SingletonLock'));

  const first = await discoverBrowserCandidates({
    platform: 'darwin',
    profiles: [ready, disabled, stopped, authorization, stale],
    runningCommands: [],
  });
  const second = await discoverBrowserCandidates({
    platform: 'darwin',
    profiles: [ready, disabled, stopped, authorization, stale],
    runningCommands: [],
  });

  assert.deepEqual(first.map(browser => browser.candidate.state), [
    'disconnected',
    'remote_debugging_disabled',
    'not_running',
    'disconnected',
    'disconnected',
  ]);
  assert.deepEqual(
    first.map(browser => browser.candidate.id),
    second.map(browser => browser.candidate.id),
  );
  assert.deepEqual(first[0].candidate, {
    id: first[0].candidate.id,
    product: 'Chrome',
    channel: 'stable',
    profile: ready.dataDir,
    processState: 'running',
    remoteDebuggingState: 'enabled',
    authorizationState: 'unknown',
    state: 'disconnected',
    remediation: {
      code: 'connect_browser',
      message: 'Run an explicit browser connect operation to request remote debugging authorization.',
      actionRequired: true,
    },
  });
  assert.equal(first[1].candidate.remediation.code, 'enable_remote_debugging');
  assert.equal(first[2].candidate.remediation.code, 'start_browser');
  assert.equal(first[3].candidate.remediation.code, 'connect_browser');
  assert.equal(first[4].candidate.remediation.code, 'restart_remote_debugging');
});

test('browser discovery omits products that are not installed and rejects malformed port files', async t => {
  const temp = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'browser-pilot-discovery-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const malformed = await definition(temp, { key: 'malformed' });
  await writeFile(join(malformed.dataDir, 'DevToolsActivePort'), 'not-a-port\ninvalid\n');
  const absent = {
    key: 'absent', product: 'Brave', channel: 'stable',
    dataDir: join(temp, 'absent-profile'),
    installPaths: [join(temp, 'absent.app')],
    executableNames: ['Absent Browser'],
  };

  const result = await discoverBrowserCandidates({
    platform: 'darwin',
    profiles: [malformed, absent],
    runningCommands: ['Test Browser'],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].candidate.state, 'remote_debugging_disabled');
  assert.equal(result[0].endpoint, undefined);
});

test('browser discovery opens no TCP or WebSocket connection', async t => {
  const temp = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'browser-pilot-discovery-'));
  const server = http.createServer();
  let tcpConnections = 0;
  let upgrades = 0;
  server.on('connection', () => { tcpConnections += 1; });
  server.on('upgrade', (_request, socket) => {
    upgrades += 1;
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  });

  const browser = await definition(temp, { key: 'passive' });
  await symlink('host-passive', join(browser.dataDir, 'SingletonLock'));
  await writeFile(
    join(browser.dataDir, 'DevToolsActivePort'),
    `${server.address().port}\n/devtools/browser/passive\n`,
  );
  const result = await discoverBrowserCandidates({
    platform: 'darwin',
    profiles: [browser],
    runningCommands: [],
  });

  assert.equal(result[0].candidate.remoteDebuggingState, 'enabled');
  assert.equal(tcpConnections, 0);
  assert.equal(upgrades, 0);
});
