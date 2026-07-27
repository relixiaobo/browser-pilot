import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CdpBrowserTargetCatalog,
  MemoryProfileContextRegistry,
} from '../dist/services.js';

class CatalogTransport {
  constructor(targetInfos) {
    this.targetInfos = targetInfos;
    this.calls = [];
  }

  async send(method) {
    this.calls.push(method);
    return { targetInfos: this.targetInfos.map(target => ({ ...target })) };
  }

  close() {}
}

test('CDP browser target catalog returns eligible user pages and preserves opener chains', async () => {
  let nextProfile = 0;
  const profileContexts = new MemoryProfileContextRegistry('browser:main', {
    idFactory: () => `profile-context:test-${++nextProfile}`,
  });
  const transport = new CatalogTransport([
    { targetId: 'user', type: 'page', title: 'User form', url: 'https://example.test/form', browserContextId: 'context-user' },
    { targetId: 'popup', type: 'page', title: 'Popup', url: 'https://example.test/popup', openerId: 'user', browserContextId: 'context-user' },
    { targetId: 'blank', type: 'page', title: '', url: 'about:blank', browserContextId: 'context-user' },
    { targetId: 'managed', type: 'page', title: 'Agent task', url: 'https://agent.test' },
    { targetId: 'chooser', type: 'page', title: 'Browser Pilot', url: 'http://127.0.0.1/chooser' },
    { targetId: 'devtools', type: 'page', title: 'DevTools', url: 'devtools://devtools/bundled/inspector.html' },
    { targetId: 'settings', type: 'page', title: 'Settings', url: 'chrome://settings/' },
    { targetId: 'extension', type: 'page', title: 'Extension', url: 'chrome-extension://abc/options.html', browserContextId: 'context-extension' },
    { targetId: 'edge-extension', type: 'page', title: 'Extension', url: 'edge-extension://def/options.html', browserContextId: 'context-edge-extension' },
    { targetId: 'worker', type: 'service_worker', title: '', url: 'https://example.test/sw.js' },
  ]);
  const catalog = new CdpBrowserTargetCatalog(
    transport,
    'browser:main',
    () => ({ profileIdentity: 'profile:default', connectionGeneration: 3 }),
    {
      isExcludedTarget: target => target.cdpTargetId === 'managed' || target.cdpTargetId === 'chooser',
      profileContexts,
    },
  );

  assert.deepEqual(await catalog.getBrowserIdentity('browser:main'), {
    profileIdentity: 'profile:default',
    connectionGeneration: 3,
  });
  assert.deepEqual(await catalog.listEligibleUserTargets('browser:main'), [
    {
      cdpTargetId: 'user',
      profileContextId: 'profile-context:test-1',
      title: 'User form',
      url: 'https://example.test/form',
    },
    {
      cdpTargetId: 'popup',
      profileContextId: 'profile-context:test-1',
      title: 'Popup',
      url: 'https://example.test/popup',
      openerCdpTargetId: 'user',
    },
    {
      cdpTargetId: 'blank',
      profileContextId: 'profile-context:test-1',
      title: '',
      url: 'about:blank',
    },
  ]);
  assert.deepEqual(await catalog.listEligibleUserTargets('browser:other'), []);
  assert.deepEqual(transport.calls, ['Target.getTargets']);
  assert.equal(
    profileContexts.list(3).some(profile => (
      profile.targets.some(target => target.url.startsWith('chrome-extension:') || target.url.startsWith('edge-extension:'))
    )),
    false,
  );
});

test('CDP browser target catalog returns no tabs while browser identity is unavailable', async () => {
  const transport = new CatalogTransport([
    { targetId: 'user', type: 'page', title: 'User', url: 'https://example.test' },
  ]);
  const catalog = new CdpBrowserTargetCatalog(
    transport,
    'browser:main',
    () => undefined,
    { isExcludedTarget: () => false },
  );

  assert.deepEqual(await catalog.listEligibleUserTargets('browser:main'), []);
  assert.deepEqual(transport.calls, []);
});
