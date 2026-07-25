import type {
  BrowserWorkspaceId,
  ControlledTargetId,
  ControlLeaseId,
  FrameId,
} from '../protocol/model.js';
import type { PublishBrowserEventInput } from './event-journal.js';

export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
export const DEFAULT_DIALOG_TIMEOUT_MS = 15_000;
export const DEFAULT_NO_PROGRESS_THRESHOLD = 3;

type WatchdogTimer = ReturnType<typeof setTimeout>;

export interface BrowserWatchdogContext {
  workspaceId: BrowserWorkspaceId;
  leaseId: ControlLeaseId;
  targetId: ControlledTargetId;
  browserConnectionGeneration: number;
}

export interface WatchdogActionEvidence {
  action: 'click' | 'type' | 'keyboard' | 'press' | 'upload';
  status: 'verified' | 'mismatch' | 'unavailable';
  reason?: string;
  effects?: readonly string[];
}

export interface BrowserWatchdogServiceOptions {
  dialogTimeoutMs?: number;
  noProgressThreshold?: number;
  setTimer?: (callback: () => void, delayMs: number) => WatchdogTimer;
  clearTimer?: (timer: WatchdogTimer) => void;
}

interface PendingDialogWatchdog extends BrowserWatchdogContext {
  dialogId: string;
  dialogType: string;
  openedAt: number;
  timer: WatchdogTimer;
}

interface NoProgressStreak extends BrowserWatchdogContext {
  count: number;
  emitted: boolean;
}

const OBSERVABLE_NO_PROGRESS_REASONS = new Set([
  'expected_state_unchanged',
  'file_count_mismatch',
  'file_name_mismatch',
  'no_observable_effect',
  'value_mismatch',
]);

function targetKey(leaseId: ControlLeaseId, targetId: ControlledTargetId): string {
  return `${leaseId}\u0000${targetId}`;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

export class BrowserWatchdogService {
  private readonly dialogTimeoutMs: number;
  private readonly noProgressThreshold: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => WatchdogTimer;
  private readonly clearTimer: (timer: WatchdogTimer) => void;
  private readonly dialogs = new Map<string, PendingDialogWatchdog>();
  private readonly noProgress = new Map<string, NoProgressStreak>();

  constructor(
    private readonly publish: (event: PublishBrowserEventInput) => void,
    options: BrowserWatchdogServiceOptions = {},
  ) {
    this.dialogTimeoutMs = options.dialogTimeoutMs ?? DEFAULT_DIALOG_TIMEOUT_MS;
    this.noProgressThreshold = options.noProgressThreshold ?? DEFAULT_NO_PROGRESS_THRESHOLD;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    assertPositiveInteger(this.dialogTimeoutMs, 'dialogTimeoutMs');
    assertPositiveInteger(this.noProgressThreshold, 'noProgressThreshold');
  }

  navigationStalled(
    context: BrowserWatchdogContext,
    input: { url: string; timeoutMs: number },
  ): void {
    this.resetTarget(context.leaseId, context.targetId);
    this.publish({
      ...context,
      type: 'watchdog.navigation_stalled',
      sensitivity: 'browser_data',
      payload: {
        url: input.url,
        timeoutMs: input.timeoutMs,
        outcome: 'unknown',
      },
    });
  }

  frameDetached(context: BrowserWatchdogContext, frameId: FrameId): void {
    this.resetTarget(context.leaseId, context.targetId);
    this.publish({
      ...context,
      type: 'watchdog.frame_detached',
      sensitivity: 'browser_data',
      payload: {
        frameId,
        selectedFrameCleared: true,
      },
    });
  }

  dialogOpened(
    context: BrowserWatchdogContext,
    input: { dialogId: string; dialogType: string; openedAt: number },
  ): void {
    this.dialogClosed(input.dialogId);
    const timer = this.setTimer(() => {
      const pending = this.dialogs.get(input.dialogId);
      if (!pending) return;
      this.dialogs.delete(input.dialogId);
      this.publish({
        workspaceId: pending.workspaceId,
        leaseId: pending.leaseId,
        targetId: pending.targetId,
        browserConnectionGeneration: pending.browserConnectionGeneration,
        type: 'watchdog.dialog_unhandled',
        sensitivity: 'browser_data',
        payload: {
          dialogId: pending.dialogId,
          type: pending.dialogType,
          openedAt: pending.openedAt,
          timeoutMs: this.dialogTimeoutMs,
        },
      });
    }, this.dialogTimeoutMs);
    if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref();
    this.dialogs.set(input.dialogId, {
      ...context,
      ...input,
      timer,
    });
  }

  dialogClosed(dialogId: string): void {
    const pending = this.dialogs.get(dialogId);
    if (!pending) return;
    this.clearTimer(pending.timer);
    this.dialogs.delete(dialogId);
  }

  actionCompleted(context: BrowserWatchdogContext, evidence: WatchdogActionEvidence): void {
    const key = targetKey(context.leaseId, context.targetId);
    if (evidence.status === 'verified') {
      this.noProgress.delete(key);
      return;
    }
    const reason = evidence.reason;
    const observableNoProgress = evidence.status === 'mismatch' || (
      reason !== undefined && OBSERVABLE_NO_PROGRESS_REASONS.has(reason)
    );
    if (!observableNoProgress) {
      this.noProgress.delete(key);
      return;
    }

    const streak = this.noProgress.get(key) ?? { ...context, count: 0, emitted: false };
    streak.count += 1;
    this.noProgress.set(key, streak);
    if (streak.emitted || streak.count < this.noProgressThreshold) return;
    streak.emitted = true;
    this.publish({
      ...context,
      type: 'watchdog.no_progress',
      sensitivity: 'browser_data',
      payload: {
        action: evidence.action,
        evidenceStatus: evidence.status,
        reason: reason ?? 'observable_mismatch',
        streak: streak.count,
        threshold: this.noProgressThreshold,
      },
    });
  }

  resetTarget(leaseId: ControlLeaseId, targetId: ControlledTargetId): void {
    this.noProgress.delete(targetKey(leaseId, targetId));
  }

  releaseLease(leaseId: ControlLeaseId): void {
    for (const [key, pending] of this.dialogs) {
      if (pending.leaseId !== leaseId) continue;
      this.clearTimer(pending.timer);
      this.dialogs.delete(key);
    }
    for (const key of this.noProgress.keys()) {
      if (key.startsWith(`${leaseId}\u0000`)) this.noProgress.delete(key);
    }
  }

  releaseWorkspace(workspaceId: BrowserWorkspaceId): void {
    for (const [key, pending] of this.dialogs) {
      if (pending.workspaceId !== workspaceId) continue;
      this.clearTimer(pending.timer);
      this.dialogs.delete(key);
    }
    for (const [key, streak] of this.noProgress) {
      if (streak.workspaceId === workspaceId) this.noProgress.delete(key);
    }
  }

  reset(): void {
    for (const pending of this.dialogs.values()) this.clearTimer(pending.timer);
    this.dialogs.clear();
    this.noProgress.clear();
  }
}
