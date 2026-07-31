import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CDPError,
  CDP_HANDSHAKE_TIMEOUT_CODE,
  ManagedTargetJanitorClient,
} from '../dist/services.js';
import { startCdpFixture as startCdpServerFixture } from './helpers/cdp.mjs';
import { forceKillChild } from './helpers/platform.mjs';

const WORKER = fileURLToPath(new URL('../dist/managed-target-janitor.js', import.meta.url));

async function startCdpFixture() {
  let server;
  const targets = new Map([
    ['user-tab', { targetId: 'user-tab', type: 'page', title: 'User', url: 'https://user.test/' }],
  ]);
  const closed = [];
  const receivedMethods = [];
  let nextTarget = 1;
  let nextGetTargetsPopup;
  const broadcast = message => {
    const payload = JSON.stringify(message);
    for (const socket of server.clients) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  };
  const fixture = await startCdpServerFixture({
    onMessage: ({ message, socket }) => {
      receivedMethods.push(message.method);
      const respond = result => socket.send(JSON.stringify({ id: message.id, result }));
      if (message.method === 'Target.setDiscoverTargets') {
        respond({});
        return;
      }
      if (message.method === 'Target.getTargets') {
        if (nextGetTargetsPopup) {
          const targetInfo = nextGetTargetsPopup;
          nextGetTargetsPopup = undefined;
          targets.set(targetInfo.targetId, targetInfo);
          broadcast({ method: 'Target.targetCreated', params: { targetInfo } });
        }
        respond({ targetInfos: [...targets.values()] });
        return;
      }
      if (message.method === 'Target.createTarget') {
        const targetId = `managed-${nextTarget++}`;
        const targetInfo = {
          targetId,
          type: 'page',
          title: '',
          url: message.params.url,
        };
        targets.set(targetId, targetInfo);
        respond({ targetId });
        broadcast({ method: 'Target.targetCreated', params: { targetInfo } });
        return;
      }
      if (message.method === 'Target.closeTarget') {
        const targetId = message.params.targetId;
        closed.push(targetId);
        targets.delete(targetId);
        respond({ success: true });
        broadcast({ method: 'Target.targetDestroyed', params: { targetId } });
        return;
      }
      if (message.method === 'Runtime.structuredFailure') {
        socket.send(JSON.stringify({
          id: message.id,
          error: {
            code: -32602,
            message: 'Invalid execution context',
            data: { contextId: 77 },
          },
        }));
        return;
      }
      respond({});
    },
  });
  server = fixture.server;
  return {
    ...fixture,
    targets,
    closed,
    receivedMethods,
    addTarget(targetId, openerId) {
      targets.set(targetId, {
        targetId,
        ...(openerId ? { openerId } : {}),
        type: 'page',
        title: 'Adopted target',
        url: 'https://adopt.test/',
      });
    },
    popup(targetId, openerId) {
      const targetInfo = {
        targetId,
        openerId,
        type: 'page',
        title: 'Popup',
        url: 'https://popup.test/',
      };
      targets.set(targetId, targetInfo);
      broadcast({ method: 'Target.targetCreated', params: { targetInfo } });
    },
    popupDuringNextGetTargets(targetId, openerId) {
      nextGetTargetsPopup = {
        targetId,
        openerId,
        type: 'page',
        title: 'Racing popup',
        url: 'https://popup.test/race',
      };
    },
  };
}

async function startHangingHandshakeFixture() {
  const sockets = new Set();
  const server = createNetServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('data', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
  return {
    wsUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/hanging`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function startWorker(wsUrl) {
  const child = spawn(process.execPath, [WORKER, wsUrl], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  const waiters = [];
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const message = JSON.parse(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      messages.push(message);
      for (const waiter of [...waiters]) waiter();
      newline = pending.indexOf('\n');
    }
  });
  const waitFor = (predicate, timeoutMs = 5_000) => new Promise((resolve, reject) => {
    const inspect = () => {
      const index = messages.findIndex(predicate);
      if (index < 0) return;
      clearTimeout(timer);
      const [message] = messages.splice(index, 1);
      waiters.splice(waiters.indexOf(inspect), 1);
      resolve(message);
    };
    const timer = setTimeout(() => {
      waiters.splice(waiters.indexOf(inspect), 1);
      reject(new Error('Timed out waiting for janitor output'));
    }, timeoutMs);
    waiters.push(inspect);
    inspect();
  });
  return { child, waitFor };
}

function waitForExit(child, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('Janitor did not exit')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test('janitor closes only owned targets and popup descendants after parent EOF', async t => {
  const cdp = await startCdpFixture();
  const { child, waitFor } = startWorker(cdp.wsUrl);
  t.after(async () => {
    forceKillChild(child);
    await cdp.close();
  });

  await waitFor(message => message.event === 'ready');
  child.stdin.write(`${JSON.stringify({
    id: 1,
    method: 'create',
    params: { url: 'about:blank', newWindow: true },
  })}\n`);
  const created = await waitFor(message => message.id === 1);
  assert.equal(created.result.targetId, 'managed-1');

  cdp.popup('managed-popup', 'managed-1');
  cdp.popup('user-popup', 'user-tab');
  await waitFor(message => message.event === 'owned' && message.targetId === 'managed-popup');
  child.stdout.destroy();
  child.stdin.end();
  await waitForExit(child);

  assert.deepEqual(cdp.closed.sort(), ['managed-1', 'managed-popup']);
  assert.deepEqual([...cdp.targets.keys()].sort(), ['user-popup', 'user-tab']);
});

test('a replacement janitor adopts live in-memory target IDs without disk state', async t => {
  const cdp = await startCdpFixture();
  const first = startWorker(cdp.wsUrl);
  let second;
  t.after(async () => {
    forceKillChild(first.child);
    if (second) forceKillChild(second.child);
    await cdp.close();
  });

  await first.waitFor(message => message.event === 'ready');
  first.child.stdin.write(`${JSON.stringify({
    id: 1,
    method: 'create',
    params: { url: 'about:blank', newWindow: true },
  })}\n`);
  const created = await first.waitFor(message => message.id === 1);
  cdp.popup('managed-popup', created.result.targetId);
  await first.waitFor(message => message.event === 'owned' && message.targetId === 'managed-popup');
  forceKillChild(first.child);
  await waitForExit(first.child);

  second = startWorker(cdp.wsUrl);
  await second.waitFor(message => message.event === 'ready');
  second.child.stdin.write(`${JSON.stringify({
    id: 2,
    method: 'adopt',
    params: { targetIds: [created.result.targetId] },
  })}\n`);
  const adopted = await second.waitFor(message => message.id === 2);
  assert.equal(adopted.result.adopted, 2);
  assert.deepEqual(adopted.result.owned, { [created.result.targetId]: true });
  second.child.stdin.end();
  await waitForExit(second.child);

  assert.deepEqual(cdp.closed.sort(), ['managed-1', 'managed-popup']);
  assert.equal(cdp.targets.has('user-tab'), true);
});

test('adoption reports requested ownership across auto-track races and missing targets', async t => {
  const cdp = await startCdpFixture();
  const worker = startWorker(cdp.wsUrl);
  t.after(async () => {
    forceKillChild(worker.child);
    await cdp.close();
  });

  await worker.waitFor(message => message.event === 'ready');
  worker.child.stdin.write(`${JSON.stringify({
    id: 1,
    method: 'create',
    params: { url: 'about:blank', newWindow: true },
  })}\n`);
  const created = await worker.waitFor(message => message.id === 1);

  cdp.popupDuringNextGetTargets('managed-racing-popup', created.result.targetId);
  worker.child.stdin.write(`${JSON.stringify({
    id: 2,
    method: 'adopt',
    params: { targetIds: ['managed-racing-popup'] },
  })}\n`);
  const raced = await worker.waitFor(message => message.id === 2);
  assert.equal(raced.result.adopted, 0);
  assert.deepEqual(raced.result.owned, { 'managed-racing-popup': true });

  worker.child.stdin.write(`${JSON.stringify({
    id: 3,
    method: 'adopt',
    params: { targetIds: ['missing-target'] },
  })}\n`);
  const missing = await worker.waitFor(message => message.id === 3);
  assert.equal(missing.result.adopted, 0);
  assert.deepEqual(missing.result.owned, { 'missing-target': false });

  worker.child.stdin.end();
  await waitForExit(worker.child);
  assert.deepEqual(cdp.closed.sort(), ['managed-1', 'managed-racing-popup']);
});

test('janitor client validates requested ownership instead of the adoption count', async t => {
  const cdp = await startCdpFixture();
  const client = new ManagedTargetJanitorClient({ workerPath: WORKER });
  t.after(async () => {
    await client.close();
    await cdp.close();
  });

  cdp.addTarget('adopt-root');
  cdp.addTarget('adopt-descendant', 'adopt-root');
  await client.connect(cdp.wsUrl);
  await client.adoptTarget('adopt-root');

  cdp.popupDuringNextGetTargets('adopt-racing-popup', 'adopt-root');
  await client.adoptTarget('adopt-racing-popup');
  await assert.rejects(
    client.adoptTarget('missing-target'),
    error => error?.code === 'internal_error' && /could not adopt/.test(error.message),
  );

  await client.close();
  assert.deepEqual(
    cdp.closed.sort(),
    ['adopt-descendant', 'adopt-racing-popup', 'adopt-root'],
  );
  assert.equal(cdp.targets.has('user-tab'), true);
});

test('janitor client round-trips CDP error code and data', async t => {
  const cdp = await startCdpFixture();
  const client = new ManagedTargetJanitorClient({ workerPath: WORKER });
  t.after(async () => {
    await client.close();
    await cdp.close();
  });
  await client.connect(cdp.wsUrl);

  await assert.rejects(
    client.send('Runtime.structuredFailure'),
    error => error instanceof CDPError && error.code === -32602 &&
      error.message === 'Invalid execution context' && error.data?.contextId === 77,
  );
});

test('janitor client preserves the CDP handshake timeout code during startup', async t => {
  const cdp = await startHangingHandshakeFixture();
  const client = new ManagedTargetJanitorClient({
    workerPath: WORKER,
    cdpOptions: {
      handshakeTimeoutMs: 30,
      pingIntervalMs: 100,
      pongTimeoutMs: 25,
    },
  });
  t.after(async () => {
    await client.close();
    await cdp.close();
  });

  await assert.rejects(
    client.connect(cdp.wsUrl),
    error => error instanceof CDPError && error.code === CDP_HANDSHAKE_TIMEOUT_CODE,
  );
});

test('janitor discards an oversized stdin frame and serves the next request', async t => {
  const cdp = await startCdpFixture();
  const worker = startWorker(cdp.wsUrl);
  t.after(async () => {
    forceKillChild(worker.child);
    await cdp.close();
  });

  await worker.waitFor(message => message.event === 'ready');
  worker.child.stdin.write('x'.repeat(70 * 1024));
  const protocolError = await worker.waitFor(message => message.event === 'protocol_error');
  assert.equal(protocolError.error.code, 'janitor_protocol_error');
  worker.child.stdin.write(`\n${JSON.stringify({
    id: 1,
    method: 'cdp.send',
    params: { method: 'Runtime.evaluate', params: { expression: '1' } },
  })}\n`);
  const response = await worker.waitFor(message => message.id === 1);
  assert.deepEqual(response.result, {});
  worker.child.stdin.end();
  await waitForExit(worker.child);
});

test('janitor client rejects oversized requests locally and remains connected', async t => {
  const cdp = await startCdpFixture();
  const client = new ManagedTargetJanitorClient({ workerPath: WORKER });
  t.after(async () => {
    await client.close();
    await cdp.close();
  });
  await client.connect(cdp.wsUrl);
  const before = cdp.receivedMethods.filter(method => method === 'Runtime.evaluate').length;

  await assert.rejects(
    client.send('Runtime.evaluate', { expression: 'x'.repeat(70 * 1024) }),
    error => error?.code === 'result_too_large',
  );
  assert.equal(
    cdp.receivedMethods.filter(method => method === 'Runtime.evaluate').length,
    before,
  );
  assert.deepEqual(await client.send('Runtime.evaluate', { expression: '1' }), {});
});

test('janitor no-cleanup shutdown preserves owned targets', async t => {
  const cdp = await startCdpFixture();
  const client = new ManagedTargetJanitorClient({ workerPath: WORKER });
  t.after(async () => {
    await client.close();
    await cdp.close();
  });
  await client.connect(cdp.wsUrl);
  const created = await client.createTarget({ url: 'about:blank', newWindow: true });

  await client.browserDisconnected();

  assert.equal(cdp.targets.has(created.targetId), true);
  assert.equal(cdp.closed.includes(created.targetId), false);
});

test('capacity-full adoption fails without closing the requested target', async t => {
  const cdp = await startCdpFixture();
  const targetIds = Array.from({ length: 4096 }, (_, index) => `t${index.toString(36)}`);
  for (const targetId of targetIds) cdp.addTarget(targetId);
  const worker = startWorker(cdp.wsUrl);
  t.after(async () => {
    forceKillChild(worker.child);
    await cdp.close();
  });

  await worker.waitFor(message => message.event === 'ready');
  const adoptFrame = `${JSON.stringify({
    id: 1,
    method: 'adopt',
    params: { targetIds },
  })}\n`;
  assert.ok(Buffer.byteLength(adoptFrame) <= 64 * 1024);
  worker.child.stdin.write(adoptFrame);
  const filled = await worker.waitFor(message => message.id === 1, 15_000);
  assert.equal(filled.result.adopted, targetIds.length);

  cdp.addTarget('overflow-target');
  worker.child.stdin.write(`${JSON.stringify({
    id: 2,
    method: 'adopt',
    params: { targetIds: ['overflow-target'] },
  })}\n`);
  const overflow = await worker.waitFor(message => message.id === 2);
  assert.equal(overflow.error.code, 'janitor_error');
  assert.match(overflow.error.message, /capacity reached/);
  assert.equal(cdp.targets.has('overflow-target'), true);
  assert.equal(cdp.closed.includes('overflow-target'), false);

  worker.child.stdin.write(`${JSON.stringify({
    id: 3,
    method: 'shutdown',
    params: { cleanup: false },
  })}\n`);
  await worker.waitFor(message => message.id === 3);
  await waitForExit(worker.child);
});
