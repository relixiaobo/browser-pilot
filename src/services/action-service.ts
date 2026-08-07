import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import {
  GET_POINTER_TARGET_STATE,
  GET_DEEP_ACTIVE_ELEMENT,
  PREPARE_EDITABLE_TARGET,
  READ_ACTIVE_CONTROL_STATE,
  READ_ACTIVE_EDITABLE_STATE,
  READ_CLICK_TARGET_STATE,
  READ_EDITABLE_STATE,
  SET_VALUE_CONTROL,
} from '../page-scripts.js';
import {
  MemoryRefStore,
  resolveTargetIdentity,
  type RefEntry,
  type RefStore,
  type SnapshotResult,
} from '../snapshot.js';
import type { Transport } from '../transport.js';
import type {
  ActionContinuityFactory,
  ActionContinuityRun,
  CompositeActionName,
} from './action-continuity.js';
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
  observationService?: ActionObservationService;
  inputDispatcher?: InputDispatcher;
  pointerOffset?: () => Promise<{ x: number; y: number }>;
  refValidator?: (input: { objectId: string; ref: number; entry: RefEntry }) => Promise<void>;
  readbackDelayMs?: number;
  focusDelayMs?: number;
  executionContextId?: number;
  continuityFactory?: ActionContinuityFactory;
  onWillDispatch?: () => void;
}

export interface ActionObservationService {
  readonly refs?: RefStore;
  observeAfterAction(limit?: number): Promise<SnapshotResult>;
  locate(selector: string): Promise<{ x: number; y: number }>;
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
  action: 'type' | 'keyboard';
  status: 'verified' | 'mismatch' | 'unavailable';
  kind: 'input' | 'contenteditable' | 'unsupported';
  sensitive: boolean;
  beforeLength?: number;
  expectedLength?: number;
  afterLength?: number;
  reason?: 'active_element_not_readable' | 'value_mismatch';
}

export type PressEffect =
  | 'value_changed'
  | 'checked_changed'
  | 'selected_changed'
  | 'pressed_changed'
  | 'expanded_changed'
  | 'focus_changed'
  | 'navigation'
  | 'document_changed'
  | 'dialog_opened'
  | 'popup_opened';

export type PressTargetKind =
  | 'input'
  | 'contenteditable'
  | 'checkbox'
  | 'radio'
  | 'select'
  | 'control'
  | 'other';

export interface PressVerificationEvidence {
  action: 'press';
  status: 'verified' | 'unavailable';
  kind: PressTargetKind;
  effects: PressEffect[];
  sensitive: boolean;
  reason?: 'target_unavailable' | 'no_observable_effect';
}

export type ClickEffect =
  | 'checked_changed'
  | 'selected_changed'
  | 'pressed_changed'
  | 'expanded_changed'
  | 'focus_changed'
  | 'navigation'
  | 'document_changed'
  | 'dialog_opened'
  | 'popup_opened';

export type ClickTargetKind =
  | 'checkbox'
  | 'radio'
  | 'switch'
  | 'option'
  | 'select'
  | 'control'
  | 'other'
  | 'coordinates';

export interface ClickVerificationEvidence {
  action: 'click';
  status: 'verified' | 'mismatch' | 'unavailable';
  kind: ClickTargetKind;
  effects: ClickEffect[];
  checked?: boolean | 'mixed';
  selected?: boolean;
  pressed?: boolean | 'mixed';
  expanded?: boolean;
  focused?: boolean;
  reason?: 'coordinate_target' | 'target_unavailable' | 'expected_state_unchanged' | 'no_observable_effect';
}

export interface ClickActionResult {
  observation: SnapshotResult;
  evidence: ClickVerificationEvidence;
}

export interface InputActionResult {
  observation: SnapshotResult;
  evidence: InputVerificationEvidence;
}

export interface PressActionResult {
  observation: SnapshotResult;
  evidence: PressVerificationEvidence;
}

interface EditableState {
  kind: 'input' | 'contenteditable' | 'unsupported';
  value: string;
  sensitive: boolean;
  editable: boolean;
  inputType?: string;
  editMode?: 'text' | 'value';
  selectionMode?: 'range' | 'select';
  reason?: EditableBlockReason;
}

interface PressTargetState {
  focusToken?: string;
  kind: PressTargetKind;
  sensitive: boolean;
  valueToken?: string;
  selectedToken?: string;
  checked?: boolean | 'mixed';
  pressed?: boolean | 'mixed';
  expanded?: boolean;
}

interface CompositeActionRun {
  action: CompositeActionName;
  continuity?: ActionContinuityRun;
  dispatchedSteps: number;
}

type EditableBlockReason =
  | 'detached'
  | 'disabled'
  | 'readonly'
  | 'inert'
  | 'unsupported_input_type'
  | 'unsupported_element'
  | 'selection_unavailable';

const EDITABLE_BLOCK_REASONS: ReadonlySet<EditableBlockReason> = new Set([
  'detached',
  'disabled',
  'readonly',
  'inert',
  'unsupported_input_type',
  'unsupported_element',
  'selection_unavailable',
]);

const PRESS_TARGET_KINDS = new Set<PressTargetKind>([
  'input',
  'contenteditable',
  'checkbox',
  'radio',
  'select',
  'control',
  'other',
]);

type PointerTargetFailureReason =
  | 'detached'
  | 'no_layout'
  | 'outside_viewport'
  | 'disabled'
  | 'obscured';

type PointerObstruction = Record<string, string> & { tagName: string };

type PointerTargetState =
  | { status: 'ready'; x: number; y: number; targetState: ClickTargetState }
  | { status: 'blocked'; reason: PointerTargetFailureReason; obstruction?: PointerObstruction };

interface ClickTargetState {
  connected: boolean;
  kind: Exclude<ClickTargetKind, 'coordinates'>;
  focused: boolean;
  checked?: boolean | 'mixed';
  selected?: boolean;
  pressed?: boolean | 'mixed';
  expanded?: boolean;
}

const POINTER_FAILURE_REASONS = new Set<PointerTargetFailureReason>([
  'detached',
  'no_layout',
  'outside_viewport',
  'disabled',
  'obscured',
]);

function parsePointerTargetState(value: unknown): PointerTargetState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid pointer target state');
  }
  const record = value as Record<string, unknown>;
  if (record.status === 'ready' && Number.isFinite(record.x) && Number.isFinite(record.y)) {
    return {
      status: 'ready',
      x: Number(record.x),
      y: Number(record.y),
      targetState: parseClickTargetState(record.targetState),
    };
  }
  if (record.status !== 'blocked' || !POINTER_FAILURE_REASONS.has(record.reason as PointerTargetFailureReason)) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid pointer target state');
  }

  let obstruction: PointerObstruction | undefined;
  if (record.obstruction !== undefined) {
    if (
      typeof record.obstruction !== 'object' || record.obstruction === null ||
      Array.isArray(record.obstruction)
    ) {
      throw new BrowserPilotError('internal_error', 'Chrome returned invalid pointer target state');
    }
    const candidate = record.obstruction as Record<string, unknown>;
    if (
      typeof candidate.tagName !== 'string' || candidate.tagName.length > 40 ||
      (candidate.role !== undefined && (typeof candidate.role !== 'string' || candidate.role.length > 40))
    ) {
      throw new BrowserPilotError('internal_error', 'Chrome returned invalid pointer target state');
    }
    obstruction = {
      tagName: candidate.tagName,
      ...(candidate.role ? { role: candidate.role } : {}),
    };
  }

  return {
    status: 'blocked',
    reason: record.reason as PointerTargetFailureReason,
    ...(obstruction ? { obstruction } : {}),
  };
}

const CLICK_TARGET_KINDS = new Set<ClickTargetState['kind']>([
  'checkbox',
  'radio',
  'switch',
  'option',
  'select',
  'control',
  'other',
]);

function parseClickTargetState(value: unknown): ClickTargetState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid click verification state');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.connected !== 'boolean' ||
    !CLICK_TARGET_KINDS.has(record.kind as ClickTargetState['kind']) ||
    typeof record.focused !== 'boolean' ||
    (record.checked !== undefined && typeof record.checked !== 'boolean' && record.checked !== 'mixed') ||
    (record.selected !== undefined && typeof record.selected !== 'boolean') ||
    (record.pressed !== undefined && typeof record.pressed !== 'boolean' && record.pressed !== 'mixed') ||
    (record.expanded !== undefined && typeof record.expanded !== 'boolean')
  ) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid click verification state');
  }
  return {
    connected: record.connected,
    kind: record.kind as ClickTargetState['kind'],
    focused: record.focused,
    ...(record.checked !== undefined ? { checked: record.checked as ClickTargetState['checked'] } : {}),
    ...(record.selected !== undefined ? { selected: record.selected } : {}),
    ...(record.pressed !== undefined ? { pressed: record.pressed as ClickTargetState['pressed'] } : {}),
    ...(record.expanded !== undefined ? { expanded: record.expanded } : {}),
  };
}

function clickEvidence(
  before: ClickTargetState,
  after: ClickTargetState | undefined,
  button: NonNullable<ClickOptions['button']>,
  clickCount: NonNullable<ClickOptions['clickCount']>,
): ClickVerificationEvidence {
  if (!after?.connected) {
    return {
      action: 'click',
      status: 'unavailable',
      kind: before.kind,
      effects: [],
      reason: 'target_unavailable',
    };
  }

  const effects: ClickEffect[] = [];
  if (before.checked !== after.checked) effects.push('checked_changed');
  if (before.selected !== after.selected) effects.push('selected_changed');
  if (before.pressed !== after.pressed) effects.push('pressed_changed');
  if (before.expanded !== after.expanded) effects.push('expanded_changed');
  if (!before.focused && after.focused) effects.push('focus_changed');

  let status: ClickVerificationEvidence['status'] = effects.length > 0 ? 'verified' : 'unavailable';
  let reason: ClickVerificationEvidence['reason'] | undefined = effects.length > 0
    ? undefined
    : 'no_observable_effect';
  if (button === 'left' && clickCount === 1 && after.checked !== undefined) {
    const expected = before.kind === 'radio'
      ? true
      : before.checked === true ? false : true;
    status = after.checked === expected ? 'verified' : 'mismatch';
    reason = status === 'mismatch' ? 'expected_state_unchanged' : undefined;
  } else if (button === 'left' && clickCount === 1 && before.kind === 'option' && after.selected !== undefined) {
    status = after.selected ? 'verified' : 'mismatch';
    reason = status === 'mismatch' ? 'expected_state_unchanged' : undefined;
  }

  return {
    action: 'click',
    status,
    kind: after.kind,
    effects,
    ...(after.checked !== undefined ? { checked: after.checked } : {}),
    ...(after.selected !== undefined ? { selected: after.selected } : {}),
    ...(after.pressed !== undefined ? { pressed: after.pressed } : {}),
    ...(after.expanded !== undefined ? { expanded: after.expanded } : {}),
    focused: after.focused,
    ...(reason ? { reason } : {}),
  };
}

function parseEditableState(value: unknown): EditableState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid input verification state');
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const inputType = record.inputType;
  const editMode = record.editMode;
  const selectionMode = record.selectionMode;
  const reason = record.reason;
  if (
    !['input', 'contenteditable', 'unsupported'].includes(String(kind)) ||
    typeof record.value !== 'string' ||
    typeof record.sensitive !== 'boolean' ||
    typeof record.editable !== 'boolean' ||
    (inputType !== undefined && (typeof inputType !== 'string' || inputType.length > 64)) ||
    (editMode !== undefined && editMode !== 'text' && editMode !== 'value') ||
    (selectionMode !== undefined && selectionMode !== 'range' && selectionMode !== 'select') ||
    (reason !== undefined && !EDITABLE_BLOCK_REASONS.has(reason as EditableBlockReason)) ||
    (record.editable && (kind === 'unsupported' || editMode === undefined || reason !== undefined)) ||
    (!record.editable && reason === undefined) ||
    (kind === 'input' && inputType === undefined) ||
    (editMode === 'text' && selectionMode === undefined) ||
    (editMode === 'value' && selectionMode !== undefined)
  ) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid input verification state');
  }
  return {
    kind: kind as EditableState['kind'],
    value: record.value,
    sensitive: record.sensitive,
    editable: record.editable,
    ...(inputType !== undefined ? { inputType } : {}),
    ...(editMode !== undefined ? { editMode } : {}),
    ...(selectionMode !== undefined ? { selectionMode } : {}),
    ...(reason !== undefined ? { reason: reason as EditableBlockReason } : {}),
  };
}

function inputEvidence(
  action: InputVerificationEvidence['action'],
  before: EditableState,
  after: EditableState,
  text: string,
  clear: boolean,
): InputVerificationEvidence {
  if (before.kind === 'unsupported' || after.kind === 'unsupported') {
    return {
      action,
      status: 'unavailable',
      kind: 'unsupported',
      sensitive: false,
      reason: 'active_element_not_readable',
    };
  }
  const insertion = before.kind === 'contenteditable' || before.inputType === 'textarea'
    ? text.replace(/\r\n?/g, '\n')
    : text;
  const expected = clear ? insertion : before.value + insertion;
  const matched = after.value === expected;
  return {
    action,
    status: matched ? 'verified' : 'mismatch',
    kind: after.kind,
    sensitive: before.sensitive || after.sensitive,
    beforeLength: before.value.length,
    expectedLength: expected.length,
    afterLength: after.value.length,
    ...(matched ? {} : { reason: 'value_mismatch' as const }),
  };
}

function parsePressTargetState(value: unknown, focusToken?: string): PressTargetState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid key verification state');
  }
  const record = value as Record<string, unknown>;
  if (
    !PRESS_TARGET_KINDS.has(record.kind as PressTargetKind) ||
    typeof record.sensitive !== 'boolean' ||
    (record.valueToken !== undefined && (typeof record.valueToken !== 'string' || record.valueToken.length > 64)) ||
    (record.selectedToken !== undefined && (typeof record.selectedToken !== 'string' || record.selectedToken.length > 64)) ||
    (record.checked !== undefined && typeof record.checked !== 'boolean' && record.checked !== 'mixed') ||
    (record.pressed !== undefined && typeof record.pressed !== 'boolean' && record.pressed !== 'mixed') ||
    (record.expanded !== undefined && typeof record.expanded !== 'boolean')
  ) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid key verification state');
  }
  return {
    ...(focusToken ? { focusToken } : {}),
    kind: record.kind as PressTargetKind,
    sensitive: record.sensitive,
    ...(record.valueToken !== undefined ? { valueToken: record.valueToken } : {}),
    ...(record.selectedToken !== undefined ? { selectedToken: record.selectedToken } : {}),
    ...(record.checked !== undefined ? { checked: record.checked as PressTargetState['checked'] } : {}),
    ...(record.pressed !== undefined ? { pressed: record.pressed as PressTargetState['pressed'] } : {}),
    ...(record.expanded !== undefined ? { expanded: record.expanded } : {}),
  };
}

function pressEvidence(before: PressTargetState, after?: PressTargetState): PressVerificationEvidence {
  if (!after) {
    return {
      action: 'press',
      status: 'unavailable',
      kind: before.kind,
      effects: [],
      sensitive: before.sensitive,
      reason: 'target_unavailable',
    };
  }
  const effects: PressEffect[] = [];
  const identitiesReadable = before.focusToken !== undefined && after.focusToken !== undefined;
  const sameTarget = identitiesReadable && before.focusToken === after.focusToken;
  if (
    sameTarget && before.valueToken !== after.valueToken &&
    (before.valueToken !== undefined || after.valueToken !== undefined)
  ) {
    effects.push('value_changed');
  }
  if (
    sameTarget && before.checked !== after.checked &&
    (before.checked !== undefined || after.checked !== undefined)
  ) {
    effects.push('checked_changed');
  }
  if (
    sameTarget &&
    before.selectedToken !== after.selectedToken &&
    (before.selectedToken !== undefined || after.selectedToken !== undefined)
  ) {
    effects.push('selected_changed');
  }
  if (
    sameTarget && before.pressed !== after.pressed &&
    (before.pressed !== undefined || after.pressed !== undefined)
  ) {
    effects.push('pressed_changed');
  }
  if (
    sameTarget && before.expanded !== after.expanded &&
    (before.expanded !== undefined || after.expanded !== undefined)
  ) {
    effects.push('expanded_changed');
  }
  if (identitiesReadable && !sameTarget) effects.push('focus_changed');
  return {
    action: 'press',
    status: effects.length > 0 ? 'verified' : 'unavailable',
    kind: after.kind,
    effects,
    sensitive: before.sensitive || after.sensitive,
    ...(effects.length > 0 ? {} : { reason: 'no_observable_effect' as const }),
  };
}

export class ActionService {
  private readonly refStore: RefStore;
  private readonly observations: ActionObservationService;
  private readonly input: InputDispatcher;
  private readonly pointerOffset: () => Promise<{ x: number; y: number }>;
  private readonly refValidator?: ActionServiceOptions['refValidator'];
  private readonly readbackDelayMs: number;
  private readonly focusDelayMs: number;
  private readonly executionContextId?: number;
  private readonly continuityFactory?: ActionContinuityFactory;
  private readonly onWillDispatch?: () => void;

  constructor(
    private readonly transport: Transport,
    private readonly sessionId: string,
    private readonly targetId: string,
    options: ActionServiceOptions = {},
  ) {
    this.refStore = options.refStore ?? options.observationService?.refs ?? new MemoryRefStore();
    this.observations = options.observationService ?? new ObservationService(
      transport,
      sessionId,
      targetId,
      { refStore: this.refStore },
    );
    this.input = options.inputDispatcher ?? new InputDispatcher(transport, sessionId);
    this.pointerOffset = options.pointerOffset ?? (async () => ({ x: 0, y: 0 }));
    this.refValidator = options.refValidator;
    this.readbackDelayMs = options.readbackDelayMs ?? 50;
    this.focusDelayMs = options.focusDelayMs ?? 300;
    this.executionContextId = options.executionContextId;
    this.continuityFactory = options.continuityFactory;
    this.onWillDispatch = options.onWillDispatch;
  }

  async click(target: ClickTarget, options: ClickOptions = {}): Promise<ClickActionResult> {
    const button = options.button ?? 'left';
    const clickCount = options.clickCount ?? 1;
    if (button === 'right' && clickCount === 2) {
      throw invalidArgument('Double-click and right-click are mutually exclusive');
    }
    const run = await this.startRun('click');
    try {
      let evidence: ClickVerificationEvidence;
      if (target.kind === 'coordinates') {
        const point = await this.offsetPointerPoint(target.x, target.y);
        await this.checkpoint(run, 'pointer_dispatch');
        this.willDispatch();
        await this.input.click(point.x, point.y, { button, clickCount });
        this.markDispatched(run);
        evidence = {
          action: 'click',
          status: 'unavailable',
          kind: 'coordinates',
          effects: [],
          reason: 'coordinate_target',
        };
      } else {
        const resolved = await resolveTargetIdentity(
          this.transport,
          this.sessionId,
          target.ref,
          this.targetId,
          this.refStore,
        );
        const { objectId } = resolved;
        try {
          const { result } = await this.transport.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: GET_POINTER_TARGET_STATE,
            returnByValue: true,
          }, this.sessionId);
          const state = parsePointerTargetState(result.value);
          await this.validateRef(objectId, target.ref, resolved.ref, resolved.entry);
          if (state.status === 'blocked') {
            const context = {
              action: 'click',
              targetId: this.targetId,
              ref: target.ref,
              reason: state.reason,
              ...(state.obstruction ? { obstruction: state.obstruction } : {}),
            };
            if (state.reason === 'detached') {
              throw new BrowserPilotError('stale_ref', 'Ref no longer resolves to a connected element', {
                context,
              });
            }
            throw new BrowserPilotError('action_not_verified', 'Ref is not currently pointer-interactable', {
              retryable: state.reason === 'outside_viewport' || state.reason === 'obscured',
              context,
            });
          }
          const point = await this.offsetPointerPoint(state.x, state.y, resolved.entry);
          await this.checkpoint(run, 'pointer_dispatch');
          this.willDispatch();
          await this.input.click(point.x, point.y, { button, clickCount });
          this.markDispatched(run);
          if (this.readbackDelayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, this.readbackDelayMs));
          }
          let after: ClickTargetState | undefined;
          try {
            const response = await this.transport.send('Runtime.callFunctionOn', {
              objectId,
              functionDeclaration: READ_CLICK_TARGET_STATE,
              returnByValue: true,
            }, this.sessionId);
            after = parseClickTargetState(response.result.value);
          } catch (error) {
            if (error instanceof BrowserPilotError && error.code === 'browser_disconnected') throw error;
          }
          evidence = clickEvidence(state.targetState, after, button, clickCount);
        } finally {
          await this.transport.send('Runtime.releaseObject', { objectId }, this.sessionId).catch(() => {});
        }
      }

      return {
        observation: await this.observations.observeAfterAction(options.observationLimit),
        evidence,
      };
    } finally {
      await this.releaseRun(run);
    }
  }

  /**
   * Pointer coordinates arrive relative to the viewport of the document that
   * owns the node. Two offsets close the gap and compose:
   *
   * - the session offset, from the observed root frame to the page, and
   * - the ref's own offset, from its document up to that observed root, which
   *   is present only for a ref inside a nested same-process frame.
   *
   * Observing the top frame makes the first zero; observing a subframe whose
   * refs all belong to it makes the second absent, which is the behavior that
   * existed before nested documents were observable.
   */
  private async offsetPointerPoint(
    x: number,
    y: number,
    entry?: RefEntry,
  ): Promise<{ x: number; y: number }> {
    const offset = await this.pointerOffset();
    if (!Number.isFinite(offset?.x) || !Number.isFinite(offset?.y)) {
      throw new BrowserPilotError('internal_error', 'Browser returned an invalid frame pointer offset');
    }
    const frame = entry?.frameOffset;
    if (frame && (!Number.isFinite(frame.x) || !Number.isFinite(frame.y))) {
      throw new BrowserPilotError('internal_error', 'Observation returned an invalid frame offset');
    }
    return {
      x: x + offset.x + (frame?.x ?? 0),
      y: y + offset.y + (frame?.y ?? 0),
    };
  }

  private async validateRef(
    objectId: string,
    refValue: string,
    resolvedRef?: number,
    entry?: RefEntry,
  ): Promise<void> {
    if (!this.refValidator) return;
    if (!entry || resolvedRef === undefined) {
      throw new BrowserPilotError('stale_ref', `Ref [${refValue}] is no longer available`, {
        context: { targetId: this.targetId, ref: refValue },
      });
    }
    await this.refValidator({ objectId, ref: resolvedRef, entry });
  }

  async press(key: string, observationLimit = 50): Promise<PressActionResult> {
    const run = await this.startRun('press');
    try {
      const before = await this.readActiveControlState();
      await this.checkpoint(run, 'key_dispatch');
      this.willDispatch();
      await this.input.press(key);
      this.markDispatched(run);
      if (this.readbackDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.readbackDelayMs));
      }
      let after: PressTargetState | undefined;
      try {
        after = await this.readActiveControlState();
      } catch (error) {
        if (error instanceof BrowserPilotError && error.code === 'browser_disconnected') throw error;
      }
      return {
        observation: await this.observations.observeAfterAction(observationLimit),
        evidence: pressEvidence(before, after),
      };
    } finally {
      await this.releaseRun(run);
    }
  }

  async type(ref: string, text: string, options: TypeOptions = {}): Promise<InputActionResult> {
    const run = await this.startRun('type');
    try {
      const resolved = await resolveTargetIdentity(
        this.transport,
        this.sessionId,
        ref,
        this.targetId,
        this.refStore,
      );
      const { objectId } = resolved;
      let evidence: InputVerificationEvidence;
      try {
        await this.validateRef(objectId, ref, resolved.ref, resolved.entry);
        await this.checkpoint(run, 'prepare_target');
        this.willDispatch();
        const before = await this.prepareElement(objectId, !!options.clear);
        this.markDispatched(run);
        this.requireEditableTarget(before, ref);
        await this.captureFocus(run, 'capture_target_focus');

        if (before.editMode === 'text') {
          if (!options.clear && before.selectionMode === 'select') {
            await this.checkpoint(run, 'move_caret', true);
            this.willDispatch();
            await this.input.press('End');
            this.markDispatched(run);
          }
          if (text.length > 0) {
            await this.checkpoint(run, 'insert_text', true);
            this.willDispatch();
            await this.input.insertText(text);
            this.markDispatched(run);
          } else if (options.clear) {
            await this.checkpoint(run, 'delete_selection', true);
            this.willDispatch();
            await this.input.press('Backspace');
            this.markDispatched(run);
          }
        } else {
          const desired = options.clear ? text : before.value + text;
          await this.checkpoint(run, 'set_control_value', true);
          this.willDispatch();
          await this.transport.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: SET_VALUE_CONTROL,
            arguments: [{ value: desired }],
          }, this.sessionId);
          this.markDispatched(run);
        }

        if (this.readbackDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, this.readbackDelayMs));
        }
        const after = await this.readElementState(objectId);
        evidence = inputEvidence('type', before, after, text, !!options.clear);
        this.requireVerification(evidence, options.verification);
        if (options.submit) {
          await this.checkpoint(run, 'submit', true);
          this.willDispatch();
          await this.input.press('Enter');
          this.markDispatched(run);
        }
      } finally {
        await this.transport.send('Runtime.releaseObject', { objectId }, this.sessionId).catch(() => {});
      }

      return {
        observation: await this.observations.observeAfterAction(options.observationLimit),
        evidence,
      };
    } finally {
      await this.releaseRun(run);
    }
  }

  async keyboard(text: string, options: KeyboardOptions = {}): Promise<InputActionResult> {
    const run = await this.startRun('keyboard');
    try {
      if (options.focusSelector) {
        const location = await this.observations.locate(options.focusSelector);
        await this.checkpoint(run, 'focus_pointer_dispatch');
        this.willDispatch();
        await this.input.click(location.x, location.y);
        this.markDispatched(run);
        if (this.focusDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.focusDelayMs));
      }
      await this.captureFocus(run, 'capture_input_focus');

      const before = await this.readActiveState();
      if (options.clear) {
        const modifier = options.selectAllModifier ?? (process.platform === 'darwin' ? 'Meta' : 'Control');
        await this.checkpoint(run, 'select_all', true);
        this.willDispatch();
        await this.input.press(`${modifier}+a`);
        this.markDispatched(run);
        await this.checkpoint(run, 'delete_selection', true);
        this.willDispatch();
        await this.input.press('Delete');
        this.markDispatched(run);
      }
      await this.input.typeText(text, options.delayMs, {
        beforeCharacter: async ({ index }) => {
          await this.checkpoint(run, `type_character:${index}`, true);
          this.willDispatch();
        },
        afterCharacter: () => this.markDispatched(run),
      });
      if (this.readbackDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.readbackDelayMs));
      const after = await this.readActiveState();
      const evidence = inputEvidence('keyboard', before, after, text, !!options.clear);
      this.requireVerification(evidence, options.verification);
      if (options.submit) {
        await this.checkpoint(run, 'submit', true);
        this.willDispatch();
        await this.input.press('Enter');
        this.markDispatched(run);
      }

      return {
        observation: await this.observations.observeAfterAction(options.observationLimit),
        evidence,
      };
    } finally {
      await this.releaseRun(run);
    }
  }

  private async startRun(action: CompositeActionName): Promise<CompositeActionRun> {
    return {
      action,
      continuity: await this.continuityFactory?.(action),
      dispatchedSteps: 0,
    };
  }

  private async checkpoint(
    run: CompositeActionRun,
    step: string,
    requireSameFocus = false,
  ): Promise<void> {
    await run.continuity?.check({
      action: run.action,
      step,
      dispatchedSteps: run.dispatchedSteps,
      ...(requireSameFocus ? { requireSameFocus: true } : {}),
    });
  }

  private async captureFocus(run: CompositeActionRun, step: string): Promise<void> {
    await run.continuity?.captureFocus({
      action: run.action,
      step,
      dispatchedSteps: run.dispatchedSteps,
    });
  }

  private markDispatched(run: CompositeActionRun): void {
    run.dispatchedSteps += 1;
  }

  private willDispatch(): void {
    this.onWillDispatch?.();
  }

  private async releaseRun(run: CompositeActionRun): Promise<void> {
    await run.continuity?.release().catch(() => {});
  }

  private async readElementState(objectId: string): Promise<EditableState> {
    const { result } = await this.transport.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: READ_EDITABLE_STATE,
      returnByValue: true,
    }, this.sessionId);
    return parseEditableState(result.value);
  }

  private async prepareElement(objectId: string, clear: boolean): Promise<EditableState> {
    const { result } = await this.transport.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: PREPARE_EDITABLE_TARGET,
      arguments: [{ value: clear }],
      returnByValue: true,
    }, this.sessionId);
    return parseEditableState(result.value);
  }

  private async readActiveState(): Promise<EditableState> {
    const params: Record<string, unknown> = {
      expression: READ_ACTIVE_EDITABLE_STATE,
      returnByValue: true,
    };
    if (this.executionContextId) params.contextId = this.executionContextId;
    const { result } = await this.transport.send('Runtime.evaluate', params, this.sessionId);
    return parseEditableState(result.value);
  }

  private async readActiveControlState(): Promise<PressTargetState> {
    const params: Record<string, unknown> = {
      expression: GET_DEEP_ACTIVE_ELEMENT,
    };
    if (this.executionContextId) params.contextId = this.executionContextId;
    const { result: active } = await this.transport.send('Runtime.evaluate', params, this.sessionId);
    if (!active.objectId) return { kind: 'other', sensitive: false };
    try {
      const { node } = await this.transport.send('DOM.describeNode', {
        objectId: active.objectId,
      }, this.sessionId);
      if (!Number.isSafeInteger(node?.backendNodeId) || Number(node.backendNodeId) < 1) {
        throw new BrowserPilotError('internal_error', 'Chrome returned invalid focused node identity');
      }
      const { result } = await this.transport.send('Runtime.callFunctionOn', {
        objectId: active.objectId,
        functionDeclaration: READ_ACTIVE_CONTROL_STATE,
        returnByValue: true,
      }, this.sessionId);
      return parsePressTargetState(result.value, `backend:${node.backendNodeId}`);
    } finally {
      await this.transport.send('Runtime.releaseObject', { objectId: active.objectId }, this.sessionId).catch(() => {});
    }
  }

  private requireVerification(
    evidence: InputVerificationEvidence,
    verification: TypeOptions['verification'],
  ): void {
    if (verification !== 'require_exact' || evidence.status === 'verified') return;
    throw new BrowserPilotError('action_not_verified', 'Input value did not match the requested result', {
      retryable: true,
      context: {
        action: evidence.action,
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

  private requireEditableTarget(state: EditableState, ref: string): void {
    if (state.editable) return;
    const context = {
      action: 'type',
      targetId: this.targetId,
      ref,
      kind: state.kind,
      ...(state.inputType ? { inputType: state.inputType } : {}),
      ...(state.reason ? { reason: state.reason } : {}),
    };
    if (state.reason === 'detached') {
      throw new BrowserPilotError('stale_ref', `Ref [${ref}] no longer resolves to a connected element`, {
        context,
      });
    }
    if (state.reason === 'unsupported_input_type' || state.reason === 'unsupported_element') {
      throw new BrowserPilotError('invalid_argument', `Ref [${ref}] is not an editable text or value control`, {
        context: { ...context, field: 'ref' },
        rpcCode: -32602,
      });
    }
    throw new BrowserPilotError('action_not_verified', `Ref [${ref}] is not currently editable`, {
      retryable: state.reason === 'disabled' || state.reason === 'readonly' || state.reason === 'inert',
      context,
    });
  }
}
