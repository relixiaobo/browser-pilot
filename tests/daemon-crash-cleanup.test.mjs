import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { waitFor } from './helpers/async.mjs';
import { startCdpFixture as startCdpServerFixture } from './helpers/cdp.mjs';
import { daemonRequest, setDaemonToken } from './helpers/daemon.mjs';
import {
  forceKillChild,
  isolatedBrokerEnvironment,
  testBrokerPaths,
  testTempPrefix,
} from './helpers/platform.mjs';

async function startCdpFixture() {
  const targets = new Map([
    ['user-tab', { targetId: 'user-tab', type: 'page', title: 'User', url: 'https://user.test/' }],
  ]);
  const closed = [];
  let connectionCount = 0;
  const fixture = await startCdpServerFixture({
    path: '/devtools/browser/crash',
    onConnection: () => { connectionCount += 1; },
    onMessage: ({ message, socket, server }) => {
      const result = value => socket.send(JSON.stringify({ id: message.id, result: value }));
      if (message.method === 'Target.getTargets') {
        result({ targetInfos: [...targets.values()] });
      } else if (message.method === 'Target.createTarget') {
        const targetInfo = {
          targetId: 'managed-crash',
          type: 'page',
          title: '',
          url: 'about:blank',
        };
        targets.set(targetInfo.targetId, targetInfo);
        result({ targetId: targetInfo.targetId });
        for (const client of server.clients) {
          if (client.readyState === 1) client.send(JSON.stringify({
            method: 'Target.targetCreated',
            params: { targetInfo },
          }));
        }
      } else if (message.method === 'Target.attachToTarget') {
        socket.send(JSON.stringify({ id: message.id, error: { message: 'fixture attach failure' } }));
      } else if (message.method === 'Target.closeTarget') {
        const targetId = message.params.targetId;
        closed.push(targetId);
        targets.delete(targetId);
        result({ success: true });
      } else if (message.method === 'Browser.getWindowForTarget') {
        result({ windowId: 71 });
      } else {
        result({});
      }
    },
  });
  return {
    ...fixture,
    targets,
    closed,
    get connectionCount() { return connectionCount; },
  };
}

test('an abruptly terminated daemon reclaims managed targets without closing user tabs', async t => {
  const root = await mkdtemp(testTempPrefix('bp-daemon-crash-'));
  const profile = join(root, 'profile');
  const socketPath = testBrokerPaths(root).endpoint;
  await mkdir(profile, { recursive: true });
  const cdp = await startCdpFixture();
  const endpoint = new URL(cdp.wsUrl);
  await writeFile(
    join(profile, 'DevToolsActivePort'),
    `${endpoint.port}\n${endpoint.pathname}\n`,
  );
  const daemon = spawn(process.execPath, [
    join(process.cwd(), 'dist', 'daemon.js'),
    'Chrome',
    profile,
  ], {
    env: isolatedBrokerEnvironment(root),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr = [];
  daemon.stderr.on('data', bytes => stderr.push(bytes.toString()));
  t.after(async () => {
    forceKillChild(daemon);
    await cdp.close();
    await rm(root, { recursive: true, force: true });
  });

  const endpointToken = await waitFor(
    async () => {
      try {
        const locator = JSON.parse(await readFile(testBrokerPaths(root).locatorFile, 'utf8'));
        return locator.token;
      } catch { return undefined; }
    },
    value => typeof value === 'string',
  );
  setDaemonToken(socketPath, endpointToken);

  const clientSessionId = 'bridge:crash-cleanup';
  const initialized = await waitFor(
    () => daemonRequest(socketPath, '/broker/rpc', {
      clientSessionId,
      method: 'initialize',
      params: {
        client: {
          id: 'com.example.crash-test',
          name: 'Crash Test',
          version: '1.0.0',
          instanceId: 'instance:crash-test',
        },
        protocol: { min: { major: 1, minor: 1 }, max: { major: 1, minor: 1 } },
        requestedCapabilities: ['browser.control', 'workspace.manage', 'observation.read'],
      },
    }),
    value => value.result?.browsers?.length > 0,
  );
  const created = await daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId,
    method: 'workspaces/create',
    params: {},
  });
  const leased = await daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId,
    method: 'leases/create',
    params: { workspaceId: created.result.workspace.id },
  });
  const connected = await daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId,
    method: 'tools/call',
    params: {
      name: 'browser.connect',
      arguments: { browserId: initialized.result.browsers[0].id },
      workspaceId: created.result.workspace.id,
      leaseId: leased.result.lease.id,
      commandId: 'command:crash-connect',
    },
  });
  const health = await waitFor(
    () => daemonRequest(socketPath, '/health'),
    value => value.browser?.state === 'connected',
  );

  await daemonRequest(socketPath, '/broker/rpc', {
    clientSessionId,
    method: 'tools/call',
    params: {
      name: 'browser.open',
      arguments: { url: 'https://task.test/', newTarget: true },
      workspaceId: created.result.workspace.id,
      leaseId: leased.result.lease.id,
    },
  });
  assert.equal(cdp.targets.has('managed-crash'), true);
  assert.equal(cdp.connectionCount, 1, 'daemon and crash janitor must share one browser connection');

  forceKillChild(daemon);
  await new Promise(resolve => daemon.once('exit', resolve));
  await waitFor(
    () => Promise.resolve(cdp.closed),
    value => value.includes('managed-crash'),
    process.platform === 'win32' ? 15_000 : 5_000,
  );

  assert.equal(cdp.targets.has('managed-crash'), false);
  assert.equal(cdp.targets.has('user-tab'), true);
  assert.equal(stderr.join(''), '');
  assert.equal(health.browser.state, 'connected');
  assert.equal(connected.result.result.state, 'connected');
});
