import { randomUUID } from 'node:crypto';
import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import type {
  BrowserInstanceId,
  ProfileContext,
  ProfileContextId,
} from '../protocol/model.js';

const DEFAULT_CDP_CONTEXT_KEY = '\u0000default';
const MAX_PROFILE_CONTEXTS = 128;
const MAX_PROFILE_TARGETS = 4096;
const MAX_PROFILE_CONTEXT_RECORDS = 512;

export interface ProfileTargetSnapshot {
  cdpTargetId: string;
  type: string;
  title: string;
  url: string;
  openerCdpTargetId?: string;
  cdpBrowserContextId?: string;
  eligible: boolean;
}

export interface ProfileContextRecord extends ProfileContext {
  cdpBrowserContextId?: string;
  representativeCdpTargetId?: string;
  targets: ProfileTargetSnapshot[];
  sequence: number;
  active: boolean;
}

export interface ProfileContextRegistryOptions {
  idFactory?: () => string;
}

function cloneTarget(target: ProfileTargetSnapshot): ProfileTargetSnapshot {
  return { ...target };
}

function cloneRecord(record: ProfileContextRecord): ProfileContextRecord {
  return { ...record, targets: record.targets.map(cloneTarget) };
}

function contextKey(cdpBrowserContextId: string | undefined): string {
  return cdpBrowserContextId ? `cdp:${cdpBrowserContextId}` : DEFAULT_CDP_CONTEXT_KEY;
}

export class MemoryProfileContextRegistry {
  private readonly recordsById = new Map<ProfileContextId, ProfileContextRecord>();
  private readonly currentByKey = new Map<string, ProfileContextId>();
  private readonly contextByTarget = new Map<string, ProfileContextId>();
  private readonly recordOrder: ProfileContextId[] = [];
  private readonly idFactory: () => string;
  private generation?: number;
  private nextSequence = 0;

  constructor(
    private readonly browserInstanceId: BrowserInstanceId,
    options: ProfileContextRegistryOptions = {},
  ) {
    this.idFactory = options.idFactory ?? (() => `profile-context:${randomUUID()}`);
  }

  reconcile(
    browserConnectionGeneration: number,
    targets: readonly ProfileTargetSnapshot[],
  ): ProfileContextRecord[] {
    if (!Number.isSafeInteger(browserConnectionGeneration) || browserConnectionGeneration < 1) {
      throw new BrowserPilotError('internal_error', 'Invalid browser connection generation');
    }
    if (targets.length > MAX_PROFILE_TARGETS) {
      throw new BrowserPilotError('result_too_large', 'Profile target inventory limit reached', {
        context: { maxProfileTargets: MAX_PROFILE_TARGETS },
      });
    }
    if (this.generation !== browserConnectionGeneration) {
      this.invalidateCurrent();
      this.generation = browserConnectionGeneration;
      this.nextSequence = 0;
    }

    const grouped = new Map<string, ProfileTargetSnapshot[]>();
    for (const target of targets) {
      if (target.type !== 'page') continue;
      const key = contextKey(target.cdpBrowserContextId);
      const group = grouped.get(key) ?? [];
      group.push(cloneTarget(target));
      grouped.set(key, group);
    }
    if (grouped.size > MAX_PROFILE_CONTEXTS) {
      throw new BrowserPilotError('result_too_large', 'Profile context inventory limit reached', {
        context: { maxProfileContexts: MAX_PROFILE_CONTEXTS },
      });
    }

    for (const id of this.currentByKey.values()) {
      const record = this.recordsById.get(id);
      if (record) record.active = false;
    }
    this.contextByTarget.clear();

    const activeKeys = new Set(grouped.keys());
    for (const [key, group] of grouped) {
      let id = this.currentByKey.get(key);
      let record = id ? this.recordsById.get(id) : undefined;
      if (!record) {
        id = this.nextId();
        const rawContextId = group[0]?.cdpBrowserContextId;
        record = {
          id,
          browserInstanceId: this.browserInstanceId,
          browserConnectionGeneration,
          label: `Profile ${++this.nextSequence}`,
          tabCount: 0,
          eligibleTabCount: 0,
          sequence: this.nextSequence,
          active: true,
          targets: [],
          ...(rawContextId ? { cdpBrowserContextId: rawContextId } : {}),
        };
        this.recordsById.set(id, record);
        this.recordOrder.push(id);
        this.currentByKey.set(key, id);
      }

      const sorted = [...group].sort((left, right) => (
        Number(right.eligible) - Number(left.eligible) ||
        left.cdpTargetId.localeCompare(right.cdpTargetId)
      ));
      record.active = true;
      record.tabCount = sorted.length;
      record.eligibleTabCount = sorted.filter(target => target.eligible).length;
      record.targets = sorted;
      record.representativeCdpTargetId = sorted[0]?.cdpTargetId;
      for (const target of sorted) this.contextByTarget.set(target.cdpTargetId, record.id);
    }

    for (const [key, id] of this.currentByKey) {
      if (activeKeys.has(key)) continue;
      const record = this.recordsById.get(id);
      if (record) record.active = false;
      this.currentByKey.delete(key);
    }
    this.pruneStaleRecords();
    return this.list(browserConnectionGeneration);
  }

  list(browserConnectionGeneration: number): ProfileContextRecord[] {
    return [...this.currentByKey.values()]
      .map(id => this.recordsById.get(id))
      .filter((record): record is ProfileContextRecord => (
        record !== undefined &&
        record.active &&
        record.browserConnectionGeneration === browserConnectionGeneration
      ))
      .sort((left, right) => left.sequence - right.sequence)
      .map(cloneRecord);
  }

  resolve(
    profileContextId: ProfileContextId,
    browserConnectionGeneration: number,
  ): ProfileContextRecord {
    const record = this.recordsById.get(profileContextId);
    if (!record) throw invalidArgument('Unknown Profile context', 'profileContextId');
    if (
      !record.active ||
      record.browserInstanceId !== this.browserInstanceId ||
      record.browserConnectionGeneration !== browserConnectionGeneration
    ) {
      throw new BrowserPilotError('profile_context_stale', 'Profile context belongs to a stale browser connection', {
        retryable: true,
        context: {
          profileContextId,
          expectedConnectionGeneration: browserConnectionGeneration,
        },
        remediation: {
          code: 'relist_profile_contexts',
          message: 'List Profile contexts again and select one from the current browser connection.',
          actionRequired: true,
        },
      });
    }
    return cloneRecord(record);
  }

  forTarget(
    cdpTargetId: string,
    browserConnectionGeneration: number,
  ): ProfileContextRecord | undefined {
    const id = this.contextByTarget.get(cdpTargetId);
    if (!id) return undefined;
    return this.resolve(id, browserConnectionGeneration);
  }

  forRawContext(
    cdpBrowserContextId: string | undefined,
    browserConnectionGeneration: number,
  ): ProfileContextRecord | undefined {
    const id = this.currentByKey.get(contextKey(cdpBrowserContextId));
    if (!id) return undefined;
    return this.resolve(id, browserConnectionGeneration);
  }

  invalidate(): void {
    this.invalidateCurrent();
    this.generation = undefined;
    this.nextSequence = 0;
  }

  private invalidateCurrent(): void {
    for (const id of this.currentByKey.values()) {
      const record = this.recordsById.get(id);
      if (record) record.active = false;
    }
    this.currentByKey.clear();
    this.contextByTarget.clear();
  }

  private pruneStaleRecords(): void {
    while (this.recordsById.size > MAX_PROFILE_CONTEXT_RECORDS) {
      const id = this.recordOrder.shift();
      if (!id) return;
      const record = this.recordsById.get(id);
      if (!record || record.active) {
        if (record?.active) this.recordOrder.push(id);
        continue;
      }
      this.recordsById.delete(id);
    }
  }

  private nextId(): ProfileContextId {
    const id = this.idFactory() as ProfileContextId;
    if (!/^profile-context:[A-Za-z0-9._:-]+$/.test(id) || this.recordsById.has(id)) {
      throw new BrowserPilotError('internal_error', 'Profile context ID factory returned an invalid or duplicate ID');
    }
    return id;
  }
}
