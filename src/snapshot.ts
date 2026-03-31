import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { REFS_FILE } from './paths.js';
import { PAGE_INFO } from './page-scripts.js';
import type { Transport } from './transport.js';

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox',
  'checkbox', 'radio', 'spinbutton', 'slider', 'switch',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
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

export interface SnapshotData {
  title: string;
  url: string;
  elements: Array<RefEntry & { ref: number; value?: string; checked?: boolean }>;
}

export interface SnapshotResult {
  text: string;
  data: SnapshotData;
}

// ── Ref persistence (scoped to targetId) ────────────

function saveRefs(targetId: string, entries: RefEntry[]): void {
  writeFileSync(REFS_FILE, JSON.stringify({ targetId, entries } satisfies StoredRefs));
}

export function loadRefs(expectedTargetId?: string): RefEntry[] {
  if (!existsSync(REFS_FILE)) return [];
  try {
    const stored: StoredRefs = JSON.parse(readFileSync(REFS_FILE, 'utf-8'));
    if (expectedTargetId && stored.targetId !== expectedTargetId) return [];
    return stored.entries;
  } catch { return []; }
}

// ── Snapshot ────────────────────────────────────────

export async function takeSnapshot(transport: Transport, sessionId: string, targetId: string, limit = 50): Promise<SnapshotResult> {
  const { result: info } = await transport.send('Runtime.evaluate', {
    expression: PAGE_INFO, returnByValue: true,
  }, sessionId);
  const { title, url } = JSON.parse(info.value);

  const { nodes } = await transport.send('Accessibility.getFullAXTree', {}, sessionId);

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

  function walk(node: any): void {
    if (!node) return;

    if (!node.ignored) {
      const role = node.role?.value;
      if (role && INTERACTIVE_ROLES.has(role) && node.backendDOMNodeId !== undefined) {
        const props = Object.fromEntries(
          (node.properties || []).map((p: any) => [p.name, p.value?.value]),
        );
        const name = node.name?.value || '';
        const value = node.value?.value;

        if (!props.disabled && (name || value) && refs.length < limit) {
          const checked = props.checked === 'true' || props.checked === true ? true : undefined;
          refs.push({ backendNodeId: node.backendDOMNodeId, role, name });
          elements.push({ ref: refs.length, backendNodeId: node.backendDOMNodeId, role, name, value, checked });
        }
      }
    }

    // Always walk children — ignored containers can have interactive descendants
    for (const child of node.children) walk(child);
  }

  if (root) walk(root);
  saveRefs(targetId, refs);

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

  return { text: lines.join('\n'), data: { title, url, elements } };
}

// ── Element resolution ──────────────────────────────

export function isRef(target: string): boolean {
  return /^\d+$/.test(target);
}

export function formatTarget(target: string, targetId?: string): string {
  if (isRef(target)) {
    const refs = loadRefs(targetId);
    const entry = refs[parseInt(target, 10) - 1];
    return entry ? `[${target}] ${entry.role} "${entry.name}"` : `[${target}]`;
  }
  return target;
}

export async function resolveTarget(transport: Transport, sessionId: string, target: string, targetId?: string): Promise<string> {
  if (isRef(target)) {
    const refs = loadRefs(targetId);
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
