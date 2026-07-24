import { BrowserPilotError } from '../protocol/errors.js';
import type { BrowserInstanceId } from '../protocol/model.js';
import type { Transport } from '../transport.js';
import type {
  BrowserTargetCatalog,
  EligibleUserTarget,
} from './browser-control-policy.js';

export interface BrowserIdentitySnapshot {
  profileIdentity: string;
  connectionGeneration: number;
}

export type BrowserIdentityProvider = () => BrowserIdentitySnapshot | undefined;

export interface BrowserTargetCandidate extends EligibleUserTarget {
  type: string;
}

export interface CdpBrowserTargetCatalogOptions {
  isExcludedTarget: (target: BrowserTargetCandidate) => boolean;
}

export function isEligibleUserPage(target: BrowserTargetCandidate): boolean {
  if (target.type !== 'page') return false;
  try {
    const url = new URL(target.url);
    return !new Set([
      'devtools:',
      'chrome:',
      'chrome-untrusted:',
      'edge:',
      'brave:',
      'vivaldi:',
    ]).has(url.protocol);
  } catch {
    return target.url === 'about:blank';
  }
}

export class CdpBrowserTargetCatalog implements BrowserTargetCatalog {
  constructor(
    private readonly transport: Transport,
    private readonly browserInstanceId: BrowserInstanceId,
    private readonly identity: BrowserIdentityProvider,
    private readonly options: CdpBrowserTargetCatalogOptions,
  ) {}

  async getBrowserIdentity(browserInstanceId: BrowserInstanceId): Promise<BrowserIdentitySnapshot | undefined> {
    return browserInstanceId === this.browserInstanceId ? this.identity() : undefined;
  }

  async listEligibleUserTargets(browserInstanceId: BrowserInstanceId): Promise<EligibleUserTarget[]> {
    if (browserInstanceId !== this.browserInstanceId || !this.identity()) return [];
    const result = await this.transport.send('Target.getTargets');
    if (!Array.isArray(result?.targetInfos)) {
      throw new BrowserPilotError('internal_error', 'Chrome returned invalid target metadata');
    }

    const eligible: EligibleUserTarget[] = [];
    for (const value of result.targetInfos) {
      if (!value || typeof value !== 'object' || typeof value.targetId !== 'string') continue;
      const candidate: BrowserTargetCandidate = {
        cdpTargetId: value.targetId,
        title: typeof value.title === 'string' ? value.title : '',
        url: typeof value.url === 'string' && value.url ? value.url : 'about:blank',
        type: typeof value.type === 'string' ? value.type : '',
        ...(typeof value.openerId === 'string' ? { openerCdpTargetId: value.openerId } : {}),
      };
      if (!isEligibleUserPage(candidate) || this.options.isExcludedTarget(candidate)) continue;
      const { type: _type, ...target } = candidate;
      eligible.push(target);
    }
    return eligible;
  }
}
