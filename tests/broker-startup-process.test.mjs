import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';

const CLI = join(process.cwd(), 'dist', 'cli.js');

function bridgeInput(instanceId, options = {}) {
  return [
    {
      jsonrpc: '2.0', id: 'initialize', method: 'initialize',
      params: {
        client: {
          id: 'com.example.startup-test',
          name: 'Startup Test',
          version: options.clientVersion ?? '1.0.0',
          instanceId,
        },
        protocol: options.protocol ?? {
          min: { major: 1, minor: 1 }, max: { major: 1, minor: 1 },
        },
        requestedCapabilities: ['browser.discovery'],
        launchMode: 'embedded',
      },
    },
    { jsonrpc: '2.0', id: 'shutdown', method: 'shutdown', params: {} },
  ].map(message => JSON.stringify(message)).join('\n') + '\n';
}

function runBridge(root, instanceId, options = {}) {
  const child = spawn(process.execPath, [options.cliPath ?? CLI, 'bridge', '--stdio'], {
    env: { ...process.env, HOME: root, PATH: '', ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes.toString(); });
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  child.stdin.end(bridgeInput(instanceId, options));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolve({
        code,
        signal,
        stderr,
        messages: stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
      });
    });
  });
}

function runCli(root, args, env = {}, cliPath = CLI) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: { ...process.env, HOME: root, PATH: '', ...env },
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

async function startGatedCdpFixture() {
  const server = http.createServer();
  const websocket = new WebSocketServer({ noServer: true });
  const upgrades = [];
  let released = false;
  let connectionCount = 0;
  const accept = ({ request, socket, head }) => {
    websocket.handleUpgrade(request, socket, head, client => {
      websocket.emit('connection', client, request);
    });
  };
  server.on('upgrade', (request, socket, head) => {
    const upgrade = { request, socket, head };
    socket.once('close', () => {
      const index = upgrades.indexOf(upgrade);
      if (index >= 0) upgrades.splice(index, 1);
    });
    if (released) accept(upgrade);
    else upgrades.push(upgrade);
  });
  websocket.on('connection', socket => {
    connectionCount += 1;
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    wsUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/gated`,
    get connectionCount() { return connectionCount; },
    get pendingUpgradeCount() { return upgrades.length; },
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

function startLiveBridge(root, instanceId) {
  const child = spawn(process.execPath, [CLI, 'bridge', '--stdio'], {
    env: { ...process.env, HOME: root, PATH: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes.toString(); });
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  const initialized = new Promise((resolve, reject) => {
    child.once('error', reject);
    const inspect = () => {
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      child.stdout.off('data', inspect);
      resolve(JSON.parse(stdout.slice(0, newline)));
    };
    child.stdout.on('data', inspect);
  });
  child.stdin.write(`${JSON.stringify(JSON.parse(bridgeInput(instanceId).split('\n')[0]))}\n`);
  return { child, initialized, stderr: () => stderr };
}

test('simultaneous bridge processes start and reuse exactly one per-user Broker', async t => {
  const root = await mkdtemp('/tmp/bp-startup-process-');
  const stateDir = join(root, '.browser-pilot');
  const socketPath = join(stateDir, 'daemon.sock');
  t.after(async () => {
    await stopDaemon(socketPath).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const [first, second] = await Promise.all([
    runBridge(root, 'startup:first', { clientVersion: '1.0.0' }),
    runBridge(root, 'startup:second', { clientVersion: '9.4.0' }),
  ]);
  for (const result of [first, second]) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.deepEqual(result.messages.map(message => message.id), ['initialize', 'shutdown']);
    assert.equal(result.messages[0].error, undefined);
  }
  assert.equal(
    first.messages[0].result.brokerProcessIdentity,
    second.messages[0].result.brokerProcessIdentity,
  );

  const locator = JSON.parse(await readFile(join(stateDir, 'broker-locator.json'), 'utf8'));
  assert.equal(locator.brokerProcessIdentity, first.messages[0].result.brokerProcessIdentity);
  assert.equal(locator.endpoint, socketPath);
  assert.equal(locator.transport, 'unix_socket');
  assert.equal(locator.schemaVersion, 2);
  assert.equal(locator.serviceVersion, locator.executable.version);
  assert.deepEqual(locator.protocol, {
    min: { major: 1, minor: 0 }, max: { major: 1, minor: 1 },
  });

  process.kill(locator.pid, 'SIGKILL');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(locator.pid, 0);
      await new Promise(resolve => setTimeout(resolve, 20));
    } catch {
      break;
    }
  }
  assert.throws(() => process.kill(locator.pid, 0));

  const recovered = await runBridge(root, 'startup:recovered');
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(recovered.messages[0].error, undefined);
  assert.notEqual(
    recovered.messages[0].result.brokerProcessIdentity,
    locator.brokerProcessIdentity,
  );
});

test('clients reuse a Broker that is still waiting for browser authorization', async t => {
  const root = await mkdtemp('/tmp/bp-starting-broker-');
  const stateDir = join(root, '.browser-pilot');
  const socketPath = join(stateDir, 'daemon.sock');
  const profile = join(root, 'profile');
  await mkdir(profile, { recursive: true });
  const cdp = await startGatedCdpFixture();
  const daemon = spawn(process.execPath, [
    join(process.cwd(), 'dist', 'daemon.js'),
    cdp.wsUrl,
    'Chrome',
    profile,
  ], {
    env: { ...process.env, HOME: root, PATH: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  daemon.stderr.on('data', bytes => { stderr += bytes.toString(); });
  t.after(async () => {
    await stopDaemon(socketPath).catch(() => {});
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGTERM');
    await cdp.close();
    await rm(root, { recursive: true, force: true });
  });

  const pidFile = join(stateDir, 'daemon.pid');
  await waitForFile(pidFile);
  const starting = JSON.parse(await readFile(pidFile, 'utf8'));
  assert.equal(starting.state, 'starting');
  assert.equal(starting.pid, daemon.pid);

  const bridge = runBridge(root, 'startup:authorization-wait');
  await waitForFile(join(stateDir, 'startup.lock'));
  cdp.release();
  const result = await bridge;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.messages[0].error, undefined);

  const locator = JSON.parse(await readFile(join(stateDir, 'broker-locator.json'), 'utf8'));
  assert.equal(locator.pid, daemon.pid);
  assert.equal(cdp.connectionCount, 1);
  assert.equal(stderr, '');
});

test('terminating an authorization-pending Broker removes its worker and starting record', async t => {
  const root = await mkdtemp('/tmp/bp-stopping-broker-');
  const stateDir = join(root, '.browser-pilot');
  const profile = join(root, 'profile');
  await mkdir(profile, { recursive: true });
  const cdp = await startGatedCdpFixture();
  const daemon = spawn(process.execPath, [
    join(process.cwd(), 'dist', 'daemon.js'),
    cdp.wsUrl,
    'Chrome',
    profile,
  ], {
    env: { ...process.env, HOME: root, PATH: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  daemon.stderr.on('data', bytes => { stderr += bytes.toString(); });
  t.after(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
    await cdp.close();
    await rm(root, { recursive: true, force: true });
  });

  const pidFile = join(stateDir, 'daemon.pid');
  await waitForFile(pidFile);
  daemon.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Authorization-pending Broker did not exit')), 10_000);
    daemon.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const deadline = Date.now() + 5_000;
  while (cdp.pendingUpgradeCount > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  await assert.rejects(access(pidFile));
  assert.equal(cdp.pendingUpgradeCount, 0);
  assert.equal(stderr, '');
});

test('incompatible clients fail without replacing the running Broker', async t => {
  const root = await mkdtemp('/tmp/bp-incompatible-process-');
  const socketPath = join(root, '.browser-pilot', 'daemon.sock');
  t.after(async () => {
    await stopDaemon(socketPath).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const compatible = await runBridge(root, 'protocol:compatible');
  const healthBefore = await daemonRequest(socketPath, '/health');
  const unauthorizedShutdown = await daemonRequest(socketPath, '/shutdown', {
    brokerProcessIdentity: healthBefore.brokerProcessIdentity,
    executableVersion: '999.0.0',
    executableIdentity: 'executable:not-the-running-installation',
  });
  const incompatible = await runBridge(root, 'protocol:incompatible', {
    protocol: { min: { major: 2, minor: 0 }, max: { major: 2, minor: 1 } },
  });
  const healthAfter = await daemonRequest(socketPath, '/health');

  assert.equal(compatible.messages[0].error, undefined);
  assert.equal(unauthorizedShutdown.error.data.code, 'protocol_incompatible');
  assert.equal(
    unauthorizedShutdown.error.data.remediation.code,
    'use_matching_executable_or_isolate',
  );
  assert.equal(incompatible.messages[0].error.data.code, 'protocol_incompatible');
  assert.equal(
    incompatible.messages[0].error.data.remediation.code,
    'use_compatible_executable_or_isolate',
  );
  assert.equal(healthAfter.brokerProcessIdentity, healthBefore.brokerProcessIdentity);
  assert.equal(healthAfter.clients.embeddedConnections, 0);
});

test('compatible Browser Pilot executable versions reuse one Broker while one-shot ownership stays exact', async t => {
  const root = await mkdtemp('/tmp/bp-compatible-version-process-');
  const socketPath = join(root, '.browser-pilot', 'daemon.sock');
  const alternateRoot = join(root, 'alternate-installation');
  const alternateDist = join(alternateRoot, 'dist');
  const alternateCli = join(alternateDist, 'cli.js');
  t.after(async () => {
    await stopDaemon(socketPath).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(alternateDist, { recursive: true });
  await copyFile(CLI, alternateCli);
  await writeFile(join(alternateRoot, 'package.json'), JSON.stringify({
    name: 'browser-pilot-compatible-fixture',
    version: '9.9.9',
    type: 'module',
  }));
  await symlink(join(process.cwd(), 'node_modules'), join(alternateRoot, 'node_modules'), 'dir');

  const original = await runBridge(root, 'version:original');
  const alternate = await runBridge(root, 'version:alternate', { cliPath: alternateCli });
  assert.equal(original.messages[0].error, undefined);
  assert.equal(alternate.messages[0].error, undefined, alternate.stderr);
  assert.equal(
    alternate.messages[0].result.brokerProcessIdentity,
    original.messages[0].result.brokerProcessIdentity,
  );
  assert.notEqual(alternate.messages[0].result.executableVersion, '9.9.9');

  const refused = await runCli(root, ['disconnect'], {}, alternateCli);
  assert.equal(refused.code, 1, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).code, 'protocol_incompatible');
  const health = await daemonRequest(socketPath, '/health');
  assert.equal(health.brokerProcessIdentity, original.messages[0].result.brokerProcessIdentity);
});

test('bp disconnect refuses to stop a Broker with a live embedded client', async t => {
  const root = await mkdtemp('/tmp/bp-live-client-process-');
  const socketPath = join(root, '.browser-pilot', 'daemon.sock');
  const bridge = startLiveBridge(root, 'live-client:one');
  t.after(async () => {
    if (bridge.child.exitCode === null) bridge.child.kill('SIGTERM');
    await stopDaemon(socketPath).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const initialized = await bridge.initialized;
  assert.equal(initialized.error, undefined, bridge.stderr());
  const before = await daemonRequest(socketPath, '/health');
  assert.equal(before.clients.embeddedConnections, 1);

  const refused = await runCli(root, ['disconnect']);
  assert.equal(refused.code, 1, refused.stderr);
  const refusal = JSON.parse(refused.stdout.trim());
  assert.equal(refusal.code, 'broker_in_use');
  assert.equal(refusal.remediation.code, 'close_embedded_clients');
  const stillRunning = await daemonRequest(socketPath, '/health');
  assert.equal(stillRunning.brokerProcessIdentity, before.brokerProcessIdentity);

  bridge.child.stdin.end(`${JSON.stringify({
    jsonrpc: '2.0', id: 'shutdown', method: 'shutdown', params: {},
  })}\n`);
  await new Promise((resolve, reject) => {
    bridge.child.once('error', reject);
    bridge.child.once('exit', resolve);
  });
  const stopped = await runCli(root, ['disconnect']);
  assert.equal(stopped.code, 0, stopped.stderr);
});

test('explicit BROWSER_PILOT_HOME isolation starts an independent Broker', async t => {
  const root = await mkdtemp('/tmp/bp-version-isolation-');
  const defaultState = join(root, '.browser-pilot');
  const isolatedState = join(root, 'isolated-v2');
  const defaultSocket = join(defaultState, 'daemon.sock');
  const isolatedSocket = join(isolatedState, 'daemon.sock');
  t.after(async () => {
    await Promise.all([
      stopDaemon(defaultSocket).catch(() => {}),
      stopDaemon(isolatedSocket).catch(() => {}),
    ]);
    await rm(root, { recursive: true, force: true });
  });

  const [shared, isolated] = await Promise.all([
    runBridge(root, 'isolation:shared'),
    runBridge(root, 'isolation:explicit', {
      env: { BROWSER_PILOT_HOME: isolatedState },
    }),
  ]);
  assert.notEqual(
    shared.messages[0].result.brokerProcessIdentity,
    isolated.messages[0].result.brokerProcessIdentity,
  );
  const [sharedLocator, isolatedLocator] = await Promise.all([
    readFile(join(defaultState, 'broker-locator.json'), 'utf8').then(JSON.parse),
    readFile(join(isolatedState, 'broker-locator.json'), 'utf8').then(JSON.parse),
  ]);
  assert.notEqual(sharedLocator.endpoint, isolatedLocator.endpoint);
  assert.equal(sharedLocator.executable.identity, isolatedLocator.executable.identity);
});

test('a live but unresponsive Broker is reported and never silently replaced', async t => {
  const root = await mkdtemp('/tmp/bp-unresponsive-process-');
  const stateDir = join(root, '.browser-pilot');
  const socketPath = join(stateDir, 'daemon.sock');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const locator = {
    schemaVersion: 1,
    pid: process.pid,
    endpoint: socketPath,
    transport: 'unix_socket',
    startedAt: Date.now(),
    brokerProcessIdentity: 'broker:live-but-unresponsive',
  };
  await writeFile(
    join(stateDir, 'broker-locator.json'),
    `${JSON.stringify(locator)}\n`,
    { mode: 0o600 },
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await runBridge(root, 'startup:unresponsive');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.messages[0].error.data.code, 'browser_disconnected');
  assert.equal(
    result.messages[0].error.data.remediation.code,
    'restart_unresponsive_broker',
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(stateDir, 'broker-locator.json'), 'utf8')),
    locator,
  );
  await assert.rejects(access(socketPath));
});
