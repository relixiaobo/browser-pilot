import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OBSERVATION_INVALIDATION_REASONS,
  OBSERVATION_TRUNCATION_REASONS,
  OBSERVATION_V1_LIMITS,
  TOOL_DEFINITIONS,
} from '../dist/protocol.js';
import {
  MemoryObservationStore,
  MemoryRefStore,
  ObservationService,
} from '../dist/services.js';

function tool(name) {
  return TOOL_DEFINITIONS.find(definition => definition.name === name);
}

function snapshotTransport(pageInfo, nodes, domSnapshot = { documents: [], strings: [] }) {
  return {
    async send(method) {
      if (method === 'Runtime.evaluate') {
        return { result: { value: JSON.stringify(pageInfo) } };
      }
      if (method === 'Accessibility.getFullAXTree') return { nodes };
      if (method === 'DOMSnapshot.captureSnapshot') return domSnapshot;
      throw new Error(`Unexpected CDP method: ${method}`);
    },
    close() {},
  };
}

function axTree(elements) {
  return [
    {
      nodeId: 'root',
      childIds: elements.map((_, index) => `element:${index}`),
      ignored: false,
      role: { value: 'RootWebArea' },
      properties: [],
    },
    ...elements.map((element, index) => ({
      nodeId: `element:${index}`,
      parentId: 'root',
      ignored: false,
      role: { value: element.role ?? 'button' },
      name: { value: element.name },
      ...(element.value !== undefined ? { value: { value: element.value } } : {}),
      properties: Object.entries(element.properties ?? {}).map(([name, value]) => ({
        name,
        value: { value },
      })),
      backendDOMNodeId: index + 1,
    })),
  ];
}

function domSnapshotFixture(elements, frameId = 'frame:test') {
  const strings = [];
  const intern = value => {
    const normalized = String(value);
    const existing = strings.indexOf(normalized);
    if (existing >= 0) return existing;
    strings.push(normalized);
    return strings.length - 1;
  };
  const nodes = {
    parentIndex: [],
    nodeType: [],
    nodeName: [],
    nodeValue: [],
    backendNodeId: [],
    attributes: [],
    isClickable: { index: [] },
    inputValue: { index: [], value: [] },
    inputChecked: { index: [] },
    optionSelected: { index: [] },
    contentDocumentIndex: { index: [], value: [] },
  };
  const layout = { nodeIndex: [], styles: [], bounds: [], paintOrders: [] };
  const append = ({ parentIndex, nodeType, nodeName, nodeValue = '', backendNodeId, attributes = {} }) => {
    const nodeIndex = nodes.backendNodeId.length;
    nodes.parentIndex.push(parentIndex);
    nodes.nodeType.push(nodeType);
    nodes.nodeName.push(intern(nodeName));
    nodes.nodeValue.push(intern(nodeValue));
    nodes.backendNodeId.push(backendNodeId);
    nodes.attributes.push(Object.entries(attributes).flatMap(([name, value]) => [intern(name), intern(value)]));
    return nodeIndex;
  };
  append({ parentIndex: -1, nodeType: 9, nodeName: '#document', backendNodeId: 9_000 });
  append({ parentIndex: 0, nodeType: 1, nodeName: 'HTML', backendNodeId: 9_001 });
  append({ parentIndex: 1, nodeType: 1, nodeName: 'BODY', backendNodeId: 9_002 });
  for (const element of elements) {
    const nodeIndex = append({
      parentIndex: 2,
      nodeType: 1,
      nodeName: element.nodeName ?? 'DIV',
      backendNodeId: element.backendNodeId,
      attributes: element.attributes,
    });
    if (element.text) {
      append({
        parentIndex: nodeIndex,
        nodeType: 3,
        nodeName: '#text',
        nodeValue: element.text,
        backendNodeId: element.backendNodeId + 10_000,
      });
    }
    if (element.clickable) nodes.isClickable.index.push(nodeIndex);
    if (element.inputValue !== undefined) {
      nodes.inputValue.index.push(nodeIndex);
      nodes.inputValue.value.push(intern(element.inputValue));
    }
    if (element.checked) nodes.inputChecked.index.push(nodeIndex);
    if (element.layout !== false) {
      layout.nodeIndex.push(nodeIndex);
      layout.styles.push([
        intern(element.display ?? 'block'),
        intern(element.visibility ?? 'visible'),
        intern(element.opacity ?? '1'),
        intern(element.pointerEvents ?? 'auto'),
      ]);
      layout.bounds.push(element.bounds ?? [10, 10, 120, 30]);
      layout.paintOrders.push(layout.paintOrders.length + 1);
    }
  }
  return {
    strings,
    documents: [{
      frameId: intern(frameId),
      documentURL: intern('https://example.test/fusion'),
      baseURL: intern('https://example.test/'),
      nodes,
      layout,
    }],
  };
}

function storeInput(overrides = {}) {
  return {
    workspaceId: 'workspace:test',
    leaseId: 'lease:test',
    targetId: 'target:test',
    browserProcessIdentity: 'process:one',
    browserConnectionGeneration: 1,
    sessionId: 'session:one',
    frameId: 'frame:one',
    loaderId: 'loader:one',
    documentGeneration: 'document:one',
    title: 'Fixture',
    url: 'https://example.test/',
    refs: [{ backendNodeId: 7, role: 'button', name: 'Submit' }],
    truncated: false,
    truncationReasons: [],
    ...overrides,
  };
}

test('Observation v1 constants are canonical across types and tool schemas', () => {
  assert.deepEqual(OBSERVATION_TRUNCATION_REASONS, [
    'element_limit',
    'text_limit',
    'depth_limit',
    'byte_limit',
  ]);
  assert.ok(OBSERVATION_INVALIDATION_REASONS.includes('document_replaced'));
  const observe = tool('browser.observe');
  assert.equal(observe.inputSchema.properties.limit.maximum, OBSERVATION_V1_LIMITS.maxElements);
  assert.equal(observe.outputSchema.properties.elements.maxItems, OBSERVATION_V1_LIMITS.maxElements);
  assert.equal(
    observe.outputSchema.properties.title.maxLength,
    OBSERVATION_V1_LIMITS.maxTitleCharacters,
  );
  assert.deepEqual(
    observe.outputSchema.properties.truncationReasons.items.enum,
    OBSERVATION_TRUNCATION_REASONS,
  );
});

test('Observation snapshots bound fields and report element, text, and depth truncation', async () => {
  const longName = 'n'.repeat(OBSERVATION_V1_LIMITS.maxElementNameCharacters + 20);
  const refs = new MemoryRefStore();
  const bounded = await new ObservationService(
    snapshotTransport(
      {
        title: 't'.repeat(OBSERVATION_V1_LIMITS.maxTitleCharacters + 20),
        url: 'https://example.test/',
        guidance: {},
      },
      axTree([{ name: longName }, { name: 'second' }]),
    ),
    'session:test',
    'target:test',
    { refStore: refs },
  ).observe(1);

  assert.equal(bounded.data.title.length, OBSERVATION_V1_LIMITS.maxTitleCharacters);
  assert.equal(bounded.data.elements.length, 1);
  assert.equal(bounded.data.elements[0].name.length, OBSERVATION_V1_LIMITS.maxElementNameCharacters);
  assert.deepEqual(bounded.truncationReasons, ['element_limit', 'text_limit']);
  assert.equal(bounded.truncated, true);
  assert.equal(refs.load('target:test').length, 1);

  const depth = OBSERVATION_V1_LIMITS.maxTreeDepth + 2;
  const nodes = [];
  for (let index = 0; index <= depth; index += 1) {
    nodes.push({
      nodeId: `node:${index}`,
      ...(index > 0 ? { parentId: `node:${index - 1}` } : {}),
      ...(index < depth ? { childIds: [`node:${index + 1}`] } : {}),
      ignored: index < depth,
      role: { value: index === depth ? 'button' : 'generic' },
      name: { value: index === depth ? 'Too Deep' : '' },
      properties: [],
      ...(index === depth ? { backendDOMNodeId: 99 } : {}),
    });
  }
  const deep = await new ObservationService(
    snapshotTransport({ title: 'Deep', url: 'https://example.test/deep', guidance: {} }, nodes),
    'session:deep',
    'target:deep',
    { refStore: new MemoryRefStore() },
  ).observe();
  assert.equal(deep.data.elements.length, 0);
  assert.deepEqual(deep.truncationReasons, ['depth_limit']);
});

test('Observation snapshots expose bounded viewport, document, and scroll geometry', async () => {
  const page = {
    viewportWidth: 1280,
    viewportHeight: 720,
    documentWidth: 1440,
    documentHeight: 3000,
    scrollX: 10,
    scrollY: 900,
    pixelsAbove: 900,
    pixelsBelow: 1380,
    pixelsLeft: 10,
    pixelsRight: 150,
    scrollPercentX: 6.3,
    scrollPercentY: 39.5,
  };
  const result = await new ObservationService(
    snapshotTransport(
      { title: 'Geometry', url: 'https://example.test/geometry', page, guidance: {} },
      axTree([]),
    ),
    'session:geometry',
    'target:geometry',
  ).observe();

  assert.deepEqual(result.data.page, page);
  assert.deepEqual(
    tool('browser.observe').outputSchema.properties.page.required,
    Object.keys(page),
  );
});

test('Observation snapshots enforce a UTF-8 serialized byte budget', async () => {
  const elements = Array.from({ length: 600 }, (_, index) => ({
    name: `${index}:${'\u754c'.repeat(4_096)}`,
  }));
  const result = await new ObservationService(
    snapshotTransport(
      { title: 'Byte budget', url: 'https://example.test/bytes', guidance: {} },
      axTree(elements),
    ),
    'session:bytes',
    'target:bytes',
    { refStore: new MemoryRefStore() },
  ).observe(600);

  assert.ok(result.data.elements.length > 0 && result.data.elements.length < elements.length);
  assert.ok(result.truncationReasons.includes('byte_limit'));
  assert.ok(Buffer.byteLength(JSON.stringify(result.data), 'utf8') <= OBSERVATION_V1_LIMITS.maxSerializedBytes);
});

test('Observation fuses AX semantics with DOM layout, state, names, and form values', async () => {
  const nodes = axTree([
    { name: 'AX Primary', role: 'button' },
    { name: 'Hidden AX', role: 'button' },
    { name: 'Disabled AX', role: 'button' },
    { name: 'Consent', role: 'checkbox', properties: { checked: false } },
    { name: 'Email', role: 'textbox' },
  ]).map(node => {
    if (!node.backendDOMNodeId) return node;
    return { ...node, backendDOMNodeId: node.backendDOMNodeId + 100 };
  });
  const domSnapshot = domSnapshotFixture([
    { backendNodeId: 101, attributes: { 'aria-label': 'DOM fallback' }, clickable: true },
    { backendNodeId: 102, text: 'Hidden AX', clickable: true, layout: false },
    { backendNodeId: 103, text: 'Disabled AX', clickable: true, attributes: { disabled: '' } },
    { backendNodeId: 104, nodeName: 'INPUT', attributes: { type: 'checkbox' }, clickable: true },
    { backendNodeId: 105, nodeName: 'INPUT', attributes: { type: 'email' }, inputValue: 'person@example.test' },
    { backendNodeId: 200, text: 'DOM Command', clickable: true, attributes: { 'data-action': 'command' } },
    { backendNodeId: 201, text: 'Hidden DOM Command', clickable: true, attributes: { hidden: '' } },
  ]);
  const refs = new MemoryRefStore();
  const result = await new ObservationService(
    snapshotTransport(
      { title: 'Fusion', url: 'https://example.test/fusion', guidance: {} },
      nodes,
      domSnapshot,
    ),
    'session:fusion',
    'target:fusion',
    { refStore: refs, frameId: 'frame:test' },
  ).observe(20);

  assert.deepEqual(result.data.elements, [
    { ref: 1, role: 'button', name: 'AX Primary' },
    { ref: 2, role: 'checkbox', name: 'Consent', checked: false },
    { ref: 3, role: 'textbox', name: 'Email', value: 'person@example.test' },
    { ref: 4, role: 'button', name: 'DOM Command' },
  ]);
  assert.deepEqual(refs.load('target:fusion').map(ref => ref.backendNodeId), [101, 104, 105, 200]);
});

test('Observation exposes ARIA options as refs but excludes native option elements', async () => {
  const result = await new ObservationService(
    snapshotTransport(
      { title: 'Dropdown', url: 'https://example.test/dropdown', guidance: {} },
      axTree([
        { name: 'ARIA choice', role: 'option' },
        { name: 'Native choice', role: 'option' },
      ]),
      domSnapshotFixture([
        { backendNodeId: 1, nodeName: 'DIV', attributes: { role: 'option' }, text: 'ARIA choice' },
        { backendNodeId: 2, nodeName: 'OPTION', text: 'Native choice' },
      ]),
    ),
    'session:dropdown',
    'target:dropdown',
    { refStore: new MemoryRefStore(), frameId: 'frame:test' },
  ).observe(20);

  assert.deepEqual(result.data.elements, [
    { ref: 1, role: 'option', name: 'ARIA choice' },
  ]);
});

test('Observation store validates full internal identity and reports same-context invalidation reasons', () => {
  const mismatchCases = [
    ['browserProcessIdentity', 'process:two', 'browser_reconnected'],
    ['browserConnectionGeneration', 2, 'browser_reconnected'],
    ['sessionId', 'session:two', 'session_replaced'],
    ['frameId', 'frame:two', 'frame_changed'],
    ['loaderId', 'loader:two', 'loader_replaced'],
    ['documentGeneration', 'document:two', 'document_replaced'],
  ];

  for (const [field, value, reason] of mismatchCases) {
    const store = new MemoryObservationStore({ idFactory: () => 'observation:test' });
    const record = store.create(storeInput());
    assert.throws(
      () => store.resolve({ ...storeInput(), observationId: record.id, ref: 1, [field]: value }),
      error => error.code === 'stale_ref' && error.context?.reason === reason,
    );
  }

  const store = new MemoryObservationStore({ idFactory: () => 'observation:invalidated' });
  const record = store.create(storeInput());
  store.invalidateTarget(record.targetId, 'navigation');
  assert.throws(
    () => store.resolve({ ...storeInput(), observationId: record.id, ref: 1 }),
    error => error.code === 'stale_ref' && error.context?.reason === 'navigation',
  );
  assert.throws(
    () => store.resolve({
      ...storeInput({ workspaceId: 'workspace:other' }),
      observationId: record.id,
      ref: 1,
    }),
    error => error.code === 'stale_ref' && error.context?.reason === undefined,
  );
});

test('Observation store returns only the newest live Observation for a target', () => {
  let now = 1_000;
  let nextId = 1;
  const store = new MemoryObservationStore({
    ttlMs: 100,
    now: () => now,
    idFactory: () => `observation:latest:${nextId++}`,
  });
  assert.throws(
    () => store.latest('workspace:test', 'lease:test', 'target:test'),
    error => error.code === 'stale_ref',
  );

  const first = store.create(storeInput());
  now = 1_010;
  const second = store.create(storeInput({ title: 'Newest' }));
  assert.equal(store.latest(first.workspaceId, first.leaseId, first.targetId).id, second.id);

  store.invalidateTarget(first.targetId, 'navigation');
  assert.throws(
    () => store.latest(first.workspaceId, first.leaseId, first.targetId),
    error => error.code === 'stale_ref',
  );

  now = 2_000;
  const expiring = store.create(storeInput({ targetId: 'target:expiring' }));
  now = expiring.expiresAt;
  assert.throws(
    () => store.latest(expiring.workspaceId, expiring.leaseId, expiring.targetId),
    error => error.code === 'stale_ref',
  );
});

test('Observation invalidation matrix returns every canonical reason to its owner', () => {
  const transitionCases = [
    {
      reason: 'navigation',
      transition: (store, record) => store.invalidateTarget(record.targetId, 'navigation'),
    },
    { reason: 'loader_replaced', resolve: { loaderId: 'loader:two' } },
    { reason: 'document_replaced', resolve: { documentGeneration: 'document:two' } },
    { reason: 'frame_changed', resolve: { frameId: 'frame:two' } },
    {
      reason: 'frame_detached',
      transition: (store, record) => store.invalidateTarget(record.targetId, 'frame_detached'),
    },
    {
      reason: 'session_replaced',
      transition: (store, record) => store.invalidateSession(record.sessionId),
    },
    {
      reason: 'target_detached',
      transition: (store, record) => store.invalidateTarget(record.targetId, 'target_detached'),
    },
    { reason: 'browser_reconnected', resolve: { browserConnectionGeneration: 2 } },
    {
      reason: 'target_ineligible',
      transition: (store, record) => store.invalidateTarget(record.targetId, 'target_ineligible'),
    },
    {
      reason: 'target_closed',
      transition: (store, record) => store.invalidateTarget(record.targetId, 'target_closed'),
    },
    {
      reason: 'control_released',
      transition: (store, record) => store.invalidateTarget(record.targetId, 'control_released'),
    },
    { reason: 'expired', expire: true },
  ];
  assert.deepEqual(
    transitionCases.map(candidate => candidate.reason).sort(),
    [...OBSERVATION_INVALIDATION_REASONS].sort(),
  );

  for (const [index, transitionCase] of transitionCases.entries()) {
    let now = 1_000;
    const observationId = `observation:transition:${index}`;
    const store = new MemoryObservationStore({
      ttlMs: 100,
      now: () => now,
      idFactory: () => observationId,
    });
    const record = store.create(storeInput());
    transitionCase.transition?.(store, record);
    if (transitionCase.expire) now = record.expiresAt;

    assert.throws(
      () => store.resolve({
        ...storeInput(),
        ...transitionCase.resolve,
        observationId: record.id,
        ref: 1,
      }),
      error => (
        error.code === 'stale_ref' &&
        error.context?.reason === transitionCase.reason &&
        error.context?.observationId === record.id
      ),
      transitionCase.reason,
    );
  }

  let now = 2_000;
  const privateStore = new MemoryObservationStore({
    ttlMs: 10,
    now: () => now,
    idFactory: () => 'observation:private-expiry',
  });
  const privateRecord = privateStore.create(storeInput());
  now = privateRecord.expiresAt;
  assert.throws(
    () => privateStore.resolve({
      ...storeInput({ workspaceId: 'workspace:other' }),
      observationId: privateRecord.id,
      ref: 1,
    }),
    error => error.code === 'stale_ref' && error.context?.reason === undefined,
  );
});

test('Observation store rejects inconsistent bounds and truncation metadata', () => {
  const store = new MemoryObservationStore();
  assert.throws(
    () => store.create(storeInput({ truncated: true, truncationReasons: [] })),
    /truncation metadata is inconsistent/,
  );
  assert.throws(
    () => store.create(storeInput({
      title: 'x'.repeat(OBSERVATION_V1_LIMITS.maxTitleCharacters + 1),
    })),
    /oversized page identity/,
  );
});
