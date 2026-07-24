import WebSocket from 'ws';
import { BrowserPilotError } from './protocol/errors.js';
import type {
  Transport,
  TransportConnectionEvent,
  TransportConnectionState,
} from './transport.js';

export class CDPClient implements Transport {
  private ws?: WebSocket;
  private nextId = 1;
  private callbacks = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private eventHandlers = new Map<string, Array<(params: any, sessionId?: string) => void>>();
  private connectionHandlers = new Set<(event: TransportConnectionEvent) => void>();
  private state: TransportConnectionState = 'disconnected';
  private closeRequested = false;

  get connectionState(): TransportConnectionState {
    return this.state;
  }

  connect(wsUrl: string): Promise<void> {
    if (this.state === 'connecting' || this.state === 'connected') {
      return Promise.reject(new Error('CDP transport is already connected or connecting'));
    }
    this.closeRequested = false;
    this.transition('connecting');
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      this.ws = socket;
      let settled = false;

      const rejectConnect = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const resolveConnect = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      // Keep a persistent handler so late WebSocket errors cannot crash Node.
      socket.on('error', (error: Error) => {
        if (socket !== this.ws) return;
        const stable = this.disconnectedError(error);
        this.failPending(stable);
        rejectConnect(stable);
        this.transition(this.closeRequested ? 'closed' : 'disconnected', stable);
        if (!this.closeRequested && socket.readyState !== WebSocket.CLOSED) socket.terminate();
      });

      const onOpen = () => {
        if (socket !== this.ws) return;
        this.transition('connected');
        resolveConnect();
      };

      socket.once('open', onOpen);

      socket.on('message', (data: Buffer) => {
        if (socket !== this.ws) return;
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

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

      socket.on('close', () => {
        if (socket !== this.ws) return;
        this.ws = undefined;
        const error = this.disconnectedError();
        this.failPending(error);
        rejectConnect(error);
        this.transition(this.closeRequested ? 'closed' : 'disconnected', error);
      });
    });
  }

  send(method: string, params?: Record<string, any>, sessionId?: string): Promise<any> {
    const socket = this.ws;
    if (this.state !== 'connected' || !socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(this.disconnectedError());
    }
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

      socket.send(JSON.stringify(msg), error => {
        if (!error) return;
        const callback = this.callbacks.get(id);
        if (!callback) return;
        this.callbacks.delete(id);
        callback.reject(this.disconnectedError(error));
      });
    });
  }

  on(method: string, handler: (params: any, sessionId?: string) => void): void {
    const handlers = this.eventHandlers.get(method) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
  }

  onConnectionState(handler: (event: TransportConnectionEvent) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  close(): void {
    this.closeRequested = true;
    const socket = this.ws;
    if (!socket) {
      this.transition('closed');
      return;
    }
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
      socket.close();
    } else {
      this.ws = undefined;
      this.transition('closed');
    }
  }

  private disconnectedError(cause?: Error): BrowserPilotError {
    return new BrowserPilotError('browser_disconnected', 'Chrome DevTools connection is unavailable', {
      retryable: true,
      ...(cause ? { cause } : {}),
    });
  }

  private failPending(error: Error): void {
    for (const callback of this.callbacks.values()) callback.reject(error);
    this.callbacks.clear();
  }

  private transition(state: TransportConnectionState, error?: Error): void {
    const previousState = this.state;
    if (state === previousState) return;
    this.state = state;
    const event: TransportConnectionEvent = {
      state,
      previousState,
      ...(error ? { error } : {}),
    };
    for (const handler of this.connectionHandlers) {
      try { handler(event); } catch { /* lifecycle observers cannot break transport */ }
    }
  }
}
