import { randomUUID } from 'node:crypto';
import { BrowserPilotError } from '../protocol/errors.js';
import type {
  BrowserWorkspaceId,
  ControlledTargetId,
  ControlLeaseId,
  ObservationDescriptor,
  ObservationId,
  ObservationInvalidationReason,
} from '../protocol/model.js';
import type { RefEntry } from '../snapshot.js';

export interface StoredObservation extends ObservationDescriptor {
  leaseId: ControlLeaseId;
  sessionId: string;
  loaderId: string;
  title: string;
  url: string;
  refs: RefEntry[];
}

export interface CreateObservationInput {
  workspaceId: BrowserWorkspaceId;
  leaseId: ControlLeaseId;
  targetId: ControlledTargetId;
  browserConnectionGeneration: number;
  sessionId: string;
  loaderId: string;
  title: string;
  url: string;
  refs: readonly RefEntry[];
  truncated: boolean;
  truncationReasons: ObservationDescriptor['truncationReasons'];
}

export interface ResolveObservationInput {
  workspaceId: BrowserWorkspaceId;
  leaseId: ControlLeaseId;
  targetId: ControlledTargetId;
  observationId: ObservationId;
  browserConnectionGeneration: number;
  sessionId: string;
  loaderId: string;
  ref?: number;
}

export interface MemoryObservationStoreOptions {
  ttlMs?: number;
  maxObservations?: number;
  now?: () => number;
  idFactory?: () => string;
}

function clone(record: StoredObservation): StoredObservation {
  return {
    ...record,
    truncationReasons: [...record.truncationReasons],
    refs: record.refs.map(ref => ({ ...ref })),
  };
}

export class MemoryObservationStore {
  private readonly records = new Map<ObservationId, StoredObservation>();
  private readonly ttlMs: number;
  private readonly maxObservations: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(options: MemoryObservationStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.maxObservations = options.maxObservations ?? 2048;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => `observation:${randomUUID()}`);
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) throw new Error('Invalid Observation TTL');
    if (!Number.isSafeInteger(this.maxObservations) || this.maxObservations <= 0) {
      throw new Error('Invalid Observation capacity');
    }
  }

  create(input: CreateObservationInput): StoredObservation {
    this.sweep();
    while (this.records.size >= this.maxObservations) {
      const oldest = [...this.records.values()]
        .sort((left, right) => left.createdAt - right.createdAt)[0];
      if (!oldest) break;
      this.records.delete(oldest.id);
    }
    const id = this.idFactory() as ObservationId;
    if (!id.startsWith('observation:') || this.records.has(id)) {
      throw new BrowserPilotError('internal_error', 'Invalid or duplicate Observation ID');
    }
    const createdAt = this.now();
    const record: StoredObservation = {
      id,
      workspaceId: input.workspaceId,
      leaseId: input.leaseId,
      targetId: input.targetId,
      browserConnectionGeneration: input.browserConnectionGeneration,
      sessionId: input.sessionId,
      loaderId: input.loaderId,
      title: input.title,
      url: input.url,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      elementCount: input.refs.length,
      truncated: input.truncated,
      truncationReasons: [...input.truncationReasons],
      refs: input.refs.map(ref => ({ ...ref })),
    };
    this.records.set(id, record);
    return clone(record);
  }

  resolve(input: ResolveObservationInput): StoredObservation {
    this.sweep();
    const record = this.records.get(input.observationId);
    if (
      !record ||
      record.invalidatedBy ||
      record.workspaceId !== input.workspaceId ||
      record.leaseId !== input.leaseId ||
      record.targetId !== input.targetId ||
      record.browserConnectionGeneration !== input.browserConnectionGeneration
    ) {
      throw this.stale(input);
    }
    if (record.sessionId !== input.sessionId) {
      this.invalidateRecord(record, 'session_replaced');
      throw this.stale(input);
    }
    if (record.loaderId !== input.loaderId) {
      this.invalidateRecord(record, 'navigation');
      throw this.stale(input);
    }
    if (input.ref !== undefined && (input.ref < 1 || input.ref > record.refs.length)) {
      throw this.stale(input);
    }
    return clone(record);
  }

  invalidateTarget(targetId: ControlledTargetId, reason: ObservationInvalidationReason): void {
    for (const record of this.records.values()) {
      if (record.targetId === targetId && !record.invalidatedBy) this.invalidateRecord(record, reason);
    }
  }

  invalidateSession(sessionId: string): void {
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId && !record.invalidatedBy) {
        this.invalidateRecord(record, 'session_replaced');
      }
    }
  }

  releaseLease(leaseId: ControlLeaseId): void {
    for (const [id, record] of this.records) {
      if (record.leaseId === leaseId) this.records.delete(id);
    }
  }

  releaseWorkspace(workspaceId: BrowserWorkspaceId): void {
    for (const [id, record] of this.records) {
      if (record.workspaceId === workspaceId) this.records.delete(id);
    }
  }

  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [id, record] of this.records) {
      if (record.expiresAt > now) continue;
      this.invalidateRecord(record, 'expired');
      this.records.delete(id);
      removed += 1;
    }
    return removed;
  }

  size(): number {
    return this.records.size;
  }

  private invalidateRecord(record: StoredObservation, reason: ObservationInvalidationReason): void {
    record.invalidatedBy = reason;
    record.refs = [];
  }

  private stale(input: ResolveObservationInput): BrowserPilotError {
    return new BrowserPilotError('stale_ref', 'Observation ref is stale or does not belong to this context', {
      context: {
        workspaceId: input.workspaceId,
        leaseId: input.leaseId,
        targetId: input.targetId,
        observationId: input.observationId,
        ...(input.ref !== undefined ? { ref: input.ref } : {}),
      },
    });
  }
}
