import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import {
  CONTENTEDITABLE_CLEAR,
  CONTENTEDITABLE_FOCUS_END,
  GET_CLICK_COORDS,
  READ_ACTIVE_EDITABLE_STATE,
  READ_EDITABLE_STATE,
  SET_VALUE,
} from '../page-scripts.js';
import { legacyRefStore, resolveTarget, type RefStore, type SnapshotResult } from '../snapshot.js';
import type { Transport } from '../transport.js';
import { InputDispatcher } from './input-dispatcher.js';
import { ObservationService } from './observation-service.js';

export type ClickTarget =
  | { kind: 'ref'; ref: string }
  | { kind: 'coordinates'; x: number; y: number };

export interface ClickOptions {
  button?: 'left' | 'right';
  clickCount?: 1 | 2;
  observationLimit?: number;
}

export interface ActionServiceOptions {
  refStore?: RefStore;
  observationService?: ObservationService;
  inputDispatcher?: InputDispatcher;
  readbackDelayMs?: number;
  focusDelayMs?: number;
}

export interface TypeOptions {
  clear?: boolean;
  submit?: boolean;
  observationLimit?: number;
  verification?: 'report' | 'require_exact';
}

export interface KeyboardOptions extends TypeOptions {
  focusSelector?: string;
  delayMs?: number;
  selectAllModifier?: 'Meta' | 'Control';
}

export interface InputVerificationEvidence {
  status: 'verified' | 'mismatch' | 'unavailable';
  kind: 'input' | 'contenteditable' | 'unsupported';
  sensitive: boolean;
  beforeLength?: number;
  expectedLength?: number;
  afterLength?: number;
  reason?: 'active_element_not_readable' | 'value_mismatch';
}

export interface InputActionResult {
  observation: SnapshotResult;
  evidence: InputVerificationEvidence;
}

interface EditableState {
  kind: 'input' | 'contenteditable' | 'unsupported';
  value: string;
  sensitive: boolean;
}

function parseClickCoordinates(value: unknown): { x: number; y: number } {
  if (typeof value !== 'string') {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid click coordinates');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid click coordinates', { cause });
  }
  if (
    typeof parsed !== 'object' || parsed === null ||
    !Number.isFinite((parsed as Record<string, unknown>).x) ||
    !Number.isFinite((parsed as Record<string, unknown>).y)
  ) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid click coordinates');
  }
  return parsed as { x: number; y: number };
}

function parseEditableState(value: unknown): EditableState {
  if (
    typeof value !== 'object' || value === null ||
    !['input', 'contenteditable', 'unsupported'].includes(String((value as Record<string, unknown>).kind)) ||
    typeof (value as Record<string, unknown>).value !== 'string' ||
    typeof (value as Record<string, unknown>).sensitive !== 'boolean'
  ) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid input verification state');
  }
  return value as EditableState;
}

function inputEvidence(before: EditableState, after: EditableState, text: string, clear: boolean): InputVerificationEvidence {
  if (before.kind === 'unsupported' || after.kind === 'unsupported') {
    return {
      status: 'unavailable',
      kind: 'unsupported',
      sensitive: false,
      reason: 'active_element_not_readable',
    };
  }
  const expected = clear ? text : before.value + text;
  const matched = after.value === expected;
  return {
    status: matched ? 'verified' : 'mismatch',
    kind: after.kind,
    sensitive: before.sensitive || after.sensitive,
    beforeLength: before.value.length,
    expectedLength: expected.length,
    afterLength: after.value.length,
    ...(matched ? {} : { reason: 'value_mismatch' as const }),
  };
}

export class ActionService {
  private readonly refStore: RefStore;
  private readonly observations: ObservationService;
  private readonly input: InputDispatcher;
  private readonly readbackDelayMs: number;
  private readonly focusDelayMs: number;

  constructor(
    private readonly transport: Transport,
    private readonly sessionId: string,
    private readonly targetId: string,
    options: ActionServiceOptions = {},
  ) {
    this.refStore = options.refStore ?? options.observationService?.refs ?? legacyRefStore;
    this.observations = options.observationService ?? new ObservationService(
      transport,
      sessionId,
      targetId,
      { refStore: this.refStore },
    );
    this.input = options.inputDispatcher ?? new InputDispatcher(transport, sessionId);
    this.readbackDelayMs = options.readbackDelayMs ?? 50;
    this.focusDelayMs = options.focusDelayMs ?? 300;
  }

  async click(target: ClickTarget, options: ClickOptions = {}): Promise<SnapshotResult> {
    const button = options.button ?? 'left';
    const clickCount = options.clickCount ?? 1;
    if (button === 'right' && clickCount === 2) {
      throw invalidArgument('Double-click and right-click are mutually exclusive');
    }

    if (target.kind === 'coordinates') {
      await this.input.click(target.x, target.y, { button, clickCount });
    } else {
      const objectId = await resolveTarget(
        this.transport,
        this.sessionId,
        target.ref,
        this.targetId,
        this.refStore,
      );
      try {
        const { result } = await this.transport.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: GET_CLICK_COORDS,
          returnByValue: true,
        }, this.sessionId);
        const coordinates = parseClickCoordinates(result.value);
        await this.input.click(coordinates.x, coordinates.y, { button, clickCount });
      } finally {
        await this.transport.send('Runtime.releaseObject', { objectId }, this.sessionId).catch(() => {});
      }
    }

    return this.observations.observeAfterAction(options.observationLimit);
  }

  async press(key: string, observationLimit = 50): Promise<SnapshotResult> {
    await this.input.press(key);
    return this.observations.observeAfterAction(observationLimit);
  }

  async type(ref: string, text: string, options: TypeOptions = {}): Promise<InputActionResult> {
    const objectId = await resolveTarget(
      this.transport,
      this.sessionId,
      ref,
      this.targetId,
      this.refStore,
    );
    let evidence: InputVerificationEvidence;
    try {
      const before = await this.readElementState(objectId);
      if (before.kind === 'unsupported') {
        throw invalidArgument(`Ref [${ref}] is not an editable input`, 'ref');
      }

      if (before.kind === 'contenteditable') {
        await this.transport.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: options.clear ? CONTENTEDITABLE_CLEAR : CONTENTEDITABLE_FOCUS_END,
        }, this.sessionId);
        await this.transport.send('Input.insertText', { text }, this.sessionId);
      } else {
        await this.transport.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: SET_VALUE,
          arguments: [{ value: text }, { value: !!options.clear }],
        }, this.sessionId);
      }

      if (this.readbackDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.readbackDelayMs));
      }
      const after = await this.readElementState(objectId);
      evidence = inputEvidence(before, after, text, !!options.clear);
      this.requireVerification(evidence, options.verification);
      if (options.submit) await this.input.press('Enter');
    } finally {
      await this.transport.send('Runtime.releaseObject', { objectId }, this.sessionId).catch(() => {});
    }

    return {
      observation: await this.observations.observeAfterAction(options.observationLimit),
      evidence,
    };
  }

  async keyboard(text: string, options: KeyboardOptions = {}): Promise<InputActionResult> {
    if (options.focusSelector) {
      const location = await this.observations.locate(options.focusSelector);
      await this.input.click(location.x, location.y);
      if (this.focusDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.focusDelayMs));
    }

    const before = await this.readActiveState();
    if (options.clear) {
      const modifier = options.selectAllModifier ?? (process.platform === 'darwin' ? 'Meta' : 'Control');
      await this.input.press(`${modifier}+a`);
      await this.input.press('Delete');
    }
    await this.input.typeText(text, options.delayMs);
    if (this.readbackDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.readbackDelayMs));
    const after = await this.readActiveState();
    const evidence = inputEvidence(before, after, text, !!options.clear);
    this.requireVerification(evidence, options.verification);
    if (options.submit) await this.input.press('Enter');

    return {
      observation: await this.observations.observeAfterAction(options.observationLimit),
      evidence,
    };
  }

  private async readElementState(objectId: string): Promise<EditableState> {
    const { result } = await this.transport.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: READ_EDITABLE_STATE,
      returnByValue: true,
    }, this.sessionId);
    return parseEditableState(result.value);
  }

  private async readActiveState(): Promise<EditableState> {
    const { result } = await this.transport.send('Runtime.evaluate', {
      expression: READ_ACTIVE_EDITABLE_STATE,
      returnByValue: true,
    }, this.sessionId);
    return parseEditableState(result.value);
  }

  private requireVerification(
    evidence: InputVerificationEvidence,
    verification: TypeOptions['verification'],
  ): void {
    if (verification !== 'require_exact' || evidence.status === 'verified') return;
    throw new BrowserPilotError('action_not_verified', 'Input value did not match the requested result', {
      retryable: true,
      context: {
        status: evidence.status,
        kind: evidence.kind,
        sensitive: evidence.sensitive,
        beforeLength: evidence.beforeLength,
        expectedLength: evidence.expectedLength,
        afterLength: evidence.afterLength,
        reason: evidence.reason,
      },
    });
  }
}
