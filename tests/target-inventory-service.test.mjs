import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MemoryControlledTargetRegistry,
  TargetInventoryService,
  createBrowserControlPolicy,
} from '../dist/services.js';

class InventoryTransport {
  constructor(targets) {
    this.targets = targets.map(target => ({ type: 'page', ...target }));
    this.calls = [];
  }

  async send(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'Target.getTargets') {
      return { targetInfos: this.targets.map(target => ({ ...target })) };
    }
    if (method === 'Target.closeTarget') {
      this.targets = this.targets.filter(target => target.targetId !== params.targetId);
      return { success: true };
    }
    return {};
  }

  close() {}
}

function createHarness({ deniedOperations = [], isCurrentContext } = {}) {
  let timestamp = 1_000;
  let targetSequence = 0;
  const browserInstanceId = 'browser:main';
  const managedTabSetId = 'tabset:task-1';
  const managedTargetIds = new Set([
    'cdp:managed',
    'cdp:managed-popup',
    'cdp:managed-nested',
  ]);
  const transport = new InventoryTransport([
    { targetId: 'cdp:managed', title: 'Agent task', url: 'https://agent.test' },
    { targetId: 'cdp:managed-popup', title: 'Agent popup', url: 'https://popup.test', openerId: 'cdp:managed' },
    { targetId: 'cdp:managed-nested', title: 'Nested popup', url: 'https://nested.test', openerId: 'cdp:managed-popup' },
    { targetId: 'cdp:user-form', title: 'User form', url: 'https://example.test/form' },
    { targetId: 'cdp:user-reference', title: 'User reference', url: 'https://example.test/reference' },
    { targetId: 'cdp:user-popup', title: 'User popup', url: 'https://example.test/popup', openerId: 'cdp:user-form' },
    { targetId: 'cdp:internal', title: 'Browser Pilot', url: 'http://127.0.0.1/internal' },
  ]);
  const catalog = {
    async getBrowserIdentity(id) {
      return id === browserInstanceId
        ? { profileIdentity: 'profile:default', connectionGeneration: 1 }
        : undefined;
    },
    async listEligibleUserTargets(id) {
      if (id !== browserInstanceId) return [];
      return transport.targets
        .filter(target => !managedTargetIds.has(target.targetId) && target.targetId !== 'cdp:internal')
        .map(target => ({
          cdpTargetId: target.targetId,
          title: target.title,
          url: target.url,
          ...(target.openerId ? { openerCdpTargetId: target.openerId } : {}),
        }));
    },
  };
  const policy = createBrowserControlPolicy(catalog, { deniedOperations });
  const registry = new MemoryControlledTargetRegistry({
    now: () => ++timestamp,
    idFactory: () => `controlled:${++targetSequence}`,
  });
  const invalidations = [];
  const inventory = new TargetInventoryService(
    transport,
    browserInstanceId,
    policy,
    registry,
    {
      onInvalidated: invalidation => invalidations.push(invalidation),
      ...(isCurrentContext ? { isCurrentContext } : {}),
    },
  );
  const contextA = {
    principalId: 'principal:agent',
    workspaceId: 'workspace:task',
    leaseId: 'lease:a',
    browserConnectionGeneration: 1,
  };
  const contextB = { ...contextA, leaseId: 'lease:b' };
  inventory.registerManagedTarget({
    ...contextA,
    managedTabSetId,
    cdpTargetId: 'cdp:managed',
    title: 'Agent task',
    url: 'https://agent.test',
  });

  return {
    browserInstanceId,
    contextA,
    contextB,
    inventory,
    invalidations,
    managedTabSetId,
    registry,
    transport,
  };
}

test('inventory immediately combines ManagedTabSet and all user tabs behind opaque IDs', async () => {
  const harness = createHarness();
  const targets = await harness.inventory.list(harness.contextA);

  assert.deepEqual(targets.map(target => target.origin), [
    'managed',
    'managed_popup',
    'managed_popup',
    'user_tab',
    'user_tab',
    'user_tab',
  ]);
  assert.deepEqual(targets.map(target => target.title), [
    'Agent task',
    'Agent popup',
    'Nested popup',
    'User form',
    'User reference',
    'User popup',
  ]);
  assert.equal(JSON.stringify(targets).includes('cdp:'), false);
  assert.equal(targets.some(target => target.title === 'Browser Pilot'), false);

  const existingFormId = targets.find(target => target.title === 'User form').targetId;
  harness.transport.targets.push({
    type: 'page',
    targetId: 'cdp:user-new',
    title: 'New user tab',
    url: 'https://example.test/new',
  });
  const refreshed = await harness.inventory.list(harness.contextA);
  assert.equal(refreshed.find(target => target.title === 'User form').targetId, existingFormId);
  assert.equal(refreshed.find(target => target.title === 'New user tab').origin, 'user_tab');
  assert.deepEqual(
    (await harness.inventory.list(harness.contextA, 'managed_only')).map(target => target.origin),
    ['managed', 'managed_popup', 'managed_popup'],
  );
  assert.deepEqual(
    (await harness.inventory.list(harness.contextA, 'user_tabs')).map(target => target.origin),
    ['user_tab', 'user_tab', 'user_tab', 'user_tab'],
  );
});

test('a tab that becomes ineligible is invalidated without being closed', async () => {
  const harness = createHarness();
  const listed = await harness.inventory.list(harness.contextA);
  const userTarget = listed.find(target => target.title === 'User form');
  harness.transport.targets.find(target => target.targetId === 'cdp:user-form').targetId = 'cdp:internal';

  await harness.inventory.refresh(harness.contextA);

  assert.ok(harness.invalidations.some(invalidation =>
    invalidation.targetId === userTarget.targetId && invalidation.reason === 'target_ineligible',
  ));
  await assert.rejects(
    () => harness.inventory.resolveForOperation(harness.contextA, userTarget.targetId, 'page.interact'),
    error => error.code === 'target_not_owned',
  );
  assert.equal(harness.transport.calls.some(call => call.method === 'Target.closeTarget'), false);
});

test('target control is exclusive per Lease and opaque IDs cannot cross Workspace boundaries', async () => {
  const harness = createHarness();
  const form = (await harness.inventory.list(harness.contextA))
    .find(target => target.title === 'User form');

  await harness.inventory.activate(harness.contextA, form.targetId);
  const fromLeaseB = await harness.inventory.list(harness.contextB);
  assert.equal(fromLeaseB.find(target => target.targetId === form.targetId).controlState, 'busy');
  const activationCalls = harness.transport.calls.filter(call => call.method === 'Target.activateTarget').length;
  await assert.rejects(
    () => harness.inventory.activate(harness.contextB, form.targetId),
    error => error.code === 'target_busy' && error.retryable,
  );
  assert.equal(
    harness.transport.calls.filter(call => call.method === 'Target.activateTarget').length,
    activationCalls,
  );

  const otherWorkspace = {
    principalId: 'principal:other',
    workspaceId: 'workspace:other',
    leaseId: 'lease:other',
  };
  await assert.rejects(
    () => harness.inventory.activate(otherWorkspace, form.targetId),
    error => error.code === 'target_not_owned',
  );

  const otherForm = (await harness.inventory.list(otherWorkspace))
    .find(target => target.title === 'User form');
  assert.notEqual(otherForm.targetId, form.targetId);
  assert.equal(otherForm.controlState, 'busy');
  await assert.rejects(
    () => harness.inventory.activate(otherWorkspace, otherForm.targetId),
    error => error.code === 'target_busy',
  );

  harness.inventory.releaseLease(harness.contextA.leaseId);
  await assert.doesNotReject(() => harness.inventory.activate(harness.contextB, form.targetId));
});

test('bulk close affects only ManagedTabSet while explicit close can close a user tab', async () => {
  const harness = createHarness();
  const userForm = (await harness.inventory.list(harness.contextA))
    .find(target => target.title === 'User form');

  const bulkResult = await harness.inventory.closeManagedTabSet(
    harness.contextA,
    harness.managedTabSetId,
  );
  assert.equal(bulkResult.closed.length, 3);
  assert.deepEqual(bulkResult.failed, []);
  assert.deepEqual(
    harness.transport.calls
      .filter(call => call.method === 'Target.closeTarget')
      .map(call => call.params.targetId),
    ['cdp:managed', 'cdp:managed-popup', 'cdp:managed-nested'],
  );
  assert.ok(harness.transport.targets.some(target => target.targetId === 'cdp:user-form'));

  await harness.inventory.close(harness.contextA, userForm.targetId);
  assert.equal(harness.transport.targets.some(target => target.targetId === 'cdp:user-form'), false);
});

test('host operation policy is enforced before CDP dispatch', async () => {
  const harness = createHarness({ deniedOperations: ['tabs.close'] });
  const userForm = (await harness.inventory.list(harness.contextA))
    .find(target => target.title === 'User form');
  const closeCalls = harness.transport.calls.filter(call => call.method === 'Target.closeTarget').length;

  await assert.rejects(
    () => harness.inventory.close(harness.contextA, userForm.targetId),
    error => error.code === 'capability_denied' && error.context?.operation === 'tabs.close',
  );
  assert.equal(
    harness.transport.calls.filter(call => call.method === 'Target.closeTarget').length,
    closeCalls,
  );
});

test('inventory serializes refreshes and rejects an old-generation snapshot before mutation', async () => {
  let currentGeneration = 1;
  const harness = createHarness({
    isCurrentContext: context => context.browserConnectionGeneration === currentGeneration,
  });
  let releaseSnapshot;
  let snapshotRequested;
  const requested = new Promise(resolve => { snapshotRequested = resolve; });
  const originalSend = harness.transport.send.bind(harness.transport);
  let firstRead = true;
  harness.transport.send = async (method, params = {}) => {
    if (method === 'Target.getTargets' && firstRead) {
      firstRead = false;
      const snapshot = harness.transport.targets.map(target => ({ ...target }));
      snapshotRequested();
      await new Promise(resolve => { releaseSnapshot = resolve; });
      return { targetInfos: snapshot };
    }
    return originalSend(method, params);
  };

  const stale = harness.inventory.refresh(harness.contextA);
  await requested;
  currentGeneration = 2;
  harness.transport.targets = harness.transport.targets.filter(target => (
    target.targetId === 'cdp:managed' || target.targetId === 'cdp:internal'
  ));
  const currentContext = { ...harness.contextA, browserConnectionGeneration: 2 };
  const current = harness.inventory.refresh(currentContext);
  releaseSnapshot();

  await assert.rejects(stale, error => (
    error.code === 'browser_disconnected' &&
    error.context.expectedConnectionGeneration === 1
  ));
  await current;
  const active = harness.registry.activeRecords(currentContext);
  assert.deepEqual(active.map(target => target.cdpTargetId), ['cdp:managed']);
  assert.equal(active.some(target => target.origin === 'user_tab'), false);
});
