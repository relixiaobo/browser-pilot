import WebSocket from 'ws';
import { BrowserPilotError } from './protocol/errors.js';
import type {
  Transport,
  TransportConnectionEvent,
  TransportConnectionState,
} from './transport.js';

export const CDP_HANDSHAKE_TIMEOUT_CODE = 'cdp_handshake_timeout';

export class CDPError extends Error {
  constructor(
    readonly code: number | string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'CDPError';
  }
}

export interface CDPClientOptions {
  handshakeTimeoutMs?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 8_000;
const DEFAULT_PING_INTERVAL_MS = 15_000;
const DEFAULT_PONG_TIMEOUT_MS = 5_000;

function positiveTiming(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

export class CDPClient implements Transport {
  private ws?: WebSocket;
  private nextId = 1;
  private callbacks = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private eventHandlers = new Map<string, Array<(params: any, sessionId?: string) => void>>();
  private anyEventHandlers = new Set<(method: string, params: any, sessionId?: string) => void>();
  private connectionHandlers = new Set<(event: TransportConnectionEvent) => void>();
  private state: TransportConnectionState = 'disconnected';
  private closeRequested = false;
  private readonly handshakeTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private handshakeTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private pongTimer?: NodeJS.Timeout;
  private missedPongs = 0;

  constructor(options: CDPClientOptions = {}) {
    this.handshakeTimeoutMs = positiveTiming(
      options.handshakeTimeoutMs,
      DEFAULT_HANDSHAKE_TIMEOUT_MS,
      'handshakeTimeoutMs',
    );
    this.pingIntervalMs = positiveTiming(options.pingIntervalMs, DEFAULT_PING_INTERVAL_MS, 'pingIntervalMs');
    this.pongTimeoutMs = positiveTiming(options.pongTimeoutMs, DEFAULT_PONG_TIMEOUT_MS, 'pongTimeoutMs');
  }

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

      this.handshakeTimer = setTimeout(() => {
        if (socket !== this.ws || settled) return;
        this.handshakeTimer = undefined;
        const error = new CDPError(
          CDP_HANDSHAKE_TIMEOUT_CODE,
          `Chrome DevTools WebSocket handshake timed out after ${this.handshakeTimeoutMs}ms`,
        );
        settled = true;
        reject(error);
        this.stopHeartbeat();
        this.transition('disconnected', error);
        socket.terminate();
      }, this.handshakeTimeoutMs);
      this.handshakeTimer.unref();

      const rejectConnect = (error: Error): void => {
        if (settled) return;
        settled = true;
        this.clearHandshakeTimer();
        reject(error);
      };
      const resolveConnect = (): void => {
        if (settled) return;
        settled = true;
        this.clearHandshakeTimer();
        resolve();
      };

      // Keep a persistent handler so late WebSocket errors cannot crash Node.
      socket.on('error', (error: Error) => {
        if (socket !== this.ws) return;
        const stable = this.disconnectedError(error);
        this.stopHeartbeat();
        this.failPending(stable);
        rejectConnect(stable);
        this.transition(this.closeRequested ? 'closed' : 'disconnected', stable);
        if (!this.closeRequested && socket.readyState !== WebSocket.CLOSED) socket.terminate();
      });

      const onOpen = () => {
        if (socket !== this.ws || settled) return;
        this.transition('connected');
        this.startHeartbeat(socket);
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
              ? cb.reject(new CDPError(
                typeof msg.error.code === 'number' || typeof msg.error.code === 'string'
                  ? msg.error.code
                  : 'cdp_error',
                typeof msg.error.message === 'string' ? msg.error.message : 'Chrome DevTools command failed',
                msg.error.data,
              ))
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
          for (const h of this.anyEventHandlers) {
            h(msg.method, msg.params, msg.sessionId);
          }
        }
      });

      socket.on('close', () => {
        if (socket !== this.ws) return;
        this.ws = undefined;
        this.clearHandshakeTimer();
        this.stopHeartbeat();
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

  onAny(handler: (method: string, params: any, sessionId?: string) => void): () => void {
    this.anyEventHandlers.add(handler);
    return () => this.anyEventHandlers.delete(handler);
  }

  onConnectionState(handler: (event: TransportConnectionEvent) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  close(): Promise<void> {
    this.closeRequested = true;
    this.clearHandshakeTimer();
    this.stopHeartbeat();
    const socket = this.ws;
    if (!socket) {
      this.transition('closed');
      return Promise.resolve();
    }
    if (socket.readyState !== WebSocket.CONNECTING && socket.readyState !== WebSocket.OPEN) {
      this.ws = undefined;
      this.failPending(this.disconnectedError());
      this.transition('closed');
      return Promise.resolve();
    }
    return new Promise(resolve => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        socket.terminate();
        if (this.ws === socket) {
          this.ws = undefined;
          this.failPending(this.disconnectedError());
          this.transition('closed');
        }
        finish();
      }, 1_000);
      timer.unref();
      socket.once('close', finish);
      socket.close();
    });
  }

  private disconnectedError(cause?: Error): BrowserPilotError {
    return new BrowserPilotError('browser_disconnected', 'Chrome DevTools connection is unavailable', {
      retryable: true,
      ...(cause ? { cause } : {}),
    });
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    this.missedPongs = 0;
    socket.on('pong', () => {
      if (socket !== this.ws || this.state !== 'connected') return;
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
      this.missedPongs = 0;
      this.scheduleHeartbeat(socket);
    });
    this.scheduleHeartbeat(socket);
  }

  private scheduleHeartbeat(socket: WebSocket): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => this.sendHeartbeat(socket), this.pingIntervalMs);
    this.heartbeatTimer.unref();
  }

  private sendHeartbeat(socket: WebSocket): void {
    this.heartbeatTimer = undefined;
    if (socket !== this.ws || this.state !== 'connected' || socket.readyState !== WebSocket.OPEN) return;
    socket.ping((error?: Error) => {
      if (error && socket === this.ws) this.disconnectUnresponsiveSocket(socket, error);
    });
    this.pongTimer = setTimeout(() => {
      this.pongTimer = undefined;
      if (socket !== this.ws || this.state !== 'connected') return;
      this.missedPongs += 1;
      if (this.missedPongs >= 2) {
        this.disconnectUnresponsiveSocket(socket, new Error('Chrome DevTools keepalive timed out'));
        return;
      }
      this.sendHeartbeat(socket);
    }, this.pongTimeoutMs);
    this.pongTimer.unref();
  }

  private disconnectUnresponsiveSocket(socket: WebSocket, cause: Error): void {
    if (socket !== this.ws) return;
    const error = this.disconnectedError(cause);
    this.stopHeartbeat();
    this.failPending(error);
    this.transition(this.closeRequested ? 'closed' : 'disconnected', error);
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.heartbeatTimer = undefined;
    this.pongTimer = undefined;
    this.missedPongs = 0;
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
