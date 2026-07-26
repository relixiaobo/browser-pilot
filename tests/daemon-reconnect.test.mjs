import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';

async function startCdpFixture() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  server.on('connection', socket => {
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, result: {} }));
    });
  });
  return {
    server,
    port: server.address().port,
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve));
    },
  };
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
    request.on('error', reject);
    if (body !== undefined) request.end(JSON.stringify(body));
    else request.end();
  });
}

async function stopDaemon(socketPath, bridgeSessionId) {
  if (bridgeSessionId) {
    await daemonRequest(socketPath, '/broker/disconnect', { bridgeSessionId }).catch(() => {});
  }
  const health = await daemonRequest(socketPath, '/health');
  return daemonRequest(socketPath, '/shutdown', {
    brokerProcessIdentity: health.brokerProcessIdentity,
    executableVersion: health.executableVersion,
    executableIdentity: health.executableIdentity,
  });
}

async function waitFor(operation, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw lastError ?? new Error('Timed out waiting for daemon state');
}

test('daemon rediscovers the selected profile and publishes one restored generation', async t => {
  // macOS limits Unix-domain socket paths to roughly 100 bytes.
  const root = await mkdtemp('/tmp/bp-daemon-reconnect-');
  const profile = join(root, 'profile');
  const socketPath = join(root, '.browser-pilot', 'daemon.sock');
  await mkdir(profile, { recursive: true });
  let first = await startCdpFixture();
  let second;
  const stderr = [];
  const child = spawn(process.execPath, [
    join(process.cwd(), 'dist', 'daemon.js'),
    `ws://127.0.0.1:${first.port}/devtools/browser/first`,
    'Chrome',
    profile,
  ], {
    env: { ...process.env, HOME: root },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', bytes => stderr.push(bytes.toString()));
  t.after(async () => {
    await stopDaemon(socketPath, 'bridge:daemon-test').catch(() => {});
    if (child.exitCode === null) child.kill('SIGTERM');
    await first?.close().catch(() => {});
    await second?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const initial = await waitFor(
    () => daemonRequest(socketPath, '/health'),
    value => value.browser?.state === 'connected',
  );
  assert.equal(initial.browser.connectionGeneration, 1);

  const initialize = await daemonRequest(socketPath, '/broker/rpc', {
    bridgeSessionId: 'bridge:daemon-test',
    method: 'initialize',
    params: {
      client: {
        id: 'com.example.daemon-test',
        name: 'Daemon Test',
        version: '1.0.0',
        instanceId: 'instance:daemon-test',
      },
      protocol: { min: { major: 1, minor: 1 }, max: { major: 1, minor: 1 } },
      requestedCapabilities: ['browser.control', 'workspace.manage', 'event.read'],
      launchMode: 'embedded',
    },
  });
  assert.equal(initialize.result.browsers[0].state, 'ready');
  const created = await daemonRequest(socketPath, '/broker/rpc', {
    bridgeSessionId: 'bridge:daemon-test',
    method: 'workspaces/create',
    params: {},
  });
  const leased = await daemonRequest(socketPath, '/broker/rpc', {
    bridgeSessionId: 'bridge:daemon-test',
    method: 'leases/create',
    params: { workspaceId: created.result.workspace.id },
  });

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
    bridgeSessionId: 'bridge:daemon-test',
    method: 'tools/call',
    params: {
      name: 'browser.connect',
      arguments: { browserId: initialize.result.browsers[0].id },
      workspaceId: created.result.workspace.id,
      leaseId: leased.result.lease.id,
      commandId: 'command:explicit-reconnect',
    },
  });
  assert.equal(connected.result.result.state, 'connected');
  const restored = await waitFor(
    () => daemonRequest(socketPath, '/health'),
    value => value.browser?.state === 'connected' && value.browser.connectionGeneration === 2,
    10_000,
  );
  assert.equal(restored.wsUrl, `ws://127.0.0.1:${second.port}/devtools/browser/second`);

  const replayed = await daemonRequest(socketPath, '/broker/rpc', {
    bridgeSessionId: 'bridge:daemon-test',
    method: 'events/poll',
    params: {
      workspaceId: created.result.workspace.id,
      cursor: created.result.eventCursor,
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
  const root = await mkdtemp('/tmp/bp-daemon-discovery-');
  const profile = join(root, 'Library', 'Application Support', 'Google', 'Chrome');
  const socketPath = join(root, '.browser-pilot', 'daemon.sock');
  await mkdir(profile, { recursive: true });
  const stderr = [];
  const child = spawn(process.execPath, [
    join(process.cwd(), 'dist', 'daemon.js'),
    '',
    'Chrome',
    profile,
  ], {
    env: { ...process.env, HOME: root, PATH: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', bytes => stderr.push(bytes.toString()));
  let cdp;
  t.after(async () => {
    await stopDaemon(socketPath, 'bridge:discovery-test').catch(() => {});
    if (child.exitCode === null) child.kill('SIGTERM');
    await cdp?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const health = await waitFor(
    () => daemonRequest(socketPath, '/health'),
    value => value.ok === true,
  );
  assert.equal(health.browser.state, 'disconnected');

  const initialized = await daemonRequest(socketPath, '/broker/rpc', {
    bridgeSessionId: 'bridge:discovery-test',
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
      launchMode: 'embedded',
    },
  });
  const selected = initialized.result.browsers.find(browser => browser.profile === profile);
  assert.ok(selected);
  assert.equal(selected.state, 'not_running');
  assert.equal(selected.remediation.code, 'start_browser');

  const discovered = await daemonRequest(socketPath, '/broker/rpc', {
    bridgeSessionId: 'bridge:discovery-test',
    method: 'tools/call',
    params: { name: 'browser.discover', arguments: {} },
  });
  assert.equal(discovered.result.command.status, 'completed');
  const discoveredSelected = discovered.result.result.browsers.find(browser => browser.id === selected.id);
  assert.ok(discoveredSelected);
  assert.equal(discoveredSelected.remoteDebuggingState, 'disabled');

  const created = await daemonRequest(socketPath, '/broker/rpc', {
    bridgeSessionId: 'bridge:discovery-test',
    method: 'workspaces/create',
    params: { browserId: selected.id },
  });
  const leased = await daemonRequest(socketPath, '/broker/rpc', {
    bridgeSessionId: 'bridge:discovery-test',
    method: 'leases/create',
    params: { workspaceId: created.result.workspace.id },
  });

  cdp = await startCdpFixture();
  await writeFile(
    join(profile, 'DevToolsActivePort'),
    `${cdp.port}\n/devtools/browser/enabled\n`,
  );
  const connected = await daemonRequest(socketPath, '/broker/rpc', {
    bridgeSessionId: 'bridge:discovery-test',
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
