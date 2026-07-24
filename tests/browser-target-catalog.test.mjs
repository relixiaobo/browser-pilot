import assert from 'node:assert/strict';
import test from 'node:test';
import { CdpBrowserTargetCatalog } from '../dist/services.js';

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
  const transport = new CatalogTransport([
    { targetId: 'user', type: 'page', title: 'User form', url: 'https://example.test/form' },
    { targetId: 'popup', type: 'page', title: 'Popup', url: 'https://example.test/popup', openerId: 'user' },
    { targetId: 'blank', type: 'page', title: '', url: 'about:blank' },
    { targetId: 'managed', type: 'page', title: 'Agent task', url: 'https://agent.test' },
    { targetId: 'chooser', type: 'page', title: 'Browser Pilot', url: 'http://127.0.0.1/chooser' },
    { targetId: 'devtools', type: 'page', title: 'DevTools', url: 'devtools://devtools/bundled/inspector.html' },
    { targetId: 'settings', type: 'page', title: 'Settings', url: 'chrome://settings/' },
    { targetId: 'worker', type: 'service_worker', title: '', url: 'https://example.test/sw.js' },
  ]);
  const catalog = new CdpBrowserTargetCatalog(
    transport,
    'browser:main',
    () => ({ profileIdentity: 'profile:default', connectionGeneration: 3 }),
    { isExcludedTarget: target => target.cdpTargetId === 'managed' || target.cdpTargetId === 'chooser' },
  );

  assert.deepEqual(await catalog.getBrowserIdentity('browser:main'), {
    profileIdentity: 'profile:default',
    connectionGeneration: 3,
  });
  assert.deepEqual(await catalog.listEligibleUserTargets('browser:main'), [
    { cdpTargetId: 'user', title: 'User form', url: 'https://example.test/form' },
    {
      cdpTargetId: 'popup',
      title: 'Popup',
      url: 'https://example.test/popup',
      openerCdpTargetId: 'user',
    },
    { cdpTargetId: 'blank', title: '', url: 'about:blank' },
  ]);
  assert.deepEqual(await catalog.listEligibleUserTargets('browser:other'), []);
  assert.deepEqual(transport.calls, ['Target.getTargets']);
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
