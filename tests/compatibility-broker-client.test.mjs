import assert from 'node:assert/strict';
import test from 'node:test';
import { CompatibilityBrokerClient, MemoryBrokerRuntime } from '../dist/services.js';

function runtimeTransport(runtime) {
  return {
    brokerCall(clientSessionId, method, params) {
      return runtime.call(clientSessionId, method, params);
    },
  };
}

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
  const first = await CompatibilityBrokerClient.create(transport, '0.1.6');
  now = 2_000;
  const second = await CompatibilityBrokerClient.create(transport, '0.1.6');

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
  const firstA = await CompatibilityBrokerClient.create(transport, '0.4.0', 'agent.alpha');
  const secondA = await CompatibilityBrokerClient.create(transport, '0.4.0', 'agent.alpha');
  const agentB = await CompatibilityBrokerClient.create(transport, '0.4.0', 'agent.beta');

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

test('compatibility client exposes command recovery and deduplicates stable request IDs', async () => {
  let executions = 0;
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '0.4.0',
    executableVersion: '0.4.0',
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
      supportedTools: ['browser.profiles.list'],
      async call(context) {
        executions += 1;
        context.markDispatched();
        return {
          workspaceId: context.workspace.id,
          leaseId: context.lease.id,
          profiles: [],
        };
      },
    },
  });
  const transport = runtimeTransport(runtime);
  const first = await CompatibilityBrokerClient.create(
    transport,
    '0.4.0',
    'agent.recovery',
    { requestId: 'tool-call-123' },
  );
  await first.callTool('browser.profiles.list');
  const original = (await first.listCommands())[0];
  assert.equal(original.status, 'completed');

  const retried = await CompatibilityBrokerClient.create(
    transport,
    '0.4.0',
    'agent.recovery',
    { requestId: 'tool-call-123' },
  );
  await retried.callTool('browser.profiles.list');
  assert.equal(executions, 1);
  assert.equal((await retried.getCommand(original.id)).command.id, original.id);
  assert.deepEqual((await retried.listCommands()).map(command => command.id), [original.id]);
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
  const oldClient = await CompatibilityBrokerClient.create(runtimeTransport(runtime), '0.1.5');
  const newerClient = await CompatibilityBrokerClient.create(runtimeTransport(runtime), '0.1.6');
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
