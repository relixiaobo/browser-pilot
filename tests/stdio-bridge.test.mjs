import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runStdioBridge } from '../dist/bridge.js';
import { MemoryBrokerRuntime } from '../dist/services.js';

function createRuntime() {
  return new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:stdio-test',
    browsers: [{
      candidate: { id: 'browser:test', product: 'Chrome', state: 'ready' },
      instance: {
        id: 'browser-instance:test',
        product: 'Chrome',
        profilePath: '/test',
        processIdentity: 'process:test',
        connectionGeneration: 1,
        state: 'connected',
      },
    }],
  });
}

function initializeMessage(id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      client: {
        id: 'com.example.agent',
        name: 'Example Agent',
        version: '1.0.0',
        instanceId: 'stdio:test',
      },
      protocol: { min: { major: 1, minor: 0 }, max: { major: 1, minor: 0 } },
      requestedCapabilities: ['workspace.manage'],
      launchMode: 'embedded',
    },
  };
}

async function execute(chunks, options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let stdout = '';
  output.on('data', chunk => { stdout += chunk.toString('utf8'); });
  const runtime = options.runtime ?? createRuntime();
  let disconnects = 0;
  const backend = options.backend ?? {
    call: (bridgeSessionId, method, params) => runtime.call(bridgeSessionId, method, params),
    disconnect(bridgeSessionId) {
      disconnects += 1;
      runtime.disconnect(bridgeSessionId);
    },
  };
  const running = runStdioBridge({
    input,
    output,
    backend,
    bridgeSessionId: 'bridge:stdio',
    ...options.bridgeOptions,
  });
  for (const chunk of chunks) input.write(chunk);
  input.end();
  const result = await running;
  return {
    result,
    messages: stdout.trim() ? stdout.trim().split('\n').map(line => JSON.parse(line)) : [],
    stdout,
    runtime,
    disconnects,
  };
}

test('stdio bridge processes strict NDJSON sequentially and emits no notification response', async () => {
  const input = [
    `${JSON.stringify(initializeMessage())}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {} })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'shutdown', params: {} })}\n`,
  ];
  const execution = await execute(input);

  assert.deepEqual(execution.result, { exitCode: 0, reason: 'shutdown' });
  assert.deepEqual(execution.messages.map(message => message.id), [1, 3]);
  assert.equal(execution.messages[0].result.serviceVersion, '1.0.0');
  assert.deepEqual(execution.messages[1].result, { ok: true });
  assert.equal(execution.stdout.endsWith('\n'), true);
  assert.equal(execution.disconnects, 1);
  assert.equal(execution.runtime.stats().connections, 0);
});

test('stdio bridge returns structured application errors and continues until EOF', async () => {
  const execution = await execute([
    `${JSON.stringify({ jsonrpc: '2.0', id: 'before', method: 'tools/list', params: {} })}\n`,
    `${JSON.stringify(initializeMessage('init'))}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 'unknown', method: 'unknown/method', params: {} })}\n`,
  ]);

  assert.deepEqual(execution.result, { exitCode: 0, reason: 'eof' });
  assert.equal(execution.messages[0].error.data.code, 'not_initialized');
  assert.equal(execution.messages[1].id, 'init');
  assert.equal(execution.messages[2].error.code, -32601);
  assert.equal(execution.messages[2].error.data.code, 'invalid_argument');
});

test('stdio bridge terminates after malformed JSON and reports id null', async () => {
  const execution = await execute(['{"jsonrpc":"2.0",nope}\n']);

  assert.deepEqual(execution.result, { exitCode: 1, reason: 'protocol_error' });
  assert.equal(execution.messages.length, 1);
  assert.equal(execution.messages[0].id, null);
  assert.equal(execution.messages[0].error.code, -32700);
  assert.equal(execution.messages[0].error.data.code, 'invalid_argument');
});

test('stdio bridge rejects invalid UTF-8 and oversized lines without unbounded buffering', async () => {
  const invalidUtf8 = await execute([Buffer.from([0xc3, 0x28, 0x0a])]);
  assert.equal(invalidUtf8.result.exitCode, 1);
  assert.equal(invalidUtf8.messages[0].error.code, -32700);

  const oversized = await execute([Buffer.from('x'.repeat(65))], {
    bridgeOptions: { maxMessageBytes: 64 },
  });
  assert.equal(oversized.result.exitCode, 1);
  assert.equal(oversized.messages[0].error.data.code, 'result_too_large');
});

test('stdio bridge rejects response envelopes and unknown JSON-RPC envelope fields', async () => {
  const response = await execute([
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`,
  ]);
  assert.equal(response.result.reason, 'protocol_error');
  assert.equal(response.messages[0].error.code, -32600);

  const unknownField = await execute([
    `${JSON.stringify({ ...initializeMessage(), extra: true })}\n`,
  ]);
  assert.equal(unknownField.result.reason, 'protocol_error');
  assert.equal(unknownField.messages[0].error.code, -32600);
});

test('stdio bridge replaces an oversized result with a bounded structured error', async () => {
  const execution = await execute([
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'large', params: {} })}\n`,
  ], {
    backend: {
      async call() { return { text: 'a'.repeat(10_000) }; },
      async disconnect() {},
    },
    bridgeOptions: { maxResultBytes: 1024 },
  });

  assert.equal(execution.messages[0].error.data.code, 'result_too_large');
  assert.equal(execution.messages[0].id, 1);
});

test('command control bypasses a pending tool call on the same stdio bridge', async () => {
  let releaseTool;
  const order = [];
  const execution = await execute([
    `${JSON.stringify(initializeMessage('init'))}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 'tool', method: 'tools/call', params: {} })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 'cancel', method: 'commands/cancel', params: {} })}\n`,
  ], {
    backend: {
      async call(_bridgeSessionId, method) {
        order.push(`${method}:start`);
        if (method === 'initialize') return { initialized: true };
        if (method === 'tools/call') {
          await new Promise(resolve => { releaseTool = resolve; });
          order.push('tools/call:end');
          return { command: { status: 'cancelled' } };
        }
        if (method === 'commands/cancel') {
          releaseTool();
          return { command: { status: 'cancelled' } };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
      async disconnect() {},
    },
  });

  assert.deepEqual(order, [
    'initialize:start',
    'tools/call:start',
    'commands/cancel:start',
    'tools/call:end',
  ]);
  assert.deepEqual(execution.messages.map(message => message.id), ['init', 'cancel', 'tool']);
});
