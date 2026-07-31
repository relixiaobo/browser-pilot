import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { supportedBrowserProfiles } from '../dist/services.js';
import { waitFor } from './helpers/async.mjs';
import { startCdpFixture } from './helpers/cdp.mjs';
import {
  daemonRequest,
  setDaemonToken,
  stopDaemon,
} from './helpers/daemon.mjs';
import {
  isolatedBrokerEnvironment,
  testBrokerPaths,
  testTempPrefix,
} from './helpers/platform.mjs';

async function startHangingHandshakeFixture() {
  const sockets = new Set();
  const server = http.createServer();
  server.on('upgrade', (_request, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
  return {
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

test('daemon disconnects a half-open CDP connection after two missed default keepalives', {
  timeout: 40_000,
}, async t => {
  const root = await mkdtemp(testTempPrefix('bp-daemon-keepalive-'));
  const profile = join(root, 'profile');
  const socketPath = testBrokerPaths(root).endpoint;
  await mkdir(profile, { recursive: true });
  const cdp = await startCdpFixture({ autoPong: false });
  await writeFile(
    join(profile, 'DevToolsActivePort'),
    `${cdp.port}\n/devtools/browser/half-open\n`,
  );
  let pingCount = 0;
  cdp.server.on('connection', socket => socket.on('ping', () => { pingCount += 1; }));
  const stderr = [];
  const child = spawn(process.execPath, [
    join(process.cwd(), 'dist', 'daemon.js'),
    'Chrome',
    profile,
  ], {
    env: isolatedBrokerEnvironment(root),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', bytes => stderr.push(bytes.toString()));
  t.after(async () => {
    await stopDaemon(socketPath).catch(() => {});
    if (child.exitCode === null) child.kill('SIGTERM');
    await cdp.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  await registerEndpointToken(root);
  const client = await initializeClient(socketPath, 'bridge:keepalive');
  await connectBrowser(socketPath, client, 'command:keepalive-connect');
  await waitFor(() => daemonRequest(socketPath, '/health'), value => (
    value.browser?.state === 'connected'
  ));
  const startedAt = Date.now();
  const disconnected = await waitFor(
    () => daemonRequest(socketPath, '/health'),
    value => value.browser?.state === 'disconnected',
    32_000,
  );

  assert.equal(disconnected.browser.connectionGeneration, 1);
  assert.ok(Date.now() - startedAt < 30_000);
  assert.ok(pingCount >= 2);
  assert.equal(stderr.join(''), '');
});

test('daemon distinguishes stale endpoints from authorization handshake timeouts', {
  timeout: 20_000,
}, async t => {
  const root = await mkdtemp(testTempPrefix('bp-daemon-connect-diagnosis-'));
  const browserEnv = isolatedBrokerEnvironment(root);
  const profile = supportedBrowserProfiles({ homeDir: root, env: browserEnv })[0]?.dataDir;
  assert.ok(profile, `No supported browser profile is defined for ${process.platform}`);
  const socketPath = testBrokerPaths(root).endpoint;
  await mkdir(profile, { recursive: true });
  const child = spawn(process.execPath, [
    join(process.cwd(), 'dist', 'daemon.js'),
    'Chrome',
    profile,
  ], {
    env: browserEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr = [];
  child.stderr.on('data', bytes => stderr.push(bytes.toString()));
  let hanging;
  t.after(async () => {
    await stopDaemon(socketPath).catch(() => {});
    if (child.exitCode === null) child.kill('SIGTERM');
    await hanging?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  await registerEndpointToken(root);
  const initialized = await waitFor(
    () => daemonRequest(socketPath, '/broker/rpc', {
      clientSessionId: 'bridge:connect-diagnosis',
      method: 'initialize',
      params: {
        client: {
          id: 'com.example.connect-diagnosis',
          name: 'Connect Diagnosis',
          version: '1.0.0',
          instanceId: 'instance:connect-diagnosis',
        },
        protocol: { min: { major: 1, minor: 1 }, max: { major: 1, minor: 1 } },
        requestedCapabilities: ['browser.control', 'workspace.manage'],
      },
    }),
    value => value.result?.browsers?.length > 0,
  );
  const browser = initialized.result.browsers.find(candidate => candidate.profile === profile);
  assert.ok(browser);
  const created = await daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId: 'bridge:connect-diagnosis',
    method: 'workspaces/create',
    params: { browserId: browser.id },
  });
  const leased = await daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId: 'bridge:connect-diagnosis',
    method: 'leases/create',
    params: { workspaceId: created.result.workspace.id },
  });
  const connect = commandId => daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId: 'bridge:connect-diagnosis',
    method: 'tools/call',
    params: {
      name: 'browser.connect',
      arguments: { browserId: browser.id },
      workspaceId: created.result.workspace.id,
      leaseId: leased.result.lease.id,
      commandId,
    },
  });

  const closedServer = http.createServer();
  await new Promise((resolve, reject) => {
    closedServer.once('listening', resolve);
    closedServer.once('error', reject);
    closedServer.listen(0, '127.0.0.1');
  });
  const stalePort = closedServer.address().port;
  await new Promise(resolve => closedServer.close(resolve));
  await writeFile(join(profile, 'DevToolsActivePort'), `${stalePort}\n/devtools/browser/stale\n`);
  const stale = await connect('command:stale-endpoint');
  assert.equal(stale.error.data.code, 'browser_disconnected');
  assert.equal(stale.error.data.remediation.code, 'start_browser');

  hanging = await startHangingHandshakeFixture();
  await writeFile(
    join(profile, 'DevToolsActivePort'),
    `${hanging.port}\n/devtools/browser/authorization-pending\n`,
  );
  const authorization = await connect('command:authorization-timeout');
  assert.equal(authorization.error.data.code, 'browser_not_authorized');
  assert.equal(authorization.error.data.remediation.code, 'allow_remote_debugging');
  assert.equal(stderr.join(''), '');
});

async function registerEndpointToken(root) {
  const paths = testBrokerPaths(root);
  const locator = await waitFor(
    async () => {
      try { return JSON.parse(await readFile(paths.locatorFile, 'utf8')); }
      catch { return undefined; }
    },
    value => typeof value?.token === 'string',
  );
  setDaemonToken(paths.endpoint, locator.token);
}

async function initializeClient(socketPath, clientSessionId, capabilities = [
  'browser.control',
  'workspace.manage',
]) {
  const initialized = await waitFor(
    () => daemonRequest(socketPath, '/broker/rpc', {
      clientSessionId,
      method: 'initialize',
      params: {
        client: {
          id: 'com.example.daemon-test',
          name: 'Daemon Test',
          version: '1.0.0',
          instanceId: `instance:${clientSessionId}`,
        },
        protocol: { min: { major: 1, minor: 1 }, max: { major: 1, minor: 1 } },
        requestedCapabilities: capabilities,
      },
    }),
    value => value.result?.browsers?.length > 0,
  );
  const browserId = initialized.result.browsers[0].id;
  const created = await daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId,
    method: 'workspaces/create',
    params: { browserId },
  });
  const leased = await daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId,
    method: 'leases/create',
    params: { workspaceId: created.result.workspace.id },
  });
  return {
    initialized,
    clientSessionId,
    browserId,
    workspaceId: created.result.workspace.id,
    leaseId: leased.result.lease.id,
    eventCursor: created.result.eventCursor,
  };
}

function connectBrowser(socketPath, client, commandId) {
  return daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId: client.clientSessionId,
    method: 'tools/call',
    params: {
      name: 'browser.connect',
      arguments: { browserId: client.browserId },
      workspaceId: client.workspaceId,
      leaseId: client.leaseId,
      commandId,
    },
  });
}

test('daemon rediscovers the selected profile and publishes one restored generation', async t => {
  const root = await mkdtemp(testTempPrefix('bp-daemon-reconnect-'));
  const profile = join(root, 'profile');
  const socketPath = testBrokerPaths(root).endpoint;
  await mkdir(profile, { recursive: true });
  let first = await startCdpFixture();
  await writeFile(
    join(profile, 'DevToolsActivePort'),
    `${first.port}\n/devtools/browser/first\n`,
  );
  let second;
  const stderr = [];
  const child = spawn(process.execPath, [
    join(process.cwd(), 'dist', 'daemon.js'),
    'Chrome',
    profile,
  ], {
    env: isolatedBrokerEnvironment(root),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', bytes => stderr.push(bytes.toString()));
  t.after(async () => {
    await stopDaemon(socketPath).catch(() => {});
    if (child.exitCode === null) child.kill('SIGTERM');
    await first?.close().catch(() => {});
    await second?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  await registerEndpointToken(root);
  const client = await initializeClient(socketPath, 'bridge:daemon-test', [
    'browser.control',
    'workspace.manage',
    'event.read',
  ]);
  const initialConnect = await connectBrowser(
    socketPath,
    client,
    'command:initial-connect',
  );
  assert.equal(initialConnect.result.result.state, 'connected');
  const initial = await waitFor(() => daemonRequest(socketPath, '/health'), value => (
    value.browser?.state === 'connected'
  ));
  assert.equal(initial.browser.connectionGeneration, 1);
  const baseline = await daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId: client.clientSessionId,
    method: 'events/poll',
    params: { workspaceId: client.workspaceId, cursor: client.eventCursor },
  });
  client.eventCursor = baseline.result.nextCursor;

  await first.close();
  first = undefined;
  const disconnected = await waitFor(
    () => daemonRequest(socketPath, '/health'),
    value => value.browser?.state === 'disconnected' || value.browser?.state === 'reconnecting',
  );
  assert.equal(disconnected.browser.connectionGeneration, 1);

  second = await startCdpFixture();
  await writeFile(
    join(profile, 'DevToolsActivePort'),
    `${second.port}\n/devtools/browser/second\n`,
  );
  const connected = await daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId: client.clientSessionId,
    method: 'tools/call',
    params: {
      name: 'browser.connect',
      arguments: { browserId: client.browserId },
      workspaceId: client.workspaceId,
      leaseId: client.leaseId,
      commandId: 'command:explicit-reconnect',
    },
  });
  assert.equal(connected.result.result.state, 'connected');
  const restored = await waitFor(
    () => daemonRequest(socketPath, '/health'),
    value => value.browser?.state === 'connected' && value.browser.connectionGeneration === 2,
    10_000,
  );
  assert.equal('wsUrl' in restored, false);

  const replayed = await daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId: client.clientSessionId,
    method: 'events/poll',
    params: {
      workspaceId: client.workspaceId,
      cursor: client.eventCursor,
    },
  });
  assert.deepEqual(replayed.result.events
    .filter(event => event.type === 'connection.lost' || event.type === 'connection.restored')
    .map(event => event.type), [
    'connection.lost',
    'connection.restored',
  ]);
  assert.equal(stderr.join(''), '');
});

test('daemon initializes with structured remediation before remote debugging is enabled', async t => {
  const root = await mkdtemp(testTempPrefix('bp-daemon-discovery-'));
  const profile = join(root, 'profile');
  const socketPath = testBrokerPaths(root).endpoint;
  await mkdir(profile, { recursive: true });
  const stderr = [];
  const child = spawn(process.execPath, [
    join(process.cwd(), 'dist', 'daemon.js'),
    'Chrome',
    profile,
  ], {
    env: isolatedBrokerEnvironment(root, { PATH: '' }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', bytes => stderr.push(bytes.toString()));
  let cdp;
  t.after(async () => {
    await stopDaemon(socketPath).catch(() => {});
    if (child.exitCode === null) child.kill('SIGTERM');
    await cdp?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  await registerEndpointToken(root);
  const health = await waitFor(
    () => daemonRequest(socketPath, '/health'),
    value => value.ok === true,
  );
  assert.equal(health.browser.state, 'disconnected');

  const initialized = await daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId: 'bridge:discovery-test',
    method: 'initialize',
    params: {
      client: {
        id: 'com.example.discovery-test',
        name: 'Discovery Test',
        version: '1.0.0',
        instanceId: 'instance:discovery-test',
      },
      protocol: { min: { major: 1, minor: 1 }, max: { major: 1, minor: 1 } },
      requestedCapabilities: ['browser.discovery', 'browser.control', 'workspace.manage'],
    },
  });
  const selected = initialized.result.browsers.find(browser => browser.profile === profile);
  assert.ok(selected);
  assert.equal(selected.state, 'not_running');
  assert.equal(selected.remediation.code, 'start_browser');

  const discovered = await daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId: 'bridge:discovery-test',
    method: 'tools/call',
    params: { name: 'browser.discover', arguments: {} },
  });
  assert.equal(discovered.result.command.status, 'completed');
  const discoveredSelected = discovered.result.result.browsers.find(browser => browser.id === selected.id);
  assert.ok(discoveredSelected);
  assert.equal(discoveredSelected.remoteDebuggingState, 'disabled');

  const created = await daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId: 'bridge:discovery-test',
    method: 'workspaces/create',
    params: { browserId: selected.id },
  });
  const leased = await daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId: 'bridge:discovery-test',
    method: 'leases/create',
    params: { workspaceId: created.result.workspace.id },
  });

  cdp = await startCdpFixture();
  await writeFile(
    join(profile, 'DevToolsActivePort'),
    `${cdp.port}\n/devtools/browser/enabled\n`,
  );
  const connected = await daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId: 'bridge:discovery-test',
    method: 'tools/call',
    params: {
      name: 'browser.connect',
      arguments: { browserId: selected.id },
      workspaceId: created.result.workspace.id,
      leaseId: leased.result.lease.id,
      commandId: 'command:explicit-connect',
    },
  });
  assert.equal(connected.result.result.state, 'connected');
  await waitFor(
    () => daemonRequest(socketPath, '/health'),
    value => value.browser?.state === 'connected' && value.browser.connectionGeneration === 1,
    10_000,
  );
  assert.equal(created.result.workspace.browserInstanceId, `browser-instance:${selected.id.slice('browser:'.length)}`);
  assert.equal(stderr.join(''), '');
});
