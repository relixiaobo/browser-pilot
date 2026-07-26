import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PROTOCOL_LIMITS, MemoryBrokerRuntime } from '../dist/services.js';

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
    protocol: overrides.protocol ?? {
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
    ...(overrides.limits ? { limits: overrides.limits } : {}),
  });
}

function initializeOneShot(runtime, bridgeSessionId, overrides = {}) {
  return runtime.call(bridgeSessionId, 'initialize', {
    client: {
      id: 'org.browser-pilot.cli',
      name: 'Browser Pilot CLI',
      version: '0.1.6',
      instanceId: 'local:one-shot',
      ...overrides.client,
    },
    protocol: overrides.protocol ?? {
      min: { major: 1, minor: 1 },
      max: { major: 1, minor: 1 },
    },
    requestedCapabilities: overrides.requestedCapabilities ?? [
      'browser.control',
      'workspace.manage',
      'observation.read',
    ],
    launchMode: 'one-shot',
    ...(overrides.limits ? { limits: overrides.limits } : {}),
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
  const observe = manifest.tools.find(tool => tool.name === 'browser.observe');
  assert.ok(observe);
  assert.deepEqual(
    observe.outputSchema.properties.elements.items.properties.value['x-browser-pilot-sensitivity'],
    ['browser_data', 'credential'],
  );
  assert.ok(manifest.tools.some(tool => tool.name === 'browser.capture'));
  assert.equal(manifest.tools.some(tool => tool.name === 'browser.eval'), false);
  assert.deepEqual(runtime.stats(), {
    principals: 1,
    connections: 1,
    activeWorkspaces: 0,
    activeLeases: 0,
  });
  assert.deepEqual(runtime.lifecycleSummary(), {
    embeddedConnections: 1,
    oneShotConnections: 0,
    activeWorkspaces: 0,
    activeLeases: 0,
  });
});

test('browser discovery is Broker-owned, filterable, and available without a browser connection', async () => {
  const runtime = createRuntime({
    browsers: [],
    toolExecutor: { supportedTools: ['browser.discover'] },
  });
  const initialized = await initialize(runtime, 'bridge:discovery-only', {
    requestedCapabilities: ['browser.discovery'],
  });
  assert.deepEqual(initialized.browsers, []);
  const empty = await runtime.call('bridge:discovery-only', 'tools/call', {
    name: 'browser.discover',
    arguments: {},
  });
  assert.equal(empty.command.status, 'completed');
  assert.deepEqual(empty.result, { browsers: [] });

  runtime.registerBrowser({
    candidate: {
      id: 'browser:brave',
      product: 'Brave',
      channel: 'stable',
      state: 'remote_debugging_disabled',
      remediation: {
        code: 'enable_remote_debugging',
        message: 'Enable remote debugging.',
        actionRequired: true,
      },
    },
    instance: {
      id: 'browser-instance:brave',
      product: 'Brave',
      profilePath: '/profiles/brave',
      processIdentity: '',
      connectionGeneration: 0,
      state: 'disconnected',
    },
  });
  const discovered = await runtime.call('bridge:discovery-only', 'tools/call', {
    name: 'browser.discover',
    arguments: { browser: 'brave' },
  });
  assert.equal(discovered.result.browsers.length, 1);
  assert.deepEqual(discovered.result.browsers[0], {
    id: 'browser:brave',
    product: 'Brave',
    channel: 'stable',
    processState: 'unknown',
    remoteDebuggingState: 'disabled',
    authorizationState: 'not_applicable',
    state: 'remote_debugging_disabled',
    remediation: {
      code: 'enable_remote_debugging',
      message: 'Enable remote debugging.',
      actionRequired: true,
    },
  });
});

test('Broker negotiates protocol 1.1 transport limits per Connection', async () => {
  const runtime = createRuntime();
  const constrained = await initialize(runtime, 'bridge:constrained', {
    protocol: {
      min: { major: 1, minor: 1 },
      max: { major: 1, minor: 1 },
    },
    limits: {
      maxMessageBytes: 128 * 1024,
      maxResultBytes: 256 * 1024,
    },
  });
  assert.deepEqual(constrained.protocol, { major: 1, minor: 1 });
  assert.deepEqual(constrained.limits, {
    ...DEFAULT_PROTOCOL_LIMITS,
    maxMessageBytes: 128 * 1024,
    maxResultBytes: 256 * 1024,
  });

  const compatibility = await initialize(runtime, 'bridge:compatibility', {
    client: { instanceId: 'instance:compatibility' },
  });
  assert.deepEqual(compatibility.protocol, { major: 1, minor: 0 });
  assert.deepEqual(compatibility.limits, DEFAULT_PROTOCOL_LIMITS);

  await assert.rejects(
    initialize(runtime, 'bridge:invalid-limits-version', {
      client: { instanceId: 'instance:invalid-limits-version' },
      limits: { maxMessageBytes: 128 * 1024 },
    }),
    error => error.code === 'protocol_incompatible',
  );
});

test('One-shot initialize reuses only the same Connection identity and contract', async () => {
  const runtime = createRuntime();
  const first = await initializeOneShot(runtime, 'bridge:cli');
  const second = await initializeOneShot(runtime, 'bridge:cli');
  assert.equal(second.connectionId, first.connectionId);
  assert.deepEqual(runtime.stats(), {
    principals: 1,
    connections: 1,
    activeWorkspaces: 0,
    activeLeases: 0,
  });

  await assert.rejects(
    () => initializeOneShot(runtime, 'bridge:cli', {
      client: { id: 'org.other.cli' },
    }),
    error => error.code === 'invalid_argument',
  );
  await assert.rejects(
    () => initializeOneShot(runtime, 'bridge:cli', {
      client: { version: '0.2.0' },
    }),
    error => error.code === 'invalid_argument',
  );
  await assert.rejects(
    () => initializeOneShot(runtime, 'bridge:cli', {
      requestedCapabilities: ['browser.control', 'workspace.manage'],
    }),
    error => error.code === 'protocol_incompatible',
  );
  await assert.rejects(
    () => initializeOneShot(runtime, 'bridge:cli', {
      limits: { maxResultBytes: 256 * 1024 },
    }),
    error => error.code === 'protocol_incompatible',
  );
});

test('Keyed Workspace and Lease creation is idempotent and renews the Lease', async () => {
  let now = 10_000;
  const runtime = createRuntime({
    now: () => now,
    minLeaseTtlMs: 1_000,
    maxLeaseTtlMs: 600_000,
  });
  await initializeOneShot(runtime, 'bridge:cli');
  const firstWorkspace = await runtime.call('bridge:cli', 'workspaces/create', {
    clientKey: 'browser-pilot-cli',
  });

  now = 11_000;
  const secondWorkspace = await runtime.call('bridge:cli', 'workspaces/create', {
    clientKey: 'browser-pilot-cli',
  });
  assert.equal(secondWorkspace.workspace.id, firstWorkspace.workspace.id);
  assert.equal(secondWorkspace.workspace.createdAt, firstWorkspace.workspace.createdAt);
  assert.equal(secondWorkspace.workspace.updatedAt, now);

  const firstLease = await runtime.call('bridge:cli', 'leases/create', {
    workspaceId: firstWorkspace.workspace.id,
    clientKey: 'browser-pilot-cli',
    ttlMs: 300_000,
  });
  now = 12_000;
  const secondLease = await runtime.call('bridge:cli', 'leases/create', {
    workspaceId: firstWorkspace.workspace.id,
    clientKey: 'browser-pilot-cli',
    ttlMs: 300_000,
  });
  assert.equal(secondLease.lease.id, firstLease.lease.id);
  assert.equal(secondLease.lease.createdAt, firstLease.lease.createdAt);
  assert.equal(secondLease.lease.lastHeartbeatAt, now);
  assert.equal(secondLease.lease.expiresAt, now + 300_000);
  assert.deepEqual(runtime.stats(), {
    principals: 1,
    connections: 1,
    activeWorkspaces: 1,
    activeLeases: 1,
  });
});

test('Keyed Workspace and Lease creation requires protocol 1.1', async () => {
  const runtime = createRuntime();
  await initialize(runtime, 'bridge:protocol-1');
  await assert.rejects(
    () => runtime.call('bridge:protocol-1', 'workspaces/create', { clientKey: 'stable-key' }),
    error => error.code === 'protocol_incompatible',
  );
  const created = await runtime.call('bridge:protocol-1', 'workspaces/create', {});
  await assert.rejects(
    () => runtime.call('bridge:protocol-1', 'leases/create', {
      workspaceId: created.workspace.id,
      clientKey: 'stable-key',
    }),
    error => error.code === 'protocol_incompatible',
  );
});

test('Keyed Workspace reuse does not depend on default browser ordering', async () => {
  const runtime = createRuntime({
    browsers: [
      {
        candidate: { id: 'browser:first', product: 'Chrome', state: 'ready' },
        instance: {
          id: 'browser-instance:first',
          product: 'Chrome',
          profilePath: '/profiles/first',
          processIdentity: 'process:first',
          connectionGeneration: 1,
          state: 'connected',
        },
      },
      {
        candidate: { id: 'browser:second', product: 'Brave', state: 'ready' },
        instance: {
          id: 'browser-instance:second',
          product: 'Brave',
          profilePath: '/profiles/second',
          processIdentity: 'process:second',
          connectionGeneration: 1,
          state: 'connected',
        },
      },
    ],
  });
  await initializeOneShot(runtime, 'bridge:browser-order');
  const first = await runtime.call('bridge:browser-order', 'workspaces/create', {
    browserId: 'browser:second',
    clientKey: 'stable-browser',
  });
  const repeated = await runtime.call('bridge:browser-order', 'workspaces/create', {
    clientKey: 'stable-browser',
  });
  assert.equal(repeated.workspace.id, first.workspace.id);
  assert.equal(repeated.workspace.browserInstanceId, 'browser-instance:second');
  await assert.rejects(
    () => runtime.call('bridge:browser-order', 'workspaces/create', {
      browserId: 'browser:first',
      clientKey: 'stable-browser',
    }),
    error => error.code === 'invalid_argument' && error.context?.field === 'clientKey',
  );
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

test('Broker commands expose outcomes, deduplicate retries, and cancel queued work', async () => {
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
  let executions = 0;
  const runtime = createRuntime({
    toolExecutor: {
      supportedTools: ['browser.connect'],
      actorKey: () => 'browser:test\u0000workspace:test',
      async call(context) {
        executions += 1;
        context.markDispatched();
        if (executions === 1) {
          markFirstStarted();
          await new Promise(resolve => { releaseFirst = resolve; });
        }
        return {
          workspaceId: context.workspace.id,
          leaseId: context.lease.id,
          browserInstanceId: context.browser.instance.id,
          connectionGeneration: context.browser.instance.connectionGeneration,
          state: 'connected',
        };
      },
    },
  });
  await initialize(runtime, 'bridge:commands');
  const { workspace } = await runtime.call('bridge:commands', 'workspaces/create', {});
  const { lease } = await runtime.call('bridge:commands', 'leases/create', { workspaceId: workspace.id });
  const call = commandId => runtime.call('bridge:commands', 'tools/call', {
    name: 'browser.connect',
    arguments: { browserId: 'browser:test' },
    workspaceId: workspace.id,
    leaseId: lease.id,
    commandId,
  });

  const first = call('command:first');
  await firstStarted;
  const second = call('command:second');
  const secondRejected = assert.rejects(second, error => (
    error.code === 'command_cancelled' && error.context.commandId === 'command:second'
  ));
  const cancelled = await runtime.call('bridge:commands', 'commands/cancel', {
    workspaceId: workspace.id,
    commandId: 'command:second',
  });
  assert.equal(cancelled.command.status, 'cancelled');
  await secondRejected;

  releaseFirst();
  const completed = await first;
  assert.equal(completed.command.status, 'completed');
  assert.equal(completed.result.state, 'connected');
  const replayed = await call('command:first');
  assert.equal(replayed.result.state, 'connected');
  assert.equal(executions, 1);

  const queried = await runtime.call('bridge:commands', 'commands/get', {
    workspaceId: workspace.id,
    commandId: 'command:first',
  });
  assert.equal(queried.command.status, 'completed');
  assert.equal(queried.result.browserInstanceId, 'browser-instance:test');
});

test('Broker records unknown outcomes after a dispatched browser disconnect', async () => {
  const runtime = createRuntime({
    toolExecutor: {
      supportedTools: ['browser.connect'],
      async call(context) {
        context.markDispatched();
        const error = new Error('connection lost');
        error.code = 'browser_disconnected';
        error.retryable = true;
        throw error;
      },
    },
  });
  await initialize(runtime, 'bridge:unknown');
  const { workspace } = await runtime.call('bridge:unknown', 'workspaces/create', {});
  const { lease } = await runtime.call('bridge:unknown', 'leases/create', { workspaceId: workspace.id });

  await assert.rejects(
    () => runtime.call('bridge:unknown', 'tools/call', {
      name: 'browser.connect',
      arguments: { browserId: 'browser:test' },
      workspaceId: workspace.id,
      leaseId: lease.id,
      commandId: 'command:unknown',
    }),
    error => error.code === 'unknown_outcome' && error.context.commandId === 'command:unknown',
  );
  const queried = await runtime.call('bridge:unknown', 'commands/get', {
    workspaceId: workspace.id,
    commandId: 'command:unknown',
  });
  assert.equal(queried.command.status, 'unknown_outcome');
  assert.equal(queried.error.data.code, 'unknown_outcome');
});

test('same-target commands publish deterministic actor-local event order', async () => {
  let publish;
  let releaseFirst;
  let firstDispatched;
  let executions = 0;
  const firstStarted = new Promise(resolve => { firstDispatched = resolve; });
  const executor = {
    supportedTools: ['browser.tabs.switch'],
    setEventPublisher(publisher) { publish = publisher; },
    commandTargetId(_context, _definition, args) { return args.targetId; },
    actorKey(context, _definition, args) {
      return `${context.workspace.id}\u0000${args.targetId}`;
    },
    async call(context, _definition, args) {
      executions += 1;
      const commandId = executions === 1 ? 'command:first' : 'command:second';
      context.markDispatched();
      publish({
        workspaceId: context.workspace.id,
        leaseId: context.lease.id,
        targetId: args.targetId,
        browserConnectionGeneration: context.browser.instance.connectionGeneration,
        type: 'navigation',
        sensitivity: 'browser_data',
        payload: { commandId },
      });
      if (executions === 1) {
        firstDispatched();
        await new Promise(resolve => { releaseFirst = resolve; });
      }
      return {
        workspaceId: context.workspace.id,
        leaseId: context.lease.id,
        targetId: args.targetId,
        url: 'https://example.test',
      };
    },
  };
  const runtime = createRuntime({ toolExecutor: executor });
  await initialize(runtime, 'bridge:event-order', {
    requestedCapabilities: ['browser.control', 'workspace.manage', 'event.read'],
  });
  const created = await runtime.call('bridge:event-order', 'workspaces/create', {});
  const { lease } = await runtime.call('bridge:event-order', 'leases/create', {
    workspaceId: created.workspace.id,
  });
  const call = (commandId, targetId) => runtime.call('bridge:event-order', 'tools/call', {
    name: 'browser.tabs.switch',
    arguments: { targetId },
    workspaceId: created.workspace.id,
    leaseId: lease.id,
    commandId,
  });

  const first = call('command:first', 'target:one');
  const second = call('command:second', 'target:one');
  await firstStarted;
  releaseFirst();
  await Promise.all([first, second]);
  const replayed = await runtime.call('bridge:event-order', 'events/poll', {
    workspaceId: created.workspace.id,
    cursor: created.eventCursor,
  });
  const order = replayed.events.map(event => event.type === 'command.status'
    ? `${event.payload.command.status}:${event.payload.command.id}`
    : `${event.type}:${event.payload.commandId}`);
  assert.deepEqual(order, [
    'accepted:command:first',
    'accepted:command:second',
    'dispatched:command:first',
    'navigation:command:first',
    'completed:command:first',
    'dispatched:command:second',
    'navigation:command:second',
    'completed:command:second',
  ]);
  assert.deepEqual(replayed.events.map(event => event.browserConnectionGeneration), Array(8).fill(1));
});

test('different target actors can interleave while preserving each target local order', async () => {
  let publish;
  let releaseSlow;
  let slowDispatched;
  const slowStarted = new Promise(resolve => { slowDispatched = resolve; });
  const executor = {
    supportedTools: ['browser.tabs.switch'],
    setEventPublisher(publisher) { publish = publisher; },
    commandTargetId(_context, _definition, args) { return args.targetId; },
    actorKey(context, _definition, args) { return `${context.workspace.id}\u0000${args.targetId}`; },
    async call(context, _definition, args) {
      context.markDispatched();
      if (args.targetId === 'target:slow') {
        slowDispatched();
        await new Promise(resolve => { releaseSlow = resolve; });
      }
      publish({
        workspaceId: context.workspace.id,
        leaseId: context.lease.id,
        targetId: args.targetId,
        browserConnectionGeneration: context.browser.instance.connectionGeneration,
        type: 'document.changed',
        sensitivity: 'browser_data',
        payload: { targetId: args.targetId },
      });
      return {
        workspaceId: context.workspace.id,
        leaseId: context.lease.id,
        targetId: args.targetId,
        url: 'https://example.test',
      };
    },
  };
  const runtime = createRuntime({ toolExecutor: executor });
  await initialize(runtime, 'bridge:target-interleave', {
    requestedCapabilities: ['browser.control', 'workspace.manage', 'event.read'],
  });
  const created = await runtime.call('bridge:target-interleave', 'workspaces/create', {});
  const { lease } = await runtime.call('bridge:target-interleave', 'leases/create', {
    workspaceId: created.workspace.id,
  });
  const call = (commandId, targetId) => runtime.call('bridge:target-interleave', 'tools/call', {
    name: 'browser.tabs.switch',
    arguments: { targetId },
    workspaceId: created.workspace.id,
    leaseId: lease.id,
    commandId,
  });

  const slow = call('command:slow', 'target:slow');
  await slowStarted;
  const fast = call('command:fast', 'target:fast');
  await fast;
  releaseSlow();
  await slow;
  const replayed = await runtime.call('bridge:target-interleave', 'events/poll', {
    workspaceId: created.workspace.id,
    cursor: created.eventCursor,
  });
  for (const [targetId, commandId] of [
    ['target:slow', 'command:slow'],
    ['target:fast', 'command:fast'],
  ]) {
    const local = replayed.events
      .filter(event => event.targetId === targetId)
      .map(event => event.type === 'command.status'
        ? event.payload.command.status
        : event.type);
    assert.deepEqual(local, ['accepted', 'dispatched', 'document.changed', 'completed'], commandId);
  }
  const terminalIds = replayed.events
    .filter(event => event.type === 'command.status' && event.payload.command.status === 'completed')
    .map(event => event.payload.command.id);
  assert.deepEqual(terminalIds, ['command:fast', 'command:slow']);
});

test('Broker fences delayed commands and browser events across reconnect generations', async () => {
  let publish;
  let releaseExecution;
  let executionDispatched;
  const dispatched = new Promise(resolve => { executionDispatched = resolve; });
  const runtime = createRuntime({
    toolExecutor: {
      supportedTools: ['browser.connect'],
      setEventPublisher(publisher) { publish = publisher; },
      async call(context) {
        context.markDispatched();
        executionDispatched();
        await new Promise(resolve => { releaseExecution = resolve; });
        return {
          workspaceId: context.workspace.id,
          leaseId: context.lease.id,
          browserInstanceId: context.browser.instance.id,
          connectionGeneration: context.browser.instance.connectionGeneration,
          state: 'connected',
        };
      },
    },
  });
  await initialize(runtime, 'bridge:generation-fence', {
    requestedCapabilities: ['browser.control', 'workspace.manage', 'event.read'],
  });
  const created = await runtime.call('bridge:generation-fence', 'workspaces/create', {});
  const { lease } = await runtime.call('bridge:generation-fence', 'leases/create', {
    workspaceId: created.workspace.id,
  });
  const pending = runtime.call('bridge:generation-fence', 'tools/call', {
    name: 'browser.connect',
    arguments: { browserId: 'browser:test' },
    workspaceId: created.workspace.id,
    leaseId: lease.id,
    commandId: 'command:generation-one',
  });
  await dispatched;
  const queued = runtime.call('bridge:generation-fence', 'tools/call', {
    name: 'browser.connect',
    arguments: { browserId: 'browser:test' },
    workspaceId: created.workspace.id,
    leaseId: lease.id,
    commandId: 'command:queued-generation-one',
  });
  const queuedRejected = assert.rejects(queued, error => error.code === 'browser_disconnected');
  runtime.updateBrowserConnection('browser-instance:test', {
    state: 'disconnected',
    connectionGeneration: 1,
  });
  runtime.updateBrowserConnection('browser-instance:test', {
    state: 'connected',
    connectionGeneration: 2,
  });
  publish({
    workspaceId: created.workspace.id,
    browserConnectionGeneration: 1,
    type: 'navigation',
    sensitivity: 'browser_data',
    payload: { url: 'https://stale.test' },
  });
  publish({
    workspaceId: created.workspace.id,
    browserConnectionGeneration: 2,
    type: 'navigation',
    sensitivity: 'browser_data',
    payload: { url: 'https://current.test' },
  });
  publish({
    workspaceId: created.workspace.id,
    browserConnectionGeneration: 3,
    type: 'navigation',
    sensitivity: 'browser_data',
    payload: { url: 'https://future.test' },
  });
  releaseExecution();
  await assert.rejects(pending, error => error.code === 'unknown_outcome');
  await queuedRejected;

  const replayed = await runtime.call('bridge:generation-fence', 'events/poll', {
    workspaceId: created.workspace.id,
    cursor: created.eventCursor,
  });
  assert.equal(replayed.events.some(event => event.payload?.url === 'https://stale.test'), false);
  assert.equal(replayed.events.some(event => event.payload?.url === 'https://future.test'), false);
  assert.equal(replayed.events.some(event => (
    event.payload?.url === 'https://current.test' && event.browserConnectionGeneration === 2
  )), true);
  const commandEvents = replayed.events.filter(event => (
    event.type === 'command.status' &&
    event.payload.command.id === 'command:generation-one'
  ));
  assert.deepEqual(commandEvents.map(event => event.payload.command.status), [
    'accepted',
    'dispatched',
    'unknown_outcome',
  ]);
  assert.deepEqual(commandEvents.map(event => event.browserConnectionGeneration), [1, 1, 1]);
  const queuedEvents = replayed.events.filter(event => (
    event.type === 'command.status' &&
    event.payload.command.id === 'command:queued-generation-one'
  ));
  assert.deepEqual(queuedEvents.map(event => event.payload.command.status), ['accepted', 'completed']);
  assert.deepEqual(queuedEvents.map(event => event.browserConnectionGeneration), [1, 1]);
  assert.deepEqual(replayed.events
    .filter(event => event.type === 'connection.lost' || event.type === 'connection.restored')
    .map(event => [event.type, event.browserConnectionGeneration]), [
    ['connection.lost', 1],
    ['connection.restored', 2],
  ]);
});

test('Broker rejects a delayed read result instead of returning stale browser data', async () => {
  let releaseRead;
  let readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  const runtime = createRuntime({
    toolExecutor: {
      supportedTools: ['browser.tabs.list'],
      async call(context) {
        readStarted();
        await new Promise(resolve => { releaseRead = resolve; });
        return {
          workspaceId: context.workspace.id,
          leaseId: context.lease.id,
          targets: [],
        };
      },
    },
  });
  await initialize(runtime, 'bridge:stale-read', {
    requestedCapabilities: ['browser.control', 'workspace.manage', 'event.read'],
  });
  const created = await runtime.call('bridge:stale-read', 'workspaces/create', {});
  const { lease } = await runtime.call('bridge:stale-read', 'leases/create', {
    workspaceId: created.workspace.id,
  });
  const pending = runtime.call('bridge:stale-read', 'tools/call', {
    name: 'browser.tabs.list',
    arguments: { scope: 'all' },
    workspaceId: created.workspace.id,
    leaseId: lease.id,
    commandId: 'command:stale-read',
  });
  await started;
  runtime.updateBrowserConnection('browser-instance:test', {
    state: 'disconnected',
    connectionGeneration: 1,
  });
  runtime.updateBrowserConnection('browser-instance:test', {
    state: 'connected',
    connectionGeneration: 2,
  });
  releaseRead();

  await assert.rejects(pending, error => (
    error.code === 'browser_disconnected' && error.retryable === true
  ));
  const command = await runtime.call('bridge:stale-read', 'commands/get', {
    workspaceId: created.workspace.id,
    commandId: 'command:stale-read',
  });
  assert.equal(command.command.status, 'completed');
  assert.equal(command.command.browserConnectionGeneration, 1);
  assert.equal(command.error.data.code, 'browser_disconnected');
});

test('Broker publishes one lost/restored pair, rejects disconnected tools, and advances generation', async () => {
  const changes = [];
  const runtime = createRuntime({
    toolExecutor: {
      supportedTools: ['browser.tabs.list'],
      browserConnectionChanged(previous, current) {
        changes.push([previous.state, current.state, current.connectionGeneration]);
      },
      async call(context) {
        return {
          workspaceId: context.workspace.id,
          leaseId: context.lease.id,
          browserInstanceId: context.browser.instance.id,
          connectionGeneration: context.browser.instance.connectionGeneration,
          state: context.browser.instance.state,
        };
      },
    },
  });
  await initialize(runtime, 'bridge:lifecycle', {
    requestedCapabilities: ['browser.control', 'workspace.manage', 'event.read'],
  });
  const created = await runtime.call('bridge:lifecycle', 'workspaces/create', {});
  const { lease } = await runtime.call('bridge:lifecycle', 'leases/create', {
    workspaceId: created.workspace.id,
  });

  runtime.updateBrowserConnection('browser-instance:test', {
    state: 'disconnected',
    connectionGeneration: 1,
  });
  runtime.updateBrowserConnection('browser-instance:test', {
    state: 'reconnecting',
    connectionGeneration: 1,
  });
  await assert.rejects(
    () => runtime.call('bridge:lifecycle', 'tools/call', {
      name: 'browser.tabs.list',
      arguments: {},
      workspaceId: created.workspace.id,
      leaseId: lease.id,
    }),
    error => error.code === 'browser_disconnected' && error.retryable === true,
  );
  await assert.rejects(
    async () => runtime.updateBrowserConnection('browser-instance:test', {
      state: 'connected',
      connectionGeneration: 1,
    }),
    error => error.code === 'internal_error',
  );

  const restored = runtime.updateBrowserConnection('browser-instance:test', {
    state: 'connected',
    connectionGeneration: 2,
    processIdentity: 'process:test:restored',
  });
  assert.equal(restored.connectionGeneration, 2);
  assert.equal(restored.processIdentity, 'process:test:restored');
  const events = await runtime.call('bridge:lifecycle', 'events/poll', {
    workspaceId: created.workspace.id,
    cursor: created.eventCursor,
  });
  assert.deepEqual(events.events.map(event => event.type), [
    'connection.lost',
    'connection.restored',
  ]);
  assert.deepEqual(events.events.map(event => event.payload.connectionGeneration), [1, 2]);
  assert.deepEqual(changes, [
    ['connected', 'disconnected', 1],
    ['disconnected', 'reconnecting', 1],
    ['reconnecting', 'connected', 2],
  ]);
});

test('Broker replays Workspace events, pushes notifications, and enforces Principal isolation', async () => {
  const runtime = createRuntime();
  await initialize(runtime, 'bridge:events', {
    requestedCapabilities: ['workspace.manage', 'event.read'],
  });
  const created = await runtime.call('bridge:events', 'workspaces/create', {});
  assert.equal(created.eventCursor, 'cursor:0');

  runtime.publishBrowserEvent({
    workspaceId: created.workspace.id,
    browserConnectionGeneration: 1,
    type: 'navigation',
    sensitivity: 'browser_data',
    payload: { url: 'https://example.test' },
  });
  const notification = await runtime.nextNotification('bridge:events', { waitMs: 0 });
  assert.equal(notification.method, 'events/event');
  assert.equal(notification.params.event.sequence, 1);

  const replayed = await runtime.call('bridge:events', 'events/poll', {
    workspaceId: created.workspace.id,
    cursor: created.eventCursor,
  });
  assert.equal(replayed.events.length, 1);
  assert.equal(replayed.events[0].payload.url, 'https://example.test');
  assert.equal(replayed.nextCursor, 'cursor:1');

  await initialize(runtime, 'bridge:other-events', {
    client: { id: 'org.other.agent', instanceId: 'instance:other-events' },
    requestedCapabilities: ['workspace.manage', 'event.read'],
  });
  await assert.rejects(
    () => runtime.call('bridge:other-events', 'events/poll', {
      workspaceId: created.workspace.id,
      cursor: 'cursor:0',
    }),
    error => error.code === 'workspace_not_found',
  );

  runtime.disconnect('bridge:events');
  await initialize(runtime, 'bridge:events-reconnected', {
    requestedCapabilities: ['workspace.manage', 'event.read'],
  });
  const resumed = await runtime.call('bridge:events-reconnected', 'workspaces/get', {
    workspaceId: created.workspace.id,
  });
  assert.equal(resumed.eventCursor, 'cursor:1');
  const recovered = await runtime.call('bridge:events-reconnected', 'events/poll', {
    workspaceId: created.workspace.id,
    cursor: 'cursor:0',
  });
  assert.equal(recovered.events[0].id, replayed.events[0].id);
});

test('Broker returns cursor_expired after bounded Workspace event compaction', async () => {
  const runtime = createRuntime({ limits: { eventJournalSize: 2 } });
  await initialize(runtime, 'bridge:compact', {
    requestedCapabilities: ['workspace.manage', 'event.read'],
  });
  const created = await runtime.call('bridge:compact', 'workspaces/create', {});
  for (let value = 1; value <= 3; value += 1) {
    runtime.publishBrowserEvent({
      workspaceId: created.workspace.id,
      browserConnectionGeneration: 1,
      type: 'document.changed',
      sensitivity: 'browser_data',
      payload: { value },
    });
  }
  await assert.rejects(
    () => runtime.call('bridge:compact', 'events/poll', {
      workspaceId: created.workspace.id,
      cursor: created.eventCursor,
    }),
    error => error.code === 'cursor_expired' && error.context.earliestCursor === 'cursor:1',
  );
});
