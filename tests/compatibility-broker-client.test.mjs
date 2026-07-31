import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalJson,
  CompatibilityBrokerClient,
  MemoryBrokerRuntime,
} from '../dist/services.js';

const DAEMON_TOKEN = 'test-daemon-token-for-compatibility-client';

function runtimeTransport(runtime) {
  return {
    brokerCall(clientSessionId, method, params) {
      return runtime.call(clientSessionId, method, params);
    },
  };
}

function requestRecoveryRuntime(executions) {
  return new MemoryBrokerRuntime({
    serviceVersion: '0.6.0',
    executableVersion: '0.6.0',
    brokerProcessIdentity: 'broker:request-recovery',
    browsers: [{
      candidate: { id: 'browser:test', product: 'Chrome', state: 'ready' },
      instance: {
        id: 'browser-instance:test',
        product: 'Chrome',
        userDataRoot: '/profiles/test',
        processIdentity: 'process:test',
        connectionGeneration: 1,
        state: 'connected',
      },
    }],
    toolExecutor: {
      supportedTools: [
        'browser.auth.clear',
        'browser.auth.set',
        'browser.tabs.close',
        'browser.tabs.list',
      ],
      async call(context, definition, args) {
        executions.push({ name: definition.name, targetId: context.targetId, args });
        context.markDispatched();
        const base = {
          workspaceId: context.workspace.id,
          leaseId: context.lease.id,
        };
        switch (definition.name) {
          case 'browser.auth.clear': return { ...base, configured: false };
          case 'browser.auth.set': return { ...base, configured: true };
          case 'browser.tabs.close': return { ...base, closedTargetId: context.targetId };
          case 'browser.tabs.list': return { ...base, targets: [] };
          default: throw new Error(`Unexpected tool: ${definition.name}`);
        }
      },
    },
  });
}

test('canonical JSON sorts nested object keys and preserves array order', () => {
  assert.equal(
    canonicalJson({ z: [3, { b: -0, a: 1.2 }], a: true }),
    '{"a":true,"z":[3,{"a":1.2,"b":0}]}',
  );
  assert.equal(canonicalJson({ '\u00e4': 1, z: 2, a: 3 }), '{"a":3,"z":2,"\u00e4":1}');
});

test('CLI clients reuse Broker Workspace and Lease state', async () => {
  let now = 1_000;
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '0.1.6',
    executableVersion: '0.1.6',
    brokerProcessIdentity: 'broker:test',
    now: () => now,
    maxLeaseTtlMs: 600_000,
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
        userDataRoot: '/profiles/test',
        processIdentity: 'process:test',
        connectionGeneration: 1,
        state: 'connected',
      },
    }],
  });
  const transport = runtimeTransport(runtime);
  const first = await CompatibilityBrokerClient.create(transport, DAEMON_TOKEN, '0.1.6');
  now = 2_000;
  const second = await CompatibilityBrokerClient.create(transport, DAEMON_TOKEN, '0.1.6');

  assert.equal(second.initialized.connectionId, first.initialized.connectionId);
  assert.equal(second.workspace.id, first.workspace.id);
  assert.equal(second.lease.id, first.lease.id);
  assert.equal(second.lease.lastHeartbeatAt, now);
  assert.equal(second.lease.expiresAt, now + 300_000);
  assert.deepEqual(runtime.stats(), {
    principals: 1,
    connections: 1,
    activeWorkspaces: 1,
    activeLeases: 1,
  });
});

test('stable CLI client keys isolate Agents while repeated calls reuse their own state', async () => {
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '0.4.0',
    executableVersion: '0.4.0',
    brokerProcessIdentity: 'broker:client-key-isolation',
    browsers: [{
      candidate: {
        id: 'browser:test',
        product: 'Chrome',
        userDataRoot: '/profiles/test',
        state: 'ready',
      },
      instance: {
        id: 'browser-instance:test',
        product: 'Chrome',
        userDataRoot: '/profiles/test',
        processIdentity: 'process:test',
        connectionGeneration: 1,
        state: 'connected',
      },
    }],
  });
  const transport = runtimeTransport(runtime);
  const firstA = await CompatibilityBrokerClient.create(transport, DAEMON_TOKEN, '0.4.0', 'agent.alpha');
  const secondA = await CompatibilityBrokerClient.create(transport, DAEMON_TOKEN, '0.4.0', 'agent.alpha');
  const agentB = await CompatibilityBrokerClient.create(transport, DAEMON_TOKEN, '0.4.0', 'agent.beta');

  assert.equal(secondA.initialized.connectionId, firstA.initialized.connectionId);
  assert.equal(secondA.workspace.id, firstA.workspace.id);
  assert.equal(secondA.lease.id, firstA.lease.id);
  assert.notEqual(agentB.initialized.connectionId, firstA.initialized.connectionId);
  assert.notEqual(agentB.workspace.id, firstA.workspace.id);
  assert.notEqual(agentB.lease.id, firstA.lease.id);
  assert.deepEqual(runtime.stats(), {
    principals: 2,
    connections: 2,
    activeWorkspaces: 2,
    activeLeases: 2,
  });
});

test('mutating retry dedup survives different preamble counts and argument key order', async () => {
  const executions = [];
  const runtime = requestRecoveryRuntime(executions);
  const transport = runtimeTransport(runtime);
  const first = await CompatibilityBrokerClient.create(
    transport,
    DAEMON_TOKEN,
    '0.6.0',
    'agent.recovery',
    { requestId: 'tool-call-123' },
  );
  await first.callTool('browser.tabs.list', { scope: 'all' });
  await first.callTool('browser.auth.set', { username: 'agent', password: 'secret' });
  const original = (await first.listCommands()).find(command => command.method === 'browser.auth.set');
  assert.ok(original);
  assert.equal(original.status, 'completed');

  const retried = await CompatibilityBrokerClient.create(
    transport,
    DAEMON_TOKEN,
    '0.6.0',
    'agent.recovery',
    { requestId: 'tool-call-123' },
  );
  await retried.callTool('browser.tabs.list', { scope: 'all' });
  await retried.callTool('browser.tabs.list', { scope: 'all' });
  await retried.callTool('browser.auth.set', { password: 'secret', username: 'agent' });
  assert.equal(executions.filter(call => call.name === 'browser.auth.set').length, 1);
  assert.equal(executions.filter(call => call.name === 'browser.tabs.list').length, 3);
  assert.equal((await retried.getCommand(original.id)).command.id, original.id);
});

test('different mutating tools sharing a request ID never collide', async () => {
  const executions = [];
  const runtime = requestRecoveryRuntime(executions);
  const transport = runtimeTransport(runtime);
  const setClient = await CompatibilityBrokerClient.create(
    transport, DAEMON_TOKEN, '0.6.0', 'agent.recovery', { requestId: 'shared-request' },
  );
  await setClient.callTool('browser.auth.set', { username: 'agent', password: 'secret' });
  const clearClient = await CompatibilityBrokerClient.create(
    transport, DAEMON_TOKEN, '0.6.0', 'agent.recovery', { requestId: 'shared-request' },
  );
  await clearClient.callTool('browser.auth.clear');
  assert.deepEqual(executions.map(call => call.name), ['browser.auth.set', 'browser.auth.clear']);
});

test('identical mutating calls have distinct keys that remain stable across invocation retries', async () => {
  const executions = [];
  const runtime = requestRecoveryRuntime(executions);
  const transport = runtimeTransport(runtime);
  const first = await CompatibilityBrokerClient.create(
    transport, DAEMON_TOKEN, '0.6.0', 'agent.recovery', { requestId: 'repeat-clear' },
  );
  await first.callTool('browser.auth.clear');
  await first.callTool('browser.auth.clear');
  assert.equal(executions.length, 2);

  const retried = await CompatibilityBrokerClient.create(
    transport, DAEMON_TOKEN, '0.6.0', 'agent.recovery', { requestId: 'repeat-clear' },
  );
  await retried.callTool('browser.auth.clear');
  await retried.callTool('browser.auth.clear');
  assert.equal(executions.length, 2);
});

test('a mutating retry resolved to a different target does not dedup', async () => {
  const executions = [];
  const runtime = requestRecoveryRuntime(executions);
  const transport = runtimeTransport(runtime);
  const first = await CompatibilityBrokerClient.create(
    transport, DAEMON_TOKEN, '0.6.0', 'agent.recovery', { requestId: 'close-request' },
  );
  await first.callTool('browser.tabs.close', {}, 'target:first');
  const second = await CompatibilityBrokerClient.create(
    transport, DAEMON_TOKEN, '0.6.0', 'agent.recovery', { requestId: 'close-request' },
  );
  await second.callTool('browser.tabs.close', {}, 'target:second');
  assert.deepEqual(
    executions.map(call => [call.name, call.targetId]),
    [['browser.tabs.close', 'target:first'], ['browser.tabs.close', 'target:second']],
  );
});

test('compatible CLI versions share one Agent namespace through protocol negotiation', async () => {
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '0.1.5',
    executableVersion: '0.1.5',
    brokerProcessIdentity: 'broker:old',
    browsers: [{
      candidate: { id: 'browser:test', product: 'Chrome', state: 'ready' },
      instance: {
        id: 'browser-instance:test',
        product: 'Chrome',
        userDataRoot: '/profiles/test',
        processIdentity: 'process:test',
        connectionGeneration: 1,
        state: 'connected',
      },
    }],
  });
  const oldClient = await CompatibilityBrokerClient.create(
    runtimeTransport(runtime), DAEMON_TOKEN, '0.1.5',
  );
  const newerClient = await CompatibilityBrokerClient.create(
    runtimeTransport(runtime), DAEMON_TOKEN, '0.1.6',
  );
  assert.notEqual(newerClient.initialized.connectionId, oldClient.initialized.connectionId);
  assert.equal(newerClient.workspace.id, oldClient.workspace.id);
  assert.notEqual(newerClient.lease.id, oldClient.lease.id);
  assert.deepEqual(runtime.stats(), {
    principals: 1,
    connections: 2,
    activeWorkspaces: 1,
    activeLeases: 2,
  });
});
