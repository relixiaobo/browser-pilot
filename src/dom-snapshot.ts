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

interface RareData {
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
  lineageByNodeIndex: ReadonlyMap<number, DomSnapshotLineage>;
}

export interface DomSnapshotLineage {
  hidden: boolean;
  inert: boolean;
  disabled: boolean;
  insideDialog: boolean;
  nearestLabelNodeIndex?: number;
}

export interface DomSnapshotWorkBudget {
  maxDescendantTextNodes: number;
  descendantTextNodes: number;
  exhausted: boolean;
  onDescendantTextNode?: () => void;
}

/**
 * A document and every same-process document nested inside it, with the page
 * offset each one sits at. Layout bounds inside a child document are relative
 * to that document's own viewport, so the offset is what makes coordinates
 * from different documents comparable.
 */
export interface DomSnapshotFrameView {
  root: DomSnapshotDocument;
  documents: readonly DomSnapshotDocument[];
  byBackendNodeId: ReadonlyMap<number, DomSnapshotNodeFact>;
  offsetOf(document: DomSnapshotDocument): { x: number; y: number };
}

export interface ParsedDomSnapshot {
  documents: DomSnapshotDocument[];
  byFrameId: ReadonlyMap<string, DomSnapshotDocument>;
  document(frameId?: string): DomSnapshotDocument | undefined;
  frameView(frameId?: string): DomSnapshotFrameView | undefined;
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
  const data = raw as RareData;
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
  for (const index of array((raw as RareData).index)) {
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
    populateNodeDepths(nodes, byNodeIndex);
    for (const node of nodes) {
      const parent = byNodeIndex.get(node.parentIndex);
      if (parent) node.parentBackendNodeId = parent.backendNodeId;
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
      lineageByNodeIndex: buildLineage(nodes),
    };
  });

  for (const document of documents) {
    for (const node of document.nodes) {
      if (node.contentDocumentIndex === undefined) continue;
      node.contentDocumentFrameId = documents[node.contentDocumentIndex]?.frameId;
    }
  }

  const byFrameId = new Map(documents.filter(document => document.frameId).map(document => [document.frameId, document]));
  const byIndex = new Map(documents.map(document => [document.index, document]));
  return {
    documents,
    byFrameId,
    document(frameId?: string) {
      return frameId ? byFrameId.get(frameId) : documents[0];
    },
    frameView(frameId?: string): DomSnapshotFrameView | undefined {
      const root = frameId ? byFrameId.get(frameId) : documents[0];
      if (!root) return undefined;

      // Same-process child documents arrive in the same capture, linked from the
      // owning iframe node. Walk down from the root only: a selected subframe
      // must not observe its parent. Each document carries the page offset of
      // the iframe chain above it, because its own layout bounds are relative to
      // its own viewport.
      const included: DomSnapshotDocument[] = [];
      const offsets = new Map<number, DomSnapshotBounds>();
      const byBackendNodeId = new Map<number, DomSnapshotNodeFact>();
      const seen = new Set<number>();
      const queue: { document: DomSnapshotDocument; x: number; y: number }[] = [
        { document: root, x: 0, y: 0 },
      ];

      while (queue.length > 0) {
        const { document, x, y } = queue.shift()!;
        // A malformed capture could link a document twice or cycle; visiting
        // each document once keeps the walk finite.
        if (seen.has(document.index)) continue;
        seen.add(document.index);
        included.push(document);
        offsets.set(document.index, { x, y, width: 0, height: 0 });
        for (const node of document.nodes) {
          if (!byBackendNodeId.has(node.backendNodeId)) byBackendNodeId.set(node.backendNodeId, node);
          if (node.contentDocumentIndex === undefined) continue;
          const child = byIndex.get(node.contentDocumentIndex);
          if (!child || seen.has(child.index)) continue;
          queue.push({
            document: child,
            x: x + (node.bounds?.x ?? 0),
            y: y + (node.bounds?.y ?? 0),
          });
        }
      }

      return {
        root,
        documents: included,
        byBackendNodeId,
        offsetOf(document: DomSnapshotDocument) {
          const offset = offsets.get(document.index);
          return { x: offset?.x ?? 0, y: offset?.y ?? 0 };
        },
      };
    },
  };
}

function populateNodeDepths(
  nodes: readonly DomSnapshotNodeFact[],
  byNodeIndex: ReadonlyMap<number, DomSnapshotNodeFact>,
): void {
  const depths = new Map<number, number>();
  for (const node of nodes) {
    if (depths.has(node.nodeIndex)) continue;
    const chain: DomSnapshotNodeFact[] = [];
    const visited = new Set<number>();
    let current: DomSnapshotNodeFact | undefined = node;
    while (current && !depths.has(current.nodeIndex) && !visited.has(current.nodeIndex)) {
      visited.add(current.nodeIndex);
      chain.push(current);
      current = byNodeIndex.get(current.parentIndex);
    }
    let depth = current ? depths.get(current.nodeIndex) ?? -1 : -1;
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      depth += 1;
      depths.set(chain[index].nodeIndex, depth);
    }
  }
  for (const node of nodes) node.depth = depths.get(node.nodeIndex) ?? 0;
}

function attributePresent(value: string | undefined): boolean {
  return value !== undefined;
}

function ariaTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function buildLineage(nodes: readonly DomSnapshotNodeFact[]): Map<number, DomSnapshotLineage> {
  const result = new Map<number, DomSnapshotLineage>();
  const ordered = [...nodes].sort((left, right) => left.depth - right.depth);
  for (const node of ordered) {
    const parent = result.get(node.parentIndex);
    const role = node.attributes.get('role')?.trim().toLowerCase();
    result.set(node.nodeIndex, {
      hidden: (parent?.hidden ?? false) ||
        attributePresent(node.attributes.get('hidden')) ||
        ariaTrue(node.attributes.get('aria-hidden')) ||
        node.styles.display === 'none' ||
        node.styles.visibility === 'hidden' ||
        node.styles.visibility === 'collapse' ||
        Number.parseFloat(node.styles.opacity) === 0,
      inert: (parent?.inert ?? false) || attributePresent(node.attributes.get('inert')),
      disabled: (parent?.disabled ?? false) ||
        attributePresent(node.attributes.get('disabled')) ||
        ariaTrue(node.attributes.get('aria-disabled')),
      insideDialog: (parent?.insideDialog ?? false) || role === 'dialog' || role === 'alertdialog',
      ...(node.nodeName === 'label'
        ? { nearestLabelNodeIndex: node.nodeIndex }
        : parent?.nearestLabelNodeIndex !== undefined
          ? { nearestLabelNodeIndex: parent.nearestLabelNodeIndex }
          : {}),
    });
  }
  return result;
}

export function domElementState(
  document: DomSnapshotDocument,
  node: DomSnapshotNodeFact,
): DomElementState {
  const lineage = document.lineageByNodeIndex.get(node.nodeIndex);
  const bounds = node.bounds;
  const visible = Boolean(
    bounds && bounds.width > 0 && bounds.height > 0 &&
    node.styles.display !== 'none' &&
    node.styles.visibility !== 'hidden' &&
    node.styles.visibility !== 'collapse' &&
    node.styles['pointer-events'] !== 'none' &&
    !lineage?.hidden
  );
  const readonly = attributePresent(node.attributes.get('readonly')) || ariaTrue(node.attributes.get('aria-readonly'));
  return { visible, disabled: lineage?.disabled ?? false, readonly, inert: lineage?.inert ?? false };
}

export function domElementInsideDialog(
  document: DomSnapshotDocument,
  node: DomSnapshotNodeFact,
): boolean {
  return document.lineageByNodeIndex.get(node.nodeIndex)?.insideDialog ?? false;
}

function normalizeName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, INTERNAL_NAME_LIMIT);
}

function descendantText(
  document: DomSnapshotDocument,
  root: DomSnapshotNodeFact,
  maxLength = INTERNAL_NAME_LIMIT,
  work?: DomSnapshotWorkBudget,
): string {
  const parts: string[] = [];
  let length = 0;
  let visitedCount = 0;
  const visited = new Set<number>();
  const stack: Array<{ node: DomSnapshotNodeFact; depth: number }> = [{ node: root, depth: 0 }];
  while (stack.length > 0 && length < maxLength && visitedCount < INTERNAL_NAME_NODE_LIMIT) {
    const current = stack.pop();
    if (!current || current.depth > INTERNAL_NAME_DEPTH_LIMIT || visited.has(current.node.nodeIndex)) continue;
    if (work && work.descendantTextNodes >= work.maxDescendantTextNodes) {
      work.exhausted = true;
      break;
    }
    const node = current.node;
    visited.add(node.nodeIndex);
    visitedCount += 1;
    if (work) {
      work.descendantTextNodes += 1;
      work.onDescendantTextNode?.();
    }
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

function labelText(
  document: DomSnapshotDocument,
  node: DomSnapshotNodeFact,
  work?: DomSnapshotWorkBudget,
): string {
  const id = node.attributes.get('id');
  if (id) {
    const labels: string[] = [];
    for (const candidate of document.labelsByFor.get(id) ?? []) {
      const text = descendantText(document, candidate, INTERNAL_NAME_LIMIT, work);
      if (text) labels.push(text);
    }
    if (labels.length > 0) return normalizeName(labels.join(' '));
  }
  const nearestLabelNodeIndex = document.lineageByNodeIndex.get(node.parentIndex)?.nearestLabelNodeIndex;
  const nearestLabel = nearestLabelNodeIndex === undefined
    ? undefined
    : document.byNodeIndex.get(nearestLabelNodeIndex);
  if (nearestLabel) return descendantText(document, nearestLabel, INTERNAL_NAME_LIMIT, work);
  return '';
}

export function domElementName(
  document: DomSnapshotDocument,
  node: DomSnapshotNodeFact,
  work?: DomSnapshotWorkBudget,
): string {
  const labelledBy = node.attributes.get('aria-labelledby');
  if (labelledBy) {
    const labels = labelledBy.split(/\s+/)
      .map(id => document.byElementId.get(id))
      .filter((candidate): candidate is DomSnapshotNodeFact => candidate !== undefined)
      .map(candidate => descendantText(document, candidate, INTERNAL_NAME_LIMIT, work))
      .filter(Boolean);
    const name = normalizeName(labels.join(' '));
    if (name) return name;
  }

  const ariaLabel = node.attributes.get('aria-label');
  if (ariaLabel) {
    const name = normalizeName(ariaLabel);
    if (name) return name;
  }
  const label = labelText(document, node, work);
  if (label) return normalizeName(label);
  for (const candidate of [
    node.attributes.get('title'),
    node.attributes.get('placeholder'),
    node.attributes.get('alt'),
  ]) {
    if (!candidate) continue;
    const name = normalizeName(candidate);
    if (name) return name;
  }
  const inputType = node.attributes.get('type')?.trim().toLowerCase();
  if (node.nodeName === 'input' && ['button', 'submit', 'reset'].includes(inputType ?? '')) {
    for (const candidate of [node.inputValue, node.attributes.get('value')]) {
      if (!candidate) continue;
      const name = normalizeName(candidate);
      if (name) return name;
    }
  }
  return descendantText(document, node, INTERNAL_NAME_LIMIT, work);
}

export function domElementValue(
  document: DomSnapshotDocument,
  node: DomSnapshotNodeFact,
  work?: DomSnapshotWorkBudget,
): string | undefined {
  if (node.inputValue !== undefined) return node.inputValue;
  const contenteditable = node.attributes.get('contenteditable')?.trim().toLowerCase();
  if (contenteditable !== undefined && contenteditable !== 'false') {
    return descendantText(document, node, 65_536, work);
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
