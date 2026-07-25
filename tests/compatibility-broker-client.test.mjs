import assert from 'node:assert/strict';
import test from 'node:test';
import { CompatibilityBrokerClient, MemoryBrokerRuntime } from '../dist/services.js';

function runtimeTransport(runtime) {
  return {
    brokerCall(bridgeSessionId, method, params) {
      return runtime.call(bridgeSessionId, method, params);
    },
  };
}

test('one-shot compatibility clients reuse daemon-memory Workspace and Lease state', async () => {
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
        profilePath: '/profiles/test',
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

test('compatibility client rejects a daemon from another executable version', async () => {
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '0.1.5',
    executableVersion: '0.1.5',
    brokerProcessIdentity: 'broker:old',
    browsers: [{
      candidate: { id: 'browser:test', product: 'Chrome', state: 'ready' },
      instance: {
        id: 'browser-instance:test',
        product: 'Chrome',
        profilePath: '/profiles/test',
        processIdentity: 'process:test',
        connectionGeneration: 1,
        state: 'connected',
      },
    }],
  });
  await assert.rejects(
    () => CompatibilityBrokerClient.create(runtimeTransport(runtime), '0.1.6'),
    error => error.code === 'protocol_incompatible' && error.remediation?.code === 'restart_browser_pilot',
  );
});
