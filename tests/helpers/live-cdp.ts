import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';

const CDP_TIMEOUT_MS = 10_000;

export interface LiveCdpConnection {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>;
  close(): Promise<void>;
}

export async function connectLiveCdp(userDataRoot: string): Promise<LiveCdpConnection> {
  const [port, path] = (await readFile(join(userDataRoot, 'DevToolsActivePort'), 'utf8'))
    .trim()
    .split(/\r?\n/);
  if (!/^\d+$/.test(port) || !path?.startsWith('/')) {
    throw new Error('Isolated Chrome returned an invalid DevTools endpoint');
  }

  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.terminate();
      reject(new Error('CDP WebSocket handshake timed out'));
    }, CDP_TIMEOUT_MS);
    socket.once('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });

  let nextId = 1;
  const pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();
  socket.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    if (!Number.isSafeInteger(message.id)) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message ?? 'CDP request failed'));
    else waiter.resolve(message.result);
  });
  socket.on('close', () => {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(new Error('CDP connection closed'));
    }
  });

  return {
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, CDP_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }));
      });
    },
    close() {
      if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          socket.terminate();
          finish();
        }, CDP_TIMEOUT_MS);
        socket.once('close', finish);
        socket.close();
      });
    },
  };
}
