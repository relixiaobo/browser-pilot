import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import {
  ArtifactStore,
  BrowserToolService,
  MemoryBrokerRuntime,
  PageLoadTimeoutError,
} from '../dist/services.js';

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
  frameTreesByTarget = new Map();
  frameOwnerBackendNodeIds = new Map();
  boxModelsByBackendNodeId = new Map();
  buttonNamesByTarget = new Map();
  extraAxButtons = [];
  extraAxNodes = [];
  pageGuidance = {};
  pageGeometry = {
    viewportWidth: 1280,
    viewportHeight: 720,
    documentWidth: 1280,
    documentHeight: 2400,
    scrollX: 0,
    scrollY: 0,
    pixelsAbove: 0,
    pixelsBelow: 1680,
    pixelsLeft: 0,
    pixelsRight: 0,
    scrollPercentX: 0,
    scrollPercentY: 0,
  };
  pointerTargetState = {
    status: 'ready',
    x: 100,
    y: 80,
    targetState: { connected: true, kind: 'control', focused: false },
  };
  pointerReadbackState = { connected: true, kind: 'control', focused: true };
  editableState;
  nextInputClear = false;
  selectedFileName;
  ariaSelected = false;
  pressStates = [];
  pressReadIndex = 0;
  continuityFocusChanged = false;
  documentBackendNodeId = 9_000;
  onMouseReleased;
  onKeyUp;
  onInsertText;

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
      case 'Runtime.enable': return {};
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
        if (this.frameTreesByTarget.has(targetId)) {
          return { frameTree: structuredClone(this.frameTreesByTarget.get(targetId)) };
        }
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
        if (String(params.expression).includes('createImageBitmap')) {
          return {
            result: {
              value: `data:image/png;base64,${Buffer.from('annotated-screenshot-bytes').toString('base64')}`,
            },
          };
        }
        if (String(params.expression).includes('browser-pilot.action-continuity.v1')) {
          if (String(params.expression).includes('state.focus !==') && this.continuityFocusChanged) {
            return { result: { value: 'focus_changed' } };
          }
          if (
            String(params.expression).includes('state.focus =') ||
            String(params.expression).includes("return 'ready'")
          ) {
            return { result: { value: 'ready' } };
          }
          return { result: { value: true } };
        }
        if (String(params.expression).includes('shadowRoot.activeElement')) {
          return { result: { objectId: `press-active-${this.pressReadIndex}` } };
        }
        if (params.expression === '1') return { result: { value: 1 } };
        if (params.expression === 'document') return { result: { objectId: `document:${targetId}` } };
        if (params.expression === 'document.readyState') return { result: { value: 'complete' } };
        if (params.expression === '6 * 7') return { result: { value: 42 } };
        if (params.expression === 'location.href') return { result: { value: target.url } };
        if (String(params.expression).startsWith('JSON.stringify((function(){var el=document.querySelector(')) {
          return { result: { value: JSON.stringify({ x: 60, y: 35, top: 20, left: 10, width: 100, height: 30 }) } };
        }
        if (String(params.expression).startsWith("JSON.stringify(Array.from(document.querySelectorAll('input[type=file]'))")) {
          return { result: { value: JSON.stringify([{ index: 1, name: 'attachment', accept: '*/*' }]) } };
        }
        if (String(params.expression).startsWith("document.querySelectorAll('input[type=file]')")) {
          return { result: { objectId: 'object:file-input' } };
        }
        if (String(params.expression).startsWith('JSON.stringify({title:document.title')) {
          return {
            result: {
              value: JSON.stringify({ title: target.title, url: target.url, page: this.pageGeometry, guidance: this.pageGuidance }),
            },
          };
        }
        if (String(params.expression).includes('totalMatches,matches,truncated:scanTruncated')) {
          return { result: { value: JSON.stringify({
            ok: true,
            title: target.title,
            url: target.url,
            totalMatches: 1,
            matches: [{
              index: 1, text: 'Submit', context: 'Submit this form', tagName: 'button',
              visible: true, x: 10, y: 20, width: 100, height: 30,
            }],
            truncated: false,
          }) } };
        }
        if (String(params.expression).includes('requestedAttributes=') && String(params.expression).includes('elements:matches')) {
          return { result: { value: JSON.stringify({
            ok: true,
            title: target.title,
            url: target.url,
            totalMatches: 1,
            elements: [{
              index: 1, tagName: 'button', role: 'button', name: 'Submit', text: 'Submit',
              visible: true, enabled: true, x: 10, y: 20, width: 100, height: 30,
              attributes: [{ name: 'data-testid', value: 'submit' }],
            }],
            truncated: false,
          }) } };
        }
        if (String(params.expression).includes("action:'scroll'") && String(params.expression).includes('document.scrollingElement')) {
          this.pageGeometry = {
            ...this.pageGeometry,
            scrollY: 576,
            pixelsAbove: 576,
            pixelsBelow: 1104,
            scrollPercentY: 34.3,
          };
          return { result: { value: {
            ok: true, action: 'scroll', status: 'verified', mode: 'relative', target: 'page',
            moved: true, deltaX: 0, deltaY: 576, beforeX: 0, beforeY: 0, afterX: 0, afterY: 576,
          } } };
        }
        return { result: { value: undefined } };
      }
      case 'Accessibility.getFullAXTree': {
        const primaryButtonName = this.buttonNamesByTarget.get(targetId) ?? 'Submit';
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
                ...this.extraAxNodes.filter(node => node.parentId === 'root').map(node => node.nodeId),
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
              name: { value: primaryButtonName },
              properties: [],
              backendDOMNodeId: 42,
            },
            ...(editableNode ? [editableNode] : []),
            ...extraNodes,
            ...this.extraAxNodes,
          ],
        };
      }
      case 'Accessibility.getPartialAXTree': {
        const backendNodeId = Number(String(params.objectId).split(':').at(-1));
        const primaryButtonName = this.buttonNamesByTarget.get(targetId) ?? 'Submit';
        const explicitNode = this.extraAxNodes.find(node => node.backendDOMNodeId === backendNodeId);
        const extraName = backendNodeId >= 100
          ? this.extraAxButtons[backendNodeId - 100]
          : undefined;
        const role = explicitNode?.role?.value ?? (backendNodeId === 43 ? 'textbox' : 'button');
        const name = explicitNode?.name?.value ?? (backendNodeId === 43 ? 'Query' : extraName ?? primaryButtonName);
        return { nodes: [{
          backendDOMNodeId: backendNodeId,
          ignored: false,
          role: { value: role },
          name: { value: name },
          properties: [],
        }] };
      }
      case 'DOMSnapshot.captureSnapshot': return { documents: [], strings: [] };
      case 'DOM.getFrameOwner': return {
        backendNodeId: this.frameOwnerBackendNodeIds.get(params.frameId),
      };
      case 'DOM.getBoxModel': return {
        model: this.boxModelsByBackendNodeId.get(params.backendNodeId),
      };
      case 'DOM.resolveNode': return { object: { objectId: `object:${params.backendNodeId}` } };
      case 'DOM.describeNode':
        if (String(params.objectId).startsWith('document:')) {
          return { node: { backendNodeId: this.documentBackendNodeId, nodeName: '#document' } };
        }
        if (String(params.objectId).startsWith('press-active-')) {
          return { node: { backendNodeId: this.pressStates[this.pressReadIndex]?.backendNodeId ?? 80 } };
        }
        return { node: { backendNodeId: 72, nodeName: 'INPUT', attributes: ['type', 'file'] } };
      case 'DOM.setFileInputFiles':
        this.selectedFileName = basename(params.files[0]);
        return {};
      case 'Runtime.releaseObject': return {};
      case 'Runtime.callFunctionOn':
        if (String(params.functionDeclaration).includes('browser-pilot.ref-revalidation.v1')) {
          return { result: { value: true } };
        }
        if (String(params.functionDeclaration).includes('optionElements.indexOf(option)')) {
          const optionObjectId = params.arguments?.[0]?.objectId;
          if (params.objectId !== 'object:302' || optionObjectId !== 'object:304') {
            return { result: { value: null } };
          }
          return { result: { value: {
            index: 1,
            label: 'Shanghai',
            value: 'sha',
            selected: this.ariaSelected,
            disabled: false,
          } } };
        }
        if (String(params.functionDeclaration).includes('this.getBoundingClientRect()')) {
          return { result: { value: { x: 10, y: 20, width: 100, height: 30 } } };
        }
        if (String(params.functionDeclaration).includes('valueToken') && this.pressStates.length > 0) {
          const { backendNodeId: _backendNodeId, ...value } = this.pressStates[this.pressReadIndex];
          this.pressReadIndex += 1;
          return { result: { value } };
        }
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
        if (String(params.functionDeclaration).includes('firstFileName')) {
          return { result: { value: {
            status: 'ready',
            fileCount: this.selectedFileName ? 1 : 0,
            ...(this.selectedFileName ? { firstFileName: this.selectedFileName } : {}),
          } } };
        }
        if (String(params.functionDeclaration).includes('Target is not a native or ARIA dropdown')) {
          if (params.objectId === 'object:302') {
            return { result: { value: {
              ok: true,
              kind: 'aria',
              expanded: true,
              multiple: false,
              requiresOpen: false,
              options: [{
                index: 1,
                label: 'Shanghai',
                value: 'sha',
                selected: this.ariaSelected,
                disabled: false,
              }],
              truncated: false,
            } } };
          }
          return { result: { value: {
            ok: true,
            kind: 'native',
            expanded: true,
            multiple: false,
            requiresOpen: false,
            options: [
              { index: 1, label: 'Choose one', value: '', selected: true, disabled: false },
              { index: 2, label: 'China', value: 'cn', selected: false, disabled: false },
            ],
            truncated: false,
          } } };
        }
        if (String(params.functionDeclaration).includes('HTMLSelectElement.prototype')) {
          return { result: { value: {
            ok: true,
            action: 'select',
            status: 'verified',
            kind: 'native',
            selected: [{ index: 2, label: 'China', value: 'cn', selected: true, disabled: false }],
          } } };
        }
        return { result: { value: undefined } };
      case 'Input.dispatchMouseEvent':
        if (params.type === 'mouseReleased') this.onMouseReleased?.(sessionId);
        return {};
      case 'Input.dispatchKeyEvent':
        if (params.type === 'keyUp') this.onKeyUp?.(params, sessionId);
        return {};
      case 'Input.insertText':
        if (this.editableState) {
          this.editableState.value = `${this.nextInputClear ? '' : this.editableState.value}${params.text}`;
          this.nextInputClear = false;
        }
        this.onInsertText?.(params, sessionId);
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
  const managedTargetCreates = [];
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding, {
      managedTargets: {
        async createTarget(params) {
          managedTargetCreates.push(params);
          return transport.send('Target.createTarget', params);
        },
      },
    }),
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
  assert.deepEqual(managedTargetCreates, [{ url: 'about:blank', newWindow: true }]);

  const listed = await tool(runtime, client, 'browser.tabs.list', { scope: 'all' });
  assert.deepEqual(listed.targets.map(target => target.origin).sort(), ['managed', 'user_tab']);
  await runtime.call(client.bridge, 'workspaces/release', { workspaceId: client.workspace.id });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transport.targets.has('user-form'), true);
  assert.equal([...transport.targets.keys()].some(id => id.startsWith('managed-')), false);
});

test('Observations return deterministic browser guidance and authentication transitions', async () => {
  const transport = new BrowserFixtureTransport();
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  const client = await createClient(runtime, 'bridge:hints', 'com.example.agent', 'instance:hints');
  const targetId = (await tool(runtime, client, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;

  const initial = await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);
  assert.deepEqual(initial.hints, []);

  transport.pageGuidance = {
    authenticationSurface: true,
    blockingModalCount: 1,
    explicitAutocompleteCount: 1,
    explicitFilterCount: 1,
  };
  const entered = await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);
  assert.deepEqual(entered.hints.map(hint => hint.code), [
    'modal_overlay',
    'authentication_surface',
    'autocomplete',
    'filter_controls',
  ]);
  assert.equal(entered.hints[0].blocking, true);
  assert.equal(entered.hints[1].state, 'entered');
  assert.equal(entered.hints[2].confidence, 'strong');

  const present = await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);
  assert.equal(present.hints.find(hint => hint.code === 'authentication_surface').state, 'present');
  transport.pageGuidance = {};
  const left = await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);
  assert.deepEqual(left.hints, [{
    code: 'authentication_surface',
    source: 'observation',
    confidence: 'strong',
    recommendedAction: 'inspect_authentication_state',
    state: 'left',
  }]);
});

test('latest Observation and locate are available through canonical Browser tools', async () => {
  const transport = new BrowserFixtureTransport();
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  const client = await createClient(runtime, 'bridge:latest', 'com.example.agent', 'instance:latest');
  const targetId = (await tool(runtime, client, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;

  await assert.rejects(
    () => tool(runtime, client, 'browser.observation.latest', {}, targetId),
    error => error.code === 'stale_ref',
  );
  const observed = await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);
  const latest = await tool(runtime, client, 'browser.observation.latest', {}, targetId);
  assert.equal(latest.observationId, observed.observationId);
  assert.equal(latest.elementCount, observed.elements.length);

  const located = await tool(runtime, client, 'browser.locate', { selector: '.editor' }, targetId);
  assert.deepEqual(
    { x: located.x, y: located.y, top: located.top, left: located.left, width: located.width, height: located.height },
    { x: 60, y: 35, top: 20, left: 10, width: 100, height: 30 },
  );
});

test('page search, element queries, scrolling, and native dropdowns work through public tools', async () => {
  const transport = new BrowserFixtureTransport();
  transport.extraAxNodes = [{
    nodeId: 'country',
    parentId: 'root',
    ignored: false,
    role: { value: 'combobox' },
    name: { value: 'Country' },
    properties: [],
    backendDOMNodeId: 202,
  }];
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding, { loadWaiter: async () => {} }),
  });
  const client = await createClient(runtime, 'bridge:page-primitives', 'com.example.agent', 'instance:page-primitives');
  const targetId = (await tool(runtime, client, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;
  const observed = await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);
  assert.equal(observed.page.documentHeight, 2400);
  const dropdownRef = observed.elements.find(element => element.name === 'Country').ref;

  const searched = await tool(runtime, client, 'browser.search', {
    query: 'Submit', wholeWord: true, limit: 10,
  }, targetId);
  assert.equal(searched.totalMatches, 1);
  assert.equal(searched.matches[0].context, 'Submit this form');

  const found = await tool(runtime, client, 'browser.elements.find', {
    selector: 'button', attributeNames: ['data-testid'], limit: 10,
  }, targetId);
  assert.equal(found.elements[0].attributes[0].value, 'submit');

  const scrolled = await tool(runtime, client, 'browser.scroll', {
    direction: 'down', amount: 0.8, unit: 'viewport', observationLimit: 10,
  }, targetId);
  assert.equal(scrolled.evidence.status, 'verified');
  assert.equal(scrolled.page.scrollY, 576);
  assert.match(scrolled.observationId, /^observation:/);

  const refreshed = await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);
  const options = await tool(runtime, client, 'browser.dropdown.options', {
    target: { observationId: refreshed.observationId, ref: dropdownRef },
  }, targetId);
  assert.deepEqual(options.options.map(option => option.label), ['Choose one', 'China']);

  const selected = await tool(runtime, client, 'browser.dropdown.select', {
    target: { observationId: refreshed.observationId, ref: dropdownRef },
    choice: { by: 'value', value: 'cn', exact: true },
    observationLimit: 10,
  }, targetId);
  assert.equal(selected.evidence.action, 'select');
  assert.equal(selected.evidence.status, 'verified', JSON.stringify(selected.evidence));
  assert.equal(selected.evidence.selected[0].value, 'cn');
});

test('ARIA dropdown selection scopes duplicate option labels to the controlled list', async () => {
  const transport = new BrowserFixtureTransport();
  transport.extraAxNodes = [
    {
      nodeId: 'city', parentId: 'root', ignored: false,
      role: { value: 'combobox' }, name: { value: 'City' },
      properties: [{ name: 'expanded', value: { value: true } }],
      backendDOMNodeId: 302,
    },
    {
      nodeId: 'unrelated-option', parentId: 'root', ignored: false,
      role: { value: 'option' }, name: { value: 'Shanghai' }, properties: [],
      backendDOMNodeId: 303,
    },
    {
      nodeId: 'owned-option', parentId: 'root', ignored: false,
      role: { value: 'option' }, name: { value: 'Shanghai' }, properties: [],
      backendDOMNodeId: 304,
    },
  ];
  transport.onMouseReleased = () => { transport.ariaSelected = true; };
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding, { loadWaiter: async () => {} }),
  });
  const client = await createClient(runtime, 'bridge:aria-select', 'com.example.agent', 'instance:aria-select');
  const targetId = (await tool(runtime, client, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;
  const observed = await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);
  const dropdownRef = observed.elements.find(element => element.name === 'City').ref;

  const selected = await tool(runtime, client, 'browser.dropdown.select', {
    target: { observationId: observed.observationId, ref: dropdownRef },
    choice: { by: 'label', label: 'Shanghai', exact: true },
    observationLimit: 10,
  }, targetId);

  const ownershipChecks = transport.calls.filter(call => (
    call.method === 'Runtime.callFunctionOn' &&
    String(call.params.functionDeclaration).includes('optionElements.indexOf(option)')
  ));
  assert.equal(selected.evidence.status, 'verified', JSON.stringify({
    evidence: selected.evidence,
    observed: observed.elements,
    ownershipChecks: ownershipChecks.map(call => ({
      target: call.params.objectId,
      option: call.params.arguments[0].objectId,
    })),
  }));
  assert.equal(selected.evidence.kind, 'aria');
  assert.equal(selected.evidence.selected[0].value, 'sha');
  assert.deepEqual(
    ownershipChecks.map(call => call.params.arguments[0].objectId),
    ['object:303', 'object:304'],
  );
});

test('Observation hints carry only numbered refs derived from explicit AX semantics', async () => {
  const transport = new BrowserFixtureTransport();
  transport.extraAxNodes = [
    {
      nodeId: 'dialog',
      parentId: 'root',
      childIds: ['dialog-button'],
      ignored: false,
      role: { value: 'dialog' },
      name: { value: 'Preferences' },
      properties: [],
    },
    {
      nodeId: 'dialog-button',
      parentId: 'dialog',
      ignored: false,
      role: { value: 'button' },
      name: { value: 'Apply' },
      properties: [],
      backendDOMNodeId: 201,
    },
    {
      nodeId: 'autocomplete',
      parentId: 'root',
      ignored: false,
      role: { value: 'combobox' },
      name: { value: 'City' },
      properties: [{ name: 'autocomplete', value: { value: 'list' } }],
      backendDOMNodeId: 202,
    },
    {
      nodeId: 'filter',
      parentId: 'root',
      ignored: false,
      role: { value: 'button' },
      name: { value: 'Filter results' },
      properties: [],
      backendDOMNodeId: 203,
    },
  ];
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  const client = await createClient(runtime, 'bridge:ax-hints', 'com.example.agent', 'instance:ax-hints');
  const targetId = (await tool(runtime, client, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;
  const observed = await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);

  const byCode = Object.fromEntries(observed.hints.map(hint => [hint.code, hint]));
  assert.deepEqual(byCode.modal_overlay.refs, [2]);
  assert.equal(byCode.modal_overlay.blocking, false);
  assert.deepEqual(byCode.autocomplete.refs, [3]);
  assert.equal(byCode.autocomplete.confidence, 'possible');
  assert.deepEqual(byCode.filter_controls.refs, [4]);
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

test('an unhandled dialog emits one watchdog event without choosing a response', async () => {
  const transport = new BrowserFixtureTransport();
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding, { dialogTimeoutMs: 5 }),
  });
  const client = await createClient(runtime, 'bridge:dialog-watchdog', 'com.example.agent', 'instance:dialog-watchdog');
  const targetId = (await tool(runtime, client, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;
  await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);
  const sessionId = [...transport.sessions.entries()]
    .find(([, cdpTargetId]) => cdpTargetId === 'user-form')[0];

  transport.emit('Page.javascriptDialogOpening', {
    type: 'confirm',
    message: 'Continue?',
    url: 'https://example.test/form',
  }, sessionId);
  await new Promise(resolve => setTimeout(resolve, 15));

  const replayed = await runtime.call(client.bridge, 'events/poll', {
    workspaceId: client.workspace.id,
    cursor: client.eventCursor,
  });
  const watchdogEvents = replayed.events.filter(event => event.type === 'watchdog.dialog_unhandled');
  assert.equal(watchdogEvents.length, 1);
  assert.equal(watchdogEvents[0].targetId, targetId);
  assert.match(watchdogEvents[0].payload.dialogId, /^dialog:/);
  assert.equal(watchdogEvents[0].payload.type, 'confirm');
  assert.equal(
    transport.calls.some(call => call.method === 'Page.handleJavaScriptDialog'),
    false,
  );
  assert.equal((await tool(runtime, client, 'browser.dialogs.list', {})).dialogs.length, 1);
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
    { requestId: 'paused-1', errorReason: 'BlockedByClient' },
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
  assert.equal(firstRequests.requests[0].sequence, 1);
  assert.equal(secondRequests.requests[0].sequence, 1);
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

test('network events hint only on blocked main-document responses', async () => {
  const transport = new BrowserFixtureTransport();
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  const client = await createClient(runtime, 'bridge:blocked-hints', 'com.example.agent', 'instance:blocked-hints');
  const targetId = (await tool(runtime, client, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;
  await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);
  const sessionId = [...transport.sessions.keys()][0];

  for (const [requestId, type, status] of [
    ['document-403', 'Document', 403],
    ['document-429', 'Document', 429],
    ['xhr-403', 'XHR', 403],
  ]) {
    transport.emit('Network.requestWillBeSent', {
      requestId,
      type,
      request: { method: 'GET', url: `https://blocked.test/${requestId}`, headers: {} },
    }, sessionId);
    transport.emit('Network.responseReceived', {
      requestId,
      response: { status, statusText: 'Blocked', headers: {}, mimeType: 'text/html' },
    }, sessionId);
  }

  const replayed = await runtime.call(client.bridge, 'events/poll', {
    workspaceId: client.workspace.id,
    cursor: client.eventCursor,
  });
  const responses = replayed.events.filter(event => event.type === 'network.response');
  assert.deepEqual(responses.slice(0, 2).map(event => event.payload.hints[0].status), [403, 429]);
  assert.equal(Object.hasOwn(responses[2].payload, 'hints'), false);
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
  transport.frameOwnerBackendNodeIds.set('cdp-child-frame', 500);
  transport.boxModelsByBackendNodeId.set(500, {
    content: [300, 150, 700, 150, 700, 450, 300, 450],
  });
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

  const observed = await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);
  await tool(runtime, client, 'browser.click', {
    target: { observationId: observed.observationId, ref: 1 },
  }, targetId);
  const rootSessionId = [...transport.sessions.entries()]
    .find(([, cdpTargetId]) => cdpTargetId === 'user-form')[0];
  const pointerCalls = transport.calls.filter(call => call.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(
    pointerCalls.map(call => [call.params.x, call.params.y, call.sessionId]),
    [
      [400, 230, rootSessionId],
      [400, 230, rootSessionId],
      [400, 230, rootSessionId],
    ],
  );

  transport.emit('Page.frameDetached', { frameId: 'cdp-child-frame' }, rootSessionId);
  const frameEvents = await runtime.call(client.bridge, 'events/poll', {
    workspaceId: client.workspace.id,
    cursor: client.eventCursor,
  });
  const detached = frameEvents.events.find(event => event.type === 'watchdog.frame_detached');
  assert.equal(detached.payload.frameId, childFrameId);
  assert.equal(JSON.stringify(detached).includes('cdp-child-frame'), false);

  const top = await tool(runtime, client, 'browser.frames.switch', { top: true }, targetId);
  assert.equal(top.frameId, listed.frames[0].frameId);
  await tool(runtime, client, 'browser.eval', { expression: '6 * 7' }, targetId);
  const topEvaluation = transport.calls.filter(call => (
    call.method === 'Runtime.evaluate' && call.params.expression === '6 * 7'
  )).at(-1);
  assert.equal('contextId' in topEvaluation.params, false);
});

test('OOPIF frames use their own CDP session for observations, refs, and actions', async () => {
  const transport = new BrowserFixtureTransport();
  transport.targets.set('oopif-target', {
    targetId: 'oopif-target',
    type: 'iframe',
    title: 'Cross Frame',
    url: 'https://cross.test/frame',
    parentId: 'frame:user-form',
    parentFrameId: 'frame:user-form',
  });
  transport.frameTreesByTarget.set('oopif-target', {
    frame: {
      id: 'oopif-target',
      parentId: 'frame:user-form',
      loaderId: 'loader:oopif:1',
      url: 'https://cross.test/frame',
      name: 'cross',
    },
  });
  transport.buttonNamesByTarget.set('oopif-target', 'Cross Frame Command');
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:oopif',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  const client = await createClient(runtime, 'bridge:oopif', 'com.example.agent', 'instance:oopif');
  const targetId = (await tool(runtime, client, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;

  const listed = await tool(runtime, client, 'browser.frames.list', {}, targetId);
  assert.equal(listed.frames.length, 2);
  const oopifFrameId = listed.frames.find(frame => frame.url === 'https://cross.test/frame').frameId;
  await tool(runtime, client, 'browser.frames.switch', { frameId: oopifFrameId }, targetId);
  const observed = await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);
  assert.equal(observed.url, 'https://cross.test/frame');
  assert.deepEqual(observed.elements, [{ ref: 1, role: 'button', name: 'Cross Frame Command' }]);

  const oopifSessionId = [...transport.sessions.entries()]
    .find(([, cdpTargetId]) => cdpTargetId === 'oopif-target')[0];
  assert.ok(transport.calls.some(call => (
    call.method === 'DOMSnapshot.captureSnapshot' && call.sessionId === oopifSessionId
  )));
  await tool(runtime, client, 'browser.click', {
    target: { observationId: observed.observationId, ref: 1 },
  }, targetId);
  const pointerCalls = transport.calls.filter(call => call.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(
    pointerCalls.map(call => [call.params.x, call.params.y, call.sessionId]),
    [
      [100, 80, oopifSessionId],
      [100, 80, oopifSessionId],
      [100, 80, oopifSessionId],
    ],
  );
  assert.equal(transport.calls.some(call => call.method === 'DOM.getFrameOwner'), false);
  assert.equal(transport.calls.some(call => (
    call.method === 'DOM.resolveNode' && call.params.backendNodeId === 42 && call.sessionId !== oopifSessionId
  )), false);

  transport.emit('Page.javascriptDialogOpening', {
    type: 'confirm',
    message: 'Cross-frame confirmation',
    url: 'https://cross.test/frame',
  }, oopifSessionId);
  const dialogs = await tool(runtime, client, 'browser.dialogs.list', {});
  assert.equal(dialogs.dialogs.length, 1);
  await tool(runtime, client, 'browser.dialogs.respond', {
    dialogId: dialogs.dialogs[0].dialogId,
    action: 'dismiss',
  }, targetId);
  assert.ok(transport.calls.some(call => (
    call.method === 'Page.handleJavaScriptDialog' && call.sessionId === oopifSessionId
  )));

  await runtime.call(client.bridge, 'workspaces/release', { workspaceId: client.workspace.id });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(transport.calls.some(call => (
    call.method === 'Target.detachFromTarget' && call.params.sessionId === oopifSessionId
  )));
});

test('stalled navigation returns unknown_outcome and an inspect-before-retry event', async () => {
  const transport = new BrowserFixtureTransport();
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding, {
      navigationTimeoutMs: 25,
      loadWaiter: async (_transport, _sessionId, timeoutMs) => {
        throw new PageLoadTimeoutError(timeoutMs);
      },
    }),
  });
  const client = await createClient(runtime, 'bridge:navigation-watchdog', 'com.example.agent', 'instance:navigation-watchdog');

  await assert.rejects(
    () => runtime.call(client.bridge, 'tools/call', {
      name: 'browser.open',
      arguments: { url: 'https://pending.test/', newTarget: true },
      workspaceId: client.workspace.id,
      leaseId: client.lease.id,
    }),
    error => (
      error.code === 'unknown_outcome' &&
      error.retryable === true &&
      error.context.reason === 'navigation_stalled' &&
      error.remediation.code === 'inspect_navigation_state'
    ),
  );
  const replayed = await runtime.call(client.bridge, 'events/poll', {
    workspaceId: client.workspace.id,
    cursor: client.eventCursor,
  });
  const stalled = replayed.events.find(event => event.type === 'watchdog.navigation_stalled');
  assert.equal(stalled.payload.url, 'https://pending.test/');
  assert.equal(stalled.payload.timeoutMs, 25);
  assert.equal(stalled.payload.outcome, 'unknown');
});

test('three observable no-progress actions emit one scoped watchdog event', async () => {
  const transport = new BrowserFixtureTransport();
  transport.pointerTargetState.targetState.focused = true;
  transport.pointerReadbackState.focused = true;
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding, { noProgressThreshold: 3 }),
  });
  const client = await createClient(runtime, 'bridge:no-progress', 'com.example.agent', 'instance:no-progress');
  const targetId = (await tool(runtime, client, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;
  let observation = await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);

  let thresholdHint;
  for (let index = 0; index < 4; index += 1) {
    observation = await tool(runtime, client, 'browser.click', {
      target: { observationId: observation.observationId, ref: 1 },
    }, targetId);
    assert.equal(observation.evidence.reason, 'no_observable_effect');
    if (index === 2) thresholdHint = observation.hints.find(hint => hint.code === 'repeated_action');
  }
  assert.equal(thresholdHint.streak, 3);

  const replayed = await runtime.call(client.bridge, 'events/poll', {
    workspaceId: client.workspace.id,
    cursor: client.eventCursor,
  });
  const watchdogEvents = replayed.events.filter(event => event.type === 'watchdog.no_progress');
  assert.equal(watchdogEvents.length, 1);
  assert.equal(watchdogEvents[0].leaseId, client.lease.id);
  assert.equal(watchdogEvents[0].targetId, targetId);
  assert.deepEqual(watchdogEvents[0].payload, {
    action: 'click',
    evidenceStatus: 'unavailable',
    reason: 'no_observable_effect',
    streak: 3,
    threshold: 3,
    hints: [thresholdHint],
  });
  assert.equal(JSON.stringify(watchdogEvents).includes('Submit'), false);
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
  assert.deepEqual(uploaded.evidence, {
    action: 'upload',
    status: 'verified',
    expectedFileCount: 1,
    fileCount: 1,
    nameMatched: true,
  });
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
    action: 'type',
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

test('browser.type stops submit after an intervening loader replacement', async () => {
  const transport = new BrowserFixtureTransport();
  transport.editableState = {
    kind: 'input',
    value: '',
    sensitive: false,
    editable: true,
    inputType: 'text',
    editMode: 'text',
    selectionMode: 'range',
  };
  transport.onInsertText = (_params, sessionId) => {
    const cdpTargetId = transport.sessions.get(sessionId);
    transport.loaders.set(cdpTargetId, 'loader:user-form:replaced');
  };
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  const client = await createClient(runtime, 'bridge:type-guard', 'com.example.agent', 'instance:type-guard');
  const targetId = (await tool(runtime, client, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;
  const observed = await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);
  const field = observed.elements.find(element => element.name === 'Query');
  assert.ok(field);

  await assert.rejects(
    () => tool(runtime, client, 'browser.type', {
      observationId: observed.observationId,
      ref: field.ref,
      text: 'partial',
      submit: true,
    }, targetId),
    error => (
      error.code === 'unknown_outcome' &&
      error.retryable === true &&
      error.context?.reason === 'loader_changed' &&
      error.context?.step === 'submit' &&
      error.context?.dispatchedSteps === 2 &&
      error.context?.remainingStepsStopped === true
    ),
  );
  assert.equal(transport.editableState.value, 'partial');
  assert.equal(
    transport.calls.some(call => (
      call.method === 'Input.dispatchKeyEvent' && call.params.key === 'Enter'
    )),
    false,
  );
});

test('Observation refs are Lease-scoped, stale after navigation, and actions return a new Observation', async () => {
  const transport = new BrowserFixtureTransport();
  transport.extraAxButtons = ['Secondary action'];
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
    observationLimit: 1,
  }, targetId);
  assert.notEqual(clicked.observationId, observed.observationId);
  assert.equal(clicked.elements[0].name, 'Submit');
  assert.equal(clicked.elements.length, 1);
  assert.equal(clicked.truncated, true);
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

test('same-document semantic mutation makes an old ref stale until the Agent observes again', async () => {
  const transport = new BrowserFixtureTransport();
  transport.extraAxButtons = ['Secondary action'];
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:semantic-ref',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  const client = await createClient(
    runtime,
    'bridge:semantic-ref',
    'com.example.agent',
    'instance:semantic-ref',
  );
  const targetId = (await tool(runtime, client, 'browser.tabs.list', {})).targets[0].targetId;
  const observed = await tool(runtime, client, 'browser.observe', {}, targetId);
  transport.buttonNamesByTarget.set('user-form', 'Delete account');
  const pointerCallCount = transport.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length;

  await assert.rejects(
    () => tool(runtime, client, 'browser.click', {
      target: { observationId: observed.observationId, ref: 1 },
    }, targetId),
    error => error.code === 'stale_ref' && error.context?.reason === undefined,
  );
  assert.equal(
    transport.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length,
    pointerCallCount,
  );

  await tool(runtime, client, 'browser.click', {
    target: { observationId: observed.observationId, ref: 2 },
  }, targetId);
  assert.equal(
    transport.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length,
    pointerCallCount + 3,
  );

  const refreshed = await tool(runtime, client, 'browser.observe', {}, targetId);
  assert.equal(refreshed.elements[0].name, 'Delete account');
  await tool(runtime, client, 'browser.click', {
    target: { observationId: refreshed.observationId, ref: 1 },
  }, targetId);
  assert.equal(
    transport.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length,
    pointerCallCount + 6,
  );
});

test('same-URL Document replacement invalidates old Observation refs before input dispatch', async () => {
  const transport = new BrowserFixtureTransport();
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  const client = await createClient(
    runtime,
    'bridge:document-generation',
    'com.example.agent',
    'instance:document-generation',
  );
  const tabs = await tool(runtime, client, 'browser.tabs.list', {});
  const targetId = tabs.targets[0].targetId;
  const observed = await tool(runtime, client, 'browser.observe', {}, targetId);

  transport.documentBackendNodeId += 1;
  const pointerCallCount = transport.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length;
  await assert.rejects(
    () => tool(runtime, client, 'browser.click', {
      target: { observationId: observed.observationId, ref: 1 },
    }, targetId),
    error => error.code === 'stale_ref' && error.context?.reason === 'document_replaced',
  );
  assert.equal(
    transport.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length,
    pointerCallCount,
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

test('browser.press merges control, navigation, document, dialog, and popup evidence', async () => {
  const transport = new BrowserFixtureTransport();
  transport.pressStates = [
    { backendNodeId: 80, kind: 'input', sensitive: false, valueToken: '0:1' },
    { backendNodeId: 80, kind: 'input', sensitive: false, valueToken: '1:2' },
  ];
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:test',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  const client = await createClient(runtime, 'bridge:press-effects', 'com.example.agent', 'instance:press-effects');
  const targetId = (await tool(runtime, client, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;
  transport.onKeyUp = (params, sessionId) => {
    if (params.key !== 'Enter') return;
    const target = transport.targets.get('user-form');
    target.url = 'https://example.test/pressed';
    target.title = 'Pressed';
    transport.loaders.set('user-form', 'loader:user-form:pressed');
    transport.emit('Page.javascriptDialogOpening', {
      type: 'alert',
      message: 'Pressed',
      url: target.url,
    }, sessionId);
    transport.emit('Target.targetCreated', {
      targetInfo: {
        targetId: 'press-popup',
        type: 'page',
        url: 'https://example.test/press-popup',
        openerId: 'user-form',
      },
    });
  };

  const pressed = await tool(runtime, client, 'browser.press', { key: 'Enter' }, targetId);

  assert.equal(pressed.url, 'https://example.test/pressed');
  assert.deepEqual(pressed.evidence, {
    action: 'press',
    status: 'verified',
    kind: 'input',
    effects: [
      'value_changed',
      'navigation',
      'document_changed',
      'dialog_opened',
      'popup_opened',
    ],
    sensitive: false,
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

test('same physical target commands share one actor across Workspace-local target IDs', async () => {
  let releaseAx;
  let markAxStarted;
  const axStarted = new Promise(resolve => { markAxStarted = resolve; });
  class BlockingTransport extends BrowserFixtureTransport {
    blockNextAx = true;

    async send(method, params, sessionId) {
      if (method === 'Accessibility.getFullAXTree' && this.blockNextAx) {
        this.blockNextAx = false;
        markAxStarted();
        await new Promise(resolve => { releaseAx = resolve; });
      }
      return super.send(method, params, sessionId);
    }
  }
  const transport = new BlockingTransport();
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:physical-actor',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  const first = await createClient(runtime, 'bridge:actor-first', 'com.first.agent', 'instance:actor-first');
  const second = await createClient(runtime, 'bridge:actor-second', 'com.second.agent', 'instance:actor-second');
  const firstTarget = (await tool(runtime, first, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;
  const secondTarget = (await tool(runtime, second, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;

  const firstCall = tool(runtime, first, 'browser.observe', { limit: 10 }, firstTarget);
  await axStarted;
  const callsBeforeSecond = transport.calls.length;
  const secondCall = tool(runtime, second, 'browser.observe', { limit: 10 }, secondTarget);
  const secondRejected = assert.rejects(secondCall, error => error.code === 'target_busy');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(transport.calls.length, callsBeforeSecond);

  releaseAx();
  await firstCall;
  await secondRejected;
});

test('explicit target release cleans the old session before another Lease acquires control', async () => {
  const transport = new BrowserFixtureTransport();
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:target-release',
    browsers: [binding],
    toolExecutor: new BrowserToolService(transport, binding),
  });
  const first = await createClient(runtime, 'bridge:release-first', 'com.first.agent', 'instance:release-first');
  const second = await createClient(runtime, 'bridge:release-second', 'com.second.agent', 'instance:release-second');
  const firstTarget = (await tool(runtime, first, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;
  const secondTarget = (await tool(runtime, second, 'browser.tabs.list', { scope: 'all' })).targets[0].targetId;

  await tool(runtime, first, 'browser.observe', { limit: 10 }, firstTarget);
  await assert.rejects(
    () => tool(runtime, second, 'browser.observe', { limit: 10 }, secondTarget),
    error => error.code === 'target_busy',
  );
  const detachedBefore = transport.calls.filter(call => call.method === 'Target.detachFromTarget').length;
  const released = await tool(runtime, first, 'browser.tabs.release', {}, firstTarget);
  assert.equal(released.released, true);
  assert.equal(
    transport.calls.filter(call => call.method === 'Target.detachFromTarget').length,
    detachedBefore + 1,
  );
  const firstEvents = await runtime.call(first.bridge, 'events/poll', {
    workspaceId: first.workspace.id,
    cursor: first.eventCursor,
  });
  assert.deepEqual(
    firstEvents.events
      .map(event => event.type)
      .filter(type => type.startsWith('target_control.')),
    ['target_control.acquired', 'target_control.released'],
  );
  assert.equal(
    firstEvents.events.find(event => (
      event.type === 'observation.invalidated' && event.payload.reason === 'control_released'
    )).targetId,
    firstTarget,
  );

  const observed = await tool(runtime, second, 'browser.observe', { limit: 10 }, secondTarget);
  assert.equal(observed.elements[0].name, 'Submit');
  const repeated = await tool(runtime, first, 'browser.tabs.release', {}, firstTarget);
  assert.equal(repeated.released, false);
  await assert.doesNotReject(() => tool(runtime, second, 'browser.observe', { limit: 10 }, secondTarget));
  assert.equal(transport.targets.has('user-form'), true);
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

  const observed = await tool(runtime, client, 'browser.observe', { limit: 10 }, targetId);
  const annotated = await tool(runtime, client, 'browser.capture', {
    annotations: { observationId: observed.observationId, refs: [1] },
  }, targetId);
  assert.equal(annotated.annotationCount, 1);
  const annotatedAccess = await runtime.call(client.bridge, 'artifacts/get', {
    workspaceId: client.workspace.id,
    leaseId: client.lease.id,
    artifactId: annotated.artifact.id,
  });
  assert.deepEqual(await readFile(annotatedAccess.path), Buffer.from('annotated-screenshot-bytes'));
  assert.ok(transport.calls.some(call => (
    call.method === 'Page.createIsolatedWorld' &&
    call.params.worldName === 'browser-pilot.screenshot-annotation.v1'
  )));
  assert.ok(transport.calls.some(call => (
    call.method === 'Runtime.evaluate' && call.params.contextId === 77 &&
    String(call.params.expression).includes('createImageBitmap')
  )));

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
  assert.deepEqual(replayed.events
    .filter(event => event.type !== 'command.status')
    .map(event => event.browserConnectionGeneration), [1, 1, 1, 1, 2, 1, 1]);

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
