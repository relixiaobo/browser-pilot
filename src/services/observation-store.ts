import { randomUUID } from 'node:crypto';
import { BrowserPilotError } from '../protocol/errors.js';
import {
  OBSERVATION_TRUNCATION_REASONS,
  OBSERVATION_V1_LIMITS,
  type BrowserWorkspaceId,
  type ControlledTargetId,
  type ControlLeaseId,
  type ObservationDescriptor,
  type ObservationId,
  type ObservationInvalidationReason,
} from '../protocol/model.js';
// Raw CDP identity stays below this store; only opaque Observation refs leave the Broker.
import type { RefEntry } from '../snapshot.js';

export interface StoredObservation extends ObservationDescriptor {
  leaseId: ControlLeaseId;
  browserProcessIdentity: string;
  sessionId: string;
  frameId: string;
  loaderId: string;
  documentGeneration: string;
  title: string;
  url: string;
  refs: RefEntry[];
}

export interface CreateObservationInput {
  workspaceId: BrowserWorkspaceId;
  leaseId: ControlLeaseId;
  targetId: ControlledTargetId;
  browserProcessIdentity: string;
  browserConnectionGeneration: number;
  sessionId: string;
  frameId: string;
  loaderId: string;
  documentGeneration: string;
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
  browserProcessIdentity: string;
  browserConnectionGeneration: number;
  sessionId: string;
  frameId: string;
  loaderId: string;
  documentGeneration: string;
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
    this.ttlMs = options.ttlMs ?? OBSERVATION_V1_LIMITS.ttlMs;
    this.maxObservations = options.maxObservations ?? OBSERVATION_V1_LIMITS.maxStoredObservations;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => `observation:${randomUUID()}`);
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) throw new Error('Invalid Observation TTL');
    if (!Number.isSafeInteger(this.maxObservations) || this.maxObservations <= 0) {
      throw new Error('Invalid Observation capacity');
    }
  }

  create(input: CreateObservationInput): StoredObservation {
    if (input.refs.length > OBSERVATION_V1_LIMITS.maxElements) {
      throw new BrowserPilotError('internal_error', 'Observation exceeds the element limit');
    }
    if (
      input.title.length > OBSERVATION_V1_LIMITS.maxTitleCharacters ||
      input.url.length > OBSERVATION_V1_LIMITS.maxUrlCharacters
    ) {
      throw new BrowserPilotError('internal_error', 'Observation contains an oversized page identity');
    }
    const reasons = new Set(input.truncationReasons);
    if (
      reasons.size !== input.truncationReasons.length ||
      input.truncationReasons.some(reason => !OBSERVATION_TRUNCATION_REASONS.includes(reason)) ||
      input.truncated !== (input.truncationReasons.length > 0)
    ) {
      throw new BrowserPilotError('internal_error', 'Observation truncation metadata is inconsistent');
    }
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
      browserProcessIdentity: input.browserProcessIdentity,
      browserConnectionGeneration: input.browserConnectionGeneration,
      sessionId: input.sessionId,
      frameId: input.frameId,
      loaderId: input.loaderId,
      documentGeneration: input.documentGeneration,
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
      record.workspaceId !== input.workspaceId ||
      record.leaseId !== input.leaseId ||
      record.targetId !== input.targetId
    ) {
      throw this.stale(input);
    }
    if (record.invalidatedBy) throw this.stale(input, record.invalidatedBy);
    if (
      record.browserProcessIdentity !== input.browserProcessIdentity ||
      record.browserConnectionGeneration !== input.browserConnectionGeneration
    ) {
      this.invalidateRecord(record, 'browser_reconnected');
      throw this.stale(input, 'browser_reconnected');
    }
    if (record.sessionId !== input.sessionId) {
      this.invalidateRecord(record, 'session_replaced');
      throw this.stale(input, 'session_replaced');
    }
    if (record.frameId !== input.frameId) {
      this.invalidateRecord(record, 'frame_changed');
      throw this.stale(input, 'frame_changed');
    }
    if (record.loaderId !== input.loaderId) {
      this.invalidateRecord(record, 'loader_replaced');
      throw this.stale(input, 'loader_replaced');
    }
    if (record.documentGeneration !== input.documentGeneration) {
      this.invalidateRecord(record, 'document_replaced');
      throw this.stale(input, 'document_replaced');
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

  invalidateSession(
    sessionId: string,
    reason: ObservationInvalidationReason = 'session_replaced',
  ): void {
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId && !record.invalidatedBy) {
        this.invalidateRecord(record, reason);
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

  private stale(
    input: ResolveObservationInput,
    reason?: ObservationInvalidationReason,
  ): BrowserPilotError {
    return new BrowserPilotError('stale_ref', 'Observation ref is stale or does not belong to this context', {
      context: {
        workspaceId: input.workspaceId,
        leaseId: input.leaseId,
        targetId: input.targetId,
        observationId: input.observationId,
        ...(input.ref !== undefined ? { ref: input.ref } : {}),
        ...(reason ? { reason } : {}),
      },
    });
  }
}
