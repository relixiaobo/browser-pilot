import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserPilotError } from '../dist/protocol.js';
import { MemoryCommandRuntime } from '../dist/services.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function input(overrides = {}) {
  return {
    principalId: 'principal:test',
    connectionId: 'connection:test',
    workspaceId: 'workspace:test',
    leaseId: 'lease:test',
    targetId: 'target:test',
    method: 'browser.click',
    mutating: true,
    cancellation: 'best_effort',
    actorKey: 'browser:test\u0000target:test',
    request: { name: 'browser.click', arguments: { ref: 1 } },
    ...overrides,
  };
}

test('Command Runtime serializes one target while allowing another target to run', async () => {
  const runtime = new MemoryCommandRuntime();
  const firstGate = deferred();
  const order = [];
  const first = runtime.run(input({ commandId: 'command:first' }), async () => {
    order.push('first:start');
    await firstGate.promise;
    order.push('first:end');
    return { value: 1 };
  });
  const second = runtime.run(input({ commandId: 'command:second' }), async () => {
    order.push('second');
    return { value: 2 };
  });
  const parallel = runtime.run(input({
    commandId: 'command:parallel',
    targetId: 'target:other',
    actorKey: 'browser:test\u0000target:other',
  }), async () => {
    order.push('parallel');
    return { value: 3 };
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['first:start', 'parallel']);
  firstGate.resolve();
  const [firstResult, secondResult, parallelResult] = await Promise.all([first, second, parallel]);
  assert.deepEqual(order, ['first:start', 'parallel', 'first:end', 'second']);
  assert.equal(firstResult.result.value, 1);
  assert.equal(secondResult.result.value, 2);
  assert.equal(parallelResult.result.value, 3);
});

test('idempotent duplicates never redispatch and completed results are replayed', async () => {
  const runtime = new MemoryCommandRuntime();
  const gate = deferred();
  let executions = 0;
  const request = input({ commandId: 'command:dedupe', idempotencyKey: 'call-123' });
  const first = runtime.run(request, async ({ markDispatched }) => {
    executions += 1;
    markDispatched();
    await gate.promise;
    return { value: 42 };
  });
  await new Promise(resolve => setImmediate(resolve));

  const inFlight = await runtime.run(input({ idempotencyKey: 'call-123' }), async () => {
    executions += 1;
    return { value: -1 };
  });
  assert.equal(inFlight.command.id, 'command:dedupe');
  assert.equal(inFlight.command.status, 'dispatched');
  assert.equal('result' in inFlight, false);
  assert.equal(executions, 1);

  gate.resolve();
  assert.equal((await first).result.value, 42);
  const replayed = await runtime.run(input({ idempotencyKey: 'call-123' }), async () => {
    executions += 1;
    return { value: -2 };
  });
  assert.equal(replayed.command.status, 'completed');
  assert.equal(replayed.result.value, 42);
  assert.equal(executions, 1);

  assert.throws(
    () => runtime.run(input({
      idempotencyKey: 'call-123',
      request: { name: 'browser.click', arguments: { ref: 2 } },
    }), async () => ({ value: 2 })),
    error => error.code === 'invalid_argument',
  );

  const explicitRuntime = new MemoryCommandRuntime();
  let explicitExecutions = 0;
  const explicit = input({ commandId: 'command:caller-owned' });
  await explicitRuntime.run(explicit, async () => {
    explicitExecutions += 1;
    return { ok: true };
  });
  const explicitReplay = await explicitRuntime.run(explicit, async () => {
    explicitExecutions += 1;
    return { ok: false };
  });
  assert.equal(explicitReplay.result.ok, true);
  assert.equal(explicitExecutions, 1);
});

test('cancellation before dispatch prevents queued execution', async () => {
  const runtime = new MemoryCommandRuntime();
  const gate = deferred();
  const first = runtime.run(input({ commandId: 'command:blocker' }), async () => {
    await gate.promise;
    return { ok: true };
  });
  let executed = false;
  const queued = runtime.run(input({ commandId: 'command:cancel-me' }), async () => {
    executed = true;
    return { ok: true };
  });
  const rejected = assert.rejects(queued, error => error.code === 'command_cancelled');
  await new Promise(resolve => setImmediate(resolve));

  const cancelled = runtime.cancel({
    principalId: 'principal:test',
    workspaceId: 'workspace:test',
    commandId: 'command:cancel-me',
  });
  assert.equal(cancelled.command.status, 'cancelled');
  await rejected;
  gate.resolve();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(executed, false);
});

test('deadline before dispatch expires, while deadline after mutating dispatch is unknown', async () => {
  let now = 1_000;
  const runtime = new MemoryCommandRuntime({ now: () => now, defaultDeadlineMs: 100, maxDeadlineMs: 1_000 });
  const blockerGate = deferred();
  const blocker = runtime.run(input({ commandId: 'command:deadline-blocker', deadlineMs: 1_000 }), async ({ markDispatched }) => {
    markDispatched();
    await blockerGate.promise;
    return { ok: true };
  });
  const queued = runtime.run(input({ commandId: 'command:queued-expiry', deadlineMs: 10 }), async () => ({ ok: true }));
  const queuedRejected = assert.rejects(queued, error => error.code === 'command_expired');
  await new Promise(resolve => setImmediate(resolve));
  now = 1_010;
  runtime.sweep();
  await queuedRejected;

  const dispatchedGate = deferred();
  const dispatched = runtime.run(input({
    commandId: 'command:dispatched-expiry',
    actorKey: 'browser:test\u0000target:other',
    deadlineMs: 10,
  }), async ({ markDispatched }) => {
    markDispatched();
    await dispatchedGate.promise;
    return { ok: true };
  });
  const dispatchedRejected = assert.rejects(dispatched, error => error.code === 'unknown_outcome');
  await new Promise(resolve => setImmediate(resolve));
  now = 1_020;
  runtime.sweep();
  await dispatchedRejected;
  assert.equal(runtime.get({
    principalId: 'principal:test',
    workspaceId: 'workspace:test',
    commandId: 'command:dispatched-expiry',
  }).command.status, 'unknown_outcome');

  dispatchedGate.resolve();
  blockerGate.resolve();
  await blocker;
});

test('known tool errors complete deterministically and transport uncertainty does not replay', async () => {
  const runtime = new MemoryCommandRuntime();
  const known = runtime.run(input({ commandId: 'command:known-error' }), async () => {
    throw new BrowserPilotError('stale_ref', 'stale');
  });
  await assert.rejects(known, error => error.code === 'stale_ref' && error.context.commandId === 'command:known-error');
  assert.equal(runtime.get({
    principalId: 'principal:test',
    workspaceId: 'workspace:test',
    commandId: 'command:known-error',
  }).command.status, 'completed');

  let executions = 0;
  const uncertainInput = input({ commandId: 'command:uncertain', idempotencyKey: 'uncertain-call' });
  await assert.rejects(
    runtime.run(uncertainInput, async ({ markDispatched }) => {
      executions += 1;
      markDispatched();
      throw new BrowserPilotError('browser_disconnected', 'lost');
    }),
    error => error.code === 'unknown_outcome',
  );
  const replay = await runtime.run(input({ idempotencyKey: 'uncertain-call' }), async () => {
    executions += 1;
    return { ok: true };
  });
  assert.equal(replay.command.status, 'unknown_outcome');
  assert.equal(replay.error.data.code, 'unknown_outcome');
  assert.equal(executions, 1);
});

test('Command Runtime bounds terminal records and enforces ownership', async () => {
  const runtime = new MemoryCommandRuntime({ maxCommands: 1 });
  await runtime.run(input({ commandId: 'command:first' }), async () => ({ ok: true }));
  await runtime.run(input({ commandId: 'command:second' }), async () => ({ ok: true }));
  assert.equal(runtime.size(), 1);
  await assert.rejects(
    async () => runtime.get({
      principalId: 'principal:other',
      workspaceId: 'workspace:test',
      commandId: 'command:second',
    }),
    error => error.code === 'invalid_argument',
  );
});
