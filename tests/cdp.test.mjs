import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import {
  CDPClient,
  CDPError,
  CDP_HANDSHAKE_TIMEOUT_CODE,
} from '../dist/services.js';

async function listenWebSocket(options = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, ...options });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return {
    server,
    url: `ws://127.0.0.1:${server.address().port}/devtools/browser/test`,
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function listenWithoutHandshake() {
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
    url: `ws://127.0.0.1:${server.address().port}/devtools/browser/hanging`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

test('CDPClient rejects a stalled WebSocket handshake with a distinct bounded-time error', async t => {
  const fixture = await listenWithoutHandshake();
  const client = new CDPClient({
    handshakeTimeoutMs: 25,
    pingIntervalMs: 100,
    pongTimeoutMs: 25,
  });
  t.after(async () => {
    await client.close();
    await fixture.close();
  });
  const startedAt = Date.now();

  await assert.rejects(
    client.connect(fixture.url),
    error => error instanceof CDPError && error.code === CDP_HANDSHAKE_TIMEOUT_CODE,
  );
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(client.connectionState, 'disconnected');
});

test('CDPClient disconnects pending work after two unanswered keepalive pings', async t => {
  const fixture = await listenWebSocket({ autoPong: false });
  const client = new CDPClient({
    handshakeTimeoutMs: 500,
    pingIntervalMs: 10,
    pongTimeoutMs: 10,
  });
  t.after(async () => {
    await client.close();
    await fixture.close();
  });
  fixture.server.on('connection', socket => socket.on('message', () => {}));
  await client.connect(fixture.url);
  const startedAt = Date.now();

  await assert.rejects(
    client.send('Runtime.neverResponds'),
    error => error.code === 'browser_disconnected' && error.retryable === true,
  );
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(client.connectionState, 'disconnected');
});

test('CDPClient preserves protocol error code and data', async t => {
  const fixture = await listenWebSocket();
  const client = new CDPClient({
    handshakeTimeoutMs: 500,
    pingIntervalMs: 1_000,
    pongTimeoutMs: 100,
  });
  t.after(async () => {
    await client.close();
    await fixture.close();
  });
  fixture.server.on('connection', socket => {
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      socket.send(JSON.stringify({
        id: message.id,
        error: {
          code: -32000,
          message: 'No node with given id found',
          data: { nodeId: 42 },
        },
      }));
    });
  });
  await client.connect(fixture.url);

  await assert.rejects(
    client.send('DOM.resolveNode', { backendNodeId: 42 }),
    error => error instanceof CDPError && error.code === -32000 &&
      error.message === 'No node with given id found' && error.data?.nodeId === 42,
  );
});
