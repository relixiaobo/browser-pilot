import { spawn, type ChildProcess } from 'node:child_process';
import {
  CDPError,
  type CDPClientOptions,
} from './cdp.js';
import { BrowserPilotError } from './protocol/errors.js';
import type {
  Transport,
  TransportConnectionEvent,
  TransportConnectionState,
} from './transport.js';
import {
  ManagedTargetCreationRejectedError,
  type ManagedTargetCreateParams,
  type ManagedTargetLifecycle,
} from './services/managed-target-lifecycle.js';
import { internalProcessInvocation, type InternalProcessInvocation } from './runtime-layout.js';

const MAX_PENDING_REQUESTS = 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 7_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  method: WorkerRequest['method'];
}

interface WorkerRequest {
  id: number;
  method: 'create' | 'adopt' | 'cdp.send' | 'shutdown';
  params: Record<string, unknown>;
}

export interface ManagedTargetJanitorClientOptions {
  workerPath?: string;
  onLog?: (message: string) => void;
  cdpOptions?: CDPClientOptions;
}

/**
 * Owns the single browser-level CDP connection in a supervised child process.
 * The child also tracks managed targets so it can close only those targets if
 * the Broker exits unexpectedly.
 */
export class ManagedTargetJanitorClient implements ManagedTargetLifecycle, Transport {
  private readonly workerInvocation: InternalProcessInvocation;
  private readonly onLog?: (message: string) => void;
  private readonly cdpOptions?: CDPClientOptions;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly ownedTargetIds = new Set<string>();
  private readonly expectedExits = new WeakSet<ChildProcess>();
  private readonly eventHandlers = new Map<string, Array<(params: any, sessionId?: string) => void>>();
  private readonly connectionHandlers = new Set<(event: TransportConnectionEvent) => void>();
  private worker?: ChildProcess;
  private desiredWsUrl?: string;
  private startTask?: Promise<void>;
  private nextRequestId = 1;
  private ready = false;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private state: TransportConnectionState = 'disconnected';
  private closed = false;

  constructor(options: ManagedTargetJanitorClientOptions = {}) {
    this.workerInvocation = options.workerPath
      ? { command: process.execPath, argumentsPrefix: [options.workerPath] }
      : internalProcessInvocation('janitor', import.meta.url);
    this.onLog = options.onLog;
    this.cdpOptions = options.cdpOptions;
  }

  get connectionState(): TransportConnectionState {
    return this.state;
  }

  async connect(wsUrl: string): Promise<void> {
    if (!/^wss?:\/\//.test(wsUrl)) throw new Error('Invalid browser CDP WebSocket URL');
    if (this.closed) throw new Error('Managed browser connection is closed');
    if (this.desiredWsUrl === wsUrl && this.worker && this.ready) return;
    this.desiredWsUrl = undefined;
    await this.stopWorker(true);
    this.ownedTargetIds.clear();
    this.desiredWsUrl = wsUrl;
    this.transition('connecting');
    try {
      await this.ensureWorker();
      this.transition('connected');
    } catch (error) {
      this.transition('disconnected', error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  send(method: string, params?: Record<string, any>, sessionId?: string): Promise<any> {
    return this.request('cdp.send', {
      method,
      ...(params !== undefined ? { params } : {}),
      ...(sessionId ? { sessionId } : {}),
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

  async browserDisconnected(): Promise<void> {
    this.desiredWsUrl = undefined;
    await this.stopWorker(false);
    this.ownedTargetIds.clear();
    if (!this.closed) this.transition('disconnected');
  }

  async createTarget(params: ManagedTargetCreateParams): Promise<{ targetId: string }> {
    await this.ensureWorker();
    const result = await this.request('create', { ...params }) as { targetId?: unknown };
    if (typeof result?.targetId !== 'string' || result.targetId.length === 0) {
      throw new BrowserPilotError('internal_error', 'Managed browser connection returned an invalid target ID');
    }
    this.ownedTargetIds.add(result.targetId);
    return { targetId: result.targetId };
  }

  async adoptTarget(targetId: string): Promise<void> {
    await this.ensureWorker();
    if (this.ownedTargetIds.has(targetId)) return;
    const result = await this.request('adopt', { targetIds: [targetId] }) as { owned?: unknown };
    const owned = result?.owned;
    if (
      !owned || typeof owned !== 'object' || Array.isArray(owned) ||
      !Object.hasOwn(owned, targetId) || (owned as Record<string, unknown>)[targetId] !== true
    ) {
      throw new BrowserPilotError('internal_error', 'Managed browser connection could not adopt the target');
    }
    this.ownedTargetIds.add(targetId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.desiredWsUrl = undefined;
    await this.stopWorker(true);
    this.ownedTargetIds.clear();
    this.transition('closed');
  }

  private async ensureWorker(): Promise<void> {
    if (this.worker && this.ready) return;
    if (!this.desiredWsUrl) throw this.unavailableError();
    if (!this.startTask) {
      this.startTask = this.startWorker().finally(() => { this.startTask = undefined; });
    }
    return this.startTask;
  }

  private async startWorker(): Promise<void> {
    const wsUrl = this.desiredWsUrl;
    if (!wsUrl) throw this.unavailableError();
    const worker = spawn(this.workerInvocation.command, [
      ...this.workerInvocation.argumentsPrefix,
      wsUrl,
      ...(this.cdpOptions ? [JSON.stringify(this.cdpOptions)] : []),
    ], {
      stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
      windowsHide: true,
    });
    this.worker = worker;
    this.ready = false;
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    worker.on('message', value => this.handleWorkerMessage(worker, value));
    worker.stderr?.on('data', value => {
      const message = Buffer.from(value).toString('utf8').trim().slice(0, 2048);
      if (message) this.onLog?.(message);
    });
    worker.on('error', error => this.failWorker(worker, error));
    worker.on('exit', (code, signal) => {
      const expected = this.expectedExits.has(worker);
      const error = new BrowserPilotError(
        'browser_disconnected',
        `Managed browser connection exited${signal ? ` from ${signal}` : ` with code ${code ?? 'unknown'}`}`,
        { retryable: true },
      );
      this.failWorker(worker, error);
      if (!expected && !this.closed) this.transition('disconnected', error);
    });
    await ready;
    if (this.ownedTargetIds.size > 0) {
      try {
        await this.requestCurrent(worker, 'adopt', { targetIds: [...this.ownedTargetIds] });
      } catch (error) {
        worker.kill('SIGKILL');
        throw error;
      }
    }
  }

  private handleWorkerMessage(worker: ChildProcess, value: unknown): void {
    if (this.worker !== worker || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (message.event === 'ready') {
      this.ready = true;
      this.readyResolve?.();
      this.readyResolve = undefined;
      this.readyReject = undefined;
      return;
    }
    if (message.event === 'startup_error') {
      const error = this.deserializeWorkerError(message.error);
      this.readyReject?.(error);
      this.readyResolve = undefined;
      this.readyReject = undefined;
      return;
    }
    if (message.event === 'owned' && typeof message.targetId === 'string') {
      this.ownedTargetIds.add(message.targetId);
      return;
    }
    if (message.event === 'destroyed' && typeof message.targetId === 'string') {
      this.ownedTargetIds.delete(message.targetId);
      return;
    }
    if (message.event === 'cdp' && typeof message.method === 'string') {
      this.dispatchEvent(
        message.method,
        message.params,
        typeof message.sessionId === 'string' ? message.sessionId : undefined,
      );
      return;
    }
    if (message.event === 'protocol_error') {
      const error = message.error && typeof message.error === 'object' && !Array.isArray(message.error)
        ? message.error as Record<string, unknown>
        : undefined;
      this.onLog?.(typeof error?.message === 'string'
        ? error.message.slice(0, 1024)
        : 'Managed browser connection protocol error');
      return;
    }
    if (!Number.isSafeInteger(message.id)) return;
    const id = Number(message.id);
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);
    clearTimeout(pending.timer);
    if (message.error && typeof message.error === 'object' && !Array.isArray(message.error)) {
      const error = message.error as Record<string, unknown>;
      const description = typeof error.message === 'string'
        ? error.message.slice(0, 1024)
        : 'Managed browser connection failed';
      if (typeof error.code === 'number' || error.code === 'cdp_error') {
        pending.reject(new CDPError(error.code, description, error.data));
      } else if (error.code === 'browser_disconnected') {
        pending.reject(new BrowserPilotError('browser_disconnected', description, { retryable: true }));
      } else if (error.code === 'janitor_error' && pending.method === 'create') {
        pending.reject(new ManagedTargetCreationRejectedError(description));
      } else {
        pending.reject(new BrowserPilotError('internal_error', description, { retryable: true }));
      }
      return;
    }
    pending.resolve(message.result);
  }

  private deserializeWorkerError(value: unknown): Error {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return new BrowserPilotError('internal_error', 'Managed browser connection failed to start');
    }
    const error = value as Record<string, unknown>;
    const description = typeof error.message === 'string'
      ? error.message.slice(0, 1024)
      : 'Managed browser connection failed to start';
    if (typeof error.code === 'number' || error.code === 'cdp_handshake_timeout' || error.code === 'cdp_error') {
      return new CDPError(error.code, description, error.data);
    }
    if (error.code === 'browser_disconnected') {
      return new BrowserPilotError('browser_disconnected', description, { retryable: true });
    }
    return new BrowserPilotError('internal_error', description, { retryable: true });
  }

  private dispatchEvent(method: string, params: unknown, sessionId?: string): void {
    const invoke = (handlers: Array<(params: any, sessionId?: string) => void>): void => {
      for (const handler of handlers) {
        try { handler(params, sessionId); } catch { /* event observers cannot break the connection */ }
      }
    };
    if (sessionId) invoke(this.eventHandlers.get(`${sessionId}:${method}`) ?? []);
    invoke(this.eventHandlers.get(method) ?? []);
  }

  private request(
    method: WorkerRequest['method'],
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const worker = this.worker;
    if (!worker || !this.ready) return Promise.reject(this.unavailableError());
    return this.requestCurrent(worker, method, params);
  }

  private requestCurrent(
    worker: ChildProcess,
    method: WorkerRequest['method'],
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.worker !== worker || !this.ready || !worker.connected) {
      return Promise.reject(this.unavailableError());
    }
    if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new BrowserPilotError(
        'result_too_large',
        'Managed browser connection request limit reached',
        { retryable: true },
      ));
    }
    const id = this.nextRequestId++;
    const request: WorkerRequest = { id, method, params };
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_REQUEST_BYTES) {
      return Promise.reject(new BrowserPilotError(
        'result_too_large',
        'Managed browser connection request exceeds the IPC size limit',
      ));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(method === 'create'
          ? new BrowserPilotError(
            'unknown_outcome',
            'Managed target creation timed out before its outcome was received',
            { retryable: true },
          )
          : new Error(`Managed browser connection timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pendingRequests.set(id, { resolve, reject, timer, method });
      worker.send?.(request, error => {
        if (!error) return;
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        clearTimeout(pending.timer);
        pending.reject(this.unavailableError(error));
      });
    });
  }

  private failWorker(worker: ChildProcess, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    this.ready = false;
    this.readyReject?.(error);
    this.readyResolve = undefined;
    this.readyReject = undefined;
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private async stopWorker(cleanup: boolean): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.expectedExits.add(worker);
    if (cleanup && this.ready && worker.stdin && !worker.stdin.destroyed) worker.stdin.end();
    else if (cleanup) worker.kill('SIGTERM');
    else if (worker.connected && this.ready) {
      const request: WorkerRequest = {
        id: this.nextRequestId++,
        method: 'shutdown',
        params: { cleanup: false },
      };
      worker.send?.(request, error => {
        if (error && worker.exitCode === null && worker.signalCode === null) worker.kill('SIGTERM');
      });
    } else worker.kill('SIGTERM');
    await new Promise<void>(resolve => {
      if (worker.exitCode !== null || worker.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        worker.kill('SIGKILL');
        resolve();
      }, STOP_TIMEOUT_MS);
      timer.unref();
      worker.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (this.worker === worker) this.failWorker(worker, this.unavailableError());
  }

  private unavailableError(cause?: Error): BrowserPilotError {
    return new BrowserPilotError('browser_disconnected', 'Managed browser connection is unavailable', {
      retryable: true,
      ...(cause ? { cause } : {}),
    });
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
      try { handler(event); } catch { /* lifecycle observers cannot break the connection */ }
    }
  }
}
