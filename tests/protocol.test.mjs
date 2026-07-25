import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BrowserPilotError,
  DEFAULT_CAPABILITIES,
  TOOL_DEFINITIONS,
  assertToolManifest,
  getToolManifest,
  negotiateCapabilities,
  negotiateProtocolLimits,
  negotiateProtocol,
  parseJsonRpcMessage,
  validateCommandAccessParams,
  validateEventsPollParams,
  validateToolCallParams,
  validateToolArguments,
  validateToolResult,
  validateInitializeParams,
} from '../dist/protocol.js';

const initializeParams = {
  client: {
    id: 'com.example.agent',
    name: 'Example Agent',
    version: '2.3.0',
    instanceId: 'instance:123',
  },
  protocol: {
    min: { major: 1, minor: 0 },
    max: { major: 1, minor: 1 },
  },
  requestedCapabilities: ['browser.control', 'developer.eval', 'future.capability'],
  launchMode: 'embedded',
  limits: {
    maxMessageBytes: 128 * 1024,
    maxResultBytes: 512 * 1024,
  },
};

test('validates initialize parameters without Agent-specific concepts', () => {
  assert.deepEqual(validateInitializeParams(initializeParams), initializeParams);
});

test('rejects malformed client identities with a stable error', () => {
  assert.throws(
    () => validateInitializeParams({ ...initializeParams, client: { ...initializeParams.client, id: 'Bad ID' } }),
    error => error instanceof BrowserPilotError && error.code === 'invalid_argument' && error.context?.field === 'id',
  );
});

test('selects the highest compatible protocol version', () => {
  assert.deepEqual(
    negotiateProtocol(
      { min: { major: 1, minor: 0 }, max: { major: 2, minor: 0 } },
      [{ major: 1, minor: 0 }, { major: 1, minor: 2 }, { major: 2, minor: 1 }],
    ),
    { major: 1, minor: 2 },
  );
});

test('validates and negotiates transport limits without changing resource limits', () => {
  assert.deepEqual(
    negotiateProtocolLimits(initializeParams.limits, {
      maxMessageBytes: 1024 * 1024,
      maxResultBytes: 256 * 1024,
      maxArtifactBytes: 100 * 1024 * 1024,
      eventJournalSize: 1000,
    }),
    {
      maxMessageBytes: 128 * 1024,
      maxResultBytes: 256 * 1024,
      maxArtifactBytes: 100 * 1024 * 1024,
      eventJournalSize: 1000,
    },
  );
  assert.throws(
    () => validateInitializeParams({
      ...initializeParams,
      limits: { maxMessageBytes: 1024 },
    }),
    error => error.code === 'invalid_argument' && error.context?.field === 'limits.maxMessageBytes',
  );
});

test('reports protocol incompatibility instead of guessing', () => {
  assert.throws(
    () => negotiateProtocol({ min: { major: 2, minor: 0 }, max: { major: 2, minor: 3 } }),
    error => error instanceof BrowserPilotError && error.code === 'protocol_incompatible',
  );
});

test('grants every supported capability by default and separates unsupported capabilities', () => {
  assert.deepEqual(
    negotiateCapabilities(initializeParams.requestedCapabilities, DEFAULT_CAPABILITIES),
    {
      granted: ['browser.control', 'developer.eval'],
      denied: [],
      unsupported: ['future.capability'],
    },
  );
});

test('parses requests, notifications, and responses', () => {
  assert.deepEqual(
    parseJsonRpcMessage('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'),
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  );
  assert.deepEqual(
    parseJsonRpcMessage('{"jsonrpc":"2.0","method":"events/ack","params":{"cursor":2}}'),
    { jsonrpc: '2.0', method: 'events/ack', params: { cursor: 2 } },
  );
  assert.deepEqual(
    parseJsonRpcMessage('{"jsonrpc":"2.0","id":"x","result":{"ok":true}}'),
    { jsonrpc: '2.0', id: 'x', result: { ok: true } },
  );
});

test('rejects malformed JSON-RPC and oversized messages', () => {
  assert.throws(
    () => parseJsonRpcMessage('{nope'),
    error => error instanceof BrowserPilotError && error.code === 'invalid_argument' && error.rpcCode === -32700,
  );
  assert.throws(
    () => parseJsonRpcMessage('{"jsonrpc":"2.0","id":1,"result":null,"error":{"code":1,"message":"x"}}'),
    error => error instanceof BrowserPilotError && error.code === 'invalid_argument',
  );
  assert.throws(
    () => parseJsonRpcMessage('{"jsonrpc":"2.0","method":"x"}', 4),
    error => error instanceof BrowserPilotError && error.code === 'result_too_large',
  );
  assert.throws(
    () => parseJsonRpcMessage('{"jsonrpc":"2.0","id":1,"method":"x","extra":true}'),
    error => error instanceof BrowserPilotError && error.rpcCode === -32600,
  );
});

test('canonical tool manifest is internally consistent and capability-filtered', () => {
  assert.doesNotThrow(() => assertToolManifest());
  assert.ok(TOOL_DEFINITIONS.length >= 20);
  assert.equal(new Set(TOOL_DEFINITIONS.map(tool => tool.name)).size, TOOL_DEFINITIONS.length);

  const manifest = getToolManifest(['artifact.read']);
  assert.deepEqual(manifest.tools.map(tool => tool.name), ['browser.capture', 'browser.pdf']);
  assert.equal(TOOL_DEFINITIONS.some(tool => tool.name.startsWith('browser.access.')), false);
});

test('canonical schemas propagate field-level sensitivity without changing values', () => {
  const tool = name => TOOL_DEFINITIONS.find(definition => definition.name === name);
  const sensitivity = schema => schema['x-browser-pilot-sensitivity'];

  const read = tool('browser.read');
  assert.deepEqual(sensitivity(read.inputSchema.properties.selector), ['browser_data']);
  assert.deepEqual(sensitivity(read.outputSchema.properties.text), ['browser_data']);

  const observe = tool('browser.observe');
  const element = observe.outputSchema.properties.elements.items;
  assert.deepEqual(sensitivity(element.properties.value), ['browser_data', 'credential']);
  assert.deepEqual(observe.sensitivity.output, ['browser_data', 'credential']);

  const auth = tool('browser.auth.set');
  assert.deepEqual(sensitivity(auth.inputSchema.properties.username), ['credential']);
  assert.deepEqual(sensitivity(auth.inputSchema.properties.password), ['credential']);

  const cookies = tool('browser.cookies.list');
  const cookie = cookies.outputSchema.properties.cookies.items;
  assert.deepEqual(sensitivity(cookie.properties.value), ['credential']);
  assert.deepEqual(sensitivity(cookie.properties.domain), ['browser_data']);

  const network = tool('browser.network.request');
  assert.deepEqual(sensitivity(network.outputSchema.properties.body), ['browser_data', 'credential']);
  assert.deepEqual(
    sensitivity(network.outputSchema.properties.request.properties.postData),
    ['browser_data', 'credential'],
  );
  assert.deepEqual(
    sensitivity(network.outputSchema.properties.request.properties.requestHeaders.items.properties.value),
    ['browser_data', 'credential'],
  );

  const upload = tool('browser.upload');
  for (const alternative of upload.inputSchema.oneOf) {
    assert.deepEqual(sensitivity(alternative.properties.artifactId), ['user_file']);
  }

  assert.deepEqual(
    validateToolArguments('browser.auth.set', { username: 'alice', password: 'secret' }),
    { username: 'alice', password: 'secret' },
  );
});

test('tool manifest rejects invalid or undeclared schema sensitivity', () => {
  const discover = TOOL_DEFINITIONS.find(tool => tool.name === 'browser.discover');
  assert.throws(
    () => assertToolManifest([{
      ...discover,
      inputSchema: {
        ...discover.inputSchema,
        'x-browser-pilot-sensitivity': ['private_unknown'],
      },
    }]),
    /unknown sensitivity private_unknown/,
  );

  const observe = TOOL_DEFINITIONS.find(tool => tool.name === 'browser.observe');
  assert.throws(
    () => assertToolManifest([{
      ...observe,
      sensitivity: { ...observe.sensitivity, output: ['browser_data'] },
    }]),
    /output schema marks credential without declaring it/,
  );
});

test('tool arguments are validated from the same schemas returned by the manifest', () => {
  assert.deepEqual(
    validateToolArguments('browser.capture', { fullPage: true, includeOriginal: true }),
    { fullPage: true, includeOriginal: true },
  );
  assert.deepEqual(
    validateToolArguments('browser.click', { target: { observationId: 'obs:123', ref: 3 } }),
    { target: { observationId: 'obs:123', ref: 3 } },
  );
  assert.throws(
    () => validateToolArguments('browser.click', { target: { ref: 3 }, surprise: true }),
    error => error instanceof BrowserPilotError && error.code === 'invalid_argument',
  );
  assert.throws(
    () => validateToolArguments('browser.frames.switch', {}),
    error => error instanceof BrowserPilotError && error.code === 'invalid_argument',
  );
  assert.deepEqual(validateToolArguments('browser.tabs.list', { scope: 'all' }), { scope: 'all' });
  assert.deepEqual(validateToolArguments('browser.tabs.release', {}), {});
  assert.throws(
    () => validateToolArguments('browser.tabs.list', { scope: 'all_authorized' }),
    error => error instanceof BrowserPilotError && error.code === 'invalid_argument',
  );
});

test('command envelopes validate caller IDs, idempotency keys, and deadlines', () => {
  const params = {
    name: 'browser.observe',
    arguments: { limit: 10 },
    workspaceId: 'workspace:123',
    leaseId: 'lease:123',
    targetId: 'target:123',
    commandId: 'command:123',
    idempotencyKey: 'observe:123',
    deadlineMs: 30_000,
  };
  assert.deepEqual(validateToolCallParams(params), params);
  assert.deepEqual(validateCommandAccessParams({
    workspaceId: 'workspace:123',
    commandId: 'command:123',
  }), {
    workspaceId: 'workspace:123',
    commandId: 'command:123',
  });
  assert.throws(
    () => validateToolCallParams({ ...params, deadlineMs: 0 }),
    error => error.code === 'invalid_argument' && error.context.field === 'deadlineMs',
  );
  assert.throws(
    () => validateToolCallParams({ ...params, commandId: 'not-a-command' }),
    error => error.code === 'invalid_argument' && error.context.field === 'commandId',
  );
});

test('event polling requires an explicit bounded Workspace cursor', () => {
  assert.deepEqual(validateEventsPollParams({
    workspaceId: 'workspace:123',
    cursor: 'cursor:42',
    limit: 250,
  }), {
    workspaceId: 'workspace:123',
    cursor: 'cursor:42',
    limit: 250,
  });
  assert.throws(
    () => validateEventsPollParams({ workspaceId: 'workspace:123' }),
    error => error.code === 'invalid_argument' && error.context.field === 'cursor',
  );
  assert.throws(
    () => validateEventsPollParams({
      workspaceId: 'workspace:123',
      cursor: 'cursor:01',
    }),
    error => error.code === 'invalid_argument' && error.context.field === 'cursor',
  );
});

test('tool result schemas require controlled-target context', () => {
  const result = {
    workspaceId: 'workspace:123',
    leaseId: 'lease:123',
    targetId: 'target:123',
    url: 'https://example.com',
    artifact: {
      id: 'artifact:123',
      workspaceId: 'workspace:123',
      kind: 'screenshot',
      mimeType: 'image/png',
      byteSize: 100,
      sensitivity: 'browser_data',
      createdAt: 1,
      expiresAt: 2,
      retained: false,
    },
  };
  assert.deepEqual(validateToolResult('browser.capture', result), result);
  assert.throws(
    () => validateToolResult('browser.capture', { artifact: result.artifact }),
    error => error instanceof BrowserPilotError && error.code === 'invalid_argument',
  );

  const tabsResult = {
    workspaceId: 'workspace:123',
    leaseId: 'lease:123',
    targets: [
      {
        targetId: 'target:user-1',
        title: 'Form',
        url: 'https://example.com/form',
        active: true,
        origin: 'user_tab',
        controlState: 'controlled',
      },
      {
        targetId: 'target:managed-1',
        title: 'Research',
        url: 'https://example.com/research',
        active: false,
        origin: 'managed',
        managedTabSetId: 'tabset:123',
        controlState: 'available',
      },
    ],
  };
  assert.deepEqual(validateToolResult('browser.tabs.list', tabsResult), tabsResult);
  assert.deepEqual(validateToolResult('browser.tabs.release', {
    workspaceId: 'workspace:123',
    leaseId: 'lease:123',
    targetId: 'target:user-1',
    url: 'https://example.com/form',
    released: true,
  }), {
    workspaceId: 'workspace:123',
    leaseId: 'lease:123',
    targetId: 'target:user-1',
    url: 'https://example.com/form',
    released: true,
  });
});

test('browser.click result schema accepts bounded typed click evidence', () => {
  const result = {
    workspaceId: 'workspace:123',
    leaseId: 'lease:123',
    targetId: 'target:123',
    url: 'https://example.com/complete',
    observationId: 'observation:123',
    title: 'Complete',
    elements: [],
    truncated: false,
    truncationReasons: [],
    evidence: {
      action: 'click',
      status: 'verified',
      kind: 'checkbox',
      effects: ['checked_changed', 'document_changed'],
      checked: true,
      focused: true,
    },
  };

  assert.deepEqual(validateToolResult('browser.click', result), result);
  assert.throws(
    () => validateToolResult('browser.click', {
      ...result,
      evidence: { ...result.evidence, effects: ['raw_cdp_effect'] },
    }),
    error => error instanceof BrowserPilotError && error.code === 'invalid_argument',
  );
});

test('Observation schemas accept only bounded discriminated Agent hints', () => {
  const base = {
    workspaceId: 'workspace:123',
    leaseId: 'lease:123',
    targetId: 'target:123',
    url: 'https://example.com/form',
    observationId: 'observation:123',
    title: 'Form',
    elements: [],
    truncated: false,
    truncationReasons: [],
  };
  const hints = [
    { code: 'autocomplete', source: 'observation', confidence: 'strong', recommendedAction: 'observe_then_select', refs: [1] },
    { code: 'modal_overlay', source: 'observation', confidence: 'possible', recommendedAction: 'resolve_overlay_first', blocking: false, refs: [2] },
    { code: 'filter_controls', source: 'observation', confidence: 'strong', recommendedAction: 'review_refinement_controls', refs: [3] },
    { code: 'access_blocked', source: 'network', confidence: 'strong', recommendedAction: 'avoid_same_navigation_retry', status: 403 },
    { code: 'authentication_surface', source: 'observation', confidence: 'strong', recommendedAction: 'inspect_authentication_state', state: 'entered' },
    { code: 'download', source: 'download', confidence: 'strong', recommendedAction: 'wait_for_download', state: 'started' },
    { code: 'download', source: 'download', confidence: 'strong', recommendedAction: 'inspect_download_artifact', state: 'completed', artifactId: 'artifact:123' },
    { code: 'download', source: 'download', confidence: 'strong', recommendedAction: 'inspect_download_failure', state: 'failed', reason: 'size_limit_exceeded' },
    { code: 'repeated_action', source: 'watchdog', confidence: 'strong', recommendedAction: 'change_strategy', streak: 3, reason: 'no_observable_effect' },
  ];

  assert.deepEqual(validateToolResult('browser.observe', { ...base, hints }), { ...base, hints });
  for (const invalid of [
    [{ ...hints[0], refs: Array.from({ length: 33 }, (_, index) => index + 1) }],
    [{ ...hints[3], status: 401 }],
    [{ ...hints[6], artifactId: undefined }],
    [{ ...hints[8], reason: 'x'.repeat(129) }],
    [{ ...hints[0], internalSelector: '#secret' }],
  ]) {
    assert.throws(
      () => validateToolResult('browser.observe', { ...base, hints: invalid }),
      error => error instanceof BrowserPilotError && error.code === 'invalid_argument',
    );
  }
});

test('action result schemas require discriminated input, press, and upload evidence', () => {
  const base = {
    workspaceId: 'workspace:123',
    leaseId: 'lease:123',
    targetId: 'target:123',
    url: 'https://example.com/form',
    observationId: 'observation:123',
    title: 'Form',
    elements: [],
    truncated: false,
    truncationReasons: [],
  };
  const typed = {
    ...base,
    evidence: {
      action: 'type',
      status: 'verified',
      kind: 'input',
      sensitive: false,
      beforeLength: 3,
      expectedLength: 7,
      afterLength: 7,
    },
  };
  const pressed = {
    ...base,
    evidence: {
      action: 'press',
      status: 'verified',
      kind: 'checkbox',
      effects: ['checked_changed'],
      sensitive: false,
    },
  };
  const uploaded = {
    ...base,
    evidence: {
      action: 'upload',
      status: 'verified',
      expectedFileCount: 1,
      fileCount: 1,
      nameMatched: true,
    },
  };

  assert.deepEqual(validateToolResult('browser.type', typed), typed);
  assert.deepEqual(validateToolResult('browser.press', pressed), pressed);
  assert.deepEqual(validateToolResult('browser.upload', uploaded), uploaded);
  assert.throws(
    () => validateToolResult('browser.type', {
      ...typed,
      evidence: { ...typed.evidence, action: undefined },
    }),
    error => error instanceof BrowserPilotError && error.code === 'invalid_argument',
  );
});
