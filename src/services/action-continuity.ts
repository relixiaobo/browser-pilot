import { randomUUID } from 'node:crypto';
import { BrowserPilotError } from '../protocol/errors.js';
import type { Transport } from '../transport.js';

export type CompositeActionName = 'click' | 'type' | 'keyboard' | 'press';

export type ActionContinuityFailureReason =
  | 'target_changed'
  | 'session_changed'
  | 'frame_changed'
  | 'loader_changed'
  | 'document_changed'
  | 'focus_changed';

export interface ActionContinuityCheckpoint {
  action: CompositeActionName;
  step: string;
  dispatchedSteps: number;
  requireSameFocus?: boolean;
}

export interface ActionContinuityRun {
  captureFocus(checkpoint: ActionContinuityCheckpoint): Promise<void>;
  check(checkpoint: ActionContinuityCheckpoint): Promise<void>;
  release(): Promise<void>;
}

export type ActionContinuityFactory = (
  action: CompositeActionName,
) => Promise<ActionContinuityRun>;

export interface CdpActionContinuityOptions {
  frameId?: string;
  executionContextId?: number;
  externalCheck?: () =>
    | ActionContinuityFailureReason
    | undefined
    | Promise<ActionContinuityFailureReason | undefined>;
}

interface FrameIdentity {
  frameId: string;
  loaderId: string;
}

const STATE_SYMBOL = 'browser-pilot.action-continuity.v1';

function interruption(
  checkpoint: ActionContinuityCheckpoint,
  reason: ActionContinuityFailureReason,
): BrowserPilotError {
  const afterDispatch = checkpoint.dispatchedSteps > 0;
  return new BrowserPilotError(
    afterDispatch ? 'unknown_outcome' : 'action_not_verified',
    afterDispatch
      ? 'Composite browser action stopped after the page context changed'
      : 'Browser action stopped before input dispatch because the page context changed',
    {
      retryable: true,
      context: {
        action: checkpoint.action,
        step: checkpoint.step,
        reason,
        dispatchedSteps: checkpoint.dispatchedSteps,
        remainingStepsStopped: true,
      },
    },
  );
}

function frameFromTree(frameTree: any, frameId: string): any | undefined {
  if (frameTree?.frame?.id === frameId) return frameTree.frame;
  for (const child of frameTree?.childFrames ?? []) {
    const match = frameFromTree(child, frameId);
    if (match) return match;
  }
  return undefined;
}

function parseFrame(frame: any): FrameIdentity {
  if (
    typeof frame?.id !== 'string' || frame.id.length === 0 ||
    typeof frame.loaderId !== 'string' || frame.loaderId.length === 0
  ) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid action frame identity');
  }
  return { frameId: frame.id, loaderId: frame.loaderId };
}

function stateExpression(
  id: string,
  operation: 'initialize' | 'captureFocus' | 'check' | 'release',
  requireSameFocus = false,
): string {
  const encodedId = JSON.stringify(id);
  const store = `globalThis[Symbol.for(${JSON.stringify(STATE_SYMBOL)})]`;
  const deepActiveElement = `(() => {
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  })()`;

  if (operation === 'initialize') {
    return `(() => {
      const symbol = Symbol.for(${JSON.stringify(STATE_SYMBOL)});
      const states = globalThis[symbol] || (globalThis[symbol] = new Map());
      states.set(${encodedId}, { document, focus: undefined });
      return true;
    })()`;
  }
  if (operation === 'captureFocus') {
    return `(() => {
      const state = ${store}?.get(${encodedId});
      if (!state || state.document !== document) return 'document_changed';
      state.focus = ${deepActiveElement};
      return state.focus ? 'ready' : 'focus_changed';
    })()`;
  }
  if (operation === 'check') {
    return `(() => {
      const state = ${store}?.get(${encodedId});
      if (!state || state.document !== document) return 'document_changed';
      ${requireSameFocus
        ? `if (state.focus !== undefined && state.focus !== ${deepActiveElement}) return 'focus_changed';`
        : ''}
      return 'ready';
    })()`;
  }
  return `(() => { ${store}?.delete(${encodedId}); return true; })()`;
}

export class CdpActionContinuityGuard implements ActionContinuityRun {
  private constructor(
    private readonly transport: Transport,
    private readonly sessionId: string,
    private readonly contextId: number,
    private readonly identity: FrameIdentity,
    private readonly stateId: string,
    private readonly externalCheck?: CdpActionContinuityOptions['externalCheck'],
  ) {}

  static async create(
    transport: Transport,
    sessionId: string,
    action: CompositeActionName,
    options: CdpActionContinuityOptions = {},
  ): Promise<CdpActionContinuityGuard> {
    const checkpoint: ActionContinuityCheckpoint = {
      action,
      step: 'initialize',
      dispatchedSteps: 0,
    };
    const externalFailure = await options.externalCheck?.();
    if (externalFailure) throw interruption(checkpoint, externalFailure);

    const { frameTree } = await transport.send('Page.getFrameTree', {}, sessionId);
    let frameId = options.frameId;
    if (!frameId && options.executionContextId !== undefined) {
      frameId = await this.frameIdForContext(
        transport,
        sessionId,
        options.executionContextId,
      );
    }
    const frame = frameId ? frameFromTree(frameTree, frameId) : frameTree?.frame;
    const identity = parseFrame(frame);
    const { executionContextId } = await transport.send('Page.createIsolatedWorld', {
      frameId: identity.frameId,
      worldName: 'browser-pilot-action-continuity',
    }, sessionId);
    if (!Number.isSafeInteger(executionContextId) || executionContextId < 1) {
      throw new BrowserPilotError('internal_error', 'Chrome returned invalid action guard context');
    }

    const stateId = `action:${randomUUID()}`;
    const guard = new CdpActionContinuityGuard(
      transport,
      sessionId,
      executionContextId,
      identity,
      stateId,
      options.externalCheck,
    );
    const initialized = await guard.evaluate(stateExpression(stateId, 'initialize'));
    if (initialized !== true) {
      throw new BrowserPilotError('internal_error', 'Chrome could not initialize action continuity state');
    }
    return guard;
  }

  async captureFocus(checkpoint: ActionContinuityCheckpoint): Promise<void> {
    await this.checkFrame(checkpoint);
    let result: unknown;
    try {
      result = await this.evaluate(stateExpression(this.stateId, 'captureFocus'));
    } catch (error) {
      await this.handleEvaluationFailure(checkpoint, error);
    }
    if (result === 'ready') return;
    if (result === 'document_changed' || result === 'focus_changed') {
      throw interruption(checkpoint, result);
    }
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid action focus state');
  }

  async check(checkpoint: ActionContinuityCheckpoint): Promise<void> {
    await this.checkFrame(checkpoint);
    let result: unknown;
    try {
      result = await this.evaluate(stateExpression(
        this.stateId,
        'check',
        checkpoint.requireSameFocus,
      ));
    } catch (error) {
      await this.handleEvaluationFailure(checkpoint, error);
    }
    if (result === 'ready') return;
    if (result === 'document_changed' || result === 'focus_changed') {
      throw interruption(checkpoint, result);
    }
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid action continuity state');
  }

  async release(): Promise<void> {
    await this.evaluate(stateExpression(this.stateId, 'release')).catch(() => {});
  }

  private static async frameIdForContext(
    transport: Transport,
    sessionId: string,
    executionContextId: number,
  ): Promise<string> {
    const { result } = await transport.send('Runtime.evaluate', {
      expression: 'document',
      contextId: executionContextId,
    }, sessionId);
    if (!result?.objectId) {
      throw new BrowserPilotError('internal_error', 'Chrome could not resolve the selected action frame');
    }
    try {
      const { node } = await transport.send('DOM.describeNode', {
        objectId: result.objectId,
      }, sessionId);
      if (typeof node?.frameId !== 'string' || node.frameId.length === 0) {
        throw new BrowserPilotError('internal_error', 'Chrome returned invalid selected action frame');
      }
      return node.frameId;
    } finally {
      await transport.send('Runtime.releaseObject', { objectId: result.objectId }, sessionId).catch(() => {});
    }
  }

  private async checkFrame(checkpoint: ActionContinuityCheckpoint): Promise<void> {
    const externalFailure = await this.externalCheck?.();
    if (externalFailure) throw interruption(checkpoint, externalFailure);

    let current: any;
    try {
      const { frameTree } = await this.transport.send('Page.getFrameTree', {}, this.sessionId);
      current = frameFromTree(frameTree, this.identity.frameId);
    } catch (error) {
      const reason = await this.externalCheck?.();
      if (reason) throw interruption(checkpoint, reason);
      if (error instanceof BrowserPilotError && error.code === 'browser_disconnected') throw error;
      throw interruption(checkpoint, 'session_changed');
    }
    if (!current) throw interruption(checkpoint, 'frame_changed');
    if (current.loaderId !== this.identity.loaderId) {
      throw interruption(checkpoint, 'loader_changed');
    }

    const trailingFailure = await this.externalCheck?.();
    if (trailingFailure) throw interruption(checkpoint, trailingFailure);
  }

  private async evaluate(expression: string): Promise<unknown> {
    const { result } = await this.transport.send('Runtime.evaluate', {
      expression,
      contextId: this.contextId,
      returnByValue: true,
    }, this.sessionId);
    return result?.value;
  }

  private async handleEvaluationFailure(
    checkpoint: ActionContinuityCheckpoint,
    error: unknown,
  ): Promise<never> {
    const reason = await this.externalCheck?.();
    if (reason) throw interruption(checkpoint, reason);
    if (error instanceof BrowserPilotError && error.code === 'browser_disconnected') throw error;
    throw interruption(checkpoint, 'document_changed');
  }
}
