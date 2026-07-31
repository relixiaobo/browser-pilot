import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../canonical-json.js';
import { asBrowserPilotError, BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import type {
  BrowserWorkspaceId,
  ClientConnectionId,
  ClientPrincipalId,
  CommandDescriptor,
  CommandId,
  CommandOutcome,
  CommandStatus,
  ControlledTargetId,
  ControlLeaseId,
  JsonRpcErrorObject,
  JsonValue,
} from '../protocol/model.js';
import type { ToolCancellation } from '../protocol/tools.js';

export interface CommandExecutionContext {
  signal: AbortSignal;
  markDispatched(): void;
}

export interface RunCommandInput {
  principalId: ClientPrincipalId;
  connectionId: ClientConnectionId;
  workspaceId?: BrowserWorkspaceId;
  leaseId?: ControlLeaseId;
  targetId?: ControlledTargetId;
  browserConnectionGeneration?: number;
  commandId?: CommandId;
  idempotencyKey?: string;
  deadlineMs?: number;
  method: string;
  mutating: boolean;
  browserDisconnectOutcomeKnown?: boolean;
  cancellation: ToolCancellation;
  actorKey: string;
  request: JsonValue;
}

export interface CommandAccessContext {
  principalId: ClientPrincipalId;
  commandId: CommandId;
  workspaceId?: BrowserWorkspaceId;
}

export interface CommandListContext {
  principalId: ClientPrincipalId;
  workspaceId: BrowserWorkspaceId;
  limit?: number;
  statuses?: readonly CommandStatus[];
}

export interface MemoryCommandRuntimeOptions {
  defaultDeadlineMs?: number;
  maxDeadlineMs?: number;
  terminalTtlMs?: number;
  maxCommands?: number;
  now?: () => number;
  idFactory?: () => string;
}

export type CommandStatusListener = (outcome: CommandOutcome) => void;

interface StoredCommand extends CommandDescriptor {
  principalId: ClientPrincipalId;
  connectionId: ClientConnectionId;
  fingerprint: string;
  scopeKey: string;
  cancellation: ToolCancellation;
  browserDisconnectOutcomeKnown: boolean;
  result?: JsonValue;
  error?: JsonRpcErrorObject;
  abortController: AbortController;
  deadlineTimer?: NodeJS.Timeout;
  resolve: (outcome: CommandOutcome) => void;
  reject: (error: BrowserPilotError) => void;
  completion: Promise<CommandOutcome>;
  settled: boolean;
}

const COMMAND_ID_PATTERN = /^command:[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const TERMINAL_STATUSES = new Set<CommandStatus>([
  'completed',
  'unknown_outcome',
  'cancelled',
  'expired',
]);

function cloneJson<T extends JsonValue | JsonRpcErrorObject>(value: T): T {
  return structuredClone(value);
}

function descriptor(record: StoredCommand): CommandDescriptor {
  return {
    id: record.id,
    ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
    ...(record.leaseId ? { leaseId: record.leaseId } : {}),
    ...(record.targetId ? { targetId: record.targetId } : {}),
    ...(record.browserConnectionGeneration !== undefined
      ? { browserConnectionGeneration: record.browserConnectionGeneration }
      : {}),
    idempotencyKey: record.idempotencyKey,
    method: record.method,
    mutating: record.mutating,
    status: record.status,
    acceptedAt: record.acceptedAt,
    deadlineAt: record.deadlineAt,
    ...(record.dispatchedAt !== undefined ? { dispatchedAt: record.dispatchedAt } : {}),
    ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
    ...(record.cancellationRequested ? { cancellationRequested: true } : {}),
  };
}

export class MemoryCommandRuntime {
  private readonly records = new Map<CommandId, StoredCommand>();
  private readonly commandsByIdempotency = new Map<string, CommandId>();
  private readonly actorTails = new Map<string, Promise<void>>();
  private readonly statusListeners = new Set<CommandStatusListener>();
  private readonly defaultDeadlineMs: number;
  private readonly maxDeadlineMs: number;
  private readonly terminalTtlMs: number;
  private readonly maxCommands: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(options: MemoryCommandRuntimeOptions = {}) {
    this.defaultDeadlineMs = options.defaultDeadlineMs ?? 60_000;
    this.maxDeadlineMs = options.maxDeadlineMs ?? 5 * 60_000;
    this.terminalTtlMs = options.terminalTtlMs ?? 5 * 60_000;
    this.maxCommands = options.maxCommands ?? 2048;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => `command:${randomUUID()}`);
    const limits = [this.defaultDeadlineMs, this.maxDeadlineMs, this.terminalTtlMs, this.maxCommands];
    if (limits.some(value => !Number.isSafeInteger(value) || value <= 0)) {
      throw new Error('Invalid Command Runtime limit');
    }
    if (this.defaultDeadlineMs > this.maxDeadlineMs) {
      throw new Error('Default Command deadline exceeds the maximum');
    }
  }

  run(
    input: RunCommandInput,
    execute: (context: CommandExecutionContext) => Promise<JsonValue>,
  ): Promise<CommandOutcome> {
    this.sweep();
    const deadlineMs = input.deadlineMs ?? this.defaultDeadlineMs;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > this.maxDeadlineMs) {
      throw invalidArgument(`deadlineMs must be from 1 through ${this.maxDeadlineMs}`, 'deadlineMs');
    }
    if (
      input.browserConnectionGeneration !== undefined &&
      (!Number.isSafeInteger(input.browserConnectionGeneration) || input.browserConnectionGeneration < 1)
    ) {
      throw invalidArgument(
        'browserConnectionGeneration must be a positive integer',
        'browserConnectionGeneration',
      );
    }
    const scopeKey = this.scopeKey(input.principalId, input.connectionId, input.workspaceId);
    const idempotencyKey = input.idempotencyKey ?? (
      input.commandId ? `command-id:${input.commandId}` : `auto:${randomUUID()}`
    );
    const fingerprint = canonicalJson(input.request);
    const idempotencyIndex = `${scopeKey}\u0000${idempotencyKey}`;
    const duplicateId = this.commandsByIdempotency.get(idempotencyIndex);
    if (duplicateId) {
      const duplicate = this.records.get(duplicateId);
      if (duplicate) {
        this.assertDuplicate(duplicate, input, fingerprint, idempotencyKey);
        return Promise.resolve(this.outcome(duplicate));
      }
      this.commandsByIdempotency.delete(idempotencyIndex);
    }

    if (input.commandId) {
      const duplicate = this.records.get(input.commandId);
      if (duplicate) {
        this.assertDuplicate(duplicate, input, fingerprint, idempotencyKey);
        return Promise.resolve(this.outcome(duplicate));
      }
    }

    this.ensureCapacity();
    const id = (input.commandId ?? this.idFactory()) as CommandId;
    if (!COMMAND_ID_PATTERN.test(id) || this.records.has(id)) {
      throw new BrowserPilotError('internal_error', 'Invalid or duplicate Command ID');
    }
    const acceptedAt = this.now();
    let resolve!: (outcome: CommandOutcome) => void;
    let reject!: (error: BrowserPilotError) => void;
    const completion = new Promise<CommandOutcome>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const record: StoredCommand = {
      id,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.leaseId ? { leaseId: input.leaseId } : {}),
      ...(input.targetId ? { targetId: input.targetId } : {}),
      ...(input.browserConnectionGeneration !== undefined
        ? { browserConnectionGeneration: input.browserConnectionGeneration }
        : {}),
      principalId: input.principalId,
      connectionId: input.connectionId,
      idempotencyKey,
      method: input.method,
      mutating: input.mutating,
      status: 'accepted',
      acceptedAt,
      deadlineAt: acceptedAt + deadlineMs,
      fingerprint,
      scopeKey,
      cancellation: input.cancellation,
      browserDisconnectOutcomeKnown: input.browserDisconnectOutcomeKnown === true,
      abortController: new AbortController(),
      resolve,
      reject,
      completion,
      settled: false,
    };
    this.records.set(id, record);
    this.commandsByIdempotency.set(idempotencyIndex, id);
    record.deadlineTimer = setTimeout(() => this.expire(record), deadlineMs);
    record.deadlineTimer.unref();
    this.emitStatus(record);
    this.enqueue(input.actorKey, () => this.execute(record, execute));
    return completion;
  }

  subscribe(listener: CommandStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  get(context: CommandAccessContext): CommandOutcome {
    this.sweep();
    return this.outcome(this.requireOwned(context));
  }

  list(context: CommandListContext): CommandDescriptor[] {
    this.sweep();
    const statuses = context.statuses ? new Set(context.statuses) : undefined;
    return [...this.records.values()]
      .filter(record => (
        record.principalId === context.principalId &&
        record.workspaceId === context.workspaceId &&
        (!statuses || statuses.has(record.status))
      ))
      .sort((left, right) => right.acceptedAt - left.acceptedAt)
      .slice(0, context.limit ?? 20)
      .map(descriptor);
  }

  cancel(context: CommandAccessContext): CommandOutcome {
    this.sweep();
    const record = this.requireOwned(context);
    if (TERMINAL_STATUSES.has(record.status)) return this.outcome(record);
    if (record.cancellation === 'not_applicable') {
      throw invalidArgument('Command does not support cancellation', 'commandId');
    }
    if (record.status === 'accepted') {
      record.abortController.abort();
      this.finishWithError(
        record,
        'cancelled',
        new BrowserPilotError('command_cancelled', 'Command was cancelled before dispatch'),
      );
      return this.outcome(record);
    }
    record.cancellationRequested = true;
    this.emitStatus(record);
    if (record.cancellation === 'best_effort') record.abortController.abort();
    return this.outcome(record);
  }

  releaseLease(leaseId: ControlLeaseId): void {
    for (const record of this.records.values()) {
      if (record.leaseId === leaseId) this.cancelForCleanup(record);
    }
  }

  releaseConnection(connectionId: ClientConnectionId): void {
    for (const record of this.records.values()) {
      if (record.connectionId === connectionId) this.cancelForCleanup(record);
    }
  }

  releaseWorkspace(workspaceId: BrowserWorkspaceId): void {
    for (const record of this.records.values()) {
      if (record.workspaceId === workspaceId) this.cancelForCleanup(record);
    }
  }

  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const record of this.records.values()) {
      if (!TERMINAL_STATUSES.has(record.status) && record.deadlineAt <= now) this.expire(record);
    }
    for (const [id, record] of this.records) {
      if (
        TERMINAL_STATUSES.has(record.status) &&
        (record.completedAt ?? record.deadlineAt) + this.terminalTtlMs <= now
      ) {
        this.deleteRecord(id, record);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.records.size;
  }

  private async execute(
    record: StoredCommand,
    execute: (context: CommandExecutionContext) => Promise<JsonValue>,
  ): Promise<void> {
    if (record.status !== 'accepted') return;
    if (record.deadlineAt <= this.now()) {
      this.expire(record);
      return;
    }
    try {
      const markDispatched = (): void => {
        if (record.status === 'cancelled') {
          throw new BrowserPilotError('command_cancelled', 'Command was cancelled before dispatch', {
            context: { commandId: record.id },
          });
        }
        if (record.status === 'expired') {
          throw new BrowserPilotError('command_expired', 'Command expired before dispatch', {
            context: { commandId: record.id },
          });
        }
        if (record.status !== 'accepted') return;
        record.status = 'dispatched';
        record.dispatchedAt = this.now();
        this.emitStatus(record);
      };
      const result = await execute({ signal: record.abortController.signal, markDispatched });
      if (TERMINAL_STATUSES.has(record.status)) return;
      markDispatched();
      record.status = 'completed';
      record.completedAt = this.now();
      record.result = cloneJson(result);
      this.clearDeadline(record);
      this.emitStatus(record);
      this.resolve(record);
    } catch (error) {
      if (TERMINAL_STATUSES.has(record.status)) return;
      const stable = this.withCommandContext(error, record);
      const knownConnectionFailure = record.browserDisconnectOutcomeKnown &&
        stable.code === 'browser_disconnected';
      if (
        record.mutating && record.dispatchedAt !== undefined &&
        !knownConnectionFailure &&
        (stable.code === 'browser_disconnected' || stable.code === 'internal_error' || stable.code === 'unknown_outcome')
      ) {
        if (stable.code === 'unknown_outcome') {
          this.finishWithError(record, 'unknown_outcome', stable);
          return;
        }
        this.finishWithError(
          record,
          'unknown_outcome',
          new BrowserPilotError('unknown_outcome', 'Command outcome is unknown after dispatch', {
            context: { commandId: record.id },
            cause: stable,
          }),
        );
      } else {
        this.finishWithError(record, 'completed', stable);
      }
    }
  }

  private expire(record: StoredCommand): void {
    if (TERMINAL_STATUSES.has(record.status)) return;
    record.abortController.abort();
    if (record.status === 'dispatched' && record.mutating) {
      this.finishWithError(
        record,
        'unknown_outcome',
        new BrowserPilotError('unknown_outcome', 'Command deadline elapsed after dispatch', {
          context: { commandId: record.id },
        }),
      );
      return;
    }
    this.finishWithError(
      record,
      'expired',
      new BrowserPilotError('command_expired', 'Command deadline elapsed before a result was known', {
        context: { commandId: record.id },
      }),
    );
  }

  private finishWithError(
    record: StoredCommand,
    status: Extract<CommandStatus, 'completed' | 'unknown_outcome' | 'cancelled' | 'expired'>,
    error: BrowserPilotError,
  ): void {
    if (TERMINAL_STATUSES.has(record.status)) return;
    const stable = this.withCommandContext(error, record);
    record.status = status;
    record.completedAt = this.now();
    record.error = stable.toJsonRpcError();
    this.clearDeadline(record);
    this.emitStatus(record);
    if (!record.settled) {
      record.settled = true;
      record.reject(stable);
    }
  }

  private resolve(record: StoredCommand): void {
    if (record.settled) return;
    record.settled = true;
    record.resolve(this.outcome(record));
  }

  private cancelForCleanup(record: StoredCommand): void {
    if (TERMINAL_STATUSES.has(record.status)) return;
    if (record.status === 'accepted') {
      record.abortController.abort();
      this.finishWithError(
        record,
        'cancelled',
        new BrowserPilotError('command_cancelled', 'Command was cancelled during resource cleanup'),
      );
      return;
    }
    record.cancellationRequested = true;
    this.emitStatus(record);
    record.abortController.abort();
  }

  private requireOwned(context: CommandAccessContext): StoredCommand {
    const record = this.records.get(context.commandId);
    if (
      !record ||
      record.principalId !== context.principalId ||
      record.workspaceId !== context.workspaceId
    ) {
      throw invalidArgument('Command was not found for this ClientPrincipal and Workspace', 'commandId');
    }
    return record;
  }

  private assertDuplicate(
    record: StoredCommand,
    input: RunCommandInput,
    fingerprint: string,
    idempotencyKey: string,
  ): void {
    if (
      record.principalId !== input.principalId ||
      record.workspaceId !== input.workspaceId ||
      record.method !== input.method ||
      record.fingerprint !== fingerprint ||
      record.idempotencyKey !== idempotencyKey
    ) {
      throw invalidArgument('Command or idempotency key was reused for a different request', 'idempotencyKey');
    }
  }

  private outcome(record: StoredCommand): CommandOutcome {
    return {
      command: descriptor(record),
      ...(record.result !== undefined ? { result: cloneJson(record.result) } : {}),
      ...(record.error ? { error: cloneJson(record.error) } : {}),
    };
  }

  private scopeKey(
    principalId: ClientPrincipalId,
    connectionId: ClientConnectionId,
    workspaceId?: BrowserWorkspaceId,
  ): string {
    return workspaceId
      ? `${principalId}\u0000${workspaceId}`
      : `${principalId}\u0000${connectionId}`;
  }

  private withCommandContext(error: unknown, record: StoredCommand): BrowserPilotError {
    const stable = asBrowserPilotError(error);
    return new BrowserPilotError(stable.code, stable.message, {
      retryable: stable.retryable,
      context: { ...(stable.context ?? {}), commandId: record.id },
      ...(stable.remediation ? { remediation: stable.remediation } : {}),
      rpcCode: stable.rpcCode,
      cause: error,
    });
  }

  private enqueue(actorKey: string, operation: () => Promise<void>): void {
    const previous = this.actorTails.get(actorKey) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    const settled = task.then(() => {}, () => {});
    this.actorTails.set(actorKey, settled);
    void settled.finally(() => {
      if (this.actorTails.get(actorKey) === settled) this.actorTails.delete(actorKey);
    });
  }

  private ensureCapacity(): void {
    if (this.records.size < this.maxCommands) return;
    const terminal = [...this.records.values()]
      .filter(record => TERMINAL_STATUSES.has(record.status))
      .sort((left, right) => (left.completedAt ?? left.deadlineAt) - (right.completedAt ?? right.deadlineAt));
    for (const record of terminal) {
      this.deleteRecord(record.id, record);
      if (this.records.size < this.maxCommands) return;
    }
    throw new BrowserPilotError('result_too_large', 'Command store capacity is exhausted', {
      retryable: true,
      context: { maxCommands: this.maxCommands },
    });
  }

  private deleteRecord(id: CommandId, record: StoredCommand): void {
    this.clearDeadline(record);
    this.records.delete(id);
    const index = `${record.scopeKey}\u0000${record.idempotencyKey}`;
    if (this.commandsByIdempotency.get(index) === id) this.commandsByIdempotency.delete(index);
  }

  private clearDeadline(record: StoredCommand): void {
    if (!record.deadlineTimer) return;
    clearTimeout(record.deadlineTimer);
    record.deadlineTimer = undefined;
  }

  private emitStatus(record: StoredCommand): void {
    const outcome = this.outcome(record);
    for (const listener of this.statusListeners) {
      try { listener(outcome); } catch { /* observers cannot affect Command execution */ }
    }
  }
}
