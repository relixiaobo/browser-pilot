import WebSocket from 'ws';
import type { Transport } from './transport.js';

export class CDPClient implements Transport {
  private ws!: WebSocket;
  private nextId = 1;
  private callbacks = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private eventHandlers = new Map<string, Array<(params: any) => void>>();

  connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      const onError = (err: Error) => {
        this.ws.removeListener('open', onOpen);
        reject(err);
      };
      const onOpen = () => {
        this.ws.removeListener('error', onError);
        resolve();
      };

      this.ws.once('open', onOpen);
      this.ws.once('error', onError);

      this.ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());

        if ('id' in msg) {
          const cb = this.callbacks.get(msg.id);
          if (cb) {
            this.callbacks.delete(msg.id);
            msg.error
              ? cb.reject(new Error(msg.error.message))
              : cb.resolve(msg.result ?? {});
          }
        } else if (msg.method) {
          // Fire handlers with session-scoped key
          if (msg.sessionId) {
            for (const h of this.eventHandlers.get(`${msg.sessionId}:${msg.method}`) ?? []) {
              h(msg.params, msg.sessionId);
            }
          }
          // Fire handlers without session scope (catch-all)
          for (const h of this.eventHandlers.get(msg.method) ?? []) {
            h(msg.params, msg.sessionId);
          }
        }
      });

      this.ws.on('close', () => {
        for (const cb of this.callbacks.values()) {
          cb.reject(new Error('Connection closed'));
        }
        this.callbacks.clear();
      });
    });
  }

  send(method: string, params?: Record<string, any>, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const msg: any = { id, method };
      if (params && Object.keys(params).length > 0) msg.params = params;
      if (sessionId) msg.sessionId = sessionId;

      const timeout = setTimeout(() => {
        this.callbacks.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30_000);

      this.callbacks.set(id, {
        resolve: (v: any) => { clearTimeout(timeout); resolve(v); },
        reject: (e: Error) => { clearTimeout(timeout); reject(e); },
      });

      this.ws.send(JSON.stringify(msg));
    });
  }

  on(method: string, handler: (params: any) => void): void {
    const handlers = this.eventHandlers.get(method) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
  }

  close(): void {
    if (this.ws) this.ws.close();
  }
}
