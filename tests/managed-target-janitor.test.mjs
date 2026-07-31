import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { forceKillChild } from './helpers/platform.mjs';

const WORKER = fileURLToPath(new URL('../dist/managed-target-janitor.js', import.meta.url));

async function startCdpFixture() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const targets = new Map([
    ['user-tab', { targetId: 'user-tab', type: 'page', title: 'User', url: 'https://user.test/' }],
  ]);
  const closed = [];
  let nextTarget = 1;
  const broadcast = message => {
    const payload = JSON.stringify(message);
    for (const socket of server.clients) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  };
  server.on('connection', socket => {
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      const respond = result => socket.send(JSON.stringify({ id: message.id, result }));
      if (message.method === 'Target.setDiscoverTargets') {
        respond({});
        return;
      }
      if (message.method === 'Target.getTargets') {
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
      respond({});
    });
  });
  return {
    wsUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/test`,
    targets,
    closed,
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
    async close() {
      for (const socket of server.clients) socket.terminate();
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
  second.child.stdin.end();
  await waitForExit(second.child);

  assert.deepEqual(cdp.closed.sort(), ['managed-1', 'managed-popup']);
  assert.equal(cdp.targets.has('user-tab'), true);
});
