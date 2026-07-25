import { randomUUID } from 'node:crypto';
import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import type {
  BrowserEvent,
  BrowserEventId,
  BrowserEventType,
  BrowserWorkspaceId,
  ControlledTargetId,
  ControlLeaseId,
  EventCursor,
  EventsPollResult,
  JsonValue,
  Sensitivity,
} from '../protocol/model.js';

export interface PublishBrowserEventInput {
  workspaceId: BrowserWorkspaceId;
  browserConnectionGeneration: number;
  leaseId?: ControlLeaseId;
  targetId?: ControlledTargetId;
  type: BrowserEventType;
  payloadVersion?: number;
  sensitivity: Sensitivity;
  payload: JsonValue;
}

export interface MemoryEventJournalOptions {
  maxEventsPerWorkspace?: number;
  now?: () => number;
  idFactory?: () => string;
  onPublished?: (event: BrowserEvent) => void;
}

interface WorkspaceJournal {
  nextSequence: number;
  events: BrowserEvent[];
}

const EVENT_ID_PATTERN = /^event:[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const CURSOR_PATTERN = /^cursor:(0|[1-9][0-9]{0,15})$/;

function cloneEvent(event: BrowserEvent): BrowserEvent {
  return structuredClone(event);
}

function cursor(sequence: number): EventCursor {
  return `cursor:${sequence}` as EventCursor;
}

function parseCursor(value: EventCursor): number {
  if (!CURSOR_PATTERN.test(value)) throw invalidArgument('Event cursor has an invalid format', 'cursor');
  const sequence = Number(value.slice('cursor:'.length));
  if (!Number.isSafeInteger(sequence)) throw invalidArgument('Event cursor is outside the supported range', 'cursor');
  return sequence;
}

export class MemoryEventJournal {
  private readonly journals = new Map<BrowserWorkspaceId, WorkspaceJournal>();
  private readonly retainedEventIds = new Set<BrowserEventId>();
  private readonly maxEventsPerWorkspace: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly listeners = new Set<(event: BrowserEvent) => void>();

  constructor(options: MemoryEventJournalOptions = {}) {
    this.maxEventsPerWorkspace = options.maxEventsPerWorkspace ?? 1000;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => `event:${randomUUID()}`);
    if (options.onPublished) this.listeners.add(options.onPublished);
    if (!Number.isSafeInteger(this.maxEventsPerWorkspace) || this.maxEventsPerWorkspace <= 0) {
      throw new Error('Invalid Event Journal capacity');
    }
  }

  createWorkspace(workspaceId: BrowserWorkspaceId): EventCursor {
    if (this.journals.has(workspaceId)) {
      throw new BrowserPilotError('internal_error', 'Workspace Event Journal already exists', {
        context: { workspaceId },
      });
    }
    this.journals.set(workspaceId, { nextSequence: 1, events: [] });
    return cursor(0);
  }

  currentCursor(workspaceId: BrowserWorkspaceId): EventCursor {
    const journal = this.requireJournal(workspaceId);
    return cursor(journal.nextSequence - 1);
  }

  publish(input: PublishBrowserEventInput): BrowserEvent {
    const journal = this.requireJournal(input.workspaceId);
    if (
      !Number.isSafeInteger(input.browserConnectionGeneration) ||
      input.browserConnectionGeneration < 1
    ) {
      throw invalidArgument(
        'Event browserConnectionGeneration must be a positive integer',
        'browserConnectionGeneration',
      );
    }
    if (!Number.isSafeInteger(input.payloadVersion ?? 1) || (input.payloadVersion ?? 1) <= 0) {
      throw invalidArgument('Event payloadVersion must be a positive integer', 'payloadVersion');
    }
    const id = this.idFactory() as BrowserEventId;
    if (!EVENT_ID_PATTERN.test(id) || this.retainedEventIds.has(id)) {
      throw new BrowserPilotError('internal_error', 'Invalid or duplicate Browser Event ID');
    }
    const event: BrowserEvent = {
      id,
      sequence: journal.nextSequence++,
      timestamp: this.now(),
      workspaceId: input.workspaceId,
      browserConnectionGeneration: input.browserConnectionGeneration,
      ...(input.leaseId ? { leaseId: input.leaseId } : {}),
      ...(input.targetId ? { targetId: input.targetId } : {}),
      type: input.type,
      payloadVersion: input.payloadVersion ?? 1,
      sensitivity: input.sensitivity,
      payload: structuredClone(input.payload),
    };
    journal.events.push(event);
    this.retainedEventIds.add(id);
    if (journal.events.length > this.maxEventsPerWorkspace) {
      const compacted = journal.events.shift();
      if (compacted) this.retainedEventIds.delete(compacted.id);
    }
    for (const listener of this.listeners) {
      try { listener(cloneEvent(event)); } catch { /* delivery cannot block journal writes */ }
    }
    return cloneEvent(event);
  }

  subscribe(listener: (event: BrowserEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  poll(
    workspaceId: BrowserWorkspaceId,
    after: EventCursor,
    limit = 100,
  ): EventsPollResult {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw invalidArgument('Event poll limit must be from 1 through 1000', 'limit');
    }
    const journal = this.requireJournal(workspaceId);
    const afterSequence = parseCursor(after);
    const latestSequence = journal.nextSequence - 1;
    if (afterSequence > latestSequence) {
      throw invalidArgument('Event cursor is ahead of this Workspace journal', 'cursor');
    }
    const earliestSequence = journal.events[0]?.sequence ?? journal.nextSequence;
    if (afterSequence < earliestSequence - 1) {
      throw new BrowserPilotError('cursor_expired', 'Event cursor is older than the retained Workspace journal', {
        context: {
          workspaceId,
          cursor: after,
          earliestCursor: cursor(earliestSequence - 1),
          latestCursor: cursor(latestSequence),
        },
      });
    }
    const events = journal.events
      .filter(event => event.sequence > afterSequence)
      .slice(0, limit)
      .map(cloneEvent);
    const nextSequence = events.at(-1)?.sequence ?? afterSequence;
    return {
      workspaceId,
      events,
      nextCursor: cursor(nextSequence),
      hasMore: nextSequence < latestSequence,
    };
  }

  releaseWorkspace(workspaceId: BrowserWorkspaceId): void {
    for (const event of this.journals.get(workspaceId)?.events ?? []) {
      this.retainedEventIds.delete(event.id);
    }
    this.journals.delete(workspaceId);
  }

  size(workspaceId?: BrowserWorkspaceId): number {
    if (workspaceId) return this.journals.get(workspaceId)?.events.length ?? 0;
    return [...this.journals.values()].reduce((total, journal) => total + journal.events.length, 0);
  }

  private requireJournal(workspaceId: BrowserWorkspaceId): WorkspaceJournal {
    const journal = this.journals.get(workspaceId);
    if (!journal) {
      throw new BrowserPilotError('workspace_not_found', 'Workspace Event Journal was not found', {
        context: { workspaceId },
      });
    }
    return journal;
  }
}
