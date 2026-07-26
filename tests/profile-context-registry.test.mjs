import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MemoryProfileContextRegistry,
} from '../dist/services.js';

function targets() {
  return [
    {
      cdpTargetId: 'a-internal',
      cdpBrowserContextId: 'raw-a',
      type: 'page',
      title: 'New tab',
      url: 'chrome://newtab/',
      eligible: false,
    },
    {
      cdpTargetId: 'a-user',
      cdpBrowserContextId: 'raw-a',
      type: 'page',
      title: 'Form',
      url: 'https://a.test/form',
      eligible: true,
    },
    {
      cdpTargetId: 'b-user',
      cdpBrowserContextId: 'raw-b',
      type: 'page',
      title: 'Reference',
      url: 'https://b.test/reference',
      eligible: true,
    },
    {
      cdpTargetId: 'worker',
      cdpBrowserContextId: 'raw-a',
      type: 'service_worker',
      title: '',
      url: 'https://a.test/sw.js',
      eligible: false,
    },
  ];
}

test('Profile contexts are grouped from TargetInfo and expose connection-scoped opaque IDs', () => {
  const ids = ['profile-context:first', 'profile-context:second'];
  const registry = new MemoryProfileContextRegistry('browser:test', {
    idFactory: () => ids.shift(),
  });

  const profiles = registry.reconcile(7, targets());
  assert.equal(profiles.length, 2);
  assert.deepEqual(profiles.map(profile => ({
    id: profile.id,
    label: profile.label,
    tabCount: profile.tabCount,
    eligibleTabCount: profile.eligibleTabCount,
    representative: profile.representativeCdpTargetId,
  })), [
    {
      id: 'profile-context:first',
      label: 'Profile 1',
      tabCount: 2,
      eligibleTabCount: 1,
      representative: 'a-user',
    },
    {
      id: 'profile-context:second',
      label: 'Profile 2',
      tabCount: 1,
      eligibleTabCount: 1,
      representative: 'b-user',
    },
  ]);
  assert.equal(registry.forTarget('a-user', 7).id, 'profile-context:first');
  assert.equal(registry.forRawContext('raw-b', 7).id, 'profile-context:second');
  assert.equal(JSON.stringify(profiles).includes('raw-a'), true, 'raw IDs remain available only to internal records');
});

test('browser reconnect invalidates old Profile IDs instead of remapping them', () => {
  const ids = [
    'profile-context:g1-a',
    'profile-context:g1-b',
    'profile-context:g2-a',
    'profile-context:g2-b',
  ];
  const registry = new MemoryProfileContextRegistry('browser:test', {
    idFactory: () => ids.shift(),
  });
  const first = registry.reconcile(1, targets());
  const second = registry.reconcile(2, targets());

  assert.notEqual(first[0].id, second[0].id);
  assert.throws(
    () => registry.resolve(first[0].id, 2),
    error => (
      error?.name === 'BrowserPilotError' &&
      error.code === 'profile_context_stale' &&
      error.retryable
    ),
  );
  assert.equal(registry.resolve(second[0].id, 2).browserConnectionGeneration, 2);
});

test('Profile context inventory is bounded before state mutation', () => {
  const registry = new MemoryProfileContextRegistry('browser:test');
  const oversized = Array.from({ length: 4097 }, (_, index) => ({
    cdpTargetId: `target-${index}`,
    cdpBrowserContextId: 'raw-a',
    type: 'page',
    title: '',
    url: 'about:blank',
    eligible: true,
  }));
  assert.throws(
    () => registry.reconcile(1, oversized),
    error => error?.name === 'BrowserPilotError' && error.code === 'result_too_large',
  );
  assert.deepEqual(registry.list(1), []);
});
