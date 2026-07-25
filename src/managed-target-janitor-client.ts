import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { BrowserPilotError } from './protocol/errors.js';
import type {
  ManagedTargetCreateParams,
  ManagedTargetLifecycle,
} from './services/managed-target-lifecycle.js';
import { internalProcessInvocation, type InternalProcessInvocation } from './runtime-layout.js';

const MAX_LINE_BYTES = 64 * 1024;
const MAX_PENDING_REQUESTS = 64;
const REQUEST_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 7_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface ManagedTargetJanitorClientOptions {
  workerPath?: string;
  onLog?: (message: string) => void;
}

export class ManagedTargetJanitorClient implements ManagedTargetLifecycle {
  private readonly workerInvocation: InternalProcessInvocation;
  private readonly onLog?: (message: string) => void;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly ownedTargetIds = new Set<string>();
  private readonly expectedExits = new WeakSet<ChildProcessWithoutNullStreams>();
  private worker?: ChildProcessWithoutNullStreams;
  private desiredWsUrl?: string;
  private startTask?: Promise<void>;
  private restartTimer?: NodeJS.Timeout;
  private restartDelayMs = 100;
  private nextRequestId = 1;
  private output: Buffer = Buffer.alloc(0);
  private ready = false;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private closed = false;

  constructor(options: ManagedTargetJanitorClientOptions = {}) {
    this.workerInvocation = options.workerPath
      ? { command: process.execPath, argumentsPrefix: [options.workerPath] }
      : internalProcessInvocation('janitor', import.meta.url);
    this.onLog = options.onLog;
  }

  async connect(wsUrl: string): Promise<void> {
    if (!/^wss?:\/\//.test(wsUrl)) throw new Error('Invalid janitor CDP WebSocket URL');
    if (this.closed) throw new Error('Managed target janitor is closed');
    if (this.desiredWsUrl === wsUrl && this.worker && this.ready) return;
    this.desiredWsUrl = undefined;
    this.clearRestartTimer();
    await this.stopWorker(true);
    this.ownedTargetIds.clear();
    this.desiredWsUrl = wsUrl;
    await this.ensureWorker();
  }

  async browserDisconnected(): Promise<void> {
    this.desiredWsUrl = undefined;
    this.clearRestartTimer();
    await this.stopWorker(true);
    this.ownedTargetIds.clear();
  }

  async createTarget(params: ManagedTargetCreateParams): Promise<{ targetId: string }> {
    await this.ensureWorker();
    const result = await this.request('create', params) as { targetId?: unknown };
    if (typeof result?.targetId !== 'string' || result.targetId.length === 0) {
      throw new BrowserPilotError('internal_error', 'Managed target janitor returned an invalid target ID');
    }
    this.ownedTargetIds.add(result.targetId);
    return { targetId: result.targetId };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.desiredWsUrl = undefined;
    this.clearRestartTimer();
    await this.stopWorker(true);
    this.ownedTargetIds.clear();
  }

  private async ensureWorker(): Promise<void> {
    if (this.worker && this.ready) return;
    if (!this.desiredWsUrl) {
      throw new BrowserPilotError('browser_disconnected', 'Managed target cleanup process is unavailable', {
        retryable: true,
      });
    }
    if (!this.startTask) {
      this.startTask = this.startWorker().finally(() => { this.startTask = undefined; });
    }
    return this.startTask;
  }

  private async startWorker(): Promise<void> {
    const wsUrl = this.desiredWsUrl;
    if (!wsUrl) throw new Error('Managed target janitor has no browser endpoint');
    const worker = spawn(this.workerInvocation.command, [
      ...this.workerInvocation.argumentsPrefix,
      wsUrl,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.worker = worker;
    this.output = Buffer.alloc(0);
    this.ready = false;
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    worker.stdout.on('data', value => this.consumeOutput(worker, value));
    worker.stderr.on('data', value => {
      const message = Buffer.from(value).toString('utf8').trim().slice(0, 2048);
      if (message) this.onLog?.(message);
    });
    worker.on('error', error => this.failWorker(worker, error));
    worker.on('exit', (code, signal) => {
      const expected = this.expectedExits.has(worker);
      const error = new BrowserPilotError(
        'browser_disconnected',
        `Managed target cleanup process exited${signal ? ` from ${signal}` : ` with code ${code ?? 'unknown'}`}`,
        { retryable: true },
      );
      this.failWorker(worker, error);
      if (!expected && !this.closed && this.desiredWsUrl) this.scheduleRestart();
    });
    await ready;
    this.restartDelayMs = 100;
    if (this.ownedTargetIds.size > 0) {
      try {
        await this.requestCurrent(worker, 'adopt', { targetIds: [...this.ownedTargetIds] });
      } catch (error) {
        worker.kill('SIGKILL');
        throw error;
      }
    }
  }

  private consumeOutput(worker: ChildProcessWithoutNullStreams, value: Buffer | string): void {
    if (this.worker !== worker) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (this.output.length + chunk.length > MAX_LINE_BYTES * 2) {
      worker.kill('SIGKILL');
      return;
    }
    this.output = this.output.length === 0 ? chunk : Buffer.concat([this.output, chunk]);
    let newline = this.output.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.output.subarray(0, newline);
      this.output = this.output.subarray(newline + 1);
      this.handleOutputLine(worker, line);
      newline = this.output.indexOf(0x0a);
    }
  }

  private handleOutputLine(worker: ChildProcessWithoutNullStreams, line: Buffer): void {
    if (line.length === 0 || line.length > MAX_LINE_BYTES) {
      worker.kill('SIGKILL');
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line.toString('utf8'));
    } catch {
      worker.kill('SIGKILL');
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      worker.kill('SIGKILL');
      return;
    }
    const message = value as Record<string, unknown>;
    if (message.event === 'ready') {
      this.ready = true;
      this.readyResolve?.();
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
    if (!Number.isSafeInteger(message.id)) {
      worker.kill('SIGKILL');
      return;
    }
    const pending = this.pendingRequests.get(Number(message.id));
    if (!pending) return;
    this.pendingRequests.delete(Number(message.id));
    clearTimeout(pending.timer);
    if (message.error && typeof message.error === 'object') {
      const error = message.error as Record<string, unknown>;
      pending.reject(new BrowserPilotError(
        'browser_disconnected',
        typeof error.message === 'string' ? error.message.slice(0, 1024) : 'Managed target janitor failed',
        { retryable: true },
      ));
      return;
    }
    pending.resolve(message.result);
  }

  private async request(method: 'create' | 'adopt', params: object): Promise<unknown> {
    await this.ensureWorker();
    const worker = this.worker;
    if (!worker || !this.ready) throw this.unavailableError();
    return this.requestCurrent(worker, method, params);
  }

  private requestCurrent(
    worker: ChildProcessWithoutNullStreams,
    method: 'create' | 'adopt',
    params: object,
  ): Promise<unknown> {
    if (this.worker !== worker || !this.ready || worker.stdin.destroyed) {
      return Promise.reject(this.unavailableError());
    }
    if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new BrowserPilotError('result_too_large', 'Managed target janitor request limit reached', {
        retryable: true,
      }));
    }
    const id = this.nextRequestId++;
    const payload = `${JSON.stringify({ id, method, params })}\n`;
    if (Buffer.byteLength(payload) > MAX_LINE_BYTES) {
      return Promise.reject(new Error('Managed target janitor request is too large'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(this.unavailableError());
        worker.kill('SIGKILL');
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pendingRequests.set(id, { resolve, reject, timer });
      worker.stdin.write(payload, error => {
        if (!error) return;
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        clearTimeout(pending.timer);
        pending.reject(this.unavailableError(error));
      });
    });
  }

  private failWorker(worker: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    this.ready = false;
    this.output = Buffer.alloc(0);
    this.readyReject?.(error);
    this.readyResolve = undefined;
    this.readyReject = undefined;
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private scheduleRestart(): void {
    if (this.restartTimer || !this.desiredWsUrl || this.closed) return;
    const timer = setTimeout(() => {
      if (this.restartTimer === timer) this.restartTimer = undefined;
      void this.ensureWorker().catch(() => this.scheduleRestart());
    }, this.restartDelayMs);
    timer.unref();
    this.restartTimer = timer;
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, 5_000);
  }

  private async stopWorker(cleanup: boolean): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.expectedExits.add(worker);
    if (cleanup && !worker.stdin.destroyed) worker.stdin.end();
    else worker.kill('SIGTERM');
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

  private clearRestartTimer(): void {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

  private unavailableError(cause?: Error): BrowserPilotError {
    return new BrowserPilotError('browser_disconnected', 'Managed target cleanup process is unavailable', {
      retryable: true,
      ...(cause ? { cause } : {}),
    });
  }
}
