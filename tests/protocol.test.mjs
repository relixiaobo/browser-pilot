import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BrowserPilotError,
  DEFAULT_CAPABILITIES,
  TOOL_DEFINITIONS,
  assertToolManifest,
  getToolManifest,
  negotiateCapabilities,
  negotiateProtocol,
  parseJsonRpcMessage,
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
  assert.throws(
    () => validateToolArguments('browser.tabs.list', { scope: 'all_authorized' }),
    error => error instanceof BrowserPilotError && error.code === 'invalid_argument',
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
});
