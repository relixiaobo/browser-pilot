import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import type { Transport } from '../transport.js';
import { isEligibleUserPage } from './browser-target-catalog.js';

export interface DiscoveredTarget {
  targetId: string;
  url: string;
  openerTargetId?: string;
}

export interface TargetDiscoveryProvider {
  discoveredTargets(): Promise<DiscoveredTarget[]>;
}

export interface BrowserTab {
  targetId: string;
  index: number;
  url: string;
  title: string;
  active: boolean;
  origin: 'managed' | 'user_tab';
}

export interface TargetListResult {
  tabs: BrowserTab[];
  managedTargetIds: string[];
  adoptedTargetIds: string[];
}

function validatesOwnedOpenerChain(
  target: DiscoveredTarget,
  owned: ReadonlySet<string>,
  discovered: ReadonlyMap<string, DiscoveredTarget>,
): boolean {
  let opener = target.openerTargetId;
  const visited = new Set<string>([target.targetId]);
  while (opener) {
    if (owned.has(opener)) return true;
    if (visited.has(opener)) return false;
    visited.add(opener);
    const parent = discovered.get(opener);
    if (!parent) return false;
    opener = parent.openerTargetId;
  }
  return false;
}

export class TargetService {
  constructor(
    private readonly transport: Transport,
    private readonly discovery: TargetDiscoveryProvider,
  ) {}

  async list(
    managedTargetIds: readonly string[],
    activeTargetId: string,
  ): Promise<TargetListResult> {
    const { targetInfos } = await this.transport.send('Target.getTargets');
    if (!Array.isArray(targetInfos)) {
      throw new BrowserPilotError('internal_error', 'Chrome returned invalid target metadata');
    }
    const existing = new Map<string, any>();
    for (const target of targetInfos) {
      if (target && typeof target.targetId === 'string') existing.set(target.targetId, target);
    }

    const retained = [...new Set(managedTargetIds)].filter(targetId => existing.has(targetId));
    const owned = new Set(retained);
    const discoveredTargets = await this.discovery.discoveredTargets();
    const discovered = new Map(discoveredTargets.map(target => [target.targetId, target]));
    const adoptedTargetIds: string[] = [];

    for (const target of discoveredTargets) {
      if (
        owned.has(target.targetId) ||
        !existing.has(target.targetId) ||
        !validatesOwnedOpenerChain(target, owned, discovered)
      ) continue;
      owned.add(target.targetId);
      retained.push(target.targetId);
      adoptedTargetIds.push(target.targetId);
    }

    const managedTabs = retained.map(targetId => {
      const target = existing.get(targetId)!;
      return {
        targetId,
        url: typeof target.url === 'string' && target.url ? target.url : 'about:blank',
        title: typeof target.title === 'string' ? target.title : '',
        active: targetId === activeTargetId,
        origin: 'managed' as const,
      };
    });

    const userTabs = [...existing.values()]
      .filter(target => !owned.has(target.targetId))
      .filter(target => isEligibleUserPage({
        cdpTargetId: target.targetId,
        title: typeof target.title === 'string' ? target.title : '',
        url: typeof target.url === 'string' && target.url ? target.url : 'about:blank',
        type: typeof target.type === 'string' ? target.type : '',
        ...(typeof target.openerId === 'string' ? { openerCdpTargetId: target.openerId } : {}),
      }))
      .map(target => ({
        targetId: target.targetId as string,
        url: typeof target.url === 'string' && target.url ? target.url : 'about:blank',
        title: typeof target.title === 'string' ? target.title : '',
        active: target.targetId === activeTargetId,
        origin: 'user_tab' as const,
      }));
    const tabs = [...managedTabs, ...userTabs].map((tab, index) => ({ ...tab, index }));
    return { tabs, managedTargetIds: retained, adoptedTargetIds };
  }

  async activateByIndex(targetIds: readonly string[], index: number): Promise<string> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= targetIds.length) {
      throw invalidArgument(`Tab index out of range (0-${targetIds.length - 1})`, 'index');
    }
    const targetId = targetIds[index];
    await this.transport.send('Target.activateTarget', { targetId });
    return targetId;
  }

  async close(visibleTargetIds: readonly string[], targetId: string): Promise<void> {
    if (!visibleTargetIds.includes(targetId)) {
      throw new BrowserPilotError('target_not_owned', 'Target is not visible in this browser context', {
        context: { targetId },
      });
    }
    await this.transport.send('Target.closeTarget', { targetId });
  }

  async closeManaged(managedTargetIds: readonly string[]): Promise<{ closed: string[]; failed: string[] }> {
    const closed: string[] = [];
    const failed: string[] = [];
    for (const targetId of [...new Set(managedTargetIds)]) {
      try {
        await this.transport.send('Target.closeTarget', { targetId });
        closed.push(targetId);
      } catch {
        failed.push(targetId);
      }
    }
    return { closed, failed };
  }
}
