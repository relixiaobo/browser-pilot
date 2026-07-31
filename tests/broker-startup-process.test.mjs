import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { supportedBrowserProfiles } from '../dist/services.js';
import {
  forceKillChild,
  forceKillProcess,
  isolatedBrokerEnvironment,
  testBrokerPaths,
  testTempPrefix,
} from './helpers/platform.mjs';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const DAEMON = join(process.cwd(), 'dist', 'daemon.js');

function runCli(root, args, env = {}, cliPath = CLI) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: isolatedBrokerEnvironment(root, { PATH: '', ...env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes.toString(); });
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function daemonRequest(socketPath, path, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path,
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function stopDaemon(socketPath) {
  const health = await daemonRequest(socketPath, '/health');
  if (!health.ok) return;
  return daemonRequest(socketPath, '/shutdown', {
    brokerProcessIdentity: health.brokerProcessIdentity,
    executableVersion: health.executableVersion,
    executableIdentity: health.executableIdentity,
  });
}

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForValue(read, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for expected value');
}

async function startPassiveBroker(root, options = {}) {
  const profile = options.profile ?? join(root, 'profile');
  const stateDir = testBrokerPaths(root, options.env).stateDir;
  await mkdir(profile, { recursive: true });
  const child = spawn(process.execPath, [
    DAEMON,
    options.product ?? 'Chrome',
    profile,
  ], {
    env: isolatedBrokerEnvironment(root, { PATH: '', ...options.env }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  await waitForFile(join(stateDir, 'broker-locator.json'));
  return { child, profile, stderr: () => stderr };
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 5_000)),
  ]);
  forceKillChild(child);
}

async function initializeClient(socketPath, clientSessionId, options = {}) {
  const initialized = await daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId,
    method: 'initialize',
    params: {
      client: {
        id: options.clientId ?? 'com.example.startup-test',
        name: 'Startup Test',
        version: options.clientVersion ?? '1.0.0',
        instanceId: options.instanceId ?? clientSessionId,
      },
      protocol: options.protocol ?? {
        min: { major: 1, minor: 1 }, max: { major: 1, minor: 3 },
      },
      requestedCapabilities: options.capabilities ?? ['browser.control', 'workspace.manage'],
    },
  });
  if (initialized.error) return initialized;
  const browserId = initialized.result.browsers[0]?.id;
  const created = await daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId,
    method: 'workspaces/create',
    params: browserId ? { browserId } : {},
  });
  if (created.error) return created;
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
  };
}

async function releaseClient(socketPath, client) {
  await daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId: client.clientSessionId,
    method: 'workspaces/release',
    params: { workspaceId: client.workspaceId },
  });
}

async function startGatedCdpFixture() {
  const server = http.createServer();
  const websocket = new WebSocketServer({ noServer: true });
  const upgrades = [];
  let released = false;
  let connectionCount = 0;
  let upgradeCount = 0;
  const accept = ({ request, socket, head }) => {
    websocket.handleUpgrade(request, socket, head, client => {
      websocket.emit('connection', client, request);
    });
  };
  server.on('upgrade', (request, socket, head) => {
    upgradeCount += 1;
    const upgrade = { request, socket, head };
    const remove = () => {
      const index = upgrades.indexOf(upgrade);
      if (index >= 0) upgrades.splice(index, 1);
    };
    socket.once('end', () => {
      remove();
      socket.destroy();
    });
    socket.once('close', remove);
    if (released) accept(upgrade);
    else upgrades.push(upgrade);
  });
  websocket.on('connection', socket => {
    connectionCount += 1;
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      socket.send(JSON.stringify({
        id: message.id,
        result: message.method === 'Target.getTargets' ? { targetInfos: [] } : {},
      }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    wsUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/gated`,
    get connectionCount() { return connectionCount; },
    get upgradeCount() { return upgradeCount; },
    get pendingUpgradeCount() { return upgrades.length; },
    disconnectClients() {
      for (const socket of websocket.clients) socket.terminate();
    },
    release() {
      if (released) return;
      released = true;
      for (const upgrade of upgrades.splice(0)) accept(upgrade);
    },
    async close() {
      this.release();
      for (const socket of websocket.clients) socket.terminate();
      await new Promise(resolve => websocket.close(resolve));
      await new Promise(resolve => server.close(resolve));
    },
  };
}

test('simultaneous CLI processes start and reuse exactly one per-user Broker', async t => {
  const root = await mkdtemp(testTempPrefix('bp-startup-process-'));
  const paths = testBrokerPaths(root);
  const stateDir = paths.stateDir;
  const socketPath = paths.endpoint;
  t.after(async () => {
    await stopDaemon(socketPath).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  await Promise.all([
    runCli(root, ['connect']),
    runCli(root, ['connect']),
  ]);
  const health = await daemonRequest(socketPath, '/health');
  const locator = JSON.parse(await readFile(join(stateDir, 'broker-locator.json'), 'utf8'));
  assert.equal(health.brokerProcessIdentity, locator.brokerProcessIdentity);
  assert.equal(health.brokerProtocol, 2);
  assert.equal(locator.endpoint, socketPath);
  assert.equal(locator.transport, paths.transport);
  assert.equal(locator.schemaVersion, 2);
  assert.equal(locator.serviceVersion, locator.executable.version);
  assert.deepEqual(locator.protocol, {
    min: { major: 1, minor: 0 }, max: { major: 1, minor: 3 },
  });

  forceKillProcess(locator.pid);
  await waitForValue(() => {
    try { process.kill(locator.pid, 0); return false; } catch { return true; }
  }, Boolean);

  await runCli(root, ['connect']);
  const recovered = JSON.parse(await readFile(join(stateDir, 'broker-locator.json'), 'utf8'));
  assert.notEqual(recovered.brokerProcessIdentity, locator.brokerProcessIdentity);
});

test('passive Broker startup and concurrent explicit connects create exactly one authorization request', async t => {
  const root = await mkdtemp(testTempPrefix('bp-explicit-authorization-'));
  const socketPath = testBrokerPaths(root).endpoint;
  const browserEnv = isolatedBrokerEnvironment(root, {
    PATH: '',
  });
  const profile = supportedBrowserProfiles({ homeDir: root, env: browserEnv })[0]?.dataDir;
  assert.ok(profile, `No supported browser profile is defined for ${process.platform}`);
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'SingletonLock'), 'fixture');
  const cdp = await startGatedCdpFixture();
  const port = new URL(cdp.wsUrl).port;
  await writeFile(join(profile, 'DevToolsActivePort'), `${port}\n/devtools/browser/gated\n`);
  const broker = await startPassiveBroker(root, { profile, env: browserEnv });
  t.after(async () => {
    await terminateChild(broker.child);
    await cdp.close();
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(cdp.upgradeCount, 0, 'Broker startup must not request browser authorization');
  const [first, second] = await Promise.all([
    initializeClient(socketPath, 'client:authorization-first'),
    initializeClient(socketPath, 'client:authorization-second'),
  ]);
  assert.equal(cdp.upgradeCount, 0, 'discovery and Workspace creation must remain passive');

  const connect = (client, commandId) => daemonRequest(socketPath, '/broker/rpc', {
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
  const firstConnect = connect(first, 'command:authorization-first');
  await waitForValue(() => cdp.pendingUpgradeCount, value => value === 1);
  const secondConnect = connect(second, 'command:authorization-second');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(cdp.upgradeCount, 1);
  assert.equal(cdp.pendingUpgradeCount, 1);

  cdp.release();
  const connected = await Promise.all([firstConnect, secondConnect]);
  assert.deepEqual(connected.map(response => response.result.result.state), ['connected', 'connected']);
  assert.equal(cdp.upgradeCount, 1);

  cdp.disconnectClients();
  await waitForValue(
    () => daemonRequest(socketPath, '/health'),
    health => health.browser?.state === 'disconnected',
  );
  await new Promise(resolve => setTimeout(resolve, 2_250));
  assert.equal(cdp.upgradeCount, 1, 'a dropped browser connection must not start an authorization loop');
});

test('CLI reuses a Broker while an explicit browser connection is pending', async t => {
  const root = await mkdtemp(testTempPrefix('bp-starting-broker-'));
  const paths = testBrokerPaths(root);
  const stateDir = paths.stateDir;
  const cdp = await startGatedCdpFixture();
  const profile = join(root, 'profile');
  const endpoint = new URL(cdp.wsUrl);
  await mkdir(profile, { recursive: true });
  await writeFile(
    join(profile, 'DevToolsActivePort'),
    `${endpoint.port}\n${endpoint.pathname}\n`,
  );
  const broker = await startPassiveBroker(root, { profile });
  t.after(async () => {
    await terminateChild(broker.child);
    await cdp.close();
    await rm(root, { recursive: true, force: true });
  });

  const client = await initializeClient(paths.endpoint, 'client:pending-browser-connect');
  const pendingConnect = daemonRequest(paths.endpoint, '/broker/rpc', {
    clientSessionId: client.clientSessionId,
    method: 'tools/call',
    params: {
      name: 'browser.connect',
      arguments: { browserId: client.browserId },
      workspaceId: client.workspaceId,
      leaseId: client.leaseId,
      commandId: 'command:pending-browser-connect',
    },
  });
  await waitForValue(() => cdp.pendingUpgradeCount, value => value === 1);
  const command = runCli(root, ['connect']);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(cdp.upgradeCount, 1);
  cdp.release();
  const [connected] = await Promise.all([pendingConnect, command]);

  const locator = JSON.parse(await readFile(join(stateDir, 'broker-locator.json'), 'utf8'));
  assert.equal(locator.pid, broker.child.pid);
  assert.equal(connected.result.result.state, 'connected');
  assert.equal(cdp.connectionCount, 1);
  assert.equal(broker.stderr(), '');
});

test('terminating an authorization-pending Broker removes its worker and starting record', async t => {
  const root = await mkdtemp(testTempPrefix('bp-stopping-broker-'));
  const stateDir = testBrokerPaths(root).stateDir;
  const cdp = await startGatedCdpFixture();
  const profile = join(root, 'profile');
  const endpoint = new URL(cdp.wsUrl);
  await mkdir(profile, { recursive: true });
  await writeFile(
    join(profile, 'DevToolsActivePort'),
    `${endpoint.port}\n${endpoint.pathname}\n`,
  );
  const broker = await startPassiveBroker(root, { profile });
  t.after(async () => {
    await terminateChild(broker.child);
    await cdp.close();
    await rm(root, { recursive: true, force: true });
  });

  const pidFile = join(stateDir, 'daemon.pid');
  const client = await initializeClient(testBrokerPaths(root).endpoint, 'client:stopping-connect');
  void daemonRequest(testBrokerPaths(root).endpoint, '/broker/rpc', {
    clientSessionId: client.clientSessionId,
    method: 'tools/call',
    params: {
      name: 'browser.connect',
      arguments: { browserId: client.browserId },
      workspaceId: client.workspaceId,
      leaseId: client.leaseId,
      commandId: 'command:stopping-connect',
    },
  }).catch(() => {});
  await waitForValue(() => cdp.pendingUpgradeCount, value => value === 1);
  await terminateChild(broker.child);
  await waitForValue(() => cdp.pendingUpgradeCount, value => value === 0);
  await assert.rejects(access(pidFile));
  assert.equal(broker.stderr(), '');
});

test('incompatible clients fail without replacing the running Broker', async t => {
  const root = await mkdtemp(testTempPrefix('bp-incompatible-process-'));
  const socketPath = testBrokerPaths(root).endpoint;
  const broker = await startPassiveBroker(root);
  t.after(async () => {
    await terminateChild(broker.child);
    await rm(root, { recursive: true, force: true });
  });

  const healthBefore = await daemonRequest(socketPath, '/health');
  const unauthorizedShutdown = await daemonRequest(socketPath, '/shutdown', {
    brokerProcessIdentity: healthBefore.brokerProcessIdentity,
    executableVersion: '999.0.0',
    executableIdentity: 'executable:not-the-running-installation',
  });
  const incompatible = await initializeClient(socketPath, 'client:incompatible', {
    protocol: { min: { major: 2, minor: 0 }, max: { major: 2, minor: 1 } },
  });
  const healthAfter = await daemonRequest(socketPath, '/health');

  assert.equal(unauthorizedShutdown.error.data.code, 'protocol_incompatible');
  assert.equal(unauthorizedShutdown.error.data.remediation.code, 'use_matching_executable_or_isolate');
  assert.equal(incompatible.error.data.code, 'protocol_incompatible');
  assert.equal(incompatible.error.data.remediation.code, 'use_compatible_executable_or_isolate');
  assert.equal(healthAfter.brokerProcessIdentity, healthBefore.brokerProcessIdentity);
  assert.equal(healthAfter.clients.connections, 0);
});

test('a second daemon refuses the live owner without disturbing it', async t => {
  const root = await mkdtemp(testTempPrefix('bp-single-daemon-'));
  const paths = testBrokerPaths(root);
  const first = await startPassiveBroker(root);
  const second = await startPassiveBroker(root, { profile: join(root, 'second-profile') });
  t.after(async () => {
    await Promise.all([terminateChild(first.child), terminateChild(second.child)]);
    await rm(root, { recursive: true, force: true });
  });

  const before = await daemonRequest(paths.endpoint, '/health');
  const secondExit = await waitForValue(
    () => Promise.resolve({ code: second.child.exitCode, signal: second.child.signalCode }),
    result => result.code !== null || result.signal !== null,
  );
  const after = await daemonRequest(paths.endpoint, '/health');
  const owner = JSON.parse(await readFile(paths.daemonOwnerLockFile, 'utf8'));

  assert.equal(secondExit.code, 1);
  assert.match(second.stderr(), /daemon_already_running/);
  assert.match(second.stderr(), /Another Browser Pilot daemon already owns this home/);
  assert.equal(after.brokerProcessIdentity, before.brokerProcessIdentity);
  assert.equal(owner.pid, first.child.pid);
  assert.equal(first.stderr(), '');
});

test('a daemon reclaims owner state after the previous process is killed', {
  skip: process.platform === 'win32' ? 'Windows has no SIGKILL signal' : false,
}, async t => {
  const root = await mkdtemp(testTempPrefix('bp-reclaim-daemon-'));
  const paths = testBrokerPaths(root);
  const first = await startPassiveBroker(root);
  let second;
  t.after(async () => {
    await terminateChild(first.child);
    if (second) await terminateChild(second.child);
    await rm(root, { recursive: true, force: true });
  });

  const before = await daemonRequest(paths.endpoint, '/health');
  forceKillChild(first.child);
  await new Promise(resolve => first.child.once('exit', resolve));

  second = await startPassiveBroker(root, { profile: join(root, 'replacement-profile') });
  const after = await waitForValue(
    async () => {
      try { return await daemonRequest(paths.endpoint, '/health'); } catch { return undefined; }
    },
    health => health?.brokerProcessIdentity !== undefined &&
      health.brokerProcessIdentity !== before.brokerProcessIdentity,
  );
  const owner = JSON.parse(await readFile(paths.daemonOwnerLockFile, 'utf8'));
  const locator = JSON.parse(await readFile(paths.locatorFile, 'utf8'));

  assert.equal(after.ok, true);
  assert.equal(owner.pid, second.child.pid);
  assert.equal(locator.pid, second.child.pid);
  assert.equal(second.stderr(), '');
});

test('compatible CLI installations reuse one Broker while shutdown ownership stays exact', async t => {
  const root = await mkdtemp(testTempPrefix('bp-compatible-install-process-'));
  const socketPath = testBrokerPaths(root).endpoint;
  const alternateRoot = join(root, 'alternate-installation');
  const alternateDist = join(alternateRoot, 'dist');
  const alternateCli = join(alternateDist, 'cli.js');
  const broker = await startPassiveBroker(root);
  t.after(async () => {
    await terminateChild(broker.child);
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(alternateDist, { recursive: true });
  await copyFile(CLI, alternateCli);
  await writeFile(join(alternateRoot, 'package.json'), JSON.stringify({
    name: 'browser-pilot-compatible-fixture',
    version: '9.9.9',
    type: 'module',
  }));
  await symlink(
    join(process.cwd(), 'node_modules'),
    join(alternateRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const original = await runCli(root, ['status']);
  const alternate = await runCli(root, ['status'], {}, alternateCli);
  assert.equal(original.code, 0, original.stderr);
  assert.equal(alternate.code, 0, alternate.stderr);
  const beforeDisconnect = await daemonRequest(socketPath, '/health');

  const released = await runCli(root, ['disconnect'], {}, alternateCli);
  assert.equal(released.code, 0, released.stderr);
  const stillRunning = await daemonRequest(socketPath, '/health');
  assert.equal(stillRunning.brokerProcessIdentity, beforeDisconnect.brokerProcessIdentity);
  assert.equal(stillRunning.clients.activeLeases, 0);

  const stopped = await runCli(root, ['disconnect']);
  assert.equal(stopped.code, 0, stopped.stderr);
  await waitForValue(async () => {
    try { await daemonRequest(socketPath, '/health'); return false; } catch { return true; }
  }, Boolean);
});

test('bp disconnect releases its namespace without stopping a Broker used by another Agent', async t => {
  const root = await mkdtemp(testTempPrefix('bp-live-client-process-'));
  const socketPath = testBrokerPaths(root).endpoint;
  const broker = await startPassiveBroker(root);
  t.after(async () => {
    await terminateChild(broker.child);
    await rm(root, { recursive: true, force: true });
  });

  const cliStatus = await runCli(root, ['status']);
  assert.equal(cliStatus.code, 0, cliStatus.stderr);
  const other = await initializeClient(socketPath, 'client:other-agent', {
    clientId: 'com.example.other-agent',
  });
  const before = await daemonRequest(socketPath, '/health');
  assert.equal(before.clients.activeLeases, 2);

  const disconnected = await runCli(root, ['disconnect']);
  assert.equal(disconnected.code, 0, disconnected.stderr);
  const stillRunning = await daemonRequest(socketPath, '/health');
  assert.equal(stillRunning.brokerProcessIdentity, before.brokerProcessIdentity);
  assert.equal(stillRunning.clients.activeLeases, 1);

  await releaseClient(socketPath, other);
  const stopped = await runCli(root, ['disconnect']);
  assert.equal(stopped.code, 0, stopped.stderr);
});

test('explicit BROWSER_PILOT_HOME isolation starts an independent Broker', async t => {
  const root = await mkdtemp(testTempPrefix('bp-version-isolation-'));
  const isolatedState = join(root, 'isolated-v2');
  const defaultState = testBrokerPaths(root).stateDir;
  const sharedBroker = await startPassiveBroker(root);
  const isolatedBroker = await startPassiveBroker(root, {
    profile: join(root, 'isolated-profile'),
    env: { BROWSER_PILOT_HOME: isolatedState },
  });
  t.after(async () => {
    await Promise.all([
      terminateChild(sharedBroker.child),
      terminateChild(isolatedBroker.child),
    ]);
    await rm(root, { recursive: true, force: true });
  });

  const [sharedLocator, isolatedLocator] = await Promise.all([
    readFile(join(defaultState, 'broker-locator.json'), 'utf8').then(JSON.parse),
    readFile(join(isolatedState, 'broker-locator.json'), 'utf8').then(JSON.parse),
  ]);
  assert.notEqual(sharedLocator.brokerProcessIdentity, isolatedLocator.brokerProcessIdentity);
  assert.notEqual(sharedLocator.endpoint, isolatedLocator.endpoint);
  assert.equal(sharedLocator.executable.identity, isolatedLocator.executable.identity);
});

test('a live but unresponsive Broker is reported and never silently replaced', async t => {
  const root = await mkdtemp(testTempPrefix('bp-unresponsive-process-'));
  const paths = testBrokerPaths(root);
  const stateDir = paths.stateDir;
  const socketPath = paths.endpoint;
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const locator = {
    schemaVersion: 1,
    pid: process.pid,
    endpoint: socketPath,
    transport: paths.transport,
    startedAt: Date.now(),
    brokerProcessIdentity: 'broker:live-but-unresponsive',
  };
  await writeFile(
    join(stateDir, 'broker-locator.json'),
    `${JSON.stringify(locator)}\n`,
    { mode: 0o600 },
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await runCli(root, ['connect']);
  assert.equal(result.code, 1, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.code, 'browser_disconnected');
  assert.equal(output.remediation.code, 'restart_unresponsive_broker');
  assert.deepEqual(
    JSON.parse(await readFile(join(stateDir, 'broker-locator.json'), 'utf8')),
    locator,
  );
  await assert.rejects(access(socketPath));
});
