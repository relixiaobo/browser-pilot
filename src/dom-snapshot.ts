const COMPUTED_STYLE_NAMES = [
  'display',
  'visibility',
  'opacity',
  'pointer-events',
] as const;

const INTERACTIVE_DOM_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox',
  'checkbox', 'radio', 'spinbutton', 'slider', 'switch',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
]);

const NAME_EXCLUDED_TAGS = new Set(['script', 'style', 'noscript', 'template']);
const INTERNAL_NAME_LIMIT = 4_096;
const INTERNAL_NAME_DEPTH_LIMIT = 128;
const INTERNAL_NAME_NODE_LIMIT = 10_000;

interface RareData<T> {
  index?: unknown;
  value?: unknown;
}

interface RawDocumentSnapshot {
  frameId?: unknown;
  documentURL?: unknown;
  baseURL?: unknown;
  nodes?: Record<string, unknown>;
  layout?: Record<string, unknown>;
}

export interface DomSnapshotBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DomSnapshotNodeFact {
  backendNodeId: number;
  documentIndex: number;
  frameId: string;
  nodeIndex: number;
  parentIndex: number;
  parentBackendNodeId?: number;
  depth: number;
  nodeType: number;
  nodeName: string;
  nodeValue: string;
  attributes: ReadonlyMap<string, string>;
  isClickable: boolean;
  inputValue?: string;
  inputChecked?: boolean;
  optionSelected?: boolean;
  contentDocumentIndex?: number;
  contentDocumentFrameId?: string;
  bounds?: DomSnapshotBounds;
  styles: Readonly<Record<string, string>>;
  paintOrder?: number;
}

export interface DomSnapshotDocument {
  index: number;
  frameId: string;
  url: string;
  baseUrl: string;
  nodes: DomSnapshotNodeFact[];
  byBackendNodeId: ReadonlyMap<number, DomSnapshotNodeFact>;
  byNodeIndex: ReadonlyMap<number, DomSnapshotNodeFact>;
  childrenByParent: ReadonlyMap<number, readonly DomSnapshotNodeFact[]>;
  byElementId: ReadonlyMap<string, DomSnapshotNodeFact>;
  labelsByFor: ReadonlyMap<string, readonly DomSnapshotNodeFact[]>;
}

export interface ParsedDomSnapshot {
  documents: DomSnapshotDocument[];
  byFrameId: ReadonlyMap<string, DomSnapshotDocument>;
  document(frameId?: string): DomSnapshotDocument | undefined;
}

export interface DomElementState {
  visible: boolean;
  disabled: boolean;
  readonly: boolean;
  inert: boolean;
}

export const DOM_SNAPSHOT_CAPTURE_PARAMS = Object.freeze({
  computedStyles: [...COMPUTED_STYLE_NAMES],
  includePaintOrder: true,
  includeDOMRects: true,
});

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function integerAt(value: unknown, index: number, fallback = -1): number {
  const item = array(value)[index];
  return Number.isSafeInteger(item) ? Number(item) : fallback;
}

function stringAt(strings: readonly unknown[], rawIndex: unknown): string {
  if (!Number.isSafeInteger(rawIndex)) return '';
  const value = strings[Number(rawIndex)];
  return typeof value === 'string' ? value : '';
}

function rareMap<T>(raw: unknown, decode: (value: unknown) => T | undefined): Map<number, T> {
  if (!raw || typeof raw !== 'object') return new Map();
  const data = raw as RareData<T>;
  const indexes = array(data.index);
  const values = array(data.value);
  const result = new Map<number, T>();
  for (let offset = 0; offset < indexes.length; offset += 1) {
    const index = indexes[offset];
    if (!Number.isSafeInteger(index) || Number(index) < 0) continue;
    const decoded = decode(values[offset]);
    if (decoded !== undefined) result.set(Number(index), decoded);
  }
  return result;
}

function rareBooleanSet(raw: unknown): Set<number> {
  if (!raw || typeof raw !== 'object') return new Set();
  const result = new Set<number>();
  for (const index of array((raw as RareData<boolean>).index)) {
    if (Number.isSafeInteger(index) && Number(index) >= 0) result.add(Number(index));
  }
  return result;
}

function decodeAttributes(strings: readonly unknown[], raw: unknown): Map<string, string> {
  const values = array(raw);
  const attributes = new Map<string, string>();
  for (let offset = 0; offset + 1 < values.length; offset += 2) {
    const name = stringAt(strings, values[offset]).trim().toLowerCase();
    if (!name) continue;
    attributes.set(name, stringAt(strings, values[offset + 1]));
  }
  return attributes;
}

function decodeBounds(raw: unknown): DomSnapshotBounds | undefined {
  const values = array(raw);
  if (values.length < 4 || values.slice(0, 4).some(value => !Number.isFinite(value))) return undefined;
  return {
    x: Number(values[0]),
    y: Number(values[1]),
    width: Number(values[2]),
    height: Number(values[3]),
  };
}

function decodeStyles(strings: readonly unknown[], raw: unknown): Record<string, string> {
  const values = array(raw);
  const styles: Record<string, string> = {};
  for (let index = 0; index < COMPUTED_STYLE_NAMES.length; index += 1) {
    styles[COMPUTED_STYLE_NAMES[index]] = stringAt(strings, values[index]);
  }
  return styles;
}

export function parseDomSnapshot(raw: unknown): ParsedDomSnapshot {
  const response = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const strings = array(response.strings);
  const rawDocuments = array(response.documents).filter(
    (document): document is RawDocumentSnapshot => Boolean(document && typeof document === 'object'),
  );

  const documents = rawDocuments.map((document, documentIndex): DomSnapshotDocument => {
    const rawNodes = document.nodes && typeof document.nodes === 'object' ? document.nodes : {};
    const rawLayout = document.layout && typeof document.layout === 'object' ? document.layout : {};
    const backendNodeIds = array(rawNodes.backendNodeId);
    const inputValues = rareMap(rawNodes.inputValue, value => stringAt(strings, value));
    const inputChecked = rareBooleanSet(rawNodes.inputChecked);
    const optionSelected = rareBooleanSet(rawNodes.optionSelected);
    const clickable = rareBooleanSet(rawNodes.isClickable);
    const contentDocuments = rareMap(
      rawNodes.contentDocumentIndex,
      value => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined,
    );
    const layoutByNode = new Map<number, {
      bounds?: DomSnapshotBounds;
      styles: Record<string, string>;
      paintOrder?: number;
    }>();
    const layoutNodeIndexes = array(rawLayout.nodeIndex);
    const layoutBounds = array(rawLayout.bounds);
    const layoutStyles = array(rawLayout.styles);
    const paintOrders = array(rawLayout.paintOrders);
    for (let layoutIndex = 0; layoutIndex < layoutNodeIndexes.length; layoutIndex += 1) {
      const nodeIndex = layoutNodeIndexes[layoutIndex];
      if (!Number.isSafeInteger(nodeIndex) || Number(nodeIndex) < 0) continue;
      const paintOrder = paintOrders[layoutIndex];
      layoutByNode.set(Number(nodeIndex), {
        bounds: decodeBounds(layoutBounds[layoutIndex]),
        styles: decodeStyles(strings, layoutStyles[layoutIndex]),
        ...(Number.isFinite(paintOrder) ? { paintOrder: Number(paintOrder) } : {}),
      });
    }

    const frameId = stringAt(strings, document.frameId);
    const nodes: DomSnapshotNodeFact[] = [];
    for (let nodeIndex = 0; nodeIndex < backendNodeIds.length; nodeIndex += 1) {
      const backendNodeId = backendNodeIds[nodeIndex];
      if (!Number.isSafeInteger(backendNodeId) || Number(backendNodeId) <= 0) continue;
      const layout = layoutByNode.get(nodeIndex);
      const contentDocumentIndex = contentDocuments.get(nodeIndex);
      nodes.push({
        backendNodeId: Number(backendNodeId),
        documentIndex,
        frameId,
        nodeIndex,
        parentIndex: integerAt(rawNodes.parentIndex, nodeIndex),
        depth: 0,
        nodeType: integerAt(rawNodes.nodeType, nodeIndex, 0),
        nodeName: stringAt(strings, array(rawNodes.nodeName)[nodeIndex]).toLowerCase(),
        nodeValue: stringAt(strings, array(rawNodes.nodeValue)[nodeIndex]),
        attributes: decodeAttributes(strings, array(rawNodes.attributes)[nodeIndex]),
        isClickable: clickable.has(nodeIndex),
        ...(inputValues.has(nodeIndex) ? { inputValue: inputValues.get(nodeIndex) } : {}),
        ...(inputChecked.has(nodeIndex) ? { inputChecked: true } : {}),
        ...(optionSelected.has(nodeIndex) ? { optionSelected: true } : {}),
        ...(contentDocumentIndex !== undefined ? { contentDocumentIndex } : {}),
        ...(layout?.bounds ? { bounds: layout.bounds } : {}),
        styles: layout?.styles ?? {},
        ...(layout?.paintOrder !== undefined ? { paintOrder: layout.paintOrder } : {}),
      });
    }

    const byNodeIndex = new Map(nodes.map(node => [node.nodeIndex, node]));
    for (const node of nodes) {
      const parent = byNodeIndex.get(node.parentIndex);
      if (parent) node.parentBackendNodeId = parent.backendNodeId;
      node.depth = nodeDepthByIndex(byNodeIndex, node.parentIndex);
    }

    const children = new Map<number, DomSnapshotNodeFact[]>();
    const byElementId = new Map<string, DomSnapshotNodeFact>();
    const labelsByFor = new Map<string, DomSnapshotNodeFact[]>();
    for (const node of nodes) {
      const siblings = children.get(node.parentIndex) ?? [];
      siblings.push(node);
      children.set(node.parentIndex, siblings);
      const id = node.attributes.get('id');
      if (id && !byElementId.has(id)) byElementId.set(id, node);
      const labelFor = node.nodeName === 'label' ? node.attributes.get('for') : undefined;
      if (labelFor) {
        const labels = labelsByFor.get(labelFor) ?? [];
        labels.push(node);
        labelsByFor.set(labelFor, labels);
      }
    }

    return {
      index: documentIndex,
      frameId,
      url: stringAt(strings, document.documentURL),
      baseUrl: stringAt(strings, document.baseURL),
      nodes,
      byBackendNodeId: new Map(nodes.map(node => [node.backendNodeId, node])),
      byNodeIndex,
      childrenByParent: children,
      byElementId,
      labelsByFor,
    };
  });

  for (const document of documents) {
    for (const node of document.nodes) {
      if (node.contentDocumentIndex === undefined) continue;
      node.contentDocumentFrameId = documents[node.contentDocumentIndex]?.frameId;
    }
  }

  const byFrameId = new Map(documents.filter(document => document.frameId).map(document => [document.frameId, document]));
  return {
    documents,
    byFrameId,
    document(frameId?: string) {
      return frameId ? byFrameId.get(frameId) : documents[0];
    },
  };
}

function nodeDepthByIndex(nodes: ReadonlyMap<number, DomSnapshotNodeFact>, parentIndex: number): number {
  let depth = 0;
  let current = parentIndex;
  const visited = new Set<number>();
  while (current >= 0 && !visited.has(current)) {
    visited.add(current);
    const parent = nodes.get(current);
    if (!parent) break;
    depth += 1;
    current = parent.parentIndex;
  }
  return depth;
}

function attributePresent(value: string | undefined): boolean {
  return value !== undefined;
}

function ariaTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function ancestors(document: DomSnapshotDocument, node: DomSnapshotNodeFact): DomSnapshotNodeFact[] {
  const result: DomSnapshotNodeFact[] = [];
  let parentIndex = node.parentIndex;
  const visited = new Set<number>();
  while (parentIndex >= 0 && !visited.has(parentIndex)) {
    visited.add(parentIndex);
    const parent = document.byNodeIndex.get(parentIndex);
    if (!parent) break;
    result.push(parent);
    parentIndex = parent.parentIndex;
  }
  return result;
}

export function domElementState(
  document: DomSnapshotDocument,
  node: DomSnapshotNodeFact,
): DomElementState {
  const lineage = [node, ...ancestors(document, node)];
  const bounds = node.bounds;
  const visible = Boolean(
    bounds && bounds.width > 0 && bounds.height > 0 &&
    node.styles.display !== 'none' &&
    node.styles.visibility !== 'hidden' &&
    node.styles.visibility !== 'collapse' &&
    node.styles['pointer-events'] !== 'none' &&
    !lineage.some(candidate => (
      attributePresent(candidate.attributes.get('hidden')) ||
      ariaTrue(candidate.attributes.get('aria-hidden')) ||
      candidate.styles.display === 'none' ||
      candidate.styles.visibility === 'hidden' ||
      candidate.styles.visibility === 'collapse' ||
      Number.parseFloat(candidate.styles.opacity) === 0
    ))
  );
  const inert = lineage.some(candidate => attributePresent(candidate.attributes.get('inert')));
  const disabled = lineage.some(candidate => (
    attributePresent(candidate.attributes.get('disabled')) ||
    ariaTrue(candidate.attributes.get('aria-disabled'))
  ));
  const readonly = attributePresent(node.attributes.get('readonly')) || ariaTrue(node.attributes.get('aria-readonly'));
  return { visible, disabled, readonly, inert };
}

export function domElementInsideDialog(
  document: DomSnapshotDocument,
  node: DomSnapshotNodeFact,
): boolean {
  return [node, ...ancestors(document, node)].some(candidate => {
    const role = candidate.attributes.get('role')?.trim().toLowerCase();
    return role === 'dialog' || role === 'alertdialog';
  });
}

function normalizeName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, INTERNAL_NAME_LIMIT);
}

function descendantText(
  document: DomSnapshotDocument,
  root: DomSnapshotNodeFact,
  maxLength = INTERNAL_NAME_LIMIT,
): string {
  const parts: string[] = [];
  let length = 0;
  let visitedCount = 0;
  const visited = new Set<number>();
  const stack: Array<{ node: DomSnapshotNodeFact; depth: number }> = [{ node: root, depth: 0 }];
  while (stack.length > 0 && length < maxLength && visitedCount < INTERNAL_NAME_NODE_LIMIT) {
    const current = stack.pop();
    if (!current || current.depth > INTERNAL_NAME_DEPTH_LIMIT || visited.has(current.node.nodeIndex)) continue;
    const node = current.node;
    visited.add(node.nodeIndex);
    visitedCount += 1;
    if (NAME_EXCLUDED_TAGS.has(node.nodeName)) continue;
    if (node !== root && node.nodeType === 1 && (
      attributePresent(node.attributes.get('hidden')) ||
      ariaTrue(node.attributes.get('aria-hidden')) ||
      node.styles.display === 'none' ||
      node.styles.visibility === 'hidden' ||
      node.styles.visibility === 'collapse' ||
      Number.parseFloat(node.styles.opacity) === 0
    )) continue;
    if (node.nodeType === 3 && node.nodeValue) {
      const value = node.nodeValue.slice(0, maxLength - length);
      parts.push(value);
      length += value.length;
    }
    const children = document.childrenByParent.get(node.nodeIndex) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index], depth: current.depth + 1 });
    }
  }
  return normalizeName(parts.join(' '));
}

function labelText(document: DomSnapshotDocument, node: DomSnapshotNodeFact): string {
  const id = node.attributes.get('id');
  if (id) {
    const labels: string[] = [];
    for (const candidate of document.labelsByFor.get(id) ?? []) {
      const text = descendantText(document, candidate);
      if (text) labels.push(text);
    }
    if (labels.length > 0) return normalizeName(labels.join(' '));
  }
  for (const candidate of ancestors(document, node)) {
    if (candidate.nodeName === 'label') return descendantText(document, candidate);
  }
  return '';
}

export function domElementName(document: DomSnapshotDocument, node: DomSnapshotNodeFact): string {
  const labelledBy = node.attributes.get('aria-labelledby');
  if (labelledBy) {
    const labels = labelledBy.split(/\s+/)
      .map(id => document.byElementId.get(id))
      .filter((candidate): candidate is DomSnapshotNodeFact => candidate !== undefined)
      .map(candidate => descendantText(document, candidate))
      .filter(Boolean);
    const name = normalizeName(labels.join(' '));
    if (name) return name;
  }

  const candidates = [
    node.attributes.get('aria-label'),
    labelText(document, node),
    node.attributes.get('title'),
    node.attributes.get('placeholder'),
    node.attributes.get('alt'),
  ];
  const inputType = node.attributes.get('type')?.trim().toLowerCase();
  if (node.nodeName === 'input' && ['button', 'submit', 'reset'].includes(inputType ?? '')) {
    candidates.push(node.inputValue, node.attributes.get('value'));
  }
  candidates.push(descendantText(document, node));
  for (const candidate of candidates) {
    if (candidate) {
      const name = normalizeName(candidate);
      if (name) return name;
    }
  }
  return '';
}

export function domElementValue(document: DomSnapshotDocument, node: DomSnapshotNodeFact): string | undefined {
  if (node.inputValue !== undefined) return node.inputValue;
  const contenteditable = node.attributes.get('contenteditable')?.trim().toLowerCase();
  if (contenteditable !== undefined && contenteditable !== 'false') {
    return descendantText(document, node, 65_536);
  }
  return undefined;
}

export function domElementChecked(node: DomSnapshotNodeFact): boolean | undefined {
  if (node.nodeName !== 'input') return undefined;
  const type = node.attributes.get('type')?.trim().toLowerCase();
  if (type !== 'checkbox' && type !== 'radio') return undefined;
  return node.inputChecked === true;
}

export function domElementRole(node: DomSnapshotNodeFact): string {
  const explicitRoles = (node.attributes.get('role') ?? '').trim().toLowerCase().split(/\s+/);
  const explicitRole = explicitRoles[0];
  if (explicitRole && INTERACTIVE_DOM_ROLES.has(explicitRole)) return explicitRole;

  if ((node.nodeName === 'a' || node.nodeName === 'area') && node.attributes.has('href')) return 'link';
  if (node.nodeName === 'button') return 'button';
  if (node.nodeName === 'textarea') return 'textbox';
  if (node.nodeName === 'select') return node.attributes.has('multiple') ? 'listbox' : 'combobox';
  if (node.nodeName === 'input') {
    switch (node.attributes.get('type')?.trim().toLowerCase()) {
      case 'checkbox': return 'checkbox';
      case 'radio': return 'radio';
      case 'range': return 'slider';
      case 'number': return 'spinbutton';
      case 'search': return 'searchbox';
      case 'button':
      case 'submit':
      case 'reset':
      case 'image': return 'button';
      case 'file': return 'button';
      default: return 'textbox';
    }
  }
  return 'button';
}

export function isDomOnlyCandidate(
  document: DomSnapshotDocument,
  node: DomSnapshotNodeFact,
): boolean {
  if (node.nodeType !== 1 || !node.isClickable) return false;
  const state = domElementState(document, node);
  return state.visible && !state.disabled && !state.readonly && !state.inert;
}
