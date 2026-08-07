import { PAGE_INFO } from './page-scripts.js';
import { CDPError } from './cdp.js';
import {
  DOM_SNAPSHOT_CAPTURE_PARAMS,
  domElementChecked,
  domElementInsideDialog,
  domElementName,
  domElementRole,
  domElementState,
  domElementValue,
  isDomOnlyCandidate,
  parseDomSnapshot,
  type DomSnapshotDocument,
  type DomSnapshotNodeFact,
  type DomSnapshotWorkBudget,
} from './dom-snapshot.js';
import {
  OBSERVATION_TRUNCATION_REASONS,
  OBSERVATION_V1_LIMITS,
  type ObservationElement,
  type ObservationTruncationReason,
  type PageGeometry,
} from './protocol/model.js';
import { BrowserPilotError, invalidArgument } from './protocol/errors.js';
import { serializeStructuralText } from './structural-text.js';
import type { Transport } from './transport.js';

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox',
  'checkbox', 'radio', 'spinbutton', 'slider', 'switch',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab',
]);

// Roles where an empty name is acceptable (unnamed inputs are still interactive)
const ALLOW_EMPTY_NAME = new Set([
  'textbox', 'searchbox', 'combobox', 'listbox',
  'checkbox', 'radio', 'spinbutton', 'slider', 'switch',
]);

// ── Types ───────────────────────────────────────────

/**
 * How many nested same-process frames contribute an accessibility tree to one
 * observation. Each costs a round trip, so the cap bounds a pathological page
 * without changing the frozen Observation v1 limit vocabulary; exceeding it
 * reports the existing work_limit truncation reason.
 */
const MAX_NESTED_AX_FRAMES = 16;

export interface RefEntry {
  backendNodeId: number;
  role: string;
  name: string;
  /**
   * The frame that owns this node, and the page offset of that frame. A node
   * inside a same-process iframe reports coordinates relative to its own
   * viewport, so dispatch needs this offset rather than the session's single
   * active-frame offset, which is only correct while every ref shares one frame.
   */
  frameId?: string;
  frameOffset?: { x: number; y: number };
}

export interface AxElementSemantic {
  backendNodeId: number;
  role: string;
  name?: string;
  properties: Record<string, unknown>;
}

export function axElementSemantic(node: unknown): AxElementSemantic | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const candidate = node as Record<string, any>;
  if (candidate.ignored === true) return undefined;
  const role = candidate.role?.value;
  const properties = Object.fromEntries(
    (Array.isArray(candidate.properties) ? candidate.properties : [])
      .filter((property: unknown): property is Record<string, any> => (
        Boolean(property) && typeof property === 'object' &&
        typeof (property as Record<string, unknown>).name === 'string'
      ))
      .map(property => [property.name, property.value?.value]),
  );
  const editable = properties.editable === 'richtext';
  if (typeof role !== 'string' || (!INTERACTIVE_ROLES.has(role) && !editable)) return undefined;
  const backendNodeId = Number(candidate.backendDOMNodeId);
  if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) return undefined;
  const name = candidate.name?.value;
  return {
    backendNodeId,
    role: String(editable && role === 'generic' ? 'textbox' : role).slice(0, 128),
    ...(typeof name === 'string' && name ? { name } : {}),
    properties,
  };
}

export interface RefStore {
  save(targetId: string, entries: RefEntry[]): void;
  load(expectedTargetId?: string): RefEntry[];
}

export class MemoryRefStore implements RefStore {
  private readonly entriesByTarget = new Map<string, RefEntry[]>();

  save(targetId: string, entries: RefEntry[]): void {
    this.entriesByTarget.set(targetId, entries.map(entry => ({ ...entry })));
  }

  load(expectedTargetId?: string): RefEntry[] {
    if (!expectedTargetId) return [];
    return (this.entriesByTarget.get(expectedTargetId) ?? []).map(entry => ({ ...entry }));
  }

  clear(targetId?: string): void {
    if (targetId) this.entriesByTarget.delete(targetId);
    else this.entriesByTarget.clear();
  }
}

export interface SnapshotData {
  title: string;
  url: string;
  page?: PageGeometry;
  // NOTE: elements are exposed to LLM agents — keep this lean.
  // backendNodeId remains internal to the in-memory Observation record.
  elements: ObservationElement[];
}

export interface SnapshotResult {
  text: string;
  data: SnapshotData;
  guidance: SnapshotGuidanceSignals;
  truncated?: boolean;
  truncationReasons?: ObservationTruncationReason[];
}

export interface SnapshotGuidanceSignals {
  authenticationSurface: boolean;
  modalCount: number;
  blockingModalCount: number;
  explicitAutocompleteCount: number;
  explicitFilterCount: number;
  autocompleteRefs: number[];
  modalRefs: number[];
  filterRefs: number[];
}

export interface SnapshotContext {
  executionContextId?: number;
  frameId?: string;
  maxDomTextNodes?: number;
  onDomTextNode?: () => void;
}

// ── Snapshot ────────────────────────────────────────

export async function takeSnapshot(
  transport: Transport,
  sessionId: string,
  targetId: string,
  limit: number = OBSERVATION_V1_LIMITS.defaultElements,
  refStore: RefStore = new MemoryRefStore(),
  context: SnapshotContext = {},
): Promise<SnapshotResult> {
  const infoParams: Record<string, unknown> = {
    expression: PAGE_INFO, returnByValue: true,
  };
  if (context.executionContextId) infoParams.contextId = context.executionContextId;
  const { result: info, exceptionDetails } = await transport.send('Runtime.evaluate', infoParams, sessionId);
  if (exceptionDetails) {
    throw new BrowserPilotError(
      'internal_error',
      exceptionDetails.exception?.description || exceptionDetails.text || 'Page observation evaluation failed',
    );
  }
  let pageInfo: any;
  try {
    pageInfo = JSON.parse(info?.value);
  } catch (cause) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid page observation metadata', { cause });
  }
  const truncation = new Set<ObservationTruncationReason>();
  let textCharacters = 0;
  const domWork: DomSnapshotWorkBudget = {
    maxDescendantTextNodes: context.maxDomTextNodes ?? OBSERVATION_V1_LIMITS.maxDomTextNodes,
    descendantTextNodes: 0,
    exhausted: false,
    ...(context.onDomTextNode ? { onDescendantTextNode: context.onDomTextNode } : {}),
  };

  const boundedText = (raw: unknown, fieldLimit: number): string => {
    const value = typeof raw === 'string' ? raw : '';
    const fieldBounded = value.slice(0, fieldLimit);
    if (fieldBounded.length !== value.length) truncation.add('text_limit');
    const remaining = Math.max(0, OBSERVATION_V1_LIMITS.maxTextCharacters - textCharacters);
    const result = fieldBounded.slice(0, remaining);
    if (result.length !== fieldBounded.length) truncation.add('text_limit');
    textCharacters += result.length;
    return result;
  };

  const title = boundedText(pageInfo.title, OBSERVATION_V1_LIMITS.maxTitleCharacters);
  const url = boundedText(pageInfo.url, OBSERVATION_V1_LIMITS.maxUrlCharacters);
  const rawPage = pageInfo.page && typeof pageInfo.page === 'object'
    ? pageInfo.page as Record<string, unknown>
    : undefined;
  const pageKeys = [
    'viewportWidth', 'viewportHeight', 'documentWidth', 'documentHeight',
    'scrollX', 'scrollY', 'pixelsAbove', 'pixelsBelow', 'pixelsLeft',
    'pixelsRight', 'scrollPercentX', 'scrollPercentY',
  ] as const;
  const page = rawPage && pageKeys.every(key => Number.isFinite(rawPage[key]) && Number(rawPage[key]) >= 0)
    ? Object.fromEntries(pageKeys.map(key => [key, Number(rawPage[key])])) as unknown as PageGeometry
    : undefined;
  const pageGuidance = pageInfo.guidance && typeof pageInfo.guidance === 'object'
    ? pageInfo.guidance as Record<string, unknown>
    : {};
  const boundedCount = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0
    ? Math.min(Number(value), 32)
    : 0;

  const [axSnapshot, rawDomSnapshot] = await Promise.all([
    transport.send(
      'Accessibility.getFullAXTree',
      context.frameId ? { frameId: context.frameId } : {},
      sessionId,
    ),
    transport.send('DOMSnapshot.captureSnapshot', DOM_SNAPSHOT_CAPTURE_PARAMS, sessionId),
  ]);
  const nodes = Array.isArray(axSnapshot.nodes) ? axSnapshot.nodes : [];
  // The DOM capture already contains every same-process document and links each
  // iframe node to its child, so the document walk costs no extra round trip.
  const domView = parseDomSnapshot(rawDomSnapshot).frameView(context.frameId);
  const documentByIndex = new Map((domView?.documents ?? []).map(document => [document.index, document]));
  const documentOf = (node: DomSnapshotNodeFact): DomSnapshotDocument | undefined =>
    documentByIndex.get(node.documentIndex);

  // Accessibility.getFullAXTree returns one frame's tree, so a control that the
  // accessibility tree describes but Chrome does not mark clickable -- a plain
  // <button> with no listener -- would be invisible inside a nested frame while
  // a clickable <div> beside it was reported. Fetch the nested trees too, but
  // only when nested documents exist, so a frameless page keeps its single
  // parallel round trip.
  const nestedFrameIds = (domView?.documents ?? [])
    .filter(document => document !== domView?.root && document.frameId)
    .map(document => document.frameId)
    .slice(0, MAX_NESTED_AX_FRAMES);
  // Reuses the existing work_limit reason rather than adding a truncation
  // vocabulary entry, which would change the frozen Observation v1 contract.
  if (nestedFrameIds.length < ((domView?.documents.length ?? 1) - 1)) truncation.add('work_limit');
  const nestedAxNodeSets = await Promise.all(nestedFrameIds.map(async frameId => {
    try {
      const nested = await transport.send('Accessibility.getFullAXTree', { frameId }, sessionId);
      return Array.isArray(nested.nodes) ? nested.nodes : [];
    } catch {
      // A frame can detach between the DOM capture and this call. Its DOM-only
      // controls still surface below; losing its accessibility names is a
      // smaller failure than losing the whole observation.
      return [];
    }
  }));

  // Build tree using childIds ordering. Each frame's tree is linked on its own,
  // because accessibility node ids are only unique within the frame that
  // produced them and merging the sets would let one frame's id shadow
  // another's.
  const roots: any[] = [];
  for (const axNodes of [nodes, ...nestedAxNodeSets]) {
    const map = new Map<string, any>();
    for (const n of axNodes) map.set(n.nodeId, { ...n, children: [] as any[] });
    for (const [, node] of map) {
      if (node.childIds) {
        node.children = node.childIds.map((id: string) => map.get(id)).filter(Boolean);
      }
      if (!node.parentId) roots.push(node);
    }
  }

  // Walk depth-first, collect interactive elements
  const refs: RefEntry[] = [];
  const elements: SnapshotData['elements'] = [];
  const autocompleteRefs: number[] = [];
  const modalRefs: number[] = [];
  const filterRefs: number[] = [];
  let modalCount = 0;
  const axClaimedBackendNodeIds = new Set<number>();
  const emittedBackendNodeIds = new Set<number>();
  let serializedBytes = Buffer.byteLength(JSON.stringify({ title, url, ...(page ? { page } : {}), elements: [] }), 'utf8');
  let byteBudgetExhausted = serializedBytes > OBSERVATION_V1_LIMITS.maxSerializedBytes;
  if (byteBudgetExhausted) truncation.add('byte_limit');

  function addElement(input: {
    backendNodeId: number;
    role: string;
    rawName: () => string;
    rawValue?: () => string | undefined;
    checked?: boolean;
    autocomplete?: string;
    insideDialog: boolean;
    owner?: { node: DomSnapshotNodeFact; document: DomSnapshotDocument };
  }): void {
    const effectiveRole = input.role.slice(0, 128);
    if (emittedBackendNodeIds.has(input.backendNodeId) || byteBudgetExhausted) return;
    if (refs.length >= limit) {
      truncation.add('element_limit');
      return;
    }

    const rawName = input.rawName();
    const rawValue = input.rawValue?.();
    const hasIdentity = rawName || rawValue || ALLOW_EMPTY_NAME.has(effectiveRole);
    if (!hasIdentity) return;
    const name = boundedText(rawName, OBSERVATION_V1_LIMITS.maxElementNameCharacters);
    const value = rawValue === undefined
      ? undefined
      : boundedText(rawValue, OBSERVATION_V1_LIMITS.maxElementValueCharacters);
    const el: SnapshotData['elements'][number] = { ref: refs.length + 1, role: effectiveRole, name };
    if (value !== undefined && value !== '') el.value = value;
    if (input.checked !== undefined) el.checked = input.checked;
    const elementBytes = Buffer.byteLength(JSON.stringify(el), 'utf8') + 1;
    if (serializedBytes + elementBytes > OBSERVATION_V1_LIMITS.maxSerializedBytes) {
      byteBudgetExhausted = true;
      truncation.add('byte_limit');
      return;
    }

    serializedBytes += elementBytes;
    emittedBackendNodeIds.add(input.backendNodeId);
    const ownerOffset = input.owner && domView ? domView.offsetOf(input.owner.document) : undefined;
    refs.push({
      backendNodeId: input.backendNodeId,
      role: effectiveRole,
      name,
      // Only carried when the node sits below the observed root; a ref in the
      // root document keeps the existing session-offset behavior.
      ...(input.owner && ownerOffset && (ownerOffset.x !== 0 || ownerOffset.y !== 0)
        ? { frameId: input.owner.node.frameId, frameOffset: ownerOffset }
        : input.owner?.node.frameId ? { frameId: input.owner.node.frameId } : {}),
    });
    elements.push(el);
    const ref = el.ref;
    const autocomplete = input.autocomplete?.trim().toLowerCase() ?? '';
    if (
      effectiveRole === 'combobox' &&
      autocomplete !== '' && autocomplete !== 'none' &&
      autocompleteRefs.length < 32
    ) autocompleteRefs.push(ref);
    if (input.insideDialog && modalRefs.length < 32) modalRefs.push(ref);
    if (
      filterRefs.length < 32 &&
      /(^|[\s_:-])(filter|filters|sort|sorting|refine|refinement)([\s_:-]|$)|筛选|过滤|排序/i.test(name)
    ) filterRefs.push(ref);
  }

  function walk(node: any, insideDialog = false, depth = 0): void {
    if (!node) return;
    if (depth > OBSERVATION_V1_LIMITS.maxTreeDepth) {
      truncation.add('depth_limit');
      return;
    }

    let childInsideDialog = insideDialog;
    if (!node.ignored) {
      const role = node.role?.value;
      const semantic = axElementSemantic(node);
      const props = semantic?.properties ?? Object.fromEntries(
        (node.properties || []).map((p: any) => [p.name, p.value?.value]),
      );
      const isDialog = role === 'dialog' || role === 'alertdialog';
      if (isDialog) {
        modalCount = Math.min(32, modalCount + 1);
        childInsideDialog = true;
      }

      if (semantic && !byteBudgetExhausted && !truncation.has('element_limit')) {
        const { backendNodeId } = semantic;
        if (Number.isSafeInteger(backendNodeId) && backendNodeId > 0) {
          axClaimedBackendNodeIds.add(backendNodeId);
          const domFact = domView?.byBackendNodeId.get(backendNodeId);
          const domOwner = domFact ? documentOf(domFact) : undefined;
          const domState = domFact && domOwner ? domElementState(domOwner, domFact) : undefined;
          const checked = props.checked === true || props.checked === 'true'
            ? true
            : props.checked === false || props.checked === 'false'
              ? false
              : domFact ? domElementChecked(domFact) : undefined;
          const nativeOption = semantic.role === 'option' && domFact?.nodeName === 'option';
          const blocked = props.disabled === true || props.disabled === 'true' ||
            props.readonly === true || props.readonly === 'true' ||
            nativeOption ||
            (domState !== undefined && (!domState.visible || domState.disabled || domState.readonly || domState.inert));
          if (!blocked) {
            addElement({
              backendNodeId,
              role: semantic.role,
              rawName: () => semantic.name !== undefined
                ? semantic.name
                : domFact && domOwner ? domElementName(domOwner, domFact, domWork) : '',
              rawValue: () => typeof node.value?.value === 'string'
                ? node.value.value
                : domFact && domOwner ? domElementValue(domOwner, domFact, domWork) : undefined,
              owner: domFact && domOwner ? { node: domFact, document: domOwner } : undefined,
              checked,
              autocomplete: typeof props.autocomplete === 'string'
                ? props.autocomplete
                : domFact?.attributes.get('autocomplete'),
              insideDialog: childInsideDialog,
            });
          }
        }
      }
    }

    // Always walk children — ignored containers can have interactive descendants
    for (const child of node.children) walk(child, childInsideDialog, depth + 1);
  }

  for (const root of roots) walk(root);

  // Every document in the view, not just the root: a control inside a
  // same-process iframe is otherwise unreachable without selecting that frame.
  // The shared budget checks below stop the walk across documents exactly as
  // they stopped it within one, so a frame-heavy page truncates rather than
  // exceeding its limits.
  outer: for (const document of domView?.documents ?? []) {
    for (const node of document.nodes) {
      if (byteBudgetExhausted || truncation.has('element_limit')) break outer;
      if (axClaimedBackendNodeIds.has(node.backendNodeId)) continue;
      if (node.depth > OBSERVATION_V1_LIMITS.maxTreeDepth) {
        truncation.add('depth_limit');
        continue;
      }
      if (!isDomOnlyCandidate(document, node)) continue;
      addElement({
        backendNodeId: node.backendNodeId,
        role: domElementRole(node),
        rawName: () => domElementName(document, node, domWork),
        rawValue: () => domElementValue(document, node, domWork),
        checked: domElementChecked(node),
        autocomplete: node.attributes.get('autocomplete'),
        insideDialog: domElementInsideDialog(document, node),
        owner: { node, document },
      });
      if (truncation.has('element_limit')) break outer;
    }
  }
  if (domWork.exhausted) truncation.add('work_limit');
  refStore.save(targetId, refs);

  // Format text
  const lines = [
    `[page] ${serializeStructuralText(title)} | ${serializeStructuralText(url, 2_048)}`,
    '',
  ];
  if (elements.length === 0) {
    lines.push('(no interactive elements)');
  } else {
    for (const el of elements) {
      let line = `[${el.ref}] ${serializeStructuralText(el.role, 128)} "${serializeStructuralText(el.name)}"`;
      if (el.value !== undefined && el.value !== '') {
        line += ` value="${serializeStructuralText(el.value)}"`;
      }
      if (el.checked) line += ' checked';
      lines.push(line);
    }
  }

  const truncationReasons = OBSERVATION_TRUNCATION_REASONS.filter(reason => truncation.has(reason));
  const truncated = truncationReasons.length > 0;
  return {
    text: lines.join('\n'),
    data: { title, url, ...(page ? { page } : {}), elements },
    guidance: {
      authenticationSurface: pageGuidance.authenticationSurface === true,
      modalCount,
      blockingModalCount: boundedCount(pageGuidance.blockingModalCount),
      explicitAutocompleteCount: boundedCount(pageGuidance.explicitAutocompleteCount),
      explicitFilterCount: boundedCount(pageGuidance.explicitFilterCount),
      autocompleteRefs,
      modalRefs,
      filterRefs,
    },
    truncated,
    truncationReasons,
  };
}

// ── Element resolution ──────────────────────────────

export function isRef(target: string): boolean {
  return /^\d+$/.test(target);
}

export function formatTarget(target: string, targetId?: string, refStore: RefStore = new MemoryRefStore()): string {
  if (isRef(target)) {
    const refs = refStore.load(targetId);
    const entry = refs[parseInt(target, 10) - 1];
    return entry ? `[${target}] ${entry.role} "${entry.name}"` : `[${target}]`;
  }
  return target;
}

export interface ResolvedTargetIdentity {
  objectId: string;
  ref?: number;
  entry?: RefEntry;
}

export async function resolveTargetIdentity(
  transport: Transport,
  sessionId: string,
  target: string,
  targetId?: string,
  refStore: RefStore = new MemoryRefStore(),
): Promise<ResolvedTargetIdentity> {
  if (isRef(target)) {
    const refs = refStore.load(targetId);
    const ref = parseInt(target, 10);
    if (ref < 1 || ref > refs.length) {
      throw new Error(`Ref [${ref}] not found. Run 'bp snapshot' to refresh.`);
    }
    const entry = refs[ref - 1];
    let object: unknown;
    try {
      ({ object } = await transport.send('DOM.resolveNode', {
        backendNodeId: entry.backendNodeId,
      }, sessionId));
    } catch (cause) {
      if (cause instanceof BrowserPilotError && cause.code === 'browser_disconnected') throw cause;
      if (cause instanceof CDPError && cause.code !== -32000) throw cause;
      throw new BrowserPilotError('stale_ref', 'Ref no longer resolves to the observed element', {
        context: { ...(targetId ? { targetId } : {}), ref },
        cause,
      });
    }
    const objectId = object && typeof object === 'object'
      ? (object as Record<string, unknown>).objectId
      : undefined;
    if (typeof objectId !== 'string' || !objectId) {
      throw new BrowserPilotError('stale_ref', 'Ref no longer resolves to the observed element', {
        context: { ...(targetId ? { targetId } : {}), ref },
      });
    }
    return { objectId, ref, entry };
  }

  const { result, exceptionDetails } = await transport.send('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(target)})`,
  }, sessionId);
  if (exceptionDetails) {
    throw invalidArgument(
      exceptionDetails.exception?.description || exceptionDetails.text || 'Element query failed',
      'selector',
    );
  }
  if (!result.objectId) throw new Error(`Element not found: ${target}`);
  return { objectId: result.objectId };
}

export async function resolveTarget(
  transport: Transport,
  sessionId: string,
  target: string,
  targetId?: string,
  refStore: RefStore = new MemoryRefStore(),
): Promise<string> {
  return (await resolveTargetIdentity(transport, sessionId, target, targetId, refStore)).objectId;
}
