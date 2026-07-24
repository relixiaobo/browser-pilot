import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ActionService,
  AuthService,
  CookieService,
  FrameService,
  InputDispatcher,
  MemoryRefStore,
  NetworkService,
  ObservationService,
  PageContentService,
  TargetService,
  UploadService,
} from '../dist/services.js';

class FakeTransport {
  calls = [];

  constructor(handler = () => ({})) {
    this.handler = handler;
  }

  async send(method, params, sessionId) {
    this.calls.push({ method, params, sessionId });
    return this.handler(method, params, sessionId, this.calls.length - 1);
  }

  close() {}
}

const snapshot = {
  text: '[page] Example | https://example.com',
  data: { title: 'Example', url: 'https://example.com', elements: [] },
};

test('ObservationService stores refs in the injected store', async () => {
  const refs = new MemoryRefStore();
  const transport = new FakeTransport(method => {
    if (method === 'Runtime.evaluate') {
      return { result: { value: JSON.stringify({ title: 'Example', url: 'https://example.com' }) } };
    }
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [
          { nodeId: 'root', childIds: ['button'], ignored: false, role: { value: 'RootWebArea' }, properties: [] },
          {
            nodeId: 'button',
            parentId: 'root',
            ignored: false,
            role: { value: 'button' },
            name: { value: 'Save' },
            properties: [],
            backendDOMNodeId: 42,
          },
        ],
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  });

  const result = await new ObservationService(
    transport,
    'session-1',
    'target-1',
    { refStore: refs },
  ).observe(10);

  assert.deepEqual(result.data.elements, [{ ref: 1, role: 'button', name: 'Save' }]);
  assert.deepEqual(refs.load('target-1'), [{ backendNodeId: 42, role: 'button', name: 'Save' }]);
  assert.deepEqual(refs.load('another-target'), []);
});

test('ObservationService locates and validates an element', async () => {
  const location = { x: 100, y: 200, top: 175, left: 50, width: 100, height: 50 };
  const transport = new FakeTransport(() => ({ result: { value: JSON.stringify(location) } }));
  const service = new ObservationService(transport, 'session-2', 'target-2');

  assert.deepEqual(await service.locate('.editor'), location);
  assert.match(transport.calls[0].params.expression, /\.editor/);
});

test('ActionService dispatches a coordinate click and observes the result', async () => {
  const transport = new FakeTransport();
  let observations = 0;
  const service = new ActionService(transport, 'session-3', 'target-3', {
    observationService: {
      async observeAfterAction(limit) {
        observations += 1;
        assert.equal(limit, 25);
        return snapshot;
      },
    },
  });

  assert.deepEqual(
    await service.click(
      { kind: 'coordinates', x: 10, y: 20 },
      { button: 'left', clickCount: 2, observationLimit: 25 },
    ),
    snapshot,
  );
  assert.equal(observations, 1);
  assert.deepEqual(transport.calls.map(call => call.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(transport.calls[1].params.clickCount, 2);
});

test('ActionService resolves a ref, clicks its current coordinates, and releases it', async () => {
  const refs = new MemoryRefStore();
  refs.save('target-4', [{ backendNodeId: 99, role: 'link', name: 'Details' }]);
  const transport = new FakeTransport(method => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'object-1' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: JSON.stringify({ x: 44, y: 55 }) } };
    return {};
  });
  const service = new ActionService(transport, 'session-4', 'target-4', {
    refStore: refs,
    observationService: { async observeAfterAction() { return snapshot; } },
  });

  await service.click({ kind: 'ref', ref: '1' });

  assert.equal(transport.calls[0].method, 'DOM.resolveNode');
  assert.equal(transport.calls[0].params.backendNodeId, 99);
  assert.equal(transport.calls.at(-1).method, 'Runtime.releaseObject');
  assert.deepEqual(
    transport.calls.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => [call.params.x, call.params.y]),
    [[44, 55], [44, 55], [44, 55]],
  );
});

test('ActionService rejects double right-click before dispatch', async () => {
  const transport = new FakeTransport();
  const service = new ActionService(transport, 'session-5', 'target-5', {
    observationService: { async observeAfterAction() { return snapshot; } },
  });

  await assert.rejects(
    () => service.click(
      { kind: 'coordinates', x: 1, y: 2 },
      { button: 'right', clickCount: 2 },
    ),
    error => error.code === 'invalid_argument',
  );
  assert.equal(transport.calls.length, 0);
});

test('InputDispatcher handles modifiers, tabs, and non-ASCII text', async () => {
  const transport = new FakeTransport();
  const input = new InputDispatcher(transport, 'session-6');

  await input.press('Control+a');
  assert.deepEqual(
    transport.calls.slice(0, 4).map(call => [call.params.type, call.params.key]),
    [['keyDown', 'Control'], ['keyDown', 'a'], ['keyUp', 'a'], ['keyUp', 'Control']],
  );

  transport.calls.length = 0;
  await input.typeText('x\t中');
  assert.equal(transport.calls.filter(call => call.method === 'Input.dispatchKeyEvent' && call.params.key === 'Tab').length, 2);
  assert.deepEqual(transport.calls.at(-1), {
    method: 'Input.insertText',
    params: { text: '中' },
    sessionId: 'session-6',
  });
});

test('InputDispatcher rejects an unknown modifier with a stable error', async () => {
  const transport = new FakeTransport();
  await assert.rejects(
    () => new InputDispatcher(transport, 'session-7').press('Unknown+a'),
    error => error.code === 'invalid_argument' && error.context?.field === 'key',
  );
  assert.equal(transport.calls.length, 0);
});

test('ActionService types into a controlled input and returns value-length evidence', async () => {
  const refs = new MemoryRefStore();
  refs.save('target-8', [{ backendNodeId: 8, role: 'textbox', name: 'Query' }]);
  const editableStates = [
    { kind: 'input', value: 'old', sensitive: false },
    { kind: 'input', value: 'old-new', sensitive: false },
  ];
  const transport = new FakeTransport((method, params) => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'input-1' } };
    if (method === 'Runtime.callFunctionOn' && params.returnByValue) {
      return { result: { value: editableStates.shift() } };
    }
    return {};
  });
  const service = new ActionService(transport, 'session-8', 'target-8', {
    refStore: refs,
    readbackDelayMs: 0,
    observationService: { async observeAfterAction() { return snapshot; } },
  });

  const result = await service.type('1', '-new');

  assert.deepEqual(result.observation, snapshot);
  assert.deepEqual(result.evidence, {
    status: 'verified',
    kind: 'input',
    sensitive: false,
    beforeLength: 3,
    expectedLength: 7,
    afterLength: 7,
  });
  const setCall = transport.calls.find(call => (
    call.method === 'Runtime.callFunctionOn' && Array.isArray(call.params.arguments)
  ));
  assert.deepEqual(setCall.params.arguments, [{ value: '-new' }, { value: false }]);
  assert.equal(transport.calls.at(-1).method, 'Runtime.releaseObject');
});

test('exact input verification fails without exposing password contents', async () => {
  const refs = new MemoryRefStore();
  refs.save('target-9', [{ backendNodeId: 9, role: 'textbox', name: 'Password' }]);
  const editableStates = [
    { kind: 'input', value: 'old-secret', sensitive: true },
    { kind: 'input', value: 'masked-result', sensitive: true },
  ];
  const transport = new FakeTransport((method, params) => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'password-1' } };
    if (method === 'Runtime.callFunctionOn' && params.returnByValue) {
      return { result: { value: editableStates.shift() } };
    }
    return {};
  });
  const service = new ActionService(transport, 'session-9', 'target-9', {
    refStore: refs,
    readbackDelayMs: 0,
    observationService: { async observeAfterAction() { return snapshot; } },
  });

  await assert.rejects(
    () => service.type('1', 'new-secret', { clear: true, verification: 'require_exact' }),
    error => {
      assert.equal(error.code, 'action_not_verified');
      assert.equal(error.context.sensitive, true);
      const serialized = JSON.stringify(error.context);
      assert.doesNotMatch(serialized, /old-secret|new-secret|masked-result/);
      return true;
    },
  );
  assert.equal(transport.calls.at(-1).method, 'Runtime.releaseObject');
});

test('keyboard reports unavailable verification for canvas-style focus', async () => {
  const transport = new FakeTransport(method => {
    if (method === 'Runtime.evaluate') {
      return { result: { value: { kind: 'unsupported', value: '', sensitive: false } } };
    }
    return {};
  });
  const service = new ActionService(transport, 'session-10', 'target-10', {
    readbackDelayMs: 0,
    observationService: { async observeAfterAction() { return snapshot; } },
  });

  const result = await service.keyboard('hello');

  assert.deepEqual(result.evidence, {
    status: 'unavailable',
    kind: 'unsupported',
    sensitive: false,
    reason: 'active_element_not_readable',
  });
  assert.deepEqual(result.observation, snapshot);
});

test('UploadService selects a file input, uploads, releases, and observes', async () => {
  const transport = new FakeTransport((method, params) => {
    if (method === 'Runtime.evaluate' && params.returnByValue) {
      return { result: { value: JSON.stringify([
        { index: 1, name: 'avatar', accept: 'image/*' },
        { index: 2, name: 'resume', accept: '.pdf' },
      ]) } };
    }
    if (method === 'Runtime.evaluate') return { result: { objectId: 'file-input-2' } };
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 72 } };
    return {};
  });
  const service = new UploadService(transport, 'session-11', {
    async observeAfterAction() { return snapshot; },
  });

  assert.deepEqual(
    await service.upload('/protected/resume.pdf', { inputIndex: 2 }),
    snapshot,
  );
  const upload = transport.calls.find(call => call.method === 'DOM.setFileInputFiles');
  assert.deepEqual(upload.params, { files: ['/protected/resume.pdf'], backendNodeId: 72 });
  assert.equal(transport.calls.at(-1).method, 'Runtime.releaseObject');
});

test('PageContentService evaluates values and parses bounded reads', async () => {
  const responses = [
    { result: { value: 42 } },
    { result: { value: JSON.stringify({
      ok: true,
      title: 'Example',
      url: 'https://example.com',
      text: 'Hello',
      length: 5,
      truncated: false,
    }) } },
  ];
  const transport = new FakeTransport(() => responses.shift());
  const service = new PageContentService(transport, 'session-12');

  assert.equal(await service.evaluate('6 * 7'), 42);
  assert.deepEqual(await service.read('main', 100), {
    title: 'Example',
    url: 'https://example.com',
    text: 'Hello',
    length: 5,
    truncated: false,
  });
});

test('PageContentService returns a stable selector error', async () => {
  const transport = new FakeTransport(() => ({
    result: { value: JSON.stringify({ ok: false, error: 'No content root found' }) },
  }));

  await assert.rejects(
    () => new PageContentService(transport, 'session-13').read('.missing', 100),
    error => error.code === 'invalid_argument' && error.context?.field === 'selector',
  );
});

test('TargetService adopts only popups with a complete owned opener chain', async () => {
  const transport = new FakeTransport(method => {
    assert.equal(method, 'Target.getTargets');
    return {
      targetInfos: [
        { targetId: 'pilot', type: 'page', url: 'https://app.test', title: 'Pilot' },
        { targetId: 'popup', type: 'page', url: 'https://popup.test', title: 'Popup' },
        { targetId: 'nested', type: 'page', url: 'https://nested.test', title: 'Nested' },
        { targetId: 'ordinary', type: 'page', url: 'https://private.test', title: 'Private' },
        { targetId: 'unrelated-popup', type: 'page', url: 'https://unrelated.test', title: 'Unrelated' },
        { targetId: 'settings', type: 'page', url: 'chrome://settings/', title: 'Settings' },
        { targetId: 'worker', type: 'service_worker', url: 'https://app.test/sw.js', title: '' },
      ],
    };
  });
  const discovery = {
    async discoveredTargets() {
      return [
        { targetId: 'popup', url: 'https://popup.test', openerTargetId: 'pilot' },
        { targetId: 'nested', url: 'https://nested.test', openerTargetId: 'popup' },
        { targetId: 'unrelated-popup', url: 'https://unrelated.test', openerTargetId: 'ordinary' },
      ];
    },
  };

  const result = await new TargetService(transport, discovery).list(['pilot'], 'pilot');

  assert.deepEqual(result.managedTargetIds, ['pilot', 'popup', 'nested']);
  assert.deepEqual(result.adoptedTargetIds, ['popup', 'nested']);
  assert.deepEqual(
    result.tabs.map(tab => [tab.targetId, tab.origin]),
    [
      ['pilot', 'managed'],
      ['popup', 'managed'],
      ['nested', 'managed'],
      ['ordinary', 'user_tab'],
      ['unrelated-popup', 'user_tab'],
    ],
  );
  assert.equal(result.tabs[0].active, true);
});

test('TargetService refuses to close a target outside the visible inventory before CDP dispatch', async () => {
  const transport = new FakeTransport();
  const service = new TargetService(transport, { async discoveredTargets() { return []; } });

  await assert.rejects(
    () => service.close(['pilot'], 'ordinary'),
    error => error.code === 'target_not_owned' && error.context?.targetId === 'ordinary',
  );
  assert.equal(transport.calls.length, 0);
});

test('TargetService explicitly closes a visible user tab', async () => {
  const transport = new FakeTransport();
  const service = new TargetService(transport, { async discoveredTargets() { return []; } });

  await service.close(['pilot', 'user-form'], 'user-form');

  assert.deepEqual(transport.calls, [{
    method: 'Target.closeTarget',
    params: { targetId: 'user-form' },
    sessionId: undefined,
  }]);
});

test('TargetService bulk close operates only on the managed IDs supplied by the caller', async () => {
  const transport = new FakeTransport();
  const service = new TargetService(transport, { async discoveredTargets() { return []; } });

  assert.deepEqual(await service.closeManaged(['pilot', 'popup']), {
    closed: ['pilot', 'popup'],
    failed: [],
  });
  assert.deepEqual(
    transport.calls.map(call => call.params.targetId),
    ['pilot', 'popup'],
  );
});

test('FrameService lists nested frames and creates a selected context', async () => {
  const transport = new FakeTransport(method => {
    if (method === 'Page.getFrameTree') {
      return {
        frameTree: {
          frame: { id: 'top', url: 'https://app.test', name: '' },
          childFrames: [{ frame: { id: 'child', url: 'https://frame.test', name: 'details' } }],
        },
      };
    }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 77 };
    return {};
  });
  const service = new FrameService(transport, 'session-14');

  assert.deepEqual(await service.list(), [
    { id: 'top', url: 'https://app.test', name: '' },
    { id: 'child', parentId: 'top', url: 'https://frame.test', name: 'details' },
  ]);
  assert.deepEqual(await service.select(1), {
    index: 1,
    frame: { id: 'child', parentId: 'top', url: 'https://frame.test', name: 'details' },
    executionContextId: 77,
  });
});

test('CookieService scopes cookie reads to the current URL or explicit domain', async () => {
  const transport = new FakeTransport(method => {
    if (method === 'Runtime.evaluate') return { result: { value: 'https://app.test/page' } };
    if (method === 'Network.getCookies') return { cookies: [] };
    return {};
  });
  const service = new CookieService(transport, 'session-15');

  await service.list();
  assert.deepEqual(transport.calls[1].params.urls, ['https://app.test/page']);
  transport.calls.length = 0;
  await service.list('example.com');
  assert.deepEqual(transport.calls[0].params.urls, ['https://example.com', 'http://example.com']);
});

test('AuthService forwards credentials without retaining them', async () => {
  const calls = [];
  const controller = {
    async setAuth(username, password) { calls.push(['set', username, password]); },
    async clearAuth() { calls.push(['clear']); },
  };
  const service = new AuthService(controller);

  await service.set('admin', 'secret');
  await service.clear();
  assert.deepEqual(calls, [['set', 'admin', 'secret'], ['clear']]);
  assert.deepEqual(Object.keys(service), ['controller']);
});

test('NetworkService validates rules before forwarding to the daemon', async () => {
  const calls = [];
  const controller = {
    async enableNetwork(sessionId) { calls.push(['enable', sessionId]); },
    async netRequests(options) { calls.push(['requests', options]); return { requests: [], total: 0 }; },
    async netRequestDetail(id) { return { id, method: 'GET', url: 'https://app.test' }; },
    async netBody(id) { return { id, body: 'ok', mimeType: 'text/plain' }; },
    async netClear() { calls.push(['clear']); },
    async netAddRule(rule) { calls.push(['rule', rule]); return { rule: { id: 1, ...rule } }; },
    async netRules() { return { rules: [] }; },
    async netRemoveRule(id) { calls.push(['remove', id]); },
  };
  const service = new NetworkService(controller, 'session-16');

  await service.enable();
  await service.addHeaders('*api*', [{ name: 'X-Test', value: 'yes' }]);
  assert.deepEqual(calls, [
    ['enable', 'session-16'],
    ['rule', { type: 'headers', pattern: '*api*', headers: [{ name: 'X-Test', value: 'yes' }] }],
  ]);
  await assert.rejects(
    () => service.addHeaders('*api*', [{ name: 'Bad\nHeader', value: 'x' }]),
    error => error.code === 'invalid_argument',
  );
  await assert.rejects(
    () => service.addMock('*api*', 42, '{}'),
    error => error.code === 'invalid_argument',
  );
  assert.equal(calls.length, 2);
});
