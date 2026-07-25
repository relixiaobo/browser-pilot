import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { REFS_FILE } from './paths.js';
import { PAGE_INFO } from './page-scripts.js';
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

interface StoredRefs {
  targetId: string;
  entries: RefEntry[];
}

export interface RefStore {
  save(targetId: string, entries: RefEntry[]): void;
  load(expectedTargetId?: string): RefEntry[];
}

export class FileRefStore implements RefStore {
  constructor(private readonly file: string = REFS_FILE) {}

  save(targetId: string, entries: RefEntry[]): void {
    writeFileSync(this.file, JSON.stringify({ targetId, entries } satisfies StoredRefs), { mode: 0o600 });
  }

  load(expectedTargetId?: string): RefEntry[] {
    if (!existsSync(this.file)) return [];
    try {
      const stored: StoredRefs = JSON.parse(readFileSync(this.file, 'utf-8'));
      if (expectedTargetId && stored.targetId !== expectedTargetId) return [];
      return stored.entries;
    } catch { return []; }
  }
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

export const legacyRefStore: RefStore = new FileRefStore();

export interface SnapshotData {
  title: string;
  url: string;
  // NOTE: elements are exposed to LLM agents — keep this lean.
  // backendNodeId is intentionally omitted (saved separately in REFS_FILE for resolution).
  elements: Array<{ ref: number; role: string; name: string; value?: string; checked?: boolean }>;
}

export interface SnapshotResult {
  text: string;
  data: SnapshotData;
  guidance: SnapshotGuidanceSignals;
  truncated?: boolean;
  truncationReasons?: Array<'element_limit'>;
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

// ── Ref persistence (scoped to targetId) ────────────

export function loadRefs(expectedTargetId?: string): RefEntry[] {
  return legacyRefStore.load(expectedTargetId);
}

// ── Snapshot ────────────────────────────────────────

export async function takeSnapshot(
  transport: Transport,
  sessionId: string,
  targetId: string,
  limit = 50,
  refStore: RefStore = legacyRefStore,
  context: SnapshotContext = {},
): Promise<SnapshotResult> {
  const infoParams: Record<string, unknown> = {
    expression: PAGE_INFO, returnByValue: true,
  };
  if (context.executionContextId) infoParams.contextId = context.executionContextId;
  const { result: info } = await transport.send('Runtime.evaluate', infoParams, sessionId);
  const pageInfo = JSON.parse(info.value);
  const { title, url } = pageInfo;
  const pageGuidance = pageInfo.guidance && typeof pageInfo.guidance === 'object'
    ? pageInfo.guidance as Record<string, unknown>
    : {};
  const boundedCount = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0
    ? Math.min(Number(value), 32)
    : 0;

  const { nodes } = await transport.send(
    'Accessibility.getFullAXTree',
    context.frameId ? { frameId: context.frameId } : {},
    sessionId,
  );

  // Build tree using childIds ordering
  const map = new Map<string, any>();
  for (const n of nodes) map.set(n.nodeId, { ...n, children: [] as any[] });
  let root: any = null;
  for (const [, node] of map) {
    if (node.childIds) {
      node.children = node.childIds.map((id: string) => map.get(id)).filter(Boolean);
    }
    if (!node.parentId) root = node;
  }

  // Walk depth-first, collect interactive elements
  const refs: RefEntry[] = [];
  const elements: SnapshotData['elements'] = [];
  const autocompleteRefs: number[] = [];
  const modalRefs: number[] = [];
  const filterRefs: number[] = [];
  let modalCount = 0;
  let eligibleCount = 0;

  function walk(node: any, insideDialog = false): void {
    if (!node) return;

    let childInsideDialog = insideDialog;
    if (!node.ignored) {
      const role = node.role?.value;
      const props = Object.fromEntries(
        (node.properties || []).map((p: any) => [p.name, p.value?.value]),
      );
      const isDialog = role === 'dialog' || role === 'alertdialog';
      if (isDialog) {
        modalCount = Math.min(32, modalCount + 1);
        childInsideDialog = true;
      }

      // Detect contenteditable elements (role=generic with editable=richtext in AX tree)
      const isEditable = props.editable === 'richtext';
      const isInteractive = role && (INTERACTIVE_ROLES.has(role) || isEditable);

      if (isInteractive && node.backendDOMNodeId !== undefined) {
        const name = node.name?.value || '';
        const value = node.value?.value;
        const effectiveRole = isEditable && role === 'generic' ? 'textbox' : role;

        // Allow empty name for input-like roles and editables; require name/value for buttons/links
        const hasIdentity = name || value || ALLOW_EMPTY_NAME.has(effectiveRole) || isEditable;
        if (!props.disabled && hasIdentity) {
          eligibleCount += 1;
        }
        if (!props.disabled && hasIdentity && refs.length < limit) {
          const checked = props.checked === 'true' || props.checked === true ? true : undefined;
          refs.push({ backendNodeId: node.backendDOMNodeId, role: effectiveRole, name });
          const el: SnapshotData['elements'][number] = { ref: refs.length, role: effectiveRole, name };
          if (value !== undefined && value !== '') el.value = value;
          if (checked) el.checked = true;
          elements.push(el);
          const ref = el.ref;
          const autocomplete = typeof props.autocomplete === 'string'
            ? props.autocomplete.trim().toLowerCase()
            : '';
          if (
            effectiveRole === 'combobox' &&
            autocomplete !== '' && autocomplete !== 'none' &&
            autocompleteRefs.length < 32
          ) autocompleteRefs.push(ref);
          if (childInsideDialog && modalRefs.length < 32) modalRefs.push(ref);
          if (
            filterRefs.length < 32 &&
            /(^|[\s_:-])(filter|filters|sort|sorting|refine|refinement)([\s_:-]|$)|筛选|过滤|排序/i.test(name)
          ) filterRefs.push(ref);
        }
      }
    }

    // Always walk children — ignored containers can have interactive descendants
    for (const child of node.children) walk(child, childInsideDialog);
  }

  if (root) walk(root);
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

  const truncated = eligibleCount > limit;
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
    truncationReasons: truncated ? ['element_limit'] : [],
  };
}

// ── Element resolution ──────────────────────────────

export function isRef(target: string): boolean {
  return /^\d+$/.test(target);
}

export function formatTarget(target: string, targetId?: string, refStore: RefStore = legacyRefStore): string {
  if (isRef(target)) {
    const refs = refStore.load(targetId);
    const entry = refs[parseInt(target, 10) - 1];
    return entry ? `[${target}] ${entry.role} "${entry.name}"` : `[${target}]`;
  }
  return target;
}

export async function resolveTarget(
  transport: Transport,
  sessionId: string,
  target: string,
  targetId?: string,
  refStore: RefStore = legacyRefStore,
): Promise<string> {
  if (isRef(target)) {
    const refs = refStore.load(targetId);
    const ref = parseInt(target, 10);
    if (ref < 1 || ref > refs.length) {
      throw new Error(`Ref [${ref}] not found. Run 'bp snapshot' to refresh.`);
    }
    const { object } = await transport.send('DOM.resolveNode', {
      backendNodeId: refs[ref - 1].backendNodeId,
    }, sessionId);
    return object.objectId;
  }

  const { result } = await transport.send('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(target)})`,
  }, sessionId);
  if (!result.objectId) throw new Error(`Element not found: ${target}`);
  return result.objectId;
}
