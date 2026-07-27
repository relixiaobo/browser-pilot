import { BrowserPilotError } from '../protocol/errors.js';
import type { BrowserInstanceId } from '../protocol/model.js';
import type { Transport } from '../transport.js';
import type {
  BrowserTargetCatalog,
  EligibleUserTarget,
} from './browser-control-policy.js';
import {
  MemoryProfileContextRegistry,
  type ProfileTargetSnapshot,
} from './profile-context-registry.js';

export interface BrowserIdentitySnapshot {
  profileIdentity: string;
  connectionGeneration: number;
}

export type BrowserIdentityProvider = () => BrowserIdentitySnapshot | undefined;

export interface BrowserTargetCandidate {
  cdpTargetId: string;
  title: string;
  url: string;
  openerCdpTargetId?: string;
  type: string;
}

export interface CdpBrowserTargetCatalogOptions {
  isExcludedTarget: (target: BrowserTargetCandidate) => boolean;
  profileContexts?: MemoryProfileContextRegistry;
}

export function isEligibleUserPage(target: BrowserTargetCandidate): boolean {
  if (target.type !== 'page') return false;
  try {
    const url = new URL(target.url);
    return !new Set([
      'devtools:',
      'chrome:',
      'chrome-extension:',
      'chrome-untrusted:',
      'edge:',
      'edge-extension:',
      'brave:',
      'vivaldi:',
    ]).has(url.protocol);
  } catch {
    return target.url === 'about:blank';
  }
}

function isExtensionPage(target: BrowserTargetCandidate): boolean {
  try {
    const protocol = new URL(target.url).protocol;
    return protocol === 'chrome-extension:' || protocol === 'edge-extension:';
  } catch {
    return false;
  }
}

export class CdpBrowserTargetCatalog implements BrowserTargetCatalog {
  private readonly profileContexts: MemoryProfileContextRegistry;

  constructor(
    private readonly transport: Transport,
    private readonly browserInstanceId: BrowserInstanceId,
    private readonly identity: BrowserIdentityProvider,
    private readonly options: CdpBrowserTargetCatalogOptions,
  ) {
    this.profileContexts = options.profileContexts ?? new MemoryProfileContextRegistry(browserInstanceId);
  }

  async getBrowserIdentity(browserInstanceId: BrowserInstanceId): Promise<BrowserIdentitySnapshot | undefined> {
    return browserInstanceId === this.browserInstanceId ? this.identity() : undefined;
  }

  async listEligibleUserTargets(browserInstanceId: BrowserInstanceId): Promise<EligibleUserTarget[]> {
    const identity = this.identity();
    if (browserInstanceId !== this.browserInstanceId || !identity) return [];
    const result = await this.transport.send('Target.getTargets');
    if (!Array.isArray(result?.targetInfos)) {
      throw new BrowserPilotError('internal_error', 'Chrome returned invalid target metadata');
    }

    const candidates: BrowserTargetCandidate[] = [];
    const snapshots: ProfileTargetSnapshot[] = [];
    for (const value of result.targetInfos) {
      if (!value || typeof value !== 'object' || typeof value.targetId !== 'string') continue;
      const candidate: BrowserTargetCandidate = {
        cdpTargetId: value.targetId,
        title: typeof value.title === 'string' ? value.title : '',
        url: typeof value.url === 'string' && value.url ? value.url : 'about:blank',
        type: typeof value.type === 'string' ? value.type : '',
        ...(typeof value.openerId === 'string' ? { openerCdpTargetId: value.openerId } : {}),
      };
      // Extension-owned pages are implementation details, not ordinary browser
      // tabs or evidence that an Agent can use to identify a Chrome Profile.
      if (isExtensionPage(candidate)) continue;
      const eligible = isEligibleUserPage(candidate) && !this.options.isExcludedTarget(candidate);
      snapshots.push({
        ...candidate,
        eligible,
        ...(typeof value.browserContextId === 'string'
          ? { cdpBrowserContextId: value.browserContextId }
          : {}),
      });
      if (eligible) candidates.push(candidate);
    }
    this.profileContexts.reconcile(identity.connectionGeneration, snapshots);

    const eligible: EligibleUserTarget[] = [];
    for (const candidate of candidates) {
      const profile = this.profileContexts.forTarget(
        candidate.cdpTargetId,
        identity.connectionGeneration,
      );
      if (!profile) continue;
      const { type: _type, ...target } = candidate;
      eligible.push({ ...target, profileContextId: profile.id });
    }
    return eligible;
  }
}
