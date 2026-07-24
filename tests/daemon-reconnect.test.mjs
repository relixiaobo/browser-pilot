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
    await daemonRequest(socketPath, '/shutdown', {}).catch(() => {});
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
      requestedCapabilities: ['workspace.manage', 'event.read'],
      launchMode: 'embedded',
    },
  });
  assert.equal(initialize.result.browsers[0].state, 'ready');
  const created = await daemonRequest(socketPath, '/broker/rpc', {
    bridgeSessionId: 'bridge:daemon-test',
    method: 'workspaces/create',
    params: {},
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
  assert.deepEqual(replayed.result.events.map(event => event.type), [
    'connection.lost',
    'connection.restored',
  ]);
  assert.equal(stderr.join(''), '');
});
