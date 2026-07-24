import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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
          },
        };
      case 'Runtime.evaluate': {
        if (params.expression === '1') return { result: { value: 1 } };
        if (params.expression === 'document.readyState') return { result: { value: 'complete' } };
        if (params.expression === '6 * 7') return { result: { value: 42 } };
        if (params.expression === 'location.href') return { result: { value: target.url } };
        if (String(params.expression).startsWith('JSON.stringify({title:document.title')) {
          return { result: { value: JSON.stringify({ title: target.title, url: target.url }) } };
        }
        return { result: { value: undefined } };
      }
      case 'Accessibility.getFullAXTree':
        return {
          nodes: [
            {
              nodeId: 'root',
              childIds: ['button'],
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
          ],
        };
      case 'DOM.resolveNode': return { object: { objectId: `object:${params.backendNodeId}` } };
      case 'Runtime.releaseObject': return {};
      case 'Runtime.callFunctionOn':
        if (String(params.functionDeclaration).includes('getBoundingClientRect')) {
          return { result: { value: JSON.stringify({ x: 100, y: 80 }) } };
        }
        return { result: { value: { kind: 'input', value: '', sensitive: false } } };
      case 'Input.dispatchMouseEvent': return {};
      case 'Input.dispatchKeyEvent': return {};
      case 'Input.insertText': return {};
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
  assert.equal(names.includes('browser.network.requests'), false);
  assert.equal(names.includes('browser.auth.set'), false);
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

  transport.loaders.set('user-form', 'loader:user-form:external-navigation');
  await assert.rejects(
    () => tool(runtime, client, 'browser.click', {
      target: { observationId: clicked.observationId, ref: 1 },
    }, targetId),
    error => error.code === 'stale_ref',
  );
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
