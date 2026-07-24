import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserControlPolicy } from '../dist/services.js';

function createHarness(deniedOperations = []) {
  const browserInstanceId = 'browser:1';
  const targets = [
    { cdpTargetId: 'cdp:user-1', title: 'Form', url: 'https://example.test/form' },
    { cdpTargetId: 'cdp:user-2', title: 'Reference', url: 'https://example.test/reference' },
  ];
  const catalog = {
    async getBrowserIdentity(id) {
      return id === browserInstanceId
        ? { profileIdentity: 'profile:default', connectionGeneration: 7 }
        : undefined;
    },
    async listEligibleUserTargets(id) {
      return id === browserInstanceId ? targets.map(target => ({ ...target })) : [];
    },
  };
  return {
    browserInstanceId,
    policy: createBrowserControlPolicy(catalog, { deniedOperations }),
    targets,
  };
}

test('default policy exposes all current and future eligible user tabs', async () => {
  const harness = createHarness();

  assert.deepEqual(
    (await harness.policy.listUserTargets(harness.browserInstanceId))
      .map(target => target.cdpTargetId),
    ['cdp:user-1', 'cdp:user-2'],
  );

  harness.targets.push({
    cdpTargetId: 'cdp:user-3',
    title: 'New tab',
    url: 'https://example.test/new',
  });
  assert.deepEqual(
    (await harness.policy.listUserTargets(harness.browserInstanceId))
      .map(target => target.cdpTargetId),
    ['cdp:user-1', 'cdp:user-2', 'cdp:user-3'],
  );
});

test('default policy permits every browser operation without grants', () => {
  const harness = createHarness();
  for (const operation of [
    'tabs.list',
    'page.observe',
    'page.interact',
    'page.navigate',
    'page.capture',
    'files.upload',
    'tabs.close',
    'dialogs.manage',
    'auth.manage',
    'cookies.read',
    'network.observe',
    'network.modify',
    'developer.eval',
  ]) {
    assert.doesNotThrow(() => harness.policy.assertOperation(operation));
  }
});

test('Agent host can remove operations at launch without an approval lifecycle', async () => {
  const harness = createHarness(['tabs.close', 'network.modify']);

  assert.doesNotThrow(() => harness.policy.assertOperation('page.interact'));
  assert.throws(
    () => harness.policy.assertOperation('tabs.close'),
    error => error.code === 'capability_denied' && error.context?.operation === 'tabs.close',
  );
  assert.throws(
    () => harness.policy.assertOperation('network.modify'),
    error => error.code === 'capability_denied',
  );
  assert.equal((await harness.policy.listUserTargets(harness.browserInstanceId)).length, 2);
});

test('denying tabs.list prevents user tab discovery', async () => {
  const harness = createHarness(['tabs.list']);
  await assert.rejects(
    () => harness.policy.listUserTargets(harness.browserInstanceId),
    error => error.code === 'capability_denied' && error.context?.operation === 'tabs.list',
  );
});

test('policy rejects unknown launch-time operations', () => {
  assert.throws(
    () => createHarness(['page.destroy']),
    error => error.code === 'invalid_argument' && error.context?.field === 'deniedOperations',
  );
});
