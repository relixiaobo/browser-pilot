import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ActionService,
  CdpActionContinuityGuard,
  CDPError,
  CookieService,
  FrameService,
  InputDispatcher,
  MemoryRefStore,
  ObservationService,
  ObservationWorldService,
  PageLoadTimeoutError,
  PageContentService,
  RefRevalidationService,
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

test('ObservationService enforces its load deadline when a CDP request never settles', async () => {
  const transport = new FakeTransport(() => new Promise(() => {}));
  const service = new ObservationService(transport, 'session:stalled', 'target:stalled', {
    settleDelayMs: 0,
    loadTimeoutMs: 25,
  });
  const startedAt = Date.now();

  await assert.rejects(
    () => service.observeAfterAction(),
    error => error instanceof PageLoadTimeoutError && error.timeoutMs === 25,
  );
  assert.ok(Date.now() - startedAt < 500, 'load deadline was not enforced around the pending CDP request');
});

function domOnlyRefSnapshot({ backendNodeId = 200, name = 'DOM Command', clickable = true } = {}) {
  const strings = [];
  const intern = value => {
    const existing = strings.indexOf(value);
    if (existing >= 0) return existing;
    strings.push(value);
    return strings.length - 1;
  };
  const empty = intern('');
  return {
    strings,
    documents: [{
      frameId: intern('frame:dom-only'),
      documentURL: intern('https://example.test/dom-only'),
      baseURL: intern('https://example.test/'),
      nodes: {
        parentIndex: [-1, 0, 1, 2],
        nodeType: [9, 1, 1, 1],
        nodeName: ['#document', 'html', 'body', 'div'].map(intern),
        nodeValue: [empty, empty, empty, empty],
        backendNodeId: [9_000, 9_001, 9_002, backendNodeId],
        attributes: [[], [], [], [intern('aria-label'), intern(name)]],
        isClickable: { index: clickable ? [3] : [] },
      },
      layout: { nodeIndex: [], bounds: [], styles: [], paintOrders: [] },
    }],
  };
}

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
    if (method === 'DOMSnapshot.captureSnapshot') return { documents: [], strings: [] };
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

test('ObservationService maps locate evaluation exceptions to a structured selector error', async () => {
  const transport = new FakeTransport(() => ({
    result: {},
    exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: poisoned selector' } },
  }));
  const service = new ObservationService(transport, 'session:locate-error', 'target:locate-error');

  await assert.rejects(
    () => service.locate('.editor'),
    error => error.code === 'invalid_argument' && error.context?.field === 'selector' &&
      /poisoned selector/.test(error.message),
  );
});

test('ObservationWorldService caches worlds and invalidates by frame, context, and session', async () => {
  let nextContextId = 70;
  const transport = new FakeTransport(method => {
    assert.equal(method, 'Page.createIsolatedWorld');
    nextContextId += 1;
    return { executionContextId: nextContextId };
  });
  const worlds = new ObservationWorldService(transport);

  assert.deepEqual(await Promise.all([
    worlds.contextId('session-a', 'frame-a'),
    worlds.contextId('session-a', 'frame-a'),
  ]), [71, 71]);
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(transport.calls[0], {
    method: 'Page.createIsolatedWorld',
    params: {
      frameId: 'frame-a',
      worldName: 'browser-pilot.observation.v1',
      grantUniveralAccess: false,
    },
    sessionId: 'session-a',
  });

  worlds.invalidateFrame('session-a', 'frame-a');
  assert.equal(await worlds.contextId('session-a', 'frame-a'), 72);
  worlds.invalidateContext('session-a', 72);
  assert.equal(await worlds.contextId('session-a', 'frame-a'), 73);
  await worlds.contextId('session-a', 'frame-b');
  worlds.invalidateSession('session-a');
  assert.equal(await worlds.contextId('session-a', 'frame-a'), 75);
  assert.equal(await worlds.contextId('session-b', 'frame-a'), 76);
  worlds.invalidateSession('session-a');
  assert.equal(await worlds.contextId('session-b', 'frame-a'), 76);
});

test('RefRevalidationService accepts unchanged AX semantics without a full DOM snapshot', async () => {
  const transport = new FakeTransport(method => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'object-ref' } };
    if (method === 'Runtime.releaseObject') return {};
    if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
    if (method === 'Accessibility.getPartialAXTree') return { nodes: [{
      backendDOMNodeId: 201,
      ignored: false,
      role: { value: 'button' },
      name: { value: 'Save' },
      properties: [],
    }] };
    throw new Error(`Unexpected method: ${method}`);
  });

  await new RefRevalidationService(transport, 'session-ref').validate(
    { backendNodeId: 201, role: 'button', name: 'Save' },
    { targetId: 'target-ref', ref: 1 },
  );

  assert.equal(transport.calls.some(call => call.method === 'DOMSnapshot.captureSnapshot'), false);
  assert.equal(transport.calls.at(-1).method, 'Runtime.releaseObject');
});

test('RefRevalidationService rejects changed AX and DOM-only semantics as stale refs', async () => {
  let domSnapshot = domOnlyRefSnapshot();
  const transport = new FakeTransport(method => {
    if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
    if (method === 'Accessibility.getPartialAXTree') return { nodes: [{
      backendDOMNodeId: 200,
      ignored: false,
      role: { value: 'generic' },
      name: { value: '' },
      properties: [],
    }] };
    if (method === 'DOMSnapshot.captureSnapshot') return domSnapshot;
    throw new Error(`Unexpected method: ${method}`);
  });
  const service = new RefRevalidationService(transport, 'session-ref');
  const expected = { backendNodeId: 200, role: 'button', name: 'DOM Command' };

  await service.validateResolved('object-ref', expected, { targetId: 'target-ref', ref: 2 });
  domSnapshot = domOnlyRefSnapshot({ name: 'Delete account' });
  await assert.rejects(
    () => service.validateResolved('object-ref', expected, { targetId: 'target-ref', ref: 2 }),
    error => (
      error.code === 'stale_ref' && error.context?.targetId === 'target-ref' &&
      error.context?.ref === 2 && error.context?.reason === undefined
    ),
  );
  domSnapshot = domOnlyRefSnapshot({ clickable: false });
  await assert.rejects(
    () => service.validateResolved('object-ref', expected),
    error => error.code === 'stale_ref',
  );
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

  const result = await service.click(
    { kind: 'coordinates', x: 10, y: 20 },
    { button: 'left', clickCount: 2, observationLimit: 25 },
  );
  assert.deepEqual(result.observation, snapshot);
  assert.deepEqual(result.evidence, {
    action: 'click',
    status: 'unavailable',
    kind: 'coordinates',
    effects: [],
    reason: 'coordinate_target',
  });
  assert.equal(observations, 1);
  assert.deepEqual(transport.calls.map(call => call.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(transport.calls[1].params.clickCount, 2);
});

test('ActionService applies the selected frame offset to pointer coordinates', async () => {
  const transport = new FakeTransport();
  const service = new ActionService(transport, 'session-offset', 'target-offset', {
    pointerOffset: async () => ({ x: 300, y: 150 }),
    observationService: { async observeAfterAction() { return snapshot; } },
  });

  await service.click({ kind: 'coordinates', x: 10, y: 20 });

  assert.deepEqual(
    transport.calls.map(call => [call.params.x, call.params.y]),
    [[310, 170], [310, 170], [310, 170]],
  );
});

test.todo('selector targets resolve in the selected subframe execution context', async () => {
  const transport = new FakeTransport((method, _params) => {
    if (method === 'Runtime.evaluate') {
      return { result: { objectId: 'object:frame-button' } };
    }
    if (method === 'Runtime.callFunctionOn') {
      return { result: { value: {
        status: 'ready',
        x: 25,
        y: 30,
        targetState: { connected: true, kind: 'control', focused: false },
      } } };
    }
    return {};
  });
  const service = new ActionService(transport, 'session:frame-root', 'target:frame-root', {
    executionContextId: 77,
    readbackDelayMs: 0,
    observationService: { async observeAfterAction() { return snapshot; } },
  });

  await service.click({ kind: 'ref', ref: '.frame-button' });

  const resolution = transport.calls.find(call => (
    call.method === 'Runtime.evaluate' && call.params.expression.includes('document.querySelector')
  ));
  assert.equal(resolution.params.contextId, 77);
});

test('ActionService resolves a ref, clicks its current coordinates, and releases it', async () => {
  const refs = new MemoryRefStore();
  refs.save('target-4', [{ backendNodeId: 99, role: 'link', name: 'Details' }]);
  const transport = new FakeTransport(method => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'object-1' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: {
      status: 'ready',
      x: 44,
      y: 55,
      targetState: { connected: true, kind: 'control', focused: false },
    } } };
    return {};
  });
  const service = new ActionService(transport, 'session-4', 'target-4', {
    refStore: refs,
    readbackDelayMs: 0,
    observationService: { async observeAfterAction() { return snapshot; } },
  });

  const result = await service.click({ kind: 'ref', ref: '1' });

  assert.equal(result.evidence.status, 'unavailable');
  assert.equal(transport.calls[0].method, 'DOM.resolveNode');
  assert.equal(transport.calls[0].params.backendNodeId, 99);
  assert.equal(transport.calls.at(-1).method, 'Runtime.releaseObject');
  assert.deepEqual(
    transport.calls.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => [call.params.x, call.params.y]),
    [[44, 55], [44, 55], [44, 55]],
  );
});

for (const blocked of [
  { reason: 'disabled', retryable: false },
  { reason: 'obscured', retryable: true, obstruction: { tagName: 'div', role: 'dialog' } },
]) {
  test(`ActionService rejects ${blocked.reason === 'obscured' ? 'an' : 'a'} ${blocked.reason} ref before pointer dispatch`, async () => {
    const refs = new MemoryRefStore();
    refs.save('target-blocked', [{ backendNodeId: 101, role: 'button', name: 'Save' }]);
    const transport = new FakeTransport(method => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'object-blocked' } };
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: { status: 'blocked', ...blocked } } };
      }
      return {};
    });
    const service = new ActionService(transport, 'session-blocked', 'target-blocked', {
      refStore: refs,
      observationService: { async observeAfterAction() { return snapshot; } },
    });

    await assert.rejects(
      () => service.click({ kind: 'ref', ref: '1' }),
      error => {
        assert.equal(error.code, 'action_not_verified');
        assert.equal(error.retryable, blocked.retryable);
        assert.equal(error.context.reason, blocked.reason);
        if (blocked.obstruction) assert.deepEqual(error.context.obstruction, blocked.obstruction);
        return true;
      },
    );
    assert.equal(transport.calls.some(call => call.method === 'Input.dispatchMouseEvent'), false);
    assert.equal(transport.calls.at(-1).method, 'Runtime.releaseObject');
  });
}

test('ActionService reports a detached pointer target as a stale ref', async () => {
  const refs = new MemoryRefStore();
  refs.save('target-detached', [{ backendNodeId: 102, role: 'link', name: 'Next' }]);
  const transport = new FakeTransport(method => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'object-detached' } };
    if (method === 'Runtime.callFunctionOn') {
      return { result: { value: { status: 'blocked', reason: 'detached' } } };
    }
    return {};
  });
  const service = new ActionService(transport, 'session-detached', 'target-detached', {
    refStore: refs,
    observationService: { async observeAfterAction() { return snapshot; } },
  });

  await assert.rejects(
    () => service.click({ kind: 'ref', ref: '1' }),
    error => error.code === 'stale_ref' && error.context?.reason === 'detached',
  );
  assert.equal(transport.calls.some(call => call.method === 'Input.dispatchMouseEvent'), false);
  assert.equal(transport.calls.at(-1).method, 'Runtime.releaseObject');
});

test('ActionService reports a node removed before live resolution as a stale ref', async () => {
  const refs = new MemoryRefStore();
  refs.save('target-removed', [{ backendNodeId: 106, role: 'button', name: 'Removed' }]);
  const transport = new FakeTransport(method => {
    if (method === 'DOM.resolveNode') {
      throw new CDPError(-32000, 'No node with given id found', { backendNodeId: 106 });
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const service = new ActionService(transport, 'session-removed', 'target-removed', {
    refStore: refs,
    refValidator: async () => assert.fail('validator must not run without a resolved node'),
    observationService: { async observeAfterAction() { return snapshot; } },
  });

  await assert.rejects(
    () => service.click({ kind: 'ref', ref: '1' }),
    error => (
      error.code === 'stale_ref' && error.context?.targetId === 'target-removed' &&
      error.context?.ref === 1 && error.context?.reason === undefined
    ),
  );
  assert.equal(transport.calls.some(call => call.method.startsWith('Input.')), false);
});

test('ActionService preserves non-node CDP errors during live ref resolution', async () => {
  const refs = new MemoryRefStore();
  refs.save('target-invalid-context', [{ backendNodeId: 107, role: 'button', name: 'Command' }]);
  const cdpError = new CDPError(-32602, 'Invalid execution context', { contextId: 77 });
  const transport = new FakeTransport(method => {
    if (method === 'DOM.resolveNode') throw cdpError;
    throw new Error(`Unexpected method: ${method}`);
  });
  const service = new ActionService(transport, 'session-invalid-context', 'target-invalid-context', {
    refStore: refs,
    observationService: { async observeAfterAction() { return snapshot; } },
  });

  await assert.rejects(
    () => service.click({ kind: 'ref', ref: '1' }),
    error => error === cdpError && error.code === -32602 && error.data?.contextId === 77,
  );
});

test('ActionService dispatches a page-validated descendant or label hit point', async () => {
  const refs = new MemoryRefStore();
  refs.save('target-label', [{ backendNodeId: 103, role: 'checkbox', name: 'Remember me' }]);
  let verificationReads = 0;
  const transport = new FakeTransport((method, params) => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'object-label' } };
    if (method === 'Runtime.callFunctionOn') {
      if (String(params.functionDeclaration).includes('elementsFromPoint')) {
        return { result: { value: {
          status: 'ready',
          x: 12.5,
          y: 18.75,
          targetState: { connected: true, kind: 'checkbox', focused: false, checked: false },
        } } };
      }
      verificationReads += 1;
      return { result: { value: {
        connected: true,
        kind: 'checkbox',
        focused: true,
        checked: true,
      } } };
    }
    return {};
  });
  const service = new ActionService(transport, 'session-label', 'target-label', {
    refStore: refs,
    readbackDelayMs: 0,
    observationService: { async observeAfterAction() { return snapshot; } },
  });

  const result = await service.click({ kind: 'ref', ref: '1' });

  assert.equal(verificationReads, 1);
  assert.deepEqual(result.evidence, {
    action: 'click',
    status: 'verified',
    kind: 'checkbox',
    effects: ['checked_changed', 'focus_changed'],
    checked: true,
    focused: true,
  });
  assert.deepEqual(
    transport.calls.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => [call.params.x, call.params.y]),
    [[12.5, 18.75], [12.5, 18.75], [12.5, 18.75]],
  );
  const validationCall = transport.calls.find(call => call.method === 'Runtime.callFunctionOn');
  assert.match(validationCall.params.functionDeclaration, /elementsFromPoint/);
  assert.match(validationCall.params.functionDeclaration, /labels/);
});

test('ActionService reports a checkbox that did not toggle as a mismatch', async () => {
  const refs = new MemoryRefStore();
  refs.save('target-checkbox', [{ backendNodeId: 105, role: 'checkbox', name: 'Accept' }]);
  const state = { connected: true, kind: 'checkbox', focused: false, checked: false };
  const transport = new FakeTransport((method, params) => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'object-checkbox' } };
    if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('elementsFromPoint')) {
      return { result: { value: { status: 'ready', x: 30, y: 40, targetState: state } } };
    }
    if (method === 'Runtime.callFunctionOn') return { result: { value: state } };
    return {};
  });
  const service = new ActionService(transport, 'session-checkbox', 'target-checkbox', {
    refStore: refs,
    readbackDelayMs: 0,
    observationService: { async observeAfterAction() { return snapshot; } },
  });

  const result = await service.click({ kind: 'ref', ref: '1' });

  assert.deepEqual(result.evidence, {
    action: 'click',
    status: 'mismatch',
    kind: 'checkbox',
    effects: [],
    checked: false,
    focused: false,
    reason: 'expected_state_unchanged',
  });
});

test('ActionService fails closed when Chrome returns an invalid pointer target state', async () => {
  const refs = new MemoryRefStore();
  refs.save('target-invalid', [{ backendNodeId: 104, role: 'button', name: 'Continue' }]);
  const transport = new FakeTransport(method => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'object-invalid' } };
    if (method === 'Runtime.callFunctionOn') {
      return { result: { value: { status: 'ready', x: 'not-a-coordinate', y: 20 } } };
    }
    return {};
  });
  const service = new ActionService(transport, 'session-invalid', 'target-invalid', {
    refStore: refs,
    observationService: { async observeAfterAction() { return snapshot; } },
  });

  await assert.rejects(
    () => service.click({ kind: 'ref', ref: '1' }),
    error => error.code === 'internal_error',
  );
  assert.equal(transport.calls.some(call => call.method === 'Input.dispatchMouseEvent'), false);
  assert.equal(transport.calls.at(-1).method, 'Runtime.releaseObject');
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
  assert.deepEqual(transport.calls[1].params.commands, ['SelectAll']);
  assert.equal(transport.calls[1].params.text, '');

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

test('CDP action continuity distinguishes pre-dispatch changes from partial outcomes', async () => {
  let loaderId = 'loader:one';
  const transport = new FakeTransport((method, params) => {
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: 'frame:top', loaderId } } };
    }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 71 };
    if (method === 'Runtime.evaluate') {
      if (String(params.expression).includes('state.focus =')) return { result: { value: 'ready' } };
      if (String(params.expression).includes('state.focus !==')) return { result: { value: 'ready' } };
      return { result: { value: true } };
    }
    throw new Error(`Unexpected method: ${method}`);
  });

  const beforeDispatch = await CdpActionContinuityGuard.create(
    transport,
    'session:continuity',
    'keyboard',
  );
  loaderId = 'loader:two';
  await assert.rejects(
    () => beforeDispatch.check({
      action: 'keyboard',
      step: 'type_character:0',
      dispatchedSteps: 0,
      requireSameFocus: true,
    }),
    error => (
      error.code === 'action_not_verified' &&
      error.context?.reason === 'loader_changed' &&
      error.context?.remainingStepsStopped === true
    ),
  );
  await beforeDispatch.release();

  const afterDispatch = await CdpActionContinuityGuard.create(
    transport,
    'session:continuity',
    'keyboard',
  );
  loaderId = 'loader:three';
  await assert.rejects(
    () => afterDispatch.check({
      action: 'keyboard',
      step: 'type_character:1',
      dispatchedSteps: 1,
      requireSameFocus: true,
    }),
    error => (
      error.code === 'unknown_outcome' &&
      error.context?.reason === 'loader_changed' &&
      error.context?.dispatchedSteps === 1
    ),
  );
  await afterDispatch.release();
});

test('CDP action continuity reports target, session, frame, and document changes', async () => {
  for (const reason of ['target_changed', 'session_changed', 'frame_changed', 'document_changed']) {
    const state = {
      externalFailure: undefined,
      frameId: 'frame:top',
      pageState: 'ready',
    };
    const transport = new FakeTransport((method, params) => {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: state.frameId, loaderId: 'loader:stable' } } };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 72 };
      if (method === 'Runtime.evaluate') {
        if (String(params.expression).includes('state.focus =')) return { result: { value: 'ready' } };
        if (String(params.expression).includes('state.focus !==')) {
          return { result: { value: state.pageState } };
        }
        return { result: { value: true } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const guard = await CdpActionContinuityGuard.create(
      transport,
      `session:${reason}`,
      'keyboard',
      { externalCheck: () => state.externalFailure },
    );
    if (reason === 'target_changed' || reason === 'session_changed') state.externalFailure = reason;
    if (reason === 'frame_changed') state.frameId = 'frame:replacement';
    if (reason === 'document_changed') state.pageState = 'document_changed';

    await assert.rejects(
      () => guard.check({
        action: 'keyboard',
        step: 'type_character:1',
        dispatchedSteps: 1,
        requireSameFocus: true,
      }),
      error => error.code === 'unknown_outcome' && error.context?.reason === reason,
    );
    await guard.release();
  }
});

test('ActionService reports observable focus and control effects for key presses', async () => {
  for (const fixture of [
    {
      before: { kind: 'input', sensitive: false, valueToken: '3:abc' },
      after: { kind: 'input', sensitive: false, valueToken: '3:abc' },
      identities: [80, 81],
      effect: 'focus_changed',
      key: 'Tab',
    },
    {
      before: { kind: 'checkbox', sensitive: false, checked: false },
      after: { kind: 'checkbox', sensitive: false, checked: true },
      identities: [82, 82],
      effect: 'checked_changed',
      key: 'Space',
    },
  ]) {
    const states = [fixture.before, fixture.after];
    let readIndex = 0;
    const transport = new FakeTransport((method, params) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: `active-${readIndex}` } };
      if (method === 'DOM.describeNode') {
        return { node: { backendNodeId: fixture.identities[Number(params.objectId.split('-')[1])] } };
      }
      if (method === 'Runtime.callFunctionOn' && params.returnByValue) {
        const value = states[readIndex];
        readIndex += 1;
        return { result: { value } };
      }
      return {};
    });
    const service = new ActionService(transport, 'session-press', 'target-press', {
      readbackDelayMs: 0,
      observationService: { async observeAfterAction() { return snapshot; } },
    });

    const result = await service.press(fixture.key);

    assert.deepEqual(result.observation, snapshot);
    assert.deepEqual(result.evidence, {
      action: 'press',
      status: 'verified',
      kind: fixture.after.kind,
      effects: [fixture.effect],
      sensitive: false,
    });
  }
});

test('ActionService reports unavailable when a key has no observable effect', async () => {
  const state = { kind: 'control', sensitive: false };
  const transport = new FakeTransport((method, params) => {
    if (method === 'Runtime.evaluate') return { result: { objectId: 'active-control' } };
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 83 } };
    if (method === 'Runtime.callFunctionOn' && params.returnByValue) return { result: { value: state } };
    return {};
  });
  const service = new ActionService(transport, 'session-press-none', 'target-press-none', {
    readbackDelayMs: 0,
    observationService: { async observeAfterAction() { return snapshot; } },
  });

  const result = await service.press('Escape');

  assert.deepEqual(result.evidence, {
    action: 'press',
    status: 'unavailable',
    kind: 'control',
    effects: [],
    sensitive: false,
    reason: 'no_observable_effect',
  });
});

test('ActionService types into a controlled input and returns value-length evidence', async () => {
  const refs = new MemoryRefStore();
  refs.save('target-8', [{ backendNodeId: 8, role: 'textbox', name: 'Query' }]);
  const editableStates = [
    {
      kind: 'input', value: 'old', sensitive: false, editable: true,
      inputType: 'text', editMode: 'text', selectionMode: 'range',
    },
    {
      kind: 'input', value: 'old-new', sensitive: false, editable: true,
      inputType: 'text', editMode: 'text', selectionMode: 'range',
    },
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
    action: 'type',
    status: 'verified',
    kind: 'input',
    sensitive: false,
    beforeLength: 3,
    expectedLength: 7,
    afterLength: 7,
  });
  const prepareCall = transport.calls.find(call => (
    call.method === 'Runtime.callFunctionOn' && call.params.returnByValue
  ));
  assert.deepEqual(prepareCall.params.arguments, [{ value: false }]);
  assert.deepEqual(transport.calls.find(call => call.method === 'Input.insertText'), {
    method: 'Input.insertText',
    params: { text: '-new' },
    sessionId: 'session-8',
  });
  assert.equal(transport.calls.at(-1).method, 'Runtime.releaseObject');
});

test('exact input verification fails without exposing password contents', async () => {
  const refs = new MemoryRefStore();
  refs.save('target-9', [{ backendNodeId: 9, role: 'textbox', name: 'Password' }]);
  const editableStates = [
    {
      kind: 'input', value: 'old-secret', sensitive: true, editable: true,
      inputType: 'password', editMode: 'text', selectionMode: 'range',
    },
    {
      kind: 'input', value: 'masked-result', sensitive: true, editable: true,
      inputType: 'password', editMode: 'text', selectionMode: 'range',
    },
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
      return { result: { value: {
        kind: 'unsupported', value: '', sensitive: false, editable: false, reason: 'unsupported_element',
      } } };
    }
    return {};
  });
  const service = new ActionService(transport, 'session-10', 'target-10', {
    readbackDelayMs: 0,
    observationService: { async observeAfterAction() { return snapshot; } },
  });

  const result = await service.keyboard('hello');

  assert.deepEqual(result.evidence, {
    action: 'keyboard',
    status: 'unavailable',
    kind: 'unsupported',
    sensitive: false,
    reason: 'active_element_not_readable',
  });
  assert.deepEqual(result.observation, snapshot);
});

test('ActionService rejects readonly and unsupported inputs before dispatch', async () => {
  for (const fixture of [
    {
      state: {
        kind: 'input', value: 'fixed', sensitive: false, editable: false,
        inputType: 'text', editMode: 'text', selectionMode: 'range', reason: 'readonly',
      },
      code: 'action_not_verified',
    },
    {
      state: {
        kind: 'unsupported', value: '', sensitive: false, editable: false,
        inputType: 'checkbox', reason: 'unsupported_input_type',
      },
      code: 'invalid_argument',
    },
  ]) {
    const refs = new MemoryRefStore();
    refs.save('target-blocked', [{ backendNodeId: 10, role: 'textbox', name: 'Blocked' }]);
    const transport = new FakeTransport((method, params) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'blocked-input' } };
      if (method === 'Runtime.callFunctionOn' && params.returnByValue) {
        return { result: { value: fixture.state } };
      }
      return {};
    });
    const service = new ActionService(transport, 'session-blocked', 'target-blocked', {
      refStore: refs,
      observationService: { async observeAfterAction() { return snapshot; } },
    });

    await assert.rejects(
      () => service.type('1', 'new value'),
      error => error.code === fixture.code && error.context?.reason === fixture.state.reason,
    );
    assert.equal(transport.calls.some(call => call.method.startsWith('Input.')), false);
    assert.equal(transport.calls.at(-1).method, 'Runtime.releaseObject');
  }
});

test('ActionService uses the bounded value-control path for date inputs', async () => {
  const refs = new MemoryRefStore();
  refs.save('target-date', [{ backendNodeId: 11, role: 'textbox', name: 'Date' }]);
  const editableStates = [
    {
      kind: 'input', value: '', sensitive: false, editable: true,
      inputType: 'date', editMode: 'value',
    },
    {
      kind: 'input', value: '2026-07-25', sensitive: false, editable: true,
      inputType: 'date', editMode: 'value',
    },
  ];
  const transport = new FakeTransport((method, params) => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'date-input' } };
    if (method === 'Runtime.callFunctionOn' && params.returnByValue) {
      return { result: { value: editableStates.shift() } };
    }
    return {};
  });
  const service = new ActionService(transport, 'session-date', 'target-date', {
    refStore: refs,
    readbackDelayMs: 0,
    observationService: { async observeAfterAction() { return snapshot; } },
  });

  const result = await service.type('1', '2026-07-25', { clear: true });

  assert.equal(result.evidence.status, 'verified');
  const valueCall = transport.calls.find(call => (
    call.method === 'Runtime.callFunctionOn' && !call.params.returnByValue && call.params.arguments
  ));
  assert.deepEqual(valueCall.params.arguments, [{ value: '2026-07-25' }]);
  assert.equal(transport.calls.some(call => call.method === 'Input.insertText'), false);
});

test('ActionService fails closed on malformed editable state', async () => {
  const refs = new MemoryRefStore();
  refs.save('target-malformed', [{ backendNodeId: 12, role: 'textbox', name: 'Malformed' }]);
  const transport = new FakeTransport((method, params) => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'malformed-input' } };
    if (method === 'Runtime.callFunctionOn' && params.returnByValue) {
      return { result: { value: {
        kind: 'input', value: 'old', sensitive: false, editable: true,
      } } };
    }
    return {};
  });
  const service = new ActionService(transport, 'session-malformed', 'target-malformed', {
    refStore: refs,
    observationService: { async observeAfterAction() { return snapshot; } },
  });

  await assert.rejects(
    () => service.type('1', 'new'),
    error => error.code === 'internal_error',
  );
  assert.equal(transport.calls.some(call => call.method.startsWith('Input.')), false);
});

test('UploadService selects a file input, uploads, releases, and observes', async () => {
  let selected = false;
  const transport = new FakeTransport((method, params) => {
    if (method === 'Runtime.evaluate' && params.returnByValue) {
      return { result: { value: JSON.stringify([
        { index: 1, name: 'avatar', accept: 'image/*' },
        { index: 2, name: 'resume', accept: '.pdf' },
      ]) } };
    }
    if (method === 'Runtime.evaluate') return { result: { objectId: 'file-input-2' } };
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 72 } };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'resolved-file-input' } };
    if (method === 'Runtime.callFunctionOn') {
      return { result: { value: {
        status: 'ready',
        fileCount: selected ? 1 : 0,
        ...(selected ? { firstFileName: 'resume.pdf' } : {}),
      } } };
    }
    if (method === 'DOM.setFileInputFiles') selected = true;
    return {};
  });
  const service = new UploadService(transport, 'session-11', {
    async observeAfterAction() { return snapshot; },
  }, { readbackDelayMs: 0 });

  const result = await service.upload('/protected/resume.pdf', { inputIndex: 2 });

  assert.deepEqual(result.observation, snapshot);
  assert.deepEqual(result.evidence, {
    action: 'upload',
    status: 'verified',
    expectedFileCount: 1,
    fileCount: 1,
    nameMatched: true,
  });
  const upload = transport.calls.find(call => call.method === 'DOM.setFileInputFiles');
  assert.deepEqual(upload.params, { files: ['/protected/resume.pdf'], backendNodeId: 72 });
  assert.equal(transport.calls.at(-1).method, 'Runtime.releaseObject');
});

test('UploadService rejects blocked inputs before assigning files', async () => {
  const transport = new FakeTransport(method => {
    if (method === 'DOM.describeNode') {
      return { node: { backendNodeId: 73, nodeName: 'INPUT', attributes: ['type', 'file'] } };
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'disabled-file-input' } };
    if (method === 'Runtime.callFunctionOn') {
      return { result: { value: { status: 'blocked', reason: 'disabled' } } };
    }
    return {};
  });
  const service = new UploadService(transport, 'session-upload-blocked', {
    async observeAfterAction() { return snapshot; },
  }, { readbackDelayMs: 0 });

  await assert.rejects(
    () => service.upload('/protected/resume.pdf', { backendNodeId: 73 }),
    error => error.code === 'action_not_verified' && error.context?.reason === 'disabled',
  );
  assert.equal(transport.calls.some(call => call.method === 'DOM.setFileInputFiles'), false);
});

test('UploadService reports a page-cleared selection as a mismatch', async () => {
  const transport = new FakeTransport(method => {
    if (method === 'DOM.describeNode') {
      return { node: { backendNodeId: 74, nodeName: 'INPUT', attributes: ['type', 'file'] } };
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'cleared-file-input' } };
    if (method === 'Runtime.callFunctionOn') {
      return { result: { value: { status: 'ready', fileCount: 0 } } };
    }
    return {};
  });
  const service = new UploadService(transport, 'session-upload-cleared', {
    async observeAfterAction() { return snapshot; },
  }, { readbackDelayMs: 0 });

  const result = await service.upload('/protected/resume.pdf', { backendNodeId: 74 });

  assert.deepEqual(result.evidence, {
    action: 'upload',
    status: 'mismatch',
    expectedFileCount: 1,
    fileCount: 0,
    nameMatched: false,
    reason: 'file_count_mismatch',
  });
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

test('FrameService recursively merges only OOPIF targets descended from the root frame', async () => {
  const transport = new FakeTransport((method, _params, sessionId) => {
    if (method === 'Page.getFrameTree' && sessionId === 'session-root') {
      return {
        frameTree: {
          frame: { id: 'top', url: 'https://app.test', name: '' },
          childFrames: [{ frame: { id: 'same', url: 'https://app.test/same', name: 'same' } }],
        },
      };
    }
    if (method === 'Page.getFrameTree' && sessionId === 'session-oopif') {
      return {
        frameTree: {
          frame: {
            id: 'oopif-target',
            parentId: 'top',
            url: 'https://cross.test/frame',
            name: 'cross',
          },
          childFrames: [{
            frame: {
              id: 'oopif-same-child',
              url: 'https://cross.test/inner',
              name: 'inner',
            },
          }],
        },
      };
    }
    if (method === 'Page.getFrameTree' && sessionId === 'session-nested') {
      return {
        frameTree: {
          frame: {
            id: 'nested-oopif',
            parentId: 'oopif-same-child',
            url: 'https://nested.test/frame',
            name: 'nested',
          },
        },
      };
    }
    if (method === 'Target.getTargets') {
      return {
        targetInfos: [
          {
            targetId: 'nested-oopif',
            type: 'iframe',
            url: 'https://nested.test/frame',
            parentFrameId: 'oopif-same-child',
          },
          {
            targetId: 'unrelated-oopif',
            type: 'iframe',
            url: 'https://unrelated.test/',
            parentFrameId: 'another-tab',
          },
          {
            targetId: 'oopif-target',
            type: 'iframe',
            url: 'https://cross.test/frame',
            parentFrameId: 'top',
          },
        ],
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const attached = [];
  const service = new FrameService(transport, 'session-root');
  const result = await service.listAcrossTargets({
    rootTargetId: 'root-target',
    attachment: () => undefined,
    async attach(target) {
      attached.push(target.targetId);
      return {
        targetId: target.targetId,
        sessionId: target.targetId === 'nested-oopif' ? 'session-nested' : 'session-oopif',
      };
    },
  });

  assert.deepEqual(attached, ['oopif-target', 'nested-oopif']);
  assert.deepEqual(result.attachedTargetIds, ['oopif-target', 'nested-oopif']);
  assert.deepEqual(result.frames.map(frame => ({
    id: frame.id,
    parentId: frame.parentId,
    sessionId: frame.sessionId,
  })), [
    { id: 'top', parentId: undefined, sessionId: 'session-root' },
    { id: 'same', parentId: 'top', sessionId: 'session-root' },
    { id: 'oopif-target', parentId: 'top', sessionId: 'session-oopif' },
    { id: 'oopif-same-child', parentId: 'oopif-target', sessionId: 'session-oopif' },
    { id: 'nested-oopif', parentId: 'oopif-same-child', sessionId: 'session-nested' },
  ]);
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
