import { BrowserPilotError } from '../protocol/errors.js';
import type {
  BrowserOperation,
  BrowserInstanceId,
  ControlledTargetId,
  ControlLeaseId,
  ManagedTabSetId,
} from '../protocol/model.js';
import type { Transport } from '../transport.js';
import type {
  BrowserControlPolicy,
  WorkspaceCallerContext,
} from './browser-control-policy.js';
import {
  MemoryControlledTargetRegistry,
  type ControlledTargetInvalidation,
  type ControlledTargetRecord,
  type ControlledTargetView,
  type LiveTargetMetadata,
} from './controlled-target-registry.js';

export interface TargetInventoryContext extends WorkspaceCallerContext {
  leaseId: ControlLeaseId;
}

export interface RegisterManagedTargetInput extends TargetInventoryContext {
  managedTabSetId: ManagedTabSetId;
  cdpTargetId: string;
  openerCdpTargetId?: string;
  origin?: 'managed' | 'managed_popup';
  title?: string;
  url?: string;
}

export interface ResolvedControlledTarget {
  targetId: ControlledTargetId;
  browserInstanceId: BrowserInstanceId;
  cdpTargetId: string;
  origin: ControlledTargetRecord['origin'];
  managedTabSetId?: ManagedTabSetId;
  newlyAcquired: boolean;
}

export interface ManagedTabSetCloseResult {
  closed: ControlledTargetId[];
  failed: Array<{ targetId: ControlledTargetId; code: string }>;
}

export interface TargetInventoryServiceOptions {
  onInvalidated?: (invalidation: ControlledTargetInvalidation) => void;
  onTargetAttached?: (target: ControlledTargetRecord) => void;
  onPopup?: (target: ControlledTargetRecord) => void;
  onControlAcquired?: (target: ControlledTargetRecord, leaseId: ControlLeaseId) => void;
  onControlReleased?: (target: ControlledTargetRecord, leaseId: ControlLeaseId) => void;
}

interface RootTargetInfo extends LiveTargetMetadata {
  type?: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export class TargetInventoryService {
  private readonly onInvalidated?: (invalidation: ControlledTargetInvalidation) => void;
  private readonly onTargetAttached?: (target: ControlledTargetRecord) => void;
  private readonly onPopup?: (target: ControlledTargetRecord) => void;
  private readonly onControlAcquired?: TargetInventoryServiceOptions['onControlAcquired'];
  private readonly onControlReleased?: TargetInventoryServiceOptions['onControlReleased'];

  constructor(
    private readonly transport: Transport,
    private readonly browserInstanceId: BrowserInstanceId,
    private readonly policy: BrowserControlPolicy,
    private readonly registry: MemoryControlledTargetRegistry,
    options: TargetInventoryServiceOptions = {},
  ) {
    this.onInvalidated = options.onInvalidated;
    this.onTargetAttached = options.onTargetAttached;
    this.onPopup = options.onPopup;
    this.onControlAcquired = options.onControlAcquired;
    this.onControlReleased = options.onControlReleased;
  }

  registerManagedTarget(input: RegisterManagedTargetInput): ControlledTargetRecord {
    return this.registry.registerManaged({
      principalId: input.principalId,
      workspaceId: input.workspaceId,
      browserInstanceId: this.browserInstanceId,
      managedTabSetId: input.managedTabSetId,
      cdpTargetId: input.cdpTargetId,
      ...(input.openerCdpTargetId ? { openerCdpTargetId: input.openerCdpTargetId } : {}),
      origin: input.origin ?? 'managed',
      title: input.title ?? '',
      url: input.url || 'about:blank',
    });
  }

  async list(
    context: TargetInventoryContext,
    scope: 'all' | 'managed_only' | 'user_tabs' = 'all',
  ): Promise<ControlledTargetView[]> {
    this.policy.assertOperation('tabs.list');
    await this.refresh(context);
    return this.registry.list(context, context.leaseId, scope);
  }

  async refresh(context: TargetInventoryContext): Promise<ControlledTargetInvalidation[]> {
    const controlledBefore = new Map(
      this.registry.activeRecords(context)
        .filter(target => target.controllerLeaseId)
        .map(target => [target.id, target]),
    );
    const liveTargets = await this.readLiveTargets();
    this.adoptManagedPopups(context, liveTargets);

    const userTargets = (await this.policy.listUserTargets(this.browserInstanceId))
      .filter(target => target.browserInstanceId === this.browserInstanceId);
    const synchronized = this.registry.syncUserTargets(
      context,
      this.browserInstanceId,
      userTargets,
    );
    for (const target of synchronized.created) this.notify(this.onTargetAttached, target);
    const invalidated = [
      ...synchronized.invalidated,
      ...this.registry.reconcileBrowserTargets(context, this.browserInstanceId, liveTargets),
    ];
    for (const invalidation of invalidated) {
      const target = controlledBefore.get(invalidation.targetId);
      if (target?.controllerLeaseId) {
        this.notify(this.onControlReleased, target, target.controllerLeaseId);
      }
    }
    this.emitInvalidations(invalidated);
    return invalidated;
  }

  async activate(
    context: TargetInventoryContext,
    targetId: ControlledTargetId,
  ): Promise<ResolvedControlledTarget> {
    const resolved = await this.resolveForOperation(context, targetId, 'tabs.list');
    try {
      await this.transport.send('Target.activateTarget', { targetId: resolved.cdpTargetId });
      this.registry.setActive(context, context.leaseId, targetId);
      return resolved;
    } catch (error) {
      if (resolved.newlyAcquired && this.registry.release(context, context.leaseId, targetId)) {
        this.notify(this.onControlReleased, this.registry.get(context, targetId), context.leaseId);
      }
      throw error;
    }
  }

  async resolveForOperation(
    context: TargetInventoryContext,
    targetId: ControlledTargetId,
    operation: BrowserOperation,
  ): Promise<ResolvedControlledTarget> {
    const target = this.registry.get(context, targetId);
    if (target.browserInstanceId !== this.browserInstanceId) {
      throw new BrowserPilotError('target_not_owned', 'Target belongs to another browser instance', {
        context: { targetId },
      });
    }
    this.policy.assertOperation(operation);
    const acquisition = this.registry.acquire(context, context.leaseId, targetId);
    if (acquisition.newlyAcquired) {
      this.notify(this.onControlAcquired, acquisition.target, context.leaseId);
    }
    return {
      targetId,
      browserInstanceId: this.browserInstanceId,
      cdpTargetId: acquisition.target.cdpTargetId,
      origin: acquisition.target.origin,
      ...(acquisition.target.managedTabSetId
        ? { managedTabSetId: acquisition.target.managedTabSetId }
        : {}),
      newlyAcquired: acquisition.newlyAcquired,
    };
  }

  async close(
    context: TargetInventoryContext,
    targetId: ControlledTargetId,
  ): Promise<ControlledTargetInvalidation> {
    const resolved = await this.resolveForOperation(context, targetId, 'tabs.close');
    const controlled = this.registry.get(context, targetId);
    try {
      const result = await this.transport.send('Target.closeTarget', { targetId: resolved.cdpTargetId });
      if (result?.success === false) {
        throw new BrowserPilotError('internal_error', 'Chrome refused to close the target', {
          retryable: true,
          context: { targetId },
        });
      }
      const invalidations = this.registry.markClosed(context, targetId);
      this.notify(this.onControlReleased, controlled, context.leaseId);
      this.emitInvalidations(invalidations);
      return invalidations.find(invalidation => invalidation.targetId === targetId)!;
    } catch (error) {
      if (resolved.newlyAcquired && this.registry.release(context, context.leaseId, targetId)) {
        this.notify(this.onControlReleased, controlled, context.leaseId);
      }
      throw error;
    }
  }

  async closeManagedTabSet(
    context: TargetInventoryContext,
    managedTabSetId: ManagedTabSetId,
  ): Promise<ManagedTabSetCloseResult> {
    const closed: ControlledTargetId[] = [];
    const failed: Array<{ targetId: ControlledTargetId; code: string }> = [];
    const targets = this.registry.managedTargets(context, managedTabSetId);
    for (const target of targets) {
      try {
        await this.close(context, target.id);
        closed.push(target.id);
      } catch (error) {
        failed.push({
          targetId: target.id,
          code: error instanceof BrowserPilotError ? error.code : 'internal_error',
        });
      }
    }
    return { closed, failed };
  }

  releaseTarget(
    context: TargetInventoryContext,
    targetId: ControlledTargetId,
  ): void {
    const target = this.registry.get(context, targetId);
    if (this.registry.release(context, context.leaseId, targetId)) {
      this.notify(this.onControlReleased, target, context.leaseId);
    }
  }

  releaseLease(leaseId: ControlLeaseId): void {
    const controlled = this.registry.controlledByLease(leaseId);
    this.registry.releaseLease(leaseId);
    for (const target of controlled) this.notify(this.onControlReleased, target, leaseId);
  }

  activeTarget(context: TargetInventoryContext): ControlledTargetRecord | undefined {
    return this.registry.activeTarget(context, context.leaseId);
  }

  releaseWorkspace(context: WorkspaceCallerContext): ControlledTargetInvalidation[] {
    const controlled = this.registry.activeRecords(context).filter(target => target.controllerLeaseId);
    const invalidated = this.registry.releaseWorkspace(context);
    for (const target of controlled) {
      this.notify(this.onControlReleased, target, target.controllerLeaseId!);
    }
    this.emitInvalidations(invalidated);
    return invalidated;
  }

  private async readLiveTargets(): Promise<Map<string, RootTargetInfo>> {
    const result = await this.transport.send('Target.getTargets');
    if (!Array.isArray(result?.targetInfos)) {
      throw new BrowserPilotError('internal_error', 'Chrome returned invalid target metadata');
    }
    const targets = new Map<string, RootTargetInfo>();
    for (const value of result.targetInfos) {
      if (!value || typeof value !== 'object') continue;
      const targetId = readString(value.targetId);
      if (!targetId) continue;
      const url = readString(value.url);
      targets.set(targetId, {
        cdpTargetId: targetId,
        title: readString(value.title) ?? '',
        url: url || 'about:blank',
        ...(readString(value.openerId)
          ? { openerCdpTargetId: readString(value.openerId)! }
          : {}),
        ...(readString(value.type) ? { type: readString(value.type) } : {}),
      });
    }
    return targets;
  }

  private adoptManagedPopups(
    context: TargetInventoryContext,
    liveTargets: ReadonlyMap<string, RootTargetInfo>,
  ): void {
    const active = new Map(
      this.registry.activeRecords(context).map(record => [record.cdpTargetId, record]),
    );
    let adopted = true;
    while (adopted) {
      adopted = false;
      for (const target of liveTargets.values()) {
        if (active.has(target.cdpTargetId) || (target.type && target.type !== 'page')) continue;
        const ancestor = this.findManagedAncestor(target, active, liveTargets);
        if (!ancestor?.managedTabSetId) continue;
        const record = this.registry.registerManaged({
          principalId: context.principalId,
          workspaceId: context.workspaceId,
          browserInstanceId: this.browserInstanceId,
          managedTabSetId: ancestor.managedTabSetId,
          cdpTargetId: target.cdpTargetId,
          ...(target.openerCdpTargetId ? { openerCdpTargetId: target.openerCdpTargetId } : {}),
          origin: 'managed_popup',
          title: target.title,
          url: target.url,
        });
        active.set(record.cdpTargetId, record);
        this.notify(this.onTargetAttached, record);
        this.notify(this.onPopup, record);
        adopted = true;
      }
    }
  }

  private findManagedAncestor(
    target: RootTargetInfo,
    active: ReadonlyMap<string, ControlledTargetRecord>,
    liveTargets: ReadonlyMap<string, RootTargetInfo>,
  ): ControlledTargetRecord | undefined {
    let opener = target.openerCdpTargetId;
    const visited = new Set<string>([target.cdpTargetId]);
    while (opener) {
      if (visited.has(opener)) return undefined;
      visited.add(opener);
      const controlled = active.get(opener);
      if (controlled) {
        return controlled.origin === 'user_tab' ? undefined : controlled;
      }
      opener = liveTargets.get(opener)?.openerCdpTargetId;
    }
    return undefined;
  }

  private emitInvalidations(invalidations: readonly ControlledTargetInvalidation[]): void {
    if (!this.onInvalidated) return;
    for (const invalidation of invalidations) {
      try { this.onInvalidated(invalidation); } catch { /* observers cannot block target invalidation */ }
    }
  }

  private notify<T extends unknown[]>(
    listener: ((...args: T) => void) | undefined,
    ...args: T
  ): void {
    if (!listener) return;
    try { listener(...args); } catch { /* observers cannot block target operations */ }
  }
}
