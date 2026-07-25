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

function snapshotTransport(pageInfo, nodes) {
  return {
    async send(method) {
      if (method === 'Runtime.evaluate') {
        return { result: { value: JSON.stringify(pageInfo) } };
      }
      if (method === 'Accessibility.getFullAXTree') return { nodes };
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
      properties: [],
      backendDOMNodeId: index + 1,
    })),
  ];
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
