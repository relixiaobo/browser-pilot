import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryBrokerRuntime } from '../dist/services.js';

function createRuntime(options = {}) {
  return new MemoryBrokerRuntime({
    serviceVersion: '1.2.3',
    brokerProcessIdentity: 'broker:test',
    browsers: [{
      candidate: {
        id: 'browser:test',
        product: 'Chrome',
        profile: '/profiles/test',
        state: 'ready',
      },
      instance: {
        id: 'browser-instance:test',
        product: 'Chrome',
        profilePath: '/profiles/test',
        processIdentity: 'process:test',
        connectionGeneration: 1,
        state: 'connected',
      },
    }],
    ...options,
  });
}

function initialize(runtime, bridgeSessionId, overrides = {}) {
  return runtime.call(bridgeSessionId, 'initialize', {
    client: {
      id: 'com.example.agent',
      name: 'Example Agent',
      version: '2.0.0',
      instanceId: 'instance:one',
      ...overrides.client,
    },
    protocol: {
      min: { major: 1, minor: 0 },
      max: { major: 1, minor: 0 },
    },
    requestedCapabilities: overrides.requestedCapabilities ?? [
      'browser.control',
      'workspace.manage',
      'observation.read',
      'artifact.read',
    ],
    launchMode: 'embedded',
  });
}

test('Broker initializes one connection and filters the canonical tool manifest', async () => {
  const runtime = createRuntime();
  const initialized = await initialize(runtime, 'bridge:one');

  assert.equal(initialized.serviceVersion, '1.2.3');
  assert.equal(initialized.protocol.major, 1);
  assert.equal(initialized.browsers[0].state, 'ready');
  assert.match(initialized.connectionId, /^connection:/);
  assert.deepEqual(initialized.capabilities.granted, [
    'browser.control',
    'workspace.manage',
    'observation.read',
    'artifact.read',
  ]);

  const manifest = await runtime.call('bridge:one', 'tools/list', {});
  assert.ok(manifest.tools.some(tool => tool.name === 'browser.observe'));
  assert.ok(manifest.tools.some(tool => tool.name === 'browser.capture'));
  assert.equal(manifest.tools.some(tool => tool.name === 'browser.eval'), false);
  assert.deepEqual(runtime.stats(), {
    principals: 1,
    connections: 1,
    activeWorkspaces: 0,
    activeLeases: 0,
  });
});

test('Workspaces belong to a Principal while Leases belong to a live Connection', async () => {
  const runtime = createRuntime();
  await initialize(runtime, 'bridge:first');
  const created = await runtime.call('bridge:first', 'workspaces/create', {});
  const leased = await runtime.call('bridge:first', 'leases/create', {
    workspaceId: created.workspace.id,
    ttlMs: 20_000,
  });

  runtime.disconnect('bridge:first');
  assert.equal(runtime.stats().activeLeases, 0);

  await initialize(runtime, 'bridge:reconnected');
  const resumed = await runtime.call('bridge:reconnected', 'workspaces/get', {
    workspaceId: created.workspace.id,
  });
  assert.equal(resumed.workspace.principalId, created.workspace.principalId);
  await assert.rejects(
    () => runtime.call('bridge:reconnected', 'leases/heartbeat', { leaseId: leased.lease.id }),
    error => error.code === 'lease_expired',
  );

  const replacement = await runtime.call('bridge:reconnected', 'leases/create', {
    workspaceId: created.workspace.id,
  });
  assert.notEqual(replacement.lease.id, leased.lease.id);
});

test('Unrelated Principals cannot inspect or lease another Principal Workspace', async () => {
  const runtime = createRuntime();
  await initialize(runtime, 'bridge:owner');
  const created = await runtime.call('bridge:owner', 'workspaces/create', {});
  await initialize(runtime, 'bridge:other', {
    client: { id: 'org.other.agent', instanceId: 'instance:other' },
  });

  await assert.rejects(
    () => runtime.call('bridge:other', 'workspaces/get', { workspaceId: created.workspace.id }),
    error => error.code === 'workspace_not_found',
  );
  await assert.rejects(
    () => runtime.call('bridge:other', 'leases/create', { workspaceId: created.workspace.id }),
    error => error.code === 'workspace_not_found',
  );
});

test('Lease heartbeat, expiry, and Workspace release are deterministic and idempotent', async () => {
  let now = 1_000;
  const released = [];
  const runtime = createRuntime({
    now: () => now,
    defaultLeaseTtlMs: 2_000,
    minLeaseTtlMs: 1_000,
    maxLeaseTtlMs: 10_000,
    onLeaseReleased: lease => released.push([lease.id, lease.state]),
  });
  await initialize(runtime, 'bridge:lease');
  const created = await runtime.call('bridge:lease', 'workspaces/create', {});
  const first = await runtime.call('bridge:lease', 'leases/create', { workspaceId: created.workspace.id });

  now = 2_000;
  const heartbeat = await runtime.call('bridge:lease', 'leases/heartbeat', {
    leaseId: first.lease.id,
    ttlMs: 3_000,
  });
  assert.equal(heartbeat.lease.expiresAt, 5_000);
  now = 5_000;
  assert.equal(runtime.sweepExpiredLeases(), 1);
  assert.deepEqual(released, [[first.lease.id, 'expired']]);

  const second = await runtime.call('bridge:lease', 'leases/create', { workspaceId: created.workspace.id });
  await runtime.call('bridge:lease', 'workspaces/release', { workspaceId: created.workspace.id });
  await runtime.call('bridge:lease', 'workspaces/release', { workspaceId: created.workspace.id });
  assert.equal(runtime.stats().activeWorkspaces, 0);
  assert.equal(runtime.stats().activeLeases, 0);
  assert.deepEqual(released.at(-1), [second.lease.id, 'released']);
});

test('Broker rejects pre-initialize calls, duplicate initialize, unknown methods, and invalid TTLs', async () => {
  const runtime = createRuntime();
  await assert.rejects(
    () => runtime.call('bridge:test', 'tools/list', {}),
    error => error.code === 'not_initialized',
  );
  await initialize(runtime, 'bridge:test');
  await assert.rejects(
    () => initialize(runtime, 'bridge:test'),
    error => error.code === 'invalid_argument',
  );
  await assert.rejects(
    () => runtime.call('bridge:test', 'not/a-method', {}),
    error => error.rpcCode === -32601,
  );
  const created = await runtime.call('bridge:test', 'workspaces/create', {});
  await assert.rejects(
    () => runtime.call('bridge:test', 'leases/create', {
      workspaceId: created.workspace.id,
      ttlMs: 10,
    }),
    error => error.code === 'invalid_argument' && error.context?.field === 'ttlMs',
  );
});

test('Broker bounds terminal records and reclaims idle Connections and Workspaces', async () => {
  let now = 0;
  const releasedWorkspaces = [];
  const runtime = createRuntime({
    now: () => now,
    maxWorkspaceRecords: 1,
    maxLeaseRecords: 1,
    connectionIdleTtlMs: 1_000,
    workspaceIdleTtlMs: 2_000,
    onWorkspaceReleased: workspace => releasedWorkspaces.push(workspace.id),
  });
  await initialize(runtime, 'bridge:bounded');
  const firstWorkspace = await runtime.call('bridge:bounded', 'workspaces/create', {});
  const firstLease = await runtime.call('bridge:bounded', 'leases/create', {
    workspaceId: firstWorkspace.workspace.id,
  });
  await runtime.call('bridge:bounded', 'leases/release', { leaseId: firstLease.lease.id });
  const secondLease = await runtime.call('bridge:bounded', 'leases/create', {
    workspaceId: firstWorkspace.workspace.id,
  });
  assert.notEqual(secondLease.lease.id, firstLease.lease.id);
  await runtime.call('bridge:bounded', 'leases/release', { leaseId: secondLease.lease.id });
  await runtime.call('bridge:bounded', 'workspaces/release', {
    workspaceId: firstWorkspace.workspace.id,
  });

  const secondWorkspace = await runtime.call('bridge:bounded', 'workspaces/create', {});
  assert.notEqual(secondWorkspace.workspace.id, firstWorkspace.workspace.id);
  now = 1_000;
  runtime.sweepExpiredLeases();
  assert.equal(runtime.stats().connections, 0);
  now = 3_000;
  runtime.sweepExpiredLeases();
  assert.equal(runtime.stats().activeWorkspaces, 0);
  assert.deepEqual(releasedWorkspaces, [firstWorkspace.workspace.id, secondWorkspace.workspace.id]);
});
