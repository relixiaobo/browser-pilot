import { PAGE_INFO } from './page-scripts.js';
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
} from './dom-snapshot.js';
import {
  OBSERVATION_TRUNCATION_REASONS,
  OBSERVATION_V1_LIMITS,
  type ObservationElement,
  type ObservationTruncationReason,
} from './protocol/model.js';
import { BrowserPilotError } from './protocol/errors.js';
import type { Transport } from './transport.js';

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox',
  'checkbox', 'radio', 'spinbutton', 'slider', 'switch',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
]);

// Roles where an empty name is acceptable (unnamed inputs are still interactive)
const ALLOW_EMPTY_NAME = new Set([
  'textbox', 'searchbox', 'combobox', 'listbox',
  'checkbox', 'radio', 'spinbutton', 'slider', 'switch',
]);

// ── Types ───────────────────────────────────────────

export interface RefEntry {
  backendNodeId: number;
  role: string;
  name: string;
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
  const { result: info } = await transport.send('Runtime.evaluate', infoParams, sessionId);
  const pageInfo = JSON.parse(info.value);
  const truncation = new Set<ObservationTruncationReason>();
  let textCharacters = 0;

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
  const domDocument = parseDomSnapshot(rawDomSnapshot).document(context.frameId);

  // Build tree using childIds ordering
  const map = new Map<string, any>();
  for (const n of nodes) map.set(n.nodeId, { ...n, children: [] as any[] });
  const roots: any[] = [];
  for (const [, node] of map) {
    if (node.childIds) {
      node.children = node.childIds.map((id: string) => map.get(id)).filter(Boolean);
    }
    if (!node.parentId) roots.push(node);
  }

  // Walk depth-first, collect interactive elements
  const refs: RefEntry[] = [];
  const elements: SnapshotData['elements'] = [];
  const autocompleteRefs: number[] = [];
  const modalRefs: number[] = [];
  const filterRefs: number[] = [];
  let modalCount = 0;
  let eligibleCount = 0;
  const axClaimedBackendNodeIds = new Set<number>();
  const emittedBackendNodeIds = new Set<number>();
  let serializedBytes = Buffer.byteLength(JSON.stringify({ title, url, elements: [] }), 'utf8');
  let byteBudgetExhausted = serializedBytes > OBSERVATION_V1_LIMITS.maxSerializedBytes;
  if (byteBudgetExhausted) truncation.add('byte_limit');

  function addElement(input: {
    backendNodeId: number;
    role: string;
    rawName: string;
    rawValue?: string;
    checked?: boolean;
    autocomplete?: string;
    insideDialog: boolean;
  }): void {
    const effectiveRole = input.role.slice(0, 128);
    const hasIdentity = input.rawName || input.rawValue || ALLOW_EMPTY_NAME.has(effectiveRole);
    if (!hasIdentity || emittedBackendNodeIds.has(input.backendNodeId)) return;
    eligibleCount += 1;
    if (refs.length >= limit || byteBudgetExhausted) return;

    const name = boundedText(input.rawName, OBSERVATION_V1_LIMITS.maxElementNameCharacters);
    const value = input.rawValue === undefined
      ? undefined
      : boundedText(input.rawValue, OBSERVATION_V1_LIMITS.maxElementValueCharacters);
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
    refs.push({ backendNodeId: input.backendNodeId, role: effectiveRole, name });
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

      if (semantic) {
        const { backendNodeId } = semantic;
        if (Number.isSafeInteger(backendNodeId) && backendNodeId > 0) {
          axClaimedBackendNodeIds.add(backendNodeId);
          const domFact = domDocument?.byBackendNodeId.get(backendNodeId);
          const domState = domFact && domDocument ? domElementState(domDocument, domFact) : undefined;
          const rawName = semantic.name !== undefined
            ? semantic.name
            : domFact && domDocument ? domElementName(domDocument, domFact) : '';
          const rawValue = typeof node.value?.value === 'string'
            ? node.value.value
            : domFact && domDocument ? domElementValue(domDocument, domFact) : undefined;
          const checked = props.checked === true || props.checked === 'true'
            ? true
            : props.checked === false || props.checked === 'false'
              ? false
              : domFact ? domElementChecked(domFact) : undefined;
          const blocked = props.disabled === true || props.disabled === 'true' ||
            props.readonly === true || props.readonly === 'true' ||
            (domState !== undefined && (!domState.visible || domState.disabled || domState.readonly || domState.inert));
          if (!blocked) {
            addElement({
              backendNodeId,
              role: semantic.role,
              rawName,
              rawValue,
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

  if (domDocument) {
    for (const node of domDocument.nodes) {
      if (axClaimedBackendNodeIds.has(node.backendNodeId) || !isDomOnlyCandidate(domDocument, node)) continue;
      if (node.depth > OBSERVATION_V1_LIMITS.maxTreeDepth) {
        truncation.add('depth_limit');
        continue;
      }
      addElement({
        backendNodeId: node.backendNodeId,
        role: domElementRole(node),
        rawName: domElementName(domDocument, node),
        rawValue: domElementValue(domDocument, node),
        checked: domElementChecked(node),
        autocomplete: node.attributes.get('autocomplete'),
        insideDialog: domElementInsideDialog(domDocument, node),
      });
    }
  }
  refStore.save(targetId, refs);

  // Format text
  const lines = [`[page] ${title} | ${url}`, ''];
  if (elements.length === 0) {
    lines.push('(no interactive elements)');
  } else {
    for (const el of elements) {
      let line = `[${el.ref}] ${el.role} "${el.name}"`;
      if (el.value !== undefined && el.value !== '') line += ` value="${el.value}"`;
      if (el.checked) line += ' checked';
      lines.push(line);
    }
  }

  if (eligibleCount > limit) truncation.add('element_limit');
  const truncationReasons = OBSERVATION_TRUNCATION_REASONS.filter(reason => truncation.has(reason));
  const truncated = truncationReasons.length > 0;
  return {
    text: lines.join('\n'),
    data: { title, url, elements },
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

  const { result } = await transport.send('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(target)})`,
  }, sessionId);
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
