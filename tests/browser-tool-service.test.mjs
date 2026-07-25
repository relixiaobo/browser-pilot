import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ArtifactStore, BrowserToolService, MemoryBrokerRuntime } from '../dist/services.js';

function png(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(bytes);
  Buffer.from('IHDR').copy(bytes, 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

class BrowserFixtureTransport {
  calls = [];
  handlers = new Map();
  targets = new Map([
    ['user-form', {
      targetId: 'user-form',
      type: 'page',
      title: 'User Form',
      url: 'https://example.test/form',
    }],
  ]);
  loaders = new Map([['user-form', 'loader:user-form:1']]);
  sessions = new Map();
  nextTarget = 1;
  nextSession = 1;
  screenshotDimensions;
  responseBodies = new Map();
  childFrames = [];
  extraAxButtons = [];
  pointerTargetState = {
    status: 'ready',
    x: 100,
    y: 80,
    targetState: { connected: true, kind: 'control', focused: false },
  };
  pointerReadbackState = { connected: true, kind: 'control', focused: true };
  editableState;
  nextInputClear = false;
  onMouseReleased;

  async send(method, params = {}, sessionId) {
    this.calls.push({ method, params, sessionId });
    const targetId = sessionId ? this.sessions.get(sessionId) : undefined;
    const target = targetId ? this.targets.get(targetId) : undefined;
    switch (method) {
      case 'Target.getTargets':
        return { targetInfos: [...this.targets.values()].map(value => ({ ...value })) };
      case 'Target.createTarget': {
        const id = `managed-${this.nextTarget++}`;
        this.targets.set(id, { targetId: id, type: 'page', title: '', url: params.url });
        this.loaders.set(id, `loader:${id}:1`);
        return { targetId: id };
      }
      case 'Browser.getWindowForTarget': return { windowId: 42, bounds: {} };
      case 'Target.activateTarget': return {};
      case 'Target.attachToTarget': {
        const id = `session-${this.nextSession++}`;
        this.sessions.set(id, params.targetId);
        return { sessionId: id };
      }
      case 'Target.detachFromTarget':
        this.sessions.delete(params.sessionId);
        return {};
      case 'Target.closeTarget':
        this.targets.delete(params.targetId);
        this.loaders.delete(params.targetId);
        return { success: true };
      case 'Page.enable': return {};
      case 'Page.createIsolatedWorld': return { executionContextId: 77 };
      case 'Network.enable': return {};
      case 'Network.getResponseBody': return this.responseBodies.get(`${sessionId}\u0000${params.requestId}`) ?? {
        body: 'response-body',
        base64Encoded: false,
      };
      case 'Fetch.enable': return {};
      case 'Fetch.disable': return {};
      case 'Fetch.continueWithAuth': return {};
      case 'Fetch.continueRequest': return {};
      case 'Fetch.failRequest': return {};
      case 'Fetch.fulfillRequest': return {};
      case 'Page.handleJavaScriptDialog':
        this.emit('Page.javascriptDialogClosed', { result: params.accept }, sessionId);
        return {};
      case 'Page.navigate':
        target.url = params.url;
        target.title = params.url.includes('managed') ? 'Managed Page' : 'Navigated';
        this.loaders.set(targetId, `${this.loaders.get(targetId)}:next`);
        return { frameId: 'frame:top', loaderId: this.loaders.get(targetId) };
      case 'Page.getFrameTree':
        return {
          frameTree: {
            frame: {
              id: `frame:${targetId}`,
              loaderId: this.loaders.get(targetId),
              url: target.url,
              name: '',
            },
            ...(this.childFrames.length > 0 ? { childFrames: this.childFrames.map(frame => ({ frame })) } : {}),
          },
        };
      case 'Runtime.evaluate': {
        if (params.expression === '1') return { result: { value: 1 } };
        if (params.expression === 'document.readyState') return { result: { value: 'complete' } };
        if (params.expression === '6 * 7') return { result: { value: 42 } };
        if (params.expression === 'location.href') return { result: { value: target.url } };
        if (String(params.expression).startsWith("JSON.stringify(Array.from(document.querySelectorAll('input[type=file]'))")) {
          return { result: { value: JSON.stringify([{ index: 1, name: 'attachment', accept: '*/*' }]) } };
        }
        if (String(params.expression).startsWith("document.querySelectorAll('input[type=file]')")) {
          return { result: { objectId: 'object:file-input' } };
        }
        if (String(params.expression).startsWith('JSON.stringify({title:document.title')) {
          return { result: { value: JSON.stringify({ title: target.title, url: target.url }) } };
        }
        return { result: { value: undefined } };
      }
      case 'Accessibility.getFullAXTree': {
        const extraNodes = this.extraAxButtons.map((name, index) => ({
          nodeId: `button-extra-${index}`,
          parentId: 'root',
          ignored: false,
          role: { value: 'button' },
          name: { value: name },
          properties: [],
          backendDOMNodeId: 100 + index,
        }));
        const editableNode = this.editableState ? {
          nodeId: 'editable',
          parentId: 'root',
          ignored: false,
          role: { value: 'textbox' },
          name: { value: 'Query' },
          properties: [],
          backendDOMNodeId: 43,
        } : undefined;
        return {
          nodes: [
            {
              nodeId: 'root',
              childIds: [
                'button',
                ...(editableNode ? [editableNode.nodeId] : []),
                ...extraNodes.map(node => node.nodeId),
              ],
              ignored: false,
              role: { value: 'RootWebArea' },
              properties: [],
            },
            {
              nodeId: 'button',
              parentId: 'root',
              ignored: false,
              role: { value: 'button' },
              name: { value: 'Submit' },
              properties: [],
              backendDOMNodeId: 42,
            },
            ...(editableNode ? [editableNode] : []),
            ...extraNodes,
          ],
        };
      }
      case 'DOM.resolveNode': return { object: { objectId: `object:${params.backendNodeId}` } };
      case 'DOM.describeNode': return {
        node: { backendNodeId: 72, nodeName: 'INPUT', attributes: ['type', 'file'] },
      };
      case 'DOM.setFileInputFiles': return {};
      case 'Runtime.releaseObject': return {};
      case 'Runtime.callFunctionOn':
        if (String(params.functionDeclaration).includes('elementsFromPoint')) {
          return { result: { value: this.pointerTargetState } };
        }
        if (String(params.functionDeclaration).includes("connected:false, kind:'other'")) {
          return { result: { value: this.pointerReadbackState } };
        }
        if (String(params.functionDeclaration).includes('unsupported_input_type') && this.editableState) {
          if (params.returnByValue) {
            if (String(params.functionDeclaration).startsWith('function(clear)')) {
              this.nextInputClear = params.arguments?.[0]?.value === true;
            }
            return { result: { value: { ...this.editableState } } };
          }
          if (String(params.functionDeclaration).startsWith('function(value)')) {
            this.editableState.value = String(params.arguments?.[0]?.value ?? '');
          }
          return {};
        }
        return { result: { value: undefined } };
      case 'Input.dispatchMouseEvent':
        if (params.type === 'mouseReleased') this.onMouseReleased?.(sessionId);
        return {};
      case 'Input.dispatchKeyEvent': return {};
      case 'Input.insertText':
        if (this.editableState) {
          this.editableState.value = `${this.nextInputClear ? '' : this.editableState.value}${params.text}`;
          this.nextInputClear = false;
        }
        return {};
      case 'Page.getLayoutMetrics': return {
        cssVisualViewport: {
          pageX: 0,
          pageY: 0,
          clientWidth: this.screenshotDimensions?.width ?? 1280,
          clientHeight: this.screenshotDimensions?.height ?? 720,
        },
      };
      case 'Page.captureScreenshot': {
        if (!this.screenshotDimensions) {
          return { data: Buffer.from('screenshot-bytes').toString('base64') };
        }
        const scale = params.clip?.scale ?? 1;
        return {
          data: png(
            Math.round(this.screenshotDimensions.width * scale),
            Math.round(this.screenshotDimensions.height * scale),
          ).toString('base64'),
        };
      }
      case 'Page.printToPDF': return { data: Buffer.from('pdf-bytes').toString('base64') };
      case 'Network.getCookies':
        return {
          cookies: [{
            name: 'session',
            value: 'secret',
            domain: 'example.test',
            path: '/',
            httpOnly: true,
            secure: true,
            expires: 0,
          }],
        };
      default: throw new Error(`Unexpected CDP call: ${method}`);
    }
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) ?? [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }

  emit(method, params, sessionId) {
    for (const handler of this.handlers.get(method) ?? []) handler(params, sessionId);
  }

  close() {}
}

const binding = {
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
};

function initialize(runtime, bridge, clientId, instanceId) {
  return runtime.call(bridge, 'initialize', {
    client: {
      id: clientId,
      name: clientId,
      version: '1.0.0',
      instanceId,
    },
    protocol: { min: { major: 1, minor: 0 }, max: { major: 1, minor: 0 } },
    requestedCapabilities: [
      'browser.discovery',
      'browser.control',
      'workspace.manage',
      'observation.read',
      'action.input',
      'cookies.read',
      'network.observe',
      'network.modify',
      'auth.manage',
      'artifact.read',
      'event.read',
      'developer.eval',
    ],
    launchMode: 'embedded',
  });
}

async function createClient(runtime, bridge, clientId, instanceId) {
  await initialize(runtime, bridge, clientId, instanceId);
  const { workspace, managedTabSet, eventCursor } = await runtime.call(bridge, 'workspaces/create', {});
  const { lease } = await runtime.call(bridge, 'leases/create', { workspaceId: workspace.id });
  return { bridge, workspace, managedTabSet, lease, eventCursor };
}

async function tool(runtime, client, name, args, targetId) {
  const outcome = await runtime.call(client.bridge, 'tools/call', {
    name,
    arguments: args,
    workspaceId: client.workspace.id,
    leaseId: client.lease.id,
    ...(targetId ? { targetId } : {}),
  });
  assert.equal(outcome.command.status, 'completed');
  return outcome.result;
}

test('production tools/list exposes only fully wired Browser tools', async () => {
  const transport = new BrowserFixtureTransport();
  const browserTools = new BrowserToolService(transport, binding);
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: browserTools,
  });
  await initialize(runtime, 'bridge:list', 'com.example.agent', 'instance:list');

  const manifest = await runtime.call('bridge:list', 'tools/list', {});
  const names = manifest.tools.map(definition => definition.name);
  assert.deepEqual(names, [...browserTools.supportedTools]);
  assert.equal(names.includes('browser.capture'), false);
  assert.equal(names.includes('browser.network.requests'), true);
  assert.equal(names.includes('browser.auth.set'), true);
});

test('tools/call lists user tabs, creates a managed target, and preserves user tabs on release', async () => {
  const transport = new BrowserFixtureTransport();
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  const client = await createClient(runtime, 'bridge:tabs', 'com.example.agent', 'instance:tabs');

  const initial = await tool(runtime, client, 'browser.tabs.list', { scope: 'all' });
  assert.equal(initial.targets.length, 1);
  assert.equal(initial.targets[0].origin, 'user_tab');
  assert.notEqual(initial.targets[0].targetId, 'user-form');

  const opened = await tool(runtime, client, 'browser.open', {
    url: 'https://managed.test/task',
    newTarget: true,
    observationLimit: 10,
  });
  assert.equal(opened.url, 'https://managed.test/task');
  assert.equal(opened.elements[0].name, 'Submit');
  assert.match(opened.observationId, /^observation:/);

  const listed = await tool(runtime, client, 'browser.tabs.list', { scope: 'all' });
  assert.deepEqual(listed.targets.map(target => target.origin).sort(), ['managed', 'user_tab']);
  await runtime.call(client.bridge, 'workspaces/release', { workspaceId: client.workspace.id });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transport.targets.has('user-form'), true);
  assert.equal([...transport.targets.keys()].some(id => id.startsWith('managed-')), false);
});

test('dialogs remain pending, emit ordered events, and require an explicit response', async () => {
  const transport = new BrowserFixtureTransport();
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  const client = await createClient(runtime, 'bridge:dialog', 'com.example.agent', 'instance:dialog');
  const listed = await tool(runtime, client, 'browser.tabs.list', { scope: 'all' });
  const targetId = listed.targets[0].targetId;
  await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);
  const sessionId = [...transport.sessions.entries()]
    .find(([, cdpTargetId]) => cdpTargetId === 'user-form')[0];

  transport.emit('Page.javascriptDialogOpening', {
    type: 'confirm',
    message: 'Submit this form?',
    url: 'https://example.test/form',
  }, sessionId);
  assert.equal(
    transport.calls.some(call => call.method === 'Page.handleJavaScriptDialog'),
    false,
  );

  const pending = await tool(runtime, client, 'browser.dialogs.list', {});
  assert.equal(pending.dialogs.length, 1);
  assert.equal(pending.dialogs[0].message, 'Submit this form?');
  const dialogId = pending.dialogs[0].dialogId;
  const response = await tool(runtime, client, 'browser.dialogs.respond', {
    dialogId,
    action: 'dismiss',
  }, targetId);
  assert.equal(response.action, 'dismiss');
  assert.deepEqual(
    transport.calls.find(call => call.method === 'Page.handleJavaScriptDialog'),
    {
      method: 'Page.handleJavaScriptDialog',
      params: { accept: false },
      sessionId,
    },
  );
  assert.deepEqual((await tool(runtime, client, 'browser.dialogs.list', {})).dialogs, []);

  const events = await runtime.call(client.bridge, 'events/poll', {
    workspaceId: client.workspace.id,
    cursor: client.eventCursor,
  });
  const dialogEvents = events.events.filter(event => event.type === 'dialog');
  assert.deepEqual(dialogEvents.map(event => event.payload.state), ['opened', 'closed']);
  assert.equal(dialogEvents[0].payload.dialogId, dialogId);
  assert.equal(dialogEvents[1].payload.action, 'dismiss');
});

test('Workspace auth and network rules are active before first navigation and use explicit Fetch handling', async () => {
  const transport = new BrowserFixtureTransport();
  const browserTools = new BrowserToolService(transport, binding);
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: browserTools,
  });
  const client = await createClient(runtime, 'bridge:network-config', 'com.example.agent', 'instance:network-config');

  const configured = await tool(runtime, client, 'browser.auth.set', {
    username: 'workspace-user',
    password: 'workspace-password',
  });
  assert.equal(configured.configured, true);
  const added = await tool(runtime, client, 'browser.network.rules.add', {
    type: 'block',
    pattern: 'https://blocked.test/*',
  });
  assert.match(added.ruleId, /^rule:/);
  assert.deepEqual((await tool(runtime, client, 'browser.network.rules.list', {})).rules, [{
    ruleId: added.ruleId,
    type: 'block',
    pattern: 'https://blocked.test/*',
  }]);

  await tool(runtime, client, 'browser.open', {
    url: 'https://managed.test/network',
    newTarget: true,
  });
  const sessionId = [...transport.sessions.entries()]
    .find(([, targetId]) => targetId === 'managed-1')[0];
  const networkEnableIndex = transport.calls.findIndex(call => (
    call.method === 'Network.enable' && call.sessionId === sessionId
  ));
  const fetchEnableIndex = transport.calls.findIndex(call => (
    call.method === 'Fetch.enable' && call.sessionId === sessionId
  ));
  const navigateIndex = transport.calls.findIndex(call => (
    call.method === 'Page.navigate' && call.sessionId === sessionId
  ));
  assert.ok(networkEnableIndex >= 0 && networkEnableIndex < navigateIndex);
  assert.ok(fetchEnableIndex >= 0 && fetchEnableIndex < navigateIndex);
  assert.deepEqual(transport.calls[fetchEnableIndex].params, {
    patterns: [{ urlPattern: '*' }],
    handleAuthRequests: true,
  });

  transport.emit('Fetch.authRequired', { requestId: 'auth-1' }, sessionId);
  transport.emit('Fetch.requestPaused', {
    requestId: 'paused-1',
    request: { url: 'https://blocked.test/private', headers: {} },
  }, sessionId);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(
    transport.calls.find(call => call.method === 'Fetch.continueWithAuth' && call.sessionId === sessionId)?.params,
    {
      requestId: 'auth-1',
      authChallengeResponse: {
        response: 'ProvideCredentials',
        username: 'workspace-user',
        password: 'workspace-password',
      },
    },
  );
  assert.deepEqual(
    transport.calls.find(call => call.method === 'Fetch.failRequest' && call.sessionId === sessionId)?.params,
    { requestId: 'paused-1', reason: 'BlockedByClient' },
  );

  await tool(runtime, client, 'browser.auth.clear', {});
  await tool(runtime, client, 'browser.network.rules.remove', { all: true });
  assert.equal(transport.calls.some(call => call.method === 'Fetch.disable' && call.sessionId === sessionId), true);
});

test('network journals, bodies, rules, auth, and events remain isolated across Agent Workspaces', async () => {
  const transport = new BrowserFixtureTransport();
  const browserTools = new BrowserToolService(transport, binding);
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: browserTools,
  });
  const first = await createClient(runtime, 'bridge:network-a', 'com.first.agent', 'instance:network-a');
  const second = await createClient(runtime, 'bridge:network-b', 'com.second.agent', 'instance:network-b');
  await tool(runtime, first, 'browser.open', { url: 'https://first.test/', newTarget: true });
  await tool(runtime, second, 'browser.open', { url: 'https://second.test/', newTarget: true });
  const firstSession = [...transport.sessions.entries()].find(([, targetId]) => targetId === 'managed-1')[0];
  const secondSession = [...transport.sessions.entries()].find(([, targetId]) => targetId === 'managed-2')[0];

  const emitRequest = (sessionId, url, status, secret) => {
    transport.emit('Network.requestWillBeSent', {
      requestId: 'shared-cdp-request-id',
      type: 'XHR',
      request: {
        method: 'POST',
        url,
        headers: { Authorization: `Bearer ${secret}` },
        postData: `secret-post-${secret}`,
      },
    }, sessionId);
    transport.emit('Network.responseReceived', {
      requestId: 'shared-cdp-request-id',
      response: {
        status,
        statusText: 'OK',
        headers: { 'Set-Cookie': `session=${secret}` },
        mimeType: 'application/json',
      },
    }, sessionId);
    transport.emit('Network.loadingFinished', {
      requestId: 'shared-cdp-request-id',
      encodedDataLength: 123,
    }, sessionId);
    transport.responseBodies.set(`${sessionId}\u0000shared-cdp-request-id`, {
      body: `secret-body-${secret}`,
      base64Encoded: false,
    });
  };
  emitRequest(firstSession, 'https://first.test/api?token=first', 201, 'first');
  emitRequest(secondSession, 'https://second.test/api', 202, 'second');

  const firstRequests = await tool(runtime, first, 'browser.network.requests', {});
  const secondRequests = await tool(runtime, second, 'browser.network.requests', {});
  assert.deepEqual(firstRequests.requests.map(request => request.url), ['https://first.test/api?token=first']);
  assert.deepEqual(secondRequests.requests.map(request => request.url), ['https://second.test/api']);
  assert.notEqual(firstRequests.requests[0].requestId, secondRequests.requests[0].requestId);
  const firstDetail = await tool(runtime, first, 'browser.network.request', {
    requestId: firstRequests.requests[0].requestId,
    includeBody: true,
  });
  assert.equal(firstDetail.body, 'secret-body-first');
  assert.equal(firstDetail.bodyEncoding, 'utf8');
  assert.equal(firstDetail.request.requestHeaders[0].value, 'Bearer first');
  await assert.rejects(
    () => tool(runtime, second, 'browser.network.request', {
      requestId: firstRequests.requests[0].requestId,
      includeBody: true,
    }),
    error => error.code === 'invalid_argument',
  );

  const events = await runtime.call(first.bridge, 'events/poll', {
    workspaceId: first.workspace.id,
    cursor: first.eventCursor,
  });
  const networkEvents = events.events.filter(event => event.type.startsWith('network.'));
  assert.deepEqual(networkEvents.map(event => event.type), ['network.request', 'network.response']);
  const serializedEvents = JSON.stringify(networkEvents);
  assert.equal(serializedEvents.includes('Bearer first'), false);
  assert.equal(serializedEvents.includes('secret-post-first'), false);
  assert.equal(serializedEvents.includes('secret-body-first'), false);
  assert.equal(serializedEvents.includes('Set-Cookie'), false);
  assert.equal(serializedEvents.includes('token=first'), false);

  await runtime.call(first.bridge, 'workspaces/release', { workspaceId: first.workspace.id });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(browserTools.ownsSession(firstSession), false);
  assert.equal(browserTools.ownsSession(secondSession), true);
  const callsBeforeRetiredEvent = transport.calls.length;
  transport.emit('Fetch.requestPaused', {
    requestId: 'after-release',
    request: { url: 'https://first.test/after-release', headers: {} },
  }, firstSession);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transport.calls.length, callsBeforeRetiredEvent);
  assert.deepEqual(
    (await tool(runtime, second, 'browser.network.requests', {})).requests.map(request => request.url),
    ['https://second.test/api'],
  );
});

test('Workspace network configuration survives Lease replacement and journals are bounded and clearable', async () => {
  const transport = new BrowserFixtureTransport();
  const browserTools = new BrowserToolService(transport, binding);
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: browserTools,
  });
  const client = await createClient(runtime, 'bridge:network-lease', 'com.example.agent', 'instance:network-lease');
  await tool(runtime, client, 'browser.network.rules.add', {
    type: 'headers',
    pattern: 'https://api.test/*',
    headers: [{ name: 'X-Agent', value: 'replacement-lease' }],
  });
  await runtime.call(client.bridge, 'leases/release', { leaseId: client.lease.id });
  const replacement = await runtime.call(client.bridge, 'leases/create', { workspaceId: client.workspace.id });
  client.lease = replacement.lease;
  await tool(runtime, client, 'browser.open', { url: 'https://api.test/start', newTarget: true });
  const sessionId = [...transport.sessions.entries()].find(([, targetId]) => targetId === 'managed-1')[0];
  assert.equal(
    transport.calls.some(call => call.method === 'Fetch.enable' && call.sessionId === sessionId),
    true,
  );

  for (let index = 0; index < 1001; index += 1) {
    transport.emit('Network.requestWillBeSent', {
      requestId: `request-${index}`,
      type: 'Fetch',
      request: { method: 'GET', url: `https://api.test/${index}`, headers: {} },
    }, sessionId);
  }
  const bounded = await tool(runtime, client, 'browser.network.requests', { limit: 1000, after: 0 });
  assert.equal(bounded.requests.length, 1000);
  assert.equal(bounded.requests[0].url, 'https://api.test/1');
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.nextCursor, 1001);

  await tool(runtime, client, 'browser.network.clear', {});
  assert.deepEqual(await tool(runtime, client, 'browser.network.requests', {}), {
    workspaceId: client.workspace.id,
    leaseId: client.lease.id,
    requests: [],
    nextCursor: 0,
    truncated: false,
  });
});

test('frame tools expose session-scoped opaque IDs and apply the selected execution context', async () => {
  const transport = new BrowserFixtureTransport();
  transport.childFrames = [{
    id: 'cdp-child-frame',
    loaderId: 'loader:child:1',
    url: 'https://frame.test/details',
    name: 'details',
  }];
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  const client = await createClient(runtime, 'bridge:frames', 'com.example.agent', 'instance:frames');
  const targetId = (await tool(runtime, client, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;

  const listed = await tool(runtime, client, 'browser.frames.list', {}, targetId);
  assert.equal(listed.frames.length, 2);
  assert.match(listed.frames[0].frameId, /^frame:/);
  assert.notEqual(listed.frames[0].frameId, 'frame:user-form');
  assert.notEqual(listed.frames[1].frameId, 'cdp-child-frame');
  assert.equal(listed.frames[1].parentFrameId, listed.frames[0].frameId);
  const childFrameId = listed.frames[1].frameId;

  const selected = await tool(runtime, client, 'browser.frames.switch', { frameId: childFrameId }, targetId);
  assert.equal(selected.frameId, childFrameId);
  const evaluated = await tool(runtime, client, 'browser.eval', { expression: '6 * 7' }, targetId);
  assert.equal(evaluated.value, 42);
  const framedEvaluation = transport.calls.filter(call => (
    call.method === 'Runtime.evaluate' && call.params.expression === '6 * 7'
  )).at(-1);
  assert.equal(framedEvaluation.params.contextId, 77);

  const top = await tool(runtime, client, 'browser.frames.switch', { top: true }, targetId);
  assert.equal(top.frameId, listed.frames[0].frameId);
  await tool(runtime, client, 'browser.eval', { expression: '6 * 7' }, targetId);
  const topEvaluation = transport.calls.filter(call => (
    call.method === 'Runtime.evaluate' && call.params.expression === '6 * 7'
  )).at(-1);
  assert.equal('contextId' in topEvaluation.params, false);
});

test('browser.upload consumes only imported upload_input Artifacts and preserves the source filename', async t => {
  const root = await mkdtemp(join(tmpdir(), 'browser-pilot-upload-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'resume.txt');
  await writeFile(source, 'resume contents');
  const artifactStore = new ArtifactStore({ directory: join(root, 'store') });
  await artifactStore.initialize();
  const transport = new BrowserFixtureTransport();
  const browserTools = new BrowserToolService(transport, binding, { artifactStore });
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: browserTools,
    artifactStore,
  });
  const client = await createClient(runtime, 'bridge:upload', 'com.example.agent', 'instance:upload');
  const imported = await runtime.call(client.bridge, 'artifacts/import', {
    workspaceId: client.workspace.id,
    leaseId: client.lease.id,
    path: source,
  });
  const targetId = (await tool(runtime, client, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;

  const uploaded = await tool(runtime, client, 'browser.upload', {
    artifactId: imported.artifact.id,
  }, targetId);
  assert.match(uploaded.observationId, /^observation:/);
  const dispatch = transport.calls.find(call => call.method === 'DOM.setFileInputFiles');
  assert.equal(dispatch.params.files[0] === source, false);
  assert.equal(dispatch.params.files[0].endsWith('/resume.txt'), true);
  assert.deepEqual(await readFile(dispatch.params.files[0]), Buffer.from('resume contents'));

  const screenshot = await artifactStore.create({
    workspaceId: client.workspace.id,
    kind: 'screenshot',
    mimeType: 'image/png',
    bytes: Buffer.from('not-an-upload-input'),
  });
  await assert.rejects(
    () => tool(runtime, client, 'browser.upload', { artifactId: screenshot.descriptor.id }, targetId),
    error => error.code === 'invalid_argument',
  );
});

test('browser.type exposes verified readback through the public tool surface', async () => {
  const transport = new BrowserFixtureTransport();
  transport.editableState = {
    kind: 'input',
    value: 'old',
    sensitive: false,
    editable: true,
    inputType: 'text',
    editMode: 'text',
    selectionMode: 'range',
  };
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  const client = await createClient(runtime, 'bridge:type', 'com.example.agent', 'instance:type');
  const targetId = (await tool(runtime, client, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;
  const observed = await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);
  const field = observed.elements.find(element => element.name === 'Query');
  assert.ok(field);

  const typed = await tool(runtime, client, 'browser.type', {
    observationId: observed.observationId,
    ref: field.ref,
    text: '-new',
    verification: 'require_exact',
  }, targetId);

  assert.notEqual(typed.observationId, observed.observationId);
  assert.deepEqual(typed.evidence, {
    status: 'verified',
    kind: 'input',
    sensitive: false,
    beforeLength: 3,
    expectedLength: 7,
    afterLength: 7,
  });
  assert.deepEqual(
    transport.calls.find(call => call.method === 'Input.insertText')?.params,
    { text: '-new' },
  );
});

test('Observation refs are Lease-scoped, stale after navigation, and actions return a new Observation', async () => {
  const transport = new BrowserFixtureTransport();
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  const client = await createClient(runtime, 'bridge:observe', 'com.example.agent', 'instance:observe');
  const listed = await tool(runtime, client, 'browser.tabs.list', { scope: 'all' });
  const targetId = listed.targets[0].targetId;

  const observed = await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);
  const clicked = await tool(runtime, client, 'browser.click', {
    target: { observationId: observed.observationId, ref: 1 },
    button: 'left',
    clickCount: 1,
  }, targetId);
  assert.notEqual(clicked.observationId, observed.observationId);
  assert.equal(clicked.elements[0].name, 'Submit');
  assert.deepEqual(clicked.evidence, {
    action: 'click',
    status: 'verified',
    kind: 'control',
    effects: ['focus_changed'],
    focused: true,
  });

  transport.loaders.set('user-form', 'loader:user-form:external-navigation');
  await assert.rejects(
    () => tool(runtime, client, 'browser.click', {
      target: { observationId: clicked.observationId, ref: 1 },
    }, targetId),
    error => error.code === 'stale_ref',
  );
});

test('browser.click returns a typed obstruction error without dispatching pointer events', async () => {
  const transport = new BrowserFixtureTransport();
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  const client = await createClient(runtime, 'bridge:blocked-click', 'com.example.agent', 'instance:blocked-click');
  const targetId = (await tool(runtime, client, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;
  const observed = await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);
  transport.pointerTargetState = {
    status: 'blocked',
    reason: 'obscured',
    obstruction: { tagName: 'div', role: 'dialog' },
  };

  await assert.rejects(
    () => tool(runtime, client, 'browser.click', {
      target: { observationId: observed.observationId, ref: 1 },
    }, targetId),
    error => (
      error.code === 'action_not_verified' &&
      error.retryable === true &&
      error.context?.reason === 'obscured' &&
      error.context?.obstruction?.role === 'dialog'
    ),
  );
  assert.equal(transport.calls.some(call => call.method === 'Input.dispatchMouseEvent'), false);
});

test('browser.click merges element, navigation, document, dialog, and popup evidence', async () => {
  const transport = new BrowserFixtureTransport();
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  const client = await createClient(runtime, 'bridge:click-effects', 'com.example.agent', 'instance:click-effects');
  const targetId = (await tool(runtime, client, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;
  const observed = await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);
  transport.onMouseReleased = sessionId => {
    const target = transport.targets.get('user-form');
    target.url = 'https://example.test/submitted';
    target.title = 'Submitted';
    transport.loaders.set('user-form', 'loader:user-form:submitted');
    transport.emit('Page.javascriptDialogOpening', {
      type: 'alert',
      message: 'Saved',
      url: target.url,
    }, sessionId);
    transport.emit('Target.targetCreated', {
      targetInfo: {
        targetId: 'user-popup',
        type: 'page',
        url: 'https://example.test/receipt',
        openerId: 'user-form',
      },
    });
  };

  const clicked = await tool(runtime, client, 'browser.click', {
    target: { observationId: observed.observationId, ref: 1 },
  }, targetId);

  assert.equal(clicked.url, 'https://example.test/submitted');
  assert.deepEqual(clicked.evidence, {
    action: 'click',
    status: 'verified',
    kind: 'control',
    effects: [
      'focus_changed',
      'navigation',
      'document_changed',
      'dialog_opened',
      'popup_opened',
    ],
    focused: true,
  });
});

test('browser.click does not mistake a larger post-click ref limit for a document change', async () => {
  const transport = new BrowserFixtureTransport();
  transport.extraAxButtons = ['Cancel', 'Help'];
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  const client = await createClient(runtime, 'bridge:click-limit', 'com.example.agent', 'instance:click-limit');
  const targetId = (await tool(runtime, client, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;
  const observed = await tool(runtime, client, 'browser.observe', { limit: 1 }, targetId);
  assert.equal(observed.truncated, true);

  const clicked = await tool(runtime, client, 'browser.click', {
    target: { observationId: observed.observationId, ref: 1 },
  }, targetId);

  assert.equal(clicked.elements.length, 3);
  assert.deepEqual(clicked.evidence.effects, ['focus_changed']);
});

test('the same physical user tab is exclusive across unrelated Agent Leases', async () => {
  const transport = new BrowserFixtureTransport();
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  const first = await createClient(runtime, 'bridge:first-agent', 'com.first.agent', 'instance:first');
  const second = await createClient(runtime, 'bridge:second-agent', 'com.second.agent', 'instance:second');
  const firstTarget = (await tool(runtime, first, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;
  const secondTarget = (await tool(runtime, second, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;
  assert.notEqual(firstTarget, secondTarget);

  await tool(runtime, first, 'browser.observe', { limit: 10 }, firstTarget);
  await assert.rejects(
    () => tool(runtime, second, 'browser.observe', { limit: 10 }, secondTarget),
    error => error.code === 'target_busy' && error.retryable === true,
  );

  await runtime.call(first.bridge, 'leases/release', { leaseId: first.lease.id });
  const observed = await tool(runtime, second, 'browser.observe', { limit: 10 }, secondTarget);
  assert.equal(observed.elements[0].name, 'Submit');
});

test('tools/call enforces envelope context, schemas, and negotiated capabilities before CDP', async () => {
  const transport = new BrowserFixtureTransport();
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  await runtime.call('bridge:limited', 'initialize', {
    client: {
      id: 'com.limited.agent',
      name: 'Limited',
      version: '1.0.0',
      instanceId: 'instance:limited',
    },
    protocol: { min: { major: 1, minor: 0 }, max: { major: 1, minor: 0 } },
    requestedCapabilities: ['workspace.manage', 'browser.control'],
    launchMode: 'embedded',
  });
  const { workspace } = await runtime.call('bridge:limited', 'workspaces/create', {});
  const { lease } = await runtime.call('bridge:limited', 'leases/create', { workspaceId: workspace.id });

  await assert.rejects(
    () => runtime.call('bridge:limited', 'tools/call', {
      name: 'browser.tabs.list',
      arguments: { scope: 'invalid' },
      workspaceId: workspace.id,
      leaseId: lease.id,
    }),
    error => error.code === 'invalid_argument',
  );
  await assert.rejects(
    () => runtime.call('bridge:limited', 'tools/call', {
      name: 'browser.observe',
      arguments: { limit: 10 },
      workspaceId: workspace.id,
      leaseId: lease.id,
      targetId: 'target:unowned',
    }),
    error => error.code === 'capability_denied',
  );
  assert.equal(transport.calls.length, 0);
});

test('screenshot and PDF tools return protected Artifacts that can be read, exported, and released', async t => {
  const root = await mkdtemp(join(tmpdir(), 'browser-pilot-tool-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactStore = new ArtifactStore({ directory: join(root, 'store') });
  await artifactStore.initialize();
  const transport = new BrowserFixtureTransport();
  const browserTools = new BrowserToolService(transport, binding, { artifactStore });
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: browserTools,
    artifactStore,
  });
  const client = await createClient(runtime, 'bridge:artifact', 'com.example.agent', 'instance:artifact');
  const targetId = (await tool(runtime, client, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;

  const captured = await tool(runtime, client, 'browser.capture', {}, targetId);
  assert.equal(captured.artifact.kind, 'screenshot');
  assert.equal(captured.artifact.workspaceId, client.workspace.id);
  assert.equal(captured.artifact.byteSize, Buffer.byteLength('screenshot-bytes'));
  assert.equal('path' in captured.artifact, false);
  assert.equal(JSON.stringify(captured).includes(Buffer.from('screenshot-bytes').toString('base64')), false);

  const accessed = await runtime.call(client.bridge, 'artifacts/get', {
    workspaceId: client.workspace.id,
    leaseId: client.lease.id,
    artifactId: captured.artifact.id,
  });
  assert.deepEqual(await readFile(accessed.path), Buffer.from('screenshot-bytes'));
  const exportedPath = join(root, 'capture.png');
  const exported = await runtime.call(client.bridge, 'artifacts/export', {
    workspaceId: client.workspace.id,
    leaseId: client.lease.id,
    artifactId: captured.artifact.id,
    path: exportedPath,
  });
  assert.equal(exported.path, exportedPath);
  assert.deepEqual(await readFile(exportedPath), Buffer.from('screenshot-bytes'));

  const pdf = await tool(runtime, client, 'browser.pdf', { landscape: true }, targetId);
  assert.equal(pdf.artifact.kind, 'pdf');
  const pdfAccess = await runtime.call(client.bridge, 'artifacts/get', {
    workspaceId: client.workspace.id,
    leaseId: client.lease.id,
    artifactId: pdf.artifact.id,
  });
  assert.deepEqual(await readFile(pdfAccess.path), Buffer.from('pdf-bytes'));

  await runtime.call(client.bridge, 'artifacts/release', {
    workspaceId: client.workspace.id,
    leaseId: client.lease.id,
    artifactId: captured.artifact.id,
  });
  await assert.rejects(() => stat(accessed.path), error => error.code === 'ENOENT');
  await runtime.call(client.bridge, 'workspaces/release', { workspaceId: client.workspace.id });
  await assert.rejects(() => stat(pdfAccess.path), error => error.code === 'ENOENT');
});

test('large screenshots return a model-sized preview and include the original only when requested', async t => {
  const root = await mkdtemp(join(tmpdir(), 'browser-pilot-preview-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactStore = new ArtifactStore({ directory: join(root, 'store') });
  await artifactStore.initialize();
  const transport = new BrowserFixtureTransport();
  transport.screenshotDimensions = { width: 3200, height: 2000 };
  const browserTools = new BrowserToolService(transport, binding, { artifactStore });
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: browserTools,
    artifactStore,
  });
  const client = await createClient(runtime, 'bridge:preview', 'com.example.agent', 'instance:preview');
  const targetId = (await tool(runtime, client, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;

  const previewOnly = await tool(runtime, client, 'browser.capture', {}, targetId);
  assert.equal(previewOnly.artifact.kind, 'screenshot_preview');
  assert.equal(previewOnly.artifact.width, 1600);
  assert.equal(previewOnly.artifact.height, 1000);
  assert.equal('preview' in previewOnly, false);

  const withOriginal = await tool(runtime, client, 'browser.capture', { includeOriginal: true }, targetId);
  assert.equal(withOriginal.artifact.kind, 'screenshot');
  assert.equal(withOriginal.artifact.width, 3200);
  assert.equal(withOriginal.preview.kind, 'screenshot_preview');
  assert.equal(withOriginal.preview.width, 1600);
  assert.equal(withOriginal.preview.previewOf, withOriginal.artifact.id);

  await runtime.call(client.bridge, 'workspaces/release', { workspaceId: client.workspace.id });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(artifactStore.size(), 0);
});

test('browser reconnection retires CDP sessions, refs, and opaque target IDs before reuse', async () => {
  const transport = new BrowserFixtureTransport();
  const connectionBinding = structuredClone(binding);
  const browserTools = new BrowserToolService(transport, connectionBinding);
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:reconnect',
    browsers: [connectionBinding],
    toolExecutor: browserTools,
  });
  const client = await createClient(
    runtime,
    'bridge:reconnect',
    'com.example.agent',
    'instance:reconnect',
  );
  const before = await tool(runtime, client, 'browser.tabs.list', { scope: 'all' });
  const oldTargetId = before.targets[0].targetId;
  const observed = await tool(runtime, client, 'browser.observe', { limit: 10 }, oldTargetId);

  runtime.updateBrowserConnection(connectionBinding.instance.id, {
    state: 'disconnected',
    connectionGeneration: 1,
  });
  runtime.updateBrowserConnection(connectionBinding.instance.id, {
    state: 'connected',
    connectionGeneration: 2,
    processIdentity: 'process:test:restored',
  });
  const replayed = await runtime.call(client.bridge, 'events/poll', {
    workspaceId: client.workspace.id,
    cursor: client.eventCursor,
  });
  assert.deepEqual(replayed.events
    .map(event => event.type)
    .filter(type => type !== 'command.status'), [
    'target.attached',
    'target_control.acquired',
    'connection.lost',
    'observation.invalidated',
    'connection.restored',
    'observation.invalidated',
    'target.detached',
  ]);

  await assert.rejects(
    () => tool(runtime, client, 'browser.click', {
      target: {
        observationId: observed.observationId,
        ref: 1,
      },
    }, oldTargetId),
    error => error.code === 'target_not_owned',
  );
  const after = await tool(runtime, client, 'browser.tabs.list', { scope: 'all' });
  assert.equal(after.targets.length, 1);
  assert.notEqual(after.targets[0].targetId, oldTargetId);
});
