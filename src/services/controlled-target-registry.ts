import { randomUUID } from 'node:crypto';
import { BrowserPilotError } from '../protocol/errors.js';
import type {
  BrowserInstanceId,
  BrowserWorkspaceId,
  ClientPrincipalId,
  ControlledTarget,
  ControlledTargetId,
  ControlledTargetOrigin,
  ControlLeaseId,
  ManagedTabSetId,
  ProfileContextId,
} from '../protocol/model.js';
import type {
  UserBrowserTarget,
  WorkspaceCallerContext,
} from './browser-control-policy.js';

export type ControlledTargetInvalidationReason =
  | 'target_ineligible'
  | 'target_detached'
  | 'browser_reconnected'
  | 'target_closed';

export interface ControlledTargetRecord extends ControlledTarget {
  principalId: ClientPrincipalId;
  browserConnectionGeneration: number;
  title: string;
  invalidatedBy?: ControlledTargetInvalidationReason;
}

export interface ManagedTargetRegistration extends WorkspaceCallerContext {
  browserInstanceId: BrowserInstanceId;
  browserConnectionGeneration: number;
  managedTabSetId: ManagedTabSetId;
  profileContextId: ProfileContextId;
  cdpTargetId: string;
  openerCdpTargetId?: string;
  origin: 'managed' | 'managed_popup';
  title: string;
  url: string;
}

export interface LiveTargetMetadata {
  cdpTargetId: string;
  profileContextId: ProfileContextId;
  title: string;
  url: string;
  openerCdpTargetId?: string;
}

export interface ControlledTargetInvalidation {
  targetId: ControlledTargetId;
  workspaceId: BrowserWorkspaceId;
  browserConnectionGeneration: number;
  reason: ControlledTargetInvalidationReason;
}

export type TargetControlState = 'available' | 'controlled' | 'busy';

export interface ControlledTargetView {
  targetId: ControlledTargetId;
  profileContextId: ProfileContextId;
  title: string;
  url: string;
  active: boolean;
  origin: ControlledTargetOrigin;
  managedTabSetId?: ManagedTabSetId;
  controlState: TargetControlState;
}

export interface ControlAcquisition {
  target: ControlledTargetRecord;
  newlyAcquired: boolean;
}

export interface ControlledTargetRegistryOptions {
  now?: () => number;
  idFactory?: () => string;
}

function cloneRecord(record: ControlledTargetRecord): ControlledTargetRecord {
  return { ...record };
}

function targetKey(
  workspaceId: BrowserWorkspaceId,
  browserInstanceId: BrowserInstanceId,
  cdpTargetId: string,
): string {
  return `${workspaceId}\u0000${browserInstanceId}\u0000${cdpTargetId}`;
}

function physicalTargetKey(browserInstanceId: BrowserInstanceId, cdpTargetId: string): string {
  return `${browserInstanceId}\u0000${cdpTargetId}`;
}

interface PhysicalTargetController {
  leaseId: ControlLeaseId;
  principalId: ClientPrincipalId;
  workspaceId: BrowserWorkspaceId;
  targetId: ControlledTargetId;
}

export class MemoryControlledTargetRegistry {
  private readonly records = new Map<ControlledTargetId, ControlledTargetRecord>();
  private readonly activeKeys = new Map<string, ControlledTargetId>();
  private readonly activeByLease = new Map<ControlLeaseId, ControlledTargetId>();
  private readonly controllers = new Map<string, PhysicalTargetController>();
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(options: ControlledTargetRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => `target:${randomUUID()}`);
  }

  registerManaged(input: ManagedTargetRegistration): ControlledTargetRecord {
    const key = targetKey(input.workspaceId, input.browserInstanceId, input.cdpTargetId);
    const existingId = this.activeKeys.get(key);
    if (existingId) {
      const existing = this.records.get(existingId)!;
      this.assertCallerOwns(input, existing);
      if (existing.origin === 'user_tab') {
        throw new BrowserPilotError('internal_error', 'A user tab cannot be converted into a managed target');
      }
      existing.title = input.title;
      existing.url = input.url;
      existing.profileContextId = input.profileContextId;
      existing.openerCdpTargetId = input.openerCdpTargetId;
      return cloneRecord(existing);
    }

    const record: ControlledTargetRecord = {
      id: this.nextId(),
      principalId: input.principalId,
      workspaceId: input.workspaceId,
      browserInstanceId: input.browserInstanceId,
      browserConnectionGeneration: input.browserConnectionGeneration,
      cdpTargetId: input.cdpTargetId,
      profileContextId: input.profileContextId,
      ...(input.openerCdpTargetId ? { openerCdpTargetId: input.openerCdpTargetId } : {}),
      origin: input.origin,
      managedTabSetId: input.managedTabSetId,
      title: input.title,
      url: input.url,
      createdAt: this.now(),
      state: 'active',
    };
    this.records.set(record.id, record);
    this.activeKeys.set(key, record.id);
    return cloneRecord(record);
  }

  syncUserTargets(
    context: WorkspaceCallerContext & { browserConnectionGeneration: number },
    browserInstanceId: BrowserInstanceId,
    userTargets: readonly UserBrowserTarget[],
  ): {
    targets: ControlledTargetRecord[];
    created: ControlledTargetRecord[];
    invalidated: ControlledTargetInvalidation[];
  } {
    const targetsByKey = new Map<string, UserBrowserTarget>();
    for (const target of userTargets) {
      if (target.browserInstanceId !== browserInstanceId) continue;
      targetsByKey.set(
        targetKey(context.workspaceId, target.browserInstanceId, target.cdpTargetId),
        target,
      );
    }

    const invalidated: ControlledTargetInvalidation[] = [];
    for (const record of this.records.values()) {
      if (
        record.state !== 'active' ||
        record.origin !== 'user_tab' ||
        record.principalId !== context.principalId ||
        record.workspaceId !== context.workspaceId ||
        record.browserInstanceId !== browserInstanceId
      ) continue;
      const key = targetKey(record.workspaceId, record.browserInstanceId, record.cdpTargetId);
      if (!targetsByKey.has(key)) {
        invalidated.push(this.invalidate(record, 'target_ineligible'));
      }
    }

    const targets: ControlledTargetRecord[] = [];
    const created: ControlledTargetRecord[] = [];
    for (const target of targetsByKey.values()) {
      const key = targetKey(context.workspaceId, target.browserInstanceId, target.cdpTargetId);
      const existingId = this.activeKeys.get(key);
      if (existingId) {
        const existing = this.records.get(existingId)!;
        this.assertCallerOwns(context, existing);
        if (existing.origin !== 'user_tab') continue;
        existing.title = target.title;
        existing.url = target.url;
        existing.profileContextId = target.profileContextId;
        targets.push(cloneRecord(existing));
        continue;
      }

      const record: ControlledTargetRecord = {
        id: this.nextId(),
        principalId: context.principalId,
        workspaceId: context.workspaceId,
        browserInstanceId: target.browserInstanceId,
        browserConnectionGeneration: context.browserConnectionGeneration,
        cdpTargetId: target.cdpTargetId,
        profileContextId: target.profileContextId,
        origin: 'user_tab',
        title: target.title,
        url: target.url,
        createdAt: this.now(),
        state: 'active',
      };
      this.records.set(record.id, record);
      this.activeKeys.set(key, record.id);
      targets.push(cloneRecord(record));
      created.push(cloneRecord(record));
    }
    return { targets, created, invalidated };
  }

  reconcileBrowserTargets(
    context: WorkspaceCallerContext,
    browserInstanceId: BrowserInstanceId,
    liveTargets: ReadonlyMap<string, LiveTargetMetadata>,
  ): ControlledTargetInvalidation[] {
    const invalidated: ControlledTargetInvalidation[] = [];
    for (const record of this.records.values()) {
      if (
        record.state !== 'active' ||
        record.principalId !== context.principalId ||
        record.workspaceId !== context.workspaceId ||
        record.browserInstanceId !== browserInstanceId
      ) continue;
      const live = liveTargets.get(record.cdpTargetId);
      if (!live) {
        invalidated.push(this.invalidate(record, 'target_detached'));
        continue;
      }
      record.title = live.title;
      record.url = live.url;
      record.openerCdpTargetId = live.openerCdpTargetId;
      if (
        record.profileContextId &&
        live.profileContextId &&
        record.profileContextId !== live.profileContextId
      ) {
        invalidated.push(this.invalidate(record, 'target_ineligible'));
      }
    }
    return invalidated;
  }

  list(
    context: WorkspaceCallerContext,
    leaseId: ControlLeaseId,
    scope: 'all' | 'managed_only' | 'user_tabs' = 'all',
  ): ControlledTargetView[] {
    const activeTargetId = this.activeByLease.get(leaseId);
    const records = [...this.records.values()]
      .filter(record =>
        record.state === 'active' &&
        record.principalId === context.principalId &&
        record.workspaceId === context.workspaceId &&
        (scope === 'all' ||
          (scope === 'managed_only' && record.origin !== 'user_tab') ||
          (scope === 'user_tabs' && record.origin === 'user_tab')),
      )
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));

    return records.map(record => ({
      targetId: record.id,
      profileContextId: record.profileContextId,
      title: record.title,
      url: record.url,
      active: record.id === activeTargetId,
      origin: record.origin,
      ...(record.managedTabSetId ? { managedTabSetId: record.managedTabSetId } : {}),
      controlState: this.controlState(context, leaseId, record),
    }));
  }

  get(context: WorkspaceCallerContext, targetId: ControlledTargetId): ControlledTargetRecord {
    const record = this.records.get(targetId);
    if (!record || record.state !== 'active') {
      throw new BrowserPilotError('target_not_owned', 'Target is not controlled by this Workspace', {
        context: { targetId },
      });
    }
    this.assertCallerOwns(context, record);
    return cloneRecord(record);
  }

  acquire(
    context: WorkspaceCallerContext,
    leaseId: ControlLeaseId,
    targetId: ControlledTargetId,
  ): ControlAcquisition {
    const record = this.records.get(targetId);
    if (!record || record.state !== 'active') {
      throw new BrowserPilotError('target_not_owned', 'Target is not controlled by this Workspace', {
        context: { targetId },
      });
    }
    this.assertCallerOwns(context, record);
    const physicalKey = physicalTargetKey(record.browserInstanceId, record.cdpTargetId);
    const controller = this.controllers.get(physicalKey);
    if (
      controller &&
      (
        controller.leaseId !== leaseId ||
        controller.principalId !== context.principalId ||
        controller.workspaceId !== context.workspaceId
      )
    ) {
      throw new BrowserPilotError('target_busy', 'Target is controlled by another Lease', {
        retryable: true,
        context: { targetId },
      });
    }
    const newlyAcquired = !controller;
    this.controllers.set(physicalKey, {
      leaseId,
      principalId: context.principalId,
      workspaceId: context.workspaceId,
      targetId,
    });
    record.controllerLeaseId = leaseId;
    return { target: cloneRecord(record), newlyAcquired };
  }

  release(context: WorkspaceCallerContext, leaseId: ControlLeaseId, targetId: ControlledTargetId): boolean {
    const record = this.records.get(targetId);
    if (!record || record.state !== 'active') return false;
    this.assertCallerOwns(context, record);
    const physicalKey = physicalTargetKey(record.browserInstanceId, record.cdpTargetId);
    const controller = this.controllers.get(physicalKey);
    if (
      controller?.leaseId === leaseId &&
      controller.principalId === context.principalId &&
      controller.workspaceId === context.workspaceId &&
      controller.targetId === targetId
    ) {
      this.controllers.delete(physicalKey);
      record.controllerLeaseId = undefined;
      if (this.activeByLease.get(leaseId) === targetId) this.activeByLease.delete(leaseId);
      return true;
    }
    if (this.activeByLease.get(leaseId) === targetId) this.activeByLease.delete(leaseId);
    return false;
  }

  controlledByLease(leaseId: ControlLeaseId): ControlledTargetRecord[] {
    return [...this.records.values()]
      .filter(record => record.state === 'active' && record.controllerLeaseId === leaseId)
      .map(cloneRecord);
  }

  releaseLease(leaseId: ControlLeaseId): void {
    for (const [key, controller] of this.controllers) {
      if (controller.leaseId === leaseId) this.controllers.delete(key);
    }
    for (const record of this.records.values()) {
      if (record.controllerLeaseId === leaseId) record.controllerLeaseId = undefined;
    }
    this.activeByLease.delete(leaseId);
  }

  activeTarget(
    context: WorkspaceCallerContext,
    leaseId: ControlLeaseId,
  ): ControlledTargetRecord | undefined {
    const targetId = this.activeByLease.get(leaseId);
    if (!targetId) return undefined;
    const record = this.records.get(targetId);
    if (!record || record.state !== 'active') {
      this.activeByLease.delete(leaseId);
      return undefined;
    }
    this.assertCallerOwns(context, record);
    return cloneRecord(record);
  }

  clearActive(context: WorkspaceCallerContext, leaseId: ControlLeaseId): void {
    const targetId = this.activeByLease.get(leaseId);
    if (!targetId) return;
    const record = this.records.get(targetId);
    if (record?.state === 'active') this.assertCallerOwns(context, record);
    this.activeByLease.delete(leaseId);
  }

  releaseWorkspace(context: WorkspaceCallerContext): ControlledTargetInvalidation[] {
    const invalidated: ControlledTargetInvalidation[] = [];
    for (const record of [...this.records.values()]) {
      if (
        record.state === 'active' &&
        record.principalId === context.principalId &&
        record.workspaceId === context.workspaceId
      ) {
        invalidated.push(this.invalidate(record, 'target_detached'));
      }
    }
    return invalidated;
  }

  invalidateBrowserConnection(browserInstanceId: BrowserInstanceId): ControlledTargetInvalidation[] {
    const invalidated: ControlledTargetInvalidation[] = [];
    for (const record of this.records.values()) {
      if (record.state === 'active' && record.browserInstanceId === browserInstanceId) {
        invalidated.push(this.invalidate(record, 'browser_reconnected'));
      }
    }
    return invalidated;
  }

  setActive(context: WorkspaceCallerContext, leaseId: ControlLeaseId, targetId: ControlledTargetId): void {
    const record = this.records.get(targetId);
    const controller = record
      ? this.controllers.get(physicalTargetKey(record.browserInstanceId, record.cdpTargetId))
      : undefined;
    if (
      !record ||
      record.state !== 'active' ||
      controller?.leaseId !== leaseId ||
      controller.principalId !== context.principalId ||
      controller.workspaceId !== context.workspaceId ||
      controller.targetId !== targetId
    ) {
      throw new BrowserPilotError('target_not_owned', 'Target is not controlled by this Lease', {
        context: { targetId, leaseId },
      });
    }
    this.assertCallerOwns(context, record);
    this.activeByLease.set(leaseId, targetId);
  }

  managedTargets(
    context: WorkspaceCallerContext,
    managedTabSetId: ManagedTabSetId,
  ): ControlledTargetRecord[] {
    return [...this.records.values()]
      .filter(record =>
        record.state === 'active' &&
        record.principalId === context.principalId &&
        record.workspaceId === context.workspaceId &&
        record.origin !== 'user_tab' &&
        record.managedTabSetId === managedTabSetId,
      )
      .map(cloneRecord);
  }

  activeRecords(context: WorkspaceCallerContext): ControlledTargetRecord[] {
    return [...this.records.values()]
      .filter(record =>
        record.state === 'active' &&
        record.principalId === context.principalId &&
        record.workspaceId === context.workspaceId,
      )
      .map(cloneRecord);
  }

  isManagedCdpTarget(
    browserInstanceId: BrowserInstanceId,
    cdpTargetId: string,
    browserConnectionGeneration: number,
  ): boolean {
    for (const record of this.records.values()) {
      if (
        record.browserInstanceId === browserInstanceId &&
        record.cdpTargetId === cdpTargetId &&
        record.browserConnectionGeneration === browserConnectionGeneration &&
        record.origin !== 'user_tab'
      ) return true;
    }
    return false;
  }

  markClosed(
    context: WorkspaceCallerContext,
    targetId: ControlledTargetId,
  ): ControlledTargetInvalidation[] {
    const record = this.records.get(targetId);
    if (!record || record.state !== 'active') {
      throw new BrowserPilotError('target_not_owned', 'Target is not controlled by this Workspace', {
        context: { targetId },
      });
    }
    this.assertCallerOwns(context, record);
    const invalidated: ControlledTargetInvalidation[] = [];
    for (const candidate of this.records.values()) {
      if (
        candidate.state === 'active' &&
        candidate.browserInstanceId === record.browserInstanceId &&
        candidate.cdpTargetId === record.cdpTargetId
      ) {
        invalidated.push(this.invalidate(candidate, 'target_closed'));
      }
    }
    return invalidated;
  }

  private invalidate(
    record: ControlledTargetRecord,
    reason: ControlledTargetInvalidationReason,
  ): ControlledTargetInvalidation {
    record.state = reason === 'target_closed' ? 'closed' : 'detached';
    record.invalidatedBy = reason;
    record.controllerLeaseId = undefined;
    const key = targetKey(record.workspaceId, record.browserInstanceId, record.cdpTargetId);
    if (this.activeKeys.get(key) === record.id) this.activeKeys.delete(key);
    const physicalKey = physicalTargetKey(record.browserInstanceId, record.cdpTargetId);
    if (this.controllers.get(physicalKey)?.targetId === record.id) {
      this.controllers.delete(physicalKey);
    }
    for (const [leaseId, targetId] of this.activeByLease) {
      if (targetId === record.id) this.activeByLease.delete(leaseId);
    }
    return {
      targetId: record.id,
      workspaceId: record.workspaceId,
      browserConnectionGeneration: record.browserConnectionGeneration,
      reason,
    };
  }

  private assertCallerOwns(
    context: WorkspaceCallerContext,
    record: ControlledTargetRecord,
  ): void {
    if (record.principalId === context.principalId && record.workspaceId === context.workspaceId) return;
    throw new BrowserPilotError('target_not_owned', 'Target is not controlled by this Workspace', {
      context: { targetId: record.id },
    });
  }

  private controlState(
    context: WorkspaceCallerContext,
    leaseId: ControlLeaseId,
    record: ControlledTargetRecord,
  ): TargetControlState {
    const controller = this.controllers.get(
      physicalTargetKey(record.browserInstanceId, record.cdpTargetId),
    );
    if (!controller) return 'available';
    return controller.leaseId === leaseId &&
      controller.principalId === context.principalId &&
      controller.workspaceId === context.workspaceId &&
      controller.targetId === record.id
      ? 'controlled'
      : 'busy';
  }

  private nextId(): ControlledTargetId {
    const id = this.idFactory() as ControlledTargetId;
    if (this.records.has(id)) {
      throw new BrowserPilotError('internal_error', 'Controlled target ID collision');
    }
    return id;
  }
}
