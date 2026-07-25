import { invalidArgument } from './errors.js';
import {
  CAPABILITIES,
  OBSERVATION_TRUNCATION_REASONS,
  OBSERVATION_V1_LIMITS,
  SENSITIVITIES,
  type ArtifactDescriptor,
  type Capability,
  type JsonValue,
  type Sensitivity,
} from './model.js';
import {
  arraySchema,
  assertSchemaDefinition,
  assertSchemaValue,
  booleanSchema,
  integerSchema,
  numberSchema,
  objectSchema,
  stringSchema,
  type JsonSchema,
} from './schema.js';

export type ToolContext = 'connection' | 'workspace' | 'target';
export type ToolIdempotency = 'read_only' | 'idempotent' | 'non_idempotent';
export type ToolCancellation = 'not_applicable' | 'before_dispatch' | 'best_effort';

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  context: ToolContext;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  requiredCapabilities: Capability[];
  mutating: boolean;
  idempotency: ToolIdempotency;
  cancellation: ToolCancellation;
  sensitivity: {
    input: Sensitivity[];
    output: Sensitivity[];
  };
  artifactKinds: ArtifactDescriptor['kind'][];
}

export interface ToolManifest {
  schemaVersion: 1;
  tools: ToolDefinition[];
}

const emptyInput = objectSchema({});

function sensitive(schema: JsonSchema, ...sensitivity: Sensitivity[]): JsonSchema {
  return { ...schema, 'x-browser-pilot-sensitivity': sensitivity };
}

const boundedText = sensitive(
  stringSchema({ minLength: 1, maxLength: 1_000_000 }),
  'browser_data',
  'credential',
);
const boundedSelector = sensitive(stringSchema({ minLength: 1, maxLength: 4096 }), 'browser_data');
const boundedUrl = sensitive(stringSchema({ minLength: 1, maxLength: 16_384 }), 'browser_data');
const opaqueIdSchema = stringSchema({ minLength: 3, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]+$' });
const headerSchema = objectSchema({
  name: sensitive(stringSchema({ minLength: 1, maxLength: 256 }), 'browser_data'),
  value: sensitive(stringSchema({ maxLength: 8192 }), 'browser_data', 'credential'),
}, ['name', 'value']);
const networkRuleSchema = objectSchema({
  ruleId: opaqueIdSchema,
  type: stringSchema({ enum: ['block', 'mock', 'headers'] }),
  pattern: boundedUrl,
  status: integerSchema({ minimum: 100, maximum: 999 }),
  headers: arraySchema(headerSchema, { maxItems: 256 }),
  bodySize: integerSchema({ minimum: 0 }),
}, ['ruleId', 'type', 'pattern']);
const networkRequestDetailSchema = objectSchema({
  requestId: opaqueIdSchema,
  sequence: integerSchema({ minimum: 1 }),
  method: stringSchema({ maxLength: 32 }),
  url: boundedUrl,
  type: stringSchema({ maxLength: 128 }),
  requestHeaders: arraySchema(headerSchema, { maxItems: 256 }),
  postData: sensitive(stringSchema({ maxLength: 65_536 }), 'browser_data', 'credential'),
  postDataTruncated: booleanSchema(),
  status: integerSchema({ minimum: 100, maximum: 999 }),
  statusText: sensitive(stringSchema({ maxLength: 4096 }), 'browser_data'),
  responseHeaders: arraySchema(headerSchema, { maxItems: 256 }),
  mimeType: stringSchema({ maxLength: 256 }),
  size: integerSchema({ minimum: 0 }),
  durationMs: numberSchema({ minimum: 0 }),
  error: sensitive(stringSchema({ maxLength: 4096 }), 'browser_data'),
  bodyAvailable: booleanSchema(),
}, [
  'requestId',
  'sequence',
  'method',
  'url',
  'type',
  'requestHeaders',
  'postDataTruncated',
  'bodyAvailable',
]);

const elementSchema = objectSchema({
  ref: integerSchema({ minimum: 1 }),
  role: stringSchema({ minLength: 1, maxLength: 128 }),
  name: sensitive(stringSchema({ maxLength: OBSERVATION_V1_LIMITS.maxElementNameCharacters }), 'browser_data'),
  value: sensitive(stringSchema({ maxLength: OBSERVATION_V1_LIMITS.maxElementValueCharacters }), 'browser_data', 'credential'),
  checked: booleanSchema(),
}, ['ref', 'role', 'name']);

const inputEvidenceSchema = objectSchema({
  action: stringSchema({ enum: ['type', 'keyboard'] }),
  status: stringSchema({ enum: ['verified', 'mismatch', 'unavailable'] }),
  kind: stringSchema({ enum: ['input', 'contenteditable', 'unsupported'] }),
  sensitive: booleanSchema(),
  beforeLength: integerSchema({ minimum: 0 }),
  expectedLength: integerSchema({ minimum: 0 }),
  afterLength: integerSchema({ minimum: 0 }),
  reason: stringSchema({ enum: ['active_element_not_readable', 'value_mismatch'] }),
}, ['action', 'status', 'kind', 'sensitive']);

const clickEvidenceSchema = objectSchema({
  action: stringSchema({ const: 'click' }),
  status: stringSchema({ enum: ['verified', 'mismatch', 'unavailable'] }),
  kind: stringSchema({ enum: [
    'checkbox', 'radio', 'switch', 'option', 'select', 'control', 'other', 'coordinates',
  ] }),
  effects: arraySchema(stringSchema({ enum: [
    'checked_changed',
    'selected_changed',
    'pressed_changed',
    'expanded_changed',
    'focus_changed',
    'navigation',
    'document_changed',
    'dialog_opened',
    'popup_opened',
  ] }), { maxItems: 9, uniqueItems: true }),
  checked: { oneOf: [booleanSchema(), stringSchema({ const: 'mixed' })] },
  selected: booleanSchema(),
  pressed: { oneOf: [booleanSchema(), stringSchema({ const: 'mixed' })] },
  expanded: booleanSchema(),
  focused: booleanSchema(),
  reason: stringSchema({ enum: [
    'coordinate_target', 'target_unavailable', 'expected_state_unchanged', 'no_observable_effect',
  ] }),
}, ['action', 'status', 'kind', 'effects']);

const pressEvidenceSchema = objectSchema({
  action: stringSchema({ const: 'press' }),
  status: stringSchema({ enum: ['verified', 'unavailable'] }),
  kind: stringSchema({ enum: [
    'input', 'contenteditable', 'checkbox', 'radio', 'select', 'control', 'other',
  ] }),
  effects: arraySchema(stringSchema({ enum: [
    'value_changed',
    'checked_changed',
    'selected_changed',
    'pressed_changed',
    'expanded_changed',
    'focus_changed',
    'navigation',
    'document_changed',
    'dialog_opened',
    'popup_opened',
  ] }), { maxItems: 10, uniqueItems: true }),
  sensitive: booleanSchema(),
  reason: stringSchema({ enum: ['target_unavailable', 'no_observable_effect'] }),
}, ['action', 'status', 'kind', 'effects', 'sensitive']);

const uploadEvidenceSchema = objectSchema({
  action: stringSchema({ const: 'upload' }),
  status: stringSchema({ enum: ['verified', 'mismatch', 'unavailable'] }),
  expectedFileCount: integerSchema({ const: 1 }),
  fileCount: integerSchema({ minimum: 0 }),
  nameMatched: booleanSchema(),
  reason: stringSchema({ enum: [
    'target_unavailable', 'file_count_mismatch', 'file_name_mismatch',
  ] }),
}, ['action', 'status', 'expectedFileCount']);

const scrollEvidenceSchema = objectSchema({
  action: stringSchema({ const: 'scroll' }),
  status: stringSchema({ enum: ['verified', 'mismatch'] }),
  mode: stringSchema({ enum: ['relative', 'position', 'text'] }),
  target: stringSchema({ enum: ['page', 'element', 'text'] }),
  moved: booleanSchema(),
  deltaX: numberSchema(),
  deltaY: numberSchema(),
  beforeX: numberSchema({ minimum: 0 }),
  beforeY: numberSchema({ minimum: 0 }),
  afterX: numberSchema({ minimum: 0 }),
  afterY: numberSchema({ minimum: 0 }),
  matchedText: sensitive(stringSchema({ maxLength: 4096 }), 'browser_data'),
  reason: stringSchema({ enum: ['at_boundary', 'text_not_found'] }),
}, [
  'action', 'status', 'mode', 'target', 'moved', 'deltaX', 'deltaY',
  'beforeX', 'beforeY', 'afterX', 'afterY',
]);

const dropdownOptionSchema = objectSchema({
  index: integerSchema({ minimum: 1, maximum: 500 }),
  label: sensitive(stringSchema({ maxLength: 4096 }), 'browser_data'),
  value: sensitive(stringSchema({ maxLength: 4096 }), 'browser_data'),
  selected: booleanSchema(),
  disabled: booleanSchema(),
}, ['index', 'label', 'value', 'selected', 'disabled']);

const selectEvidenceSchema = objectSchema({
  action: stringSchema({ const: 'select' }),
  status: stringSchema({ enum: ['verified', 'mismatch', 'unavailable'] }),
  kind: stringSchema({ enum: ['native', 'aria'] }),
  selected: arraySchema(dropdownOptionSchema, { maxItems: 500 }),
  reason: stringSchema({ enum: ['option_not_found', 'selection_mismatch', 'selection_not_exposed'] }),
}, ['action', 'status', 'kind', 'selected']);

const artifactSchema = objectSchema({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  kind: stringSchema({ enum: ['screenshot', 'screenshot_preview', 'pdf', 'download', 'upload_input'] }),
  mimeType: stringSchema({ minLength: 1, maxLength: 256 }),
  byteSize: integerSchema({ minimum: 0 }),
  fileName: stringSchema({ minLength: 1, maxLength: 4096 }),
  width: integerSchema({ minimum: 1 }),
  height: integerSchema({ minimum: 1 }),
  sensitivity: stringSchema({ enum: ['public', 'browser_data', 'credential', 'user_file'] }),
  createdAt: integerSchema({ minimum: 0 }),
  expiresAt: integerSchema({ minimum: 0 }),
  retained: booleanSchema(),
  previewOf: opaqueIdSchema,
}, ['id', 'workspaceId', 'kind', 'mimeType', 'byteSize', 'sensitivity', 'createdAt', 'expiresAt', 'retained']);

const hintRefsSchema = arraySchema(integerSchema({ minimum: 1 }), {
  maxItems: 32,
  uniqueItems: true,
});
const agentHintSchema: JsonSchema = {
  oneOf: [
    objectSchema({
      code: stringSchema({ const: 'autocomplete' }),
      source: stringSchema({ const: 'observation' }),
      confidence: stringSchema({ enum: ['strong', 'possible'] }),
      recommendedAction: stringSchema({ const: 'observe_then_select' }),
      refs: hintRefsSchema,
    }, ['code', 'source', 'confidence', 'recommendedAction', 'refs']),
    objectSchema({
      code: stringSchema({ const: 'modal_overlay' }),
      source: stringSchema({ const: 'observation' }),
      confidence: stringSchema({ enum: ['strong', 'possible'] }),
      recommendedAction: stringSchema({ const: 'resolve_overlay_first' }),
      blocking: booleanSchema(),
      refs: hintRefsSchema,
    }, ['code', 'source', 'confidence', 'recommendedAction', 'blocking', 'refs']),
    objectSchema({
      code: stringSchema({ const: 'filter_controls' }),
      source: stringSchema({ const: 'observation' }),
      confidence: stringSchema({ const: 'strong' }),
      recommendedAction: stringSchema({ const: 'review_refinement_controls' }),
      refs: hintRefsSchema,
    }, ['code', 'source', 'confidence', 'recommendedAction', 'refs']),
    objectSchema({
      code: stringSchema({ const: 'access_blocked' }),
      source: stringSchema({ const: 'network' }),
      confidence: stringSchema({ const: 'strong' }),
      recommendedAction: stringSchema({ const: 'avoid_same_navigation_retry' }),
      status: integerSchema({ enum: [403, 429] }),
    }, ['code', 'source', 'confidence', 'recommendedAction', 'status']),
    objectSchema({
      code: stringSchema({ const: 'authentication_surface' }),
      source: stringSchema({ const: 'observation' }),
      confidence: stringSchema({ const: 'strong' }),
      recommendedAction: stringSchema({ const: 'inspect_authentication_state' }),
      state: stringSchema({ enum: ['present', 'entered', 'left'] }),
    }, ['code', 'source', 'confidence', 'recommendedAction', 'state']),
    objectSchema({
      code: stringSchema({ const: 'download' }),
      source: stringSchema({ const: 'download' }),
      confidence: stringSchema({ const: 'strong' }),
      recommendedAction: stringSchema({ const: 'wait_for_download' }),
      state: stringSchema({ const: 'started' }),
    }, ['code', 'source', 'confidence', 'recommendedAction', 'state']),
    objectSchema({
      code: stringSchema({ const: 'download' }),
      source: stringSchema({ const: 'download' }),
      confidence: stringSchema({ const: 'strong' }),
      recommendedAction: stringSchema({ const: 'inspect_download_artifact' }),
      state: stringSchema({ const: 'completed' }),
      artifactId: opaqueIdSchema,
    }, ['code', 'source', 'confidence', 'recommendedAction', 'state', 'artifactId']),
    objectSchema({
      code: stringSchema({ const: 'download' }),
      source: stringSchema({ const: 'download' }),
      confidence: stringSchema({ const: 'strong' }),
      recommendedAction: stringSchema({ const: 'inspect_download_failure' }),
      state: stringSchema({ enum: ['failed', 'cancelled'] }),
      reason: stringSchema({ minLength: 1, maxLength: 128 }),
    }, ['code', 'source', 'confidence', 'recommendedAction', 'state', 'reason']),
    objectSchema({
      code: stringSchema({ const: 'repeated_action' }),
      source: stringSchema({ const: 'watchdog' }),
      confidence: stringSchema({ const: 'strong' }),
      recommendedAction: stringSchema({ const: 'change_strategy' }),
      streak: integerSchema({ minimum: 1, maximum: 1_000_000 }),
      reason: stringSchema({ minLength: 1, maxLength: 128 }),
    }, ['code', 'source', 'confidence', 'recommendedAction', 'streak', 'reason']),
  ],
};

function resultSchema(
  context: ToolContext,
  properties: Record<string, JsonSchema> = {},
  required: string[] = [],
): JsonSchema {
  const contextProperties: Record<string, JsonSchema> = {};
  const contextRequired: string[] = [];
  if (context === 'workspace' || context === 'target') {
    contextProperties.workspaceId = opaqueIdSchema;
    contextProperties.leaseId = opaqueIdSchema;
    contextRequired.push('workspaceId', 'leaseId');
  }
  if (context === 'target') {
    contextProperties.targetId = opaqueIdSchema;
    contextProperties.url = boundedUrl;
    contextRequired.push('targetId', 'url');
  }
  return objectSchema({ ...contextProperties, ...properties }, [...contextRequired, ...required]);
}

const observationOutput = resultSchema('target', {
  observationId: opaqueIdSchema,
  title: sensitive(stringSchema({ maxLength: OBSERVATION_V1_LIMITS.maxTitleCharacters }), 'browser_data'),
  page: objectSchema({
    viewportWidth: integerSchema({ minimum: 0 }),
    viewportHeight: integerSchema({ minimum: 0 }),
    documentWidth: integerSchema({ minimum: 0 }),
    documentHeight: integerSchema({ minimum: 0 }),
    scrollX: integerSchema({ minimum: 0 }),
    scrollY: integerSchema({ minimum: 0 }),
    pixelsAbove: integerSchema({ minimum: 0 }),
    pixelsBelow: integerSchema({ minimum: 0 }),
    pixelsLeft: integerSchema({ minimum: 0 }),
    pixelsRight: integerSchema({ minimum: 0 }),
    scrollPercentX: numberSchema({ minimum: 0, maximum: 100 }),
    scrollPercentY: numberSchema({ minimum: 0, maximum: 100 }),
  }, [
    'viewportWidth', 'viewportHeight', 'documentWidth', 'documentHeight',
    'scrollX', 'scrollY', 'pixelsAbove', 'pixelsBelow', 'pixelsLeft',
    'pixelsRight', 'scrollPercentX', 'scrollPercentY',
  ]),
  elements: arraySchema(elementSchema, { maxItems: OBSERVATION_V1_LIMITS.maxElements }),
  truncated: booleanSchema(),
  truncationReasons: arraySchema(stringSchema({
    enum: [...OBSERVATION_TRUNCATION_REASONS],
  }), { uniqueItems: true }),
  hints: arraySchema(agentHintSchema, { maxItems: 16 }),
  evidence: { oneOf: [
    inputEvidenceSchema,
    clickEvidenceSchema,
    pressEvidenceSchema,
    uploadEvidenceSchema,
    scrollEvidenceSchema,
    selectEvidenceSchema,
  ] },
}, ['observationId', 'title', 'elements', 'truncated', 'truncationReasons']);

const artifactOutput = resultSchema('target', {
  artifact: artifactSchema,
  preview: artifactSchema,
  annotationCount: integerSchema({ minimum: 0, maximum: 200 }),
}, ['artifact']);

const elementAddressSchema: JsonSchema = {
  oneOf: [
    objectSchema({
      observationId: opaqueIdSchema,
      ref: integerSchema({ minimum: 1 }),
    }, ['observationId', 'ref']),
    objectSchema({ selector: boundedSelector }, ['selector']),
  ],
};

const dropdownChoiceSchema: JsonSchema = {
  oneOf: [
    objectSchema({ by: stringSchema({ const: 'index' }), index: integerSchema({ minimum: 1, maximum: 500 }) }, ['by', 'index']),
    objectSchema({
      by: stringSchema({ const: 'label' }),
      label: sensitive(stringSchema({ minLength: 1, maxLength: 4096 }), 'browser_data'),
      exact: booleanSchema(),
    }, ['by', 'label']),
    objectSchema({
      by: stringSchema({ const: 'value' }),
      value: sensitive(stringSchema({ minLength: 1, maxLength: 4096 }), 'browser_data'),
      exact: booleanSchema(),
    }, ['by', 'value']),
  ],
};

function tool(definition: ToolDefinition): ToolDefinition {
  return definition;
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  tool({
    name: 'browser.discover',
    title: 'Discover browsers',
    description: 'List supported local browsers and structured setup or authorization state.',
    context: 'connection',
    inputSchema: objectSchema({ browser: stringSchema({ minLength: 1, maxLength: 128 }) }),
    outputSchema: resultSchema('connection', {
      browsers: arraySchema(objectSchema({
        id: opaqueIdSchema,
        product: stringSchema({ minLength: 1, maxLength: 128 }),
        channel: stringSchema({ maxLength: 128 }),
        profile: sensitive(stringSchema({ maxLength: 4096 }), 'browser_data'),
        processState: stringSchema({ enum: ['running', 'not_running', 'unknown'] }),
        remoteDebuggingState: stringSchema({ enum: ['enabled', 'disabled', 'stale'] }),
        authorizationState: stringSchema({ enum: ['authorized', 'required', 'not_applicable', 'unknown'] }),
        state: stringSchema({ enum: ['ready', 'not_running', 'remote_debugging_disabled', 'authorization_required', 'disconnected'] }),
        remediation: objectSchema({
          code: stringSchema({ minLength: 1, maxLength: 128 }),
          message: stringSchema({ minLength: 1, maxLength: 4096 }),
          actionRequired: booleanSchema(),
        }, ['code', 'message', 'actionRequired']),
      }, [
        'id', 'product', 'processState', 'remoteDebuggingState',
        'authorizationState', 'state',
      ])),
    }, ['browsers']),
    requiredCapabilities: ['browser.discovery'],
    mutating: false,
    idempotency: 'read_only',
    cancellation: 'not_applicable',
    sensitivity: { input: [], output: ['browser_data'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.connect',
    title: 'Connect browser',
    description: 'Connect a Workspace to a selected authorized browser instance.',
    context: 'workspace',
    inputSchema: objectSchema({ browserId: opaqueIdSchema }, ['browserId']),
    outputSchema: resultSchema('workspace', {
      browserInstanceId: opaqueIdSchema,
      connectionGeneration: integerSchema({ minimum: 1 }),
      state: stringSchema({ const: 'connected' }),
    }, ['browserInstanceId', 'connectionGeneration', 'state']),
    requiredCapabilities: ['browser.control'],
    mutating: true,
    idempotency: 'idempotent',
    cancellation: 'before_dispatch',
    sensitivity: { input: [], output: ['browser_data'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.open',
    title: 'Open URL',
    description: 'Navigate an authorized controlled target or create a new target in the ManagedTabSet.',
    context: 'workspace',
    inputSchema: objectSchema({
      url: boundedUrl,
      targetId: opaqueIdSchema,
      newTarget: booleanSchema(),
      observationLimit: integerSchema({ minimum: 1, maximum: OBSERVATION_V1_LIMITS.maxElements }),
    }, ['url']),
    outputSchema: observationOutput,
    requiredCapabilities: ['browser.control', 'observation.read'],
    mutating: true,
    idempotency: 'non_idempotent',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data'], output: ['browser_data', 'credential'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.observe',
    title: 'Observe page',
    description: 'Create an immutable bounded Observation with numbered refs.',
    context: 'target',
    inputSchema: objectSchema({
      limit: integerSchema({ minimum: 1, maximum: OBSERVATION_V1_LIMITS.maxElements }),
    }),
    outputSchema: observationOutput,
    requiredCapabilities: ['observation.read'],
    mutating: false,
    idempotency: 'read_only',
    cancellation: 'best_effort',
    sensitivity: { input: [], output: ['browser_data', 'credential'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.observation.latest',
    title: 'Get latest Observation',
    description: 'Return the latest live Observation descriptor for a controlled target.',
    context: 'target',
    inputSchema: emptyInput,
    outputSchema: resultSchema('target', {
      observationId: opaqueIdSchema,
      createdAt: integerSchema({ minimum: 0 }),
      expiresAt: integerSchema({ minimum: 0 }),
      elementCount: integerSchema({ minimum: 0, maximum: OBSERVATION_V1_LIMITS.maxElements }),
    }, ['observationId', 'createdAt', 'expiresAt', 'elementCount']),
    requiredCapabilities: ['observation.read'],
    mutating: false,
    idempotency: 'read_only',
    cancellation: 'not_applicable',
    sensitivity: { input: [], output: ['browser_data'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.locate',
    title: 'Locate element',
    description: 'Return viewport coordinates for a CSS selector in the selected frame.',
    context: 'target',
    inputSchema: objectSchema({ selector: boundedSelector }, ['selector']),
    outputSchema: resultSchema('target', {
      x: numberSchema(),
      y: numberSchema(),
      top: numberSchema(),
      left: numberSchema(),
      width: numberSchema({ minimum: 0 }),
      height: numberSchema({ minimum: 0 }),
    }, ['x', 'y', 'top', 'left', 'width', 'height']),
    requiredCapabilities: ['observation.read'],
    mutating: false,
    idempotency: 'read_only',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data'], output: ['browser_data'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.read',
    title: 'Read page text',
    description: 'Read bounded text from the page or a selector.',
    context: 'target',
    inputSchema: objectSchema({
      selector: boundedSelector,
      limit: integerSchema({ minimum: 1, maximum: 1_000_000 }),
    }),
    outputSchema: resultSchema('target', {
      title: sensitive(stringSchema({ maxLength: 4096 }), 'browser_data'),
      text: sensitive(stringSchema({ maxLength: 1_000_000 }), 'browser_data'),
      length: integerSchema({ minimum: 0 }),
      truncated: booleanSchema(),
    }, ['title', 'text', 'length', 'truncated']),
    requiredCapabilities: ['observation.read'],
    mutating: false,
    idempotency: 'read_only',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data'], output: ['browser_data'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.search',
    title: 'Search page text',
    description: 'Find bounded visible text matches without returning the entire page.',
    context: 'target',
    inputSchema: objectSchema({
      query: sensitive(stringSchema({ minLength: 1, maxLength: 4096 }), 'browser_data'),
      selector: boundedSelector,
      caseSensitive: booleanSchema(),
      wholeWord: booleanSchema(),
      limit: integerSchema({ minimum: 1, maximum: 200 }),
    }, ['query']),
    outputSchema: resultSchema('target', {
      title: sensitive(stringSchema({ maxLength: 4096 }), 'browser_data'),
      totalMatches: integerSchema({ minimum: 0 }),
      matches: arraySchema(objectSchema({
        index: integerSchema({ minimum: 1 }),
        text: sensitive(stringSchema({ maxLength: 4096 }), 'browser_data'),
        context: sensitive(stringSchema({ maxLength: 500 }), 'browser_data'),
        tagName: stringSchema({ maxLength: 64 }),
        visible: booleanSchema(),
        x: numberSchema(),
        y: numberSchema(),
        width: numberSchema({ minimum: 0 }),
        height: numberSchema({ minimum: 0 }),
      }, ['index', 'text', 'context', 'tagName', 'visible', 'x', 'y', 'width', 'height']), { maxItems: 200 }),
      truncated: booleanSchema(),
    }, ['title', 'totalMatches', 'matches', 'truncated']),
    requiredCapabilities: ['observation.read'],
    mutating: false,
    idempotency: 'read_only',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data'], output: ['browser_data'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.elements.find',
    title: 'Find DOM elements',
    description: 'Run a bounded CSS query and return safe element metadata without exposing DOM handles.',
    context: 'target',
    inputSchema: objectSchema({
      selector: boundedSelector,
      limit: integerSchema({ minimum: 1, maximum: 200 }),
      attributeNames: arraySchema(
        sensitive(stringSchema({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z_:][A-Za-z0-9_.:-]*$' }), 'browser_data'),
        { maxItems: 20, uniqueItems: true },
      ),
      pierceShadow: booleanSchema(),
    }, ['selector']),
    outputSchema: resultSchema('target', {
      title: sensitive(stringSchema({ maxLength: 4096 }), 'browser_data'),
      totalMatches: integerSchema({ minimum: 0 }),
      elements: arraySchema(objectSchema({
        index: integerSchema({ minimum: 1 }),
        tagName: stringSchema({ maxLength: 64 }),
        role: stringSchema({ maxLength: 128 }),
        name: sensitive(stringSchema({ maxLength: 4096 }), 'browser_data'),
        text: sensitive(stringSchema({ maxLength: 500 }), 'browser_data'),
        visible: booleanSchema(),
        enabled: booleanSchema(),
        x: numberSchema(),
        y: numberSchema(),
        width: numberSchema({ minimum: 0 }),
        height: numberSchema({ minimum: 0 }),
        attributes: arraySchema(objectSchema({
          name: sensitive(stringSchema({ maxLength: 128 }), 'browser_data'),
          value: sensitive(stringSchema({ maxLength: 2048 }), 'browser_data', 'credential'),
        }, ['name', 'value']), { maxItems: 20 }),
      }, [
        'index', 'tagName', 'role', 'name', 'text', 'visible', 'enabled',
        'x', 'y', 'width', 'height', 'attributes',
      ]), { maxItems: 200 }),
      truncated: booleanSchema(),
    }, ['title', 'totalMatches', 'elements', 'truncated']),
    requiredCapabilities: ['observation.read'],
    mutating: false,
    idempotency: 'read_only',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data'], output: ['browser_data', 'credential'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.scroll',
    title: 'Scroll page or element',
    description: 'Scroll the page, a ref, a CSS-selected container, or visible text and return a fresh Observation.',
    context: 'target',
    inputSchema: objectSchema({
      target: elementAddressSchema,
      direction: stringSchema({ enum: ['up', 'down', 'left', 'right'] }),
      amount: numberSchema({ minimum: 0.01, maximum: 100_000 }),
      unit: stringSchema({ enum: ['pixels', 'viewport'] }),
      position: stringSchema({ enum: ['start', 'end'] }),
      text: sensitive(stringSchema({ minLength: 1, maxLength: 4096 }), 'browser_data'),
      exact: booleanSchema(),
      observationLimit: integerSchema({ minimum: 1, maximum: OBSERVATION_V1_LIMITS.maxElements }),
    }),
    outputSchema: observationOutput,
    requiredCapabilities: ['action.input', 'observation.read'],
    mutating: true,
    idempotency: 'non_idempotent',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data'], output: ['browser_data', 'credential'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.dropdown.options',
    title: 'List dropdown options',
    description: 'Enumerate bounded native or currently exposed ARIA dropdown options.',
    context: 'target',
    inputSchema: objectSchema({ target: elementAddressSchema }, ['target']),
    outputSchema: resultSchema('target', {
      kind: stringSchema({ enum: ['native', 'aria'] }),
      expanded: booleanSchema(),
      multiple: booleanSchema(),
      requiresOpen: booleanSchema(),
      options: arraySchema(dropdownOptionSchema, { maxItems: 500 }),
      truncated: booleanSchema(),
    }, ['kind', 'expanded', 'multiple', 'requiresOpen', 'options', 'truncated']),
    requiredCapabilities: ['observation.read'],
    mutating: false,
    idempotency: 'read_only',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data'], output: ['browser_data'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.dropdown.select',
    title: 'Select dropdown option',
    description: 'Select and verify a native or ARIA dropdown option, opening custom controls when needed.',
    context: 'target',
    inputSchema: objectSchema({
      target: elementAddressSchema,
      choice: dropdownChoiceSchema,
      observationLimit: integerSchema({ minimum: 1, maximum: OBSERVATION_V1_LIMITS.maxElements }),
    }, ['target', 'choice']),
    outputSchema: observationOutput,
    requiredCapabilities: ['action.input', 'observation.read'],
    mutating: true,
    idempotency: 'non_idempotent',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data'], output: ['browser_data', 'credential'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.click',
    title: 'Click element',
    description: 'Click an Observation ref or viewport coordinates after interactability checks.',
    context: 'target',
    inputSchema: objectSchema({
      target: {
        oneOf: [
          objectSchema({ observationId: opaqueIdSchema, ref: integerSchema({ minimum: 1 }) }, ['observationId', 'ref']),
          objectSchema({ x: numberSchema(), y: numberSchema() }, ['x', 'y']),
        ],
      },
      button: stringSchema({ enum: ['left', 'right'] }),
      clickCount: integerSchema({ minimum: 1, maximum: 2 }),
      observationLimit: integerSchema({ minimum: 1, maximum: OBSERVATION_V1_LIMITS.maxElements }),
    }, ['target']),
    outputSchema: observationOutput,
    requiredCapabilities: ['action.input', 'observation.read'],
    mutating: true,
    idempotency: 'non_idempotent',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data'], output: ['browser_data', 'credential'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.type',
    title: 'Type into element',
    description: 'Enter text into an Observation ref and read back the effective value.',
    context: 'target',
    inputSchema: objectSchema({
      observationId: opaqueIdSchema,
      ref: integerSchema({ minimum: 1 }),
      text: boundedText,
      clear: booleanSchema(),
      submit: booleanSchema(),
      verification: stringSchema({ enum: ['report', 'require_exact'] }),
      observationLimit: integerSchema({ minimum: 1, maximum: OBSERVATION_V1_LIMITS.maxElements }),
    }, ['observationId', 'ref', 'text']),
    outputSchema: observationOutput,
    requiredCapabilities: ['action.input', 'observation.read'],
    mutating: true,
    idempotency: 'non_idempotent',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data', 'credential'], output: ['browser_data', 'credential'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.keyboard',
    title: 'Type with keyboard',
    description: 'Dispatch keyboard input to the currently focused page control.',
    context: 'target',
    inputSchema: objectSchema({
      text: boundedText,
      clear: booleanSchema(),
      submit: booleanSchema(),
      delayMs: integerSchema({ minimum: 0, maximum: 60_000 }),
      focusSelector: boundedSelector,
      verification: stringSchema({ enum: ['report', 'require_exact'] }),
      observationLimit: integerSchema({ minimum: 1, maximum: OBSERVATION_V1_LIMITS.maxElements }),
    }, ['text']),
    outputSchema: observationOutput,
    requiredCapabilities: ['action.input', 'observation.read'],
    mutating: true,
    idempotency: 'non_idempotent',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data', 'credential'], output: ['browser_data', 'credential'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.press',
    title: 'Press key',
    description: 'Dispatch a key or key combination and report bounded observable effects.',
    context: 'target',
    inputSchema: objectSchema({
      key: stringSchema({ minLength: 1, maxLength: 128 }),
      observationLimit: integerSchema({ minimum: 1, maximum: OBSERVATION_V1_LIMITS.maxElements }),
    }, ['key']),
    outputSchema: observationOutput,
    requiredCapabilities: ['action.input', 'observation.read'],
    mutating: true,
    idempotency: 'non_idempotent',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data'], output: ['browser_data', 'credential'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.capture',
    title: 'Capture screenshot',
    description: 'Capture the viewport, full page, or a selected element as protected Artifacts.',
    context: 'target',
    inputSchema: objectSchema({
      fullPage: booleanSchema(),
      selector: boundedSelector,
      includeOriginal: booleanSchema(),
      annotations: objectSchema({
        observationId: opaqueIdSchema,
        refs: arraySchema(integerSchema({ minimum: 1 }), { maxItems: 200, uniqueItems: true }),
      }, ['observationId']),
    }),
    outputSchema: artifactOutput,
    requiredCapabilities: ['artifact.read'],
    mutating: false,
    idempotency: 'idempotent',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data'], output: ['browser_data'] },
    artifactKinds: ['screenshot', 'screenshot_preview'],
  }),
  tool({
    name: 'browser.pdf',
    title: 'Capture PDF',
    description: 'Print the controlled target to a protected PDF Artifact.',
    context: 'target',
    inputSchema: objectSchema({ landscape: booleanSchema() }),
    outputSchema: artifactOutput,
    requiredCapabilities: ['artifact.read'],
    mutating: false,
    idempotency: 'idempotent',
    cancellation: 'best_effort',
    sensitivity: { input: [], output: ['browser_data'] },
    artifactKinds: ['pdf'],
  }),
  tool({
    name: 'browser.upload',
    title: 'Upload file',
    description: 'Assign a client-authorized local file and verify the browser selection.',
    context: 'target',
    inputSchema: {
      oneOf: [
        objectSchema({
          artifactId: sensitive(opaqueIdSchema, 'user_file'),
          observationId: opaqueIdSchema,
          ref: integerSchema({ minimum: 1 }),
          observationLimit: integerSchema({ minimum: 1, maximum: OBSERVATION_V1_LIMITS.maxElements }),
        }, ['artifactId', 'observationId', 'ref']),
        objectSchema({
          artifactId: sensitive(opaqueIdSchema, 'user_file'),
          inputIndex: integerSchema({ minimum: 1 }),
          observationLimit: integerSchema({ minimum: 1, maximum: OBSERVATION_V1_LIMITS.maxElements }),
        }, ['artifactId', 'inputIndex']),
        objectSchema({
          artifactId: sensitive(opaqueIdSchema, 'user_file'),
          observationLimit: integerSchema({ minimum: 1, maximum: OBSERVATION_V1_LIMITS.maxElements }),
        }, ['artifactId']),
      ],
    },
    outputSchema: observationOutput,
    requiredCapabilities: ['action.input', 'artifact.read', 'observation.read'],
    mutating: true,
    idempotency: 'non_idempotent',
    cancellation: 'best_effort',
    sensitivity: { input: ['user_file'], output: ['browser_data', 'credential'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.tabs.list',
    title: 'List browser tabs',
    description: 'List ManagedTabSet targets and all eligible user tabs in the connected browser.',
    context: 'workspace',
    inputSchema: objectSchema({
      scope: stringSchema({ enum: ['all', 'managed_only', 'user_tabs'] }),
    }),
    outputSchema: resultSchema('workspace', {
      targets: arraySchema(objectSchema({
        targetId: opaqueIdSchema,
        title: sensitive(stringSchema({ maxLength: 4096 }), 'browser_data'),
        url: boundedUrl,
        active: booleanSchema(),
        origin: stringSchema({ enum: ['managed', 'managed_popup', 'user_tab'] }),
        managedTabSetId: opaqueIdSchema,
        controlState: stringSchema({ enum: ['available', 'controlled', 'busy'] }),
      }, ['targetId', 'title', 'url', 'active', 'origin', 'controlState'])),
    }, ['targets']),
    requiredCapabilities: ['browser.control'],
    mutating: false,
    idempotency: 'read_only',
    cancellation: 'not_applicable',
    sensitivity: { input: [], output: ['browser_data'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.tabs.switch',
    title: 'Switch tab',
    description: 'Set a managed or user tab as the active controlled target for the current Lease.',
    context: 'workspace',
    inputSchema: objectSchema({ targetId: opaqueIdSchema }, ['targetId']),
    outputSchema: resultSchema('target'),
    requiredCapabilities: ['browser.control'],
    mutating: true,
    idempotency: 'idempotent',
    cancellation: 'before_dispatch',
    sensitivity: { input: ['browser_data'], output: ['browser_data'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.tabs.close',
    title: 'Close tab',
    description: 'Close one explicitly addressed managed or user tab.',
    context: 'target',
    inputSchema: emptyInput,
    outputSchema: resultSchema('workspace', { closedTargetId: opaqueIdSchema }, ['closedTargetId']),
    requiredCapabilities: ['browser.control'],
    mutating: true,
    idempotency: 'idempotent',
    cancellation: 'before_dispatch',
    sensitivity: { input: [], output: ['browser_data'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.tabs.release',
    title: 'Release tab control',
    description: 'Relinquish this Lease control of one tab without closing it.',
    context: 'target',
    inputSchema: emptyInput,
    outputSchema: resultSchema('target', { released: booleanSchema() }, ['released']),
    requiredCapabilities: ['browser.control'],
    mutating: true,
    idempotency: 'idempotent',
    cancellation: 'before_dispatch',
    sensitivity: { input: [], output: ['browser_data'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.frames.list',
    title: 'List frames',
    description: 'List frames and CDP sessions belonging to the controlled target.',
    context: 'target',
    inputSchema: emptyInput,
    outputSchema: resultSchema('target', {
      frames: arraySchema(objectSchema({
        frameId: opaqueIdSchema,
        parentFrameId: opaqueIdSchema,
        url: boundedUrl,
        name: sensitive(stringSchema({ maxLength: 4096 }), 'browser_data'),
      }, ['frameId', 'url', 'name'])),
    }, ['frames']),
    requiredCapabilities: ['observation.read'],
    mutating: false,
    idempotency: 'read_only',
    cancellation: 'not_applicable',
    sensitivity: { input: [], output: ['browser_data'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.frames.switch',
    title: 'Switch frame',
    description: 'Set the active frame for the current Lease after target-access validation.',
    context: 'target',
    inputSchema: {
      oneOf: [
        objectSchema({ frameId: opaqueIdSchema }, ['frameId']),
        objectSchema({ top: booleanSchema({ const: true }) }, ['top']),
      ],
    },
    outputSchema: resultSchema('target', { frameId: opaqueIdSchema }, ['frameId']),
    requiredCapabilities: ['browser.control'],
    mutating: true,
    idempotency: 'idempotent',
    cancellation: 'before_dispatch',
    sensitivity: { input: ['browser_data'], output: ['browser_data'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.dialogs.list',
    title: 'List dialogs',
    description: 'List pending dialogs for controlled targets without auto-accepting them.',
    context: 'workspace',
    inputSchema: emptyInput,
    outputSchema: resultSchema('workspace', {
      dialogs: arraySchema(objectSchema({
        dialogId: opaqueIdSchema,
        targetId: opaqueIdSchema,
        type: stringSchema({ enum: ['alert', 'confirm', 'prompt', 'beforeunload'] }),
        message: sensitive(stringSchema({ maxLength: 65_536 }), 'browser_data'),
      }, ['dialogId', 'targetId', 'type', 'message'])),
    }, ['dialogs']),
    requiredCapabilities: ['event.read'],
    mutating: false,
    idempotency: 'read_only',
    cancellation: 'not_applicable',
    sensitivity: { input: [], output: ['browser_data'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.dialogs.respond',
    title: 'Respond to dialog',
    description: 'Explicitly accept or dismiss a pending dialog on a controlled target.',
    context: 'target',
    inputSchema: objectSchema({
      dialogId: opaqueIdSchema,
      action: stringSchema({ enum: ['accept', 'dismiss'] }),
      promptText: sensitive(stringSchema({ maxLength: 65_536 }), 'browser_data', 'credential'),
    }, ['dialogId', 'action']),
    outputSchema: resultSchema('target', { dialogId: opaqueIdSchema, action: stringSchema({ enum: ['accept', 'dismiss'] }) }, ['dialogId', 'action']),
    requiredCapabilities: ['action.input'],
    mutating: true,
    idempotency: 'idempotent',
    cancellation: 'before_dispatch',
    sensitivity: { input: ['browser_data', 'credential'], output: ['browser_data'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.auth.set',
    title: 'Set HTTP auth',
    description: 'Set Workspace-scoped HTTP authentication credentials.',
    context: 'workspace',
    inputSchema: objectSchema({
      username: sensitive(stringSchema({ minLength: 1, maxLength: 4096 }), 'credential'),
      password: sensitive(stringSchema({ maxLength: 65_536 }), 'credential'),
    }, ['username', 'password']),
    outputSchema: resultSchema('workspace', { configured: booleanSchema({ const: true }) }, ['configured']),
    requiredCapabilities: ['auth.manage'],
    mutating: true,
    idempotency: 'idempotent',
    cancellation: 'before_dispatch',
    sensitivity: { input: ['credential'], output: [] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.auth.clear',
    title: 'Clear HTTP auth',
    description: 'Remove Workspace-scoped HTTP authentication credentials.',
    context: 'workspace',
    inputSchema: emptyInput,
    outputSchema: resultSchema('workspace', { configured: booleanSchema({ const: false }) }, ['configured']),
    requiredCapabilities: ['auth.manage'],
    mutating: true,
    idempotency: 'idempotent',
    cancellation: 'before_dispatch',
    sensitivity: { input: [], output: [] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.cookies.list',
    title: 'List cookies',
    description: 'List cookies available to a controlled target with sensitivity metadata.',
    context: 'target',
    inputSchema: objectSchema({
      domain: sensitive(stringSchema({ minLength: 1, maxLength: 2048 }), 'browser_data'),
    }),
    outputSchema: resultSchema('target', {
      cookies: arraySchema(objectSchema({
        name: sensitive(stringSchema({ maxLength: 4096 }), 'browser_data'),
        value: sensitive(stringSchema({ maxLength: 1_000_000 }), 'credential'),
        domain: sensitive(stringSchema({ maxLength: 2048 }), 'browser_data'),
        path: sensitive(stringSchema({ maxLength: 4096 }), 'browser_data'),
        httpOnly: booleanSchema(),
        secure: booleanSchema(),
        expires: numberSchema(),
      }, ['name', 'value', 'domain', 'path', 'httpOnly', 'secure', 'expires'])),
    }, ['cookies']),
    requiredCapabilities: ['cookies.read'],
    mutating: false,
    idempotency: 'read_only',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data'], output: ['browser_data', 'credential'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.network.requests',
    title: 'List network requests',
    description: 'List bounded Workspace-scoped network request metadata.',
    context: 'workspace',
    inputSchema: objectSchema({
      limit: integerSchema({ minimum: 1, maximum: 1000 }),
      after: integerSchema({ minimum: 0 }),
      url: sensitive(stringSchema({ maxLength: 16_384 }), 'browser_data'),
      method: stringSchema({ maxLength: 32 }),
      status: stringSchema({ maxLength: 16 }),
      type: arraySchema(stringSchema({ minLength: 1, maxLength: 128 }), { uniqueItems: true }),
    }),
    outputSchema: resultSchema('workspace', {
      requests: arraySchema(objectSchema({
        requestId: opaqueIdSchema,
        sequence: integerSchema({ minimum: 1 }),
        method: stringSchema({ maxLength: 32 }),
        url: boundedUrl,
        status: integerSchema({ minimum: 100, maximum: 999 }),
        type: stringSchema({ maxLength: 128 }),
        size: integerSchema({ minimum: 0 }),
        durationMs: numberSchema({ minimum: 0 }),
        error: sensitive(stringSchema({ maxLength: 4096 }), 'browser_data'),
      }, ['requestId', 'sequence', 'method', 'url', 'type'])),
      nextCursor: integerSchema({ minimum: 0 }),
      truncated: booleanSchema(),
    }, ['requests', 'nextCursor', 'truncated']),
    requiredCapabilities: ['network.observe'],
    mutating: false,
    idempotency: 'read_only',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data'], output: ['browser_data'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.network.request',
    title: 'Read network request',
    description: 'Read bounded details for one Workspace-scoped request.',
    context: 'workspace',
    inputSchema: objectSchema({ requestId: opaqueIdSchema, includeBody: booleanSchema() }, ['requestId']),
    outputSchema: resultSchema('workspace', {
      request: networkRequestDetailSchema,
      body: sensitive(stringSchema({ maxLength: 1_000_000 }), 'browser_data', 'credential'),
      bodyEncoding: stringSchema({ enum: ['utf8', 'base64'] }),
      mimeType: stringSchema({ maxLength: 256 }),
      bodyTruncated: booleanSchema(),
    }, ['request', 'bodyTruncated']),
    requiredCapabilities: ['network.observe'],
    mutating: false,
    idempotency: 'read_only',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data'], output: ['browser_data', 'credential'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.network.clear',
    title: 'Clear network journal',
    description: 'Clear captured request metadata for the current Workspace.',
    context: 'workspace',
    inputSchema: emptyInput,
    outputSchema: resultSchema('workspace', { cleared: booleanSchema({ const: true }) }, ['cleared']),
    requiredCapabilities: ['network.observe'],
    mutating: true,
    idempotency: 'idempotent',
    cancellation: 'before_dispatch',
    sensitivity: { input: [], output: [] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.network.rules.list',
    title: 'List network rules',
    description: 'List interception rules owned by the current Workspace.',
    context: 'workspace',
    inputSchema: emptyInput,
    outputSchema: resultSchema('workspace', {
      rules: arraySchema(networkRuleSchema),
    }, ['rules']),
    requiredCapabilities: ['network.observe'],
    mutating: false,
    idempotency: 'read_only',
    cancellation: 'not_applicable',
    sensitivity: { input: [], output: ['browser_data', 'credential'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.network.rules.add',
    title: 'Add network rule',
    description: 'Add a Workspace-scoped block, mock, or header rule.',
    context: 'workspace',
    inputSchema: {
      oneOf: [
        objectSchema({ type: stringSchema({ const: 'block' }), pattern: boundedUrl }, ['type', 'pattern']),
        objectSchema({
          type: stringSchema({ const: 'mock' }),
          pattern: boundedUrl,
          status: integerSchema({ minimum: 100, maximum: 999 }),
          headers: arraySchema(headerSchema, { maxItems: 256 }),
          body: sensitive(stringSchema({ maxLength: 1_000_000 }), 'browser_data', 'credential'),
        }, ['type', 'pattern']),
        objectSchema({
          type: stringSchema({ const: 'headers' }),
          pattern: boundedUrl,
          headers: arraySchema(headerSchema, { minItems: 1, maxItems: 256 }),
        }, ['type', 'pattern', 'headers']),
      ],
    },
    outputSchema: resultSchema('workspace', { ruleId: opaqueIdSchema }, ['ruleId']),
    requiredCapabilities: ['network.modify'],
    mutating: true,
    idempotency: 'non_idempotent',
    cancellation: 'before_dispatch',
    sensitivity: { input: ['browser_data', 'credential'], output: ['browser_data'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.network.rules.remove',
    title: 'Remove network rule',
    description: 'Remove one owned interception rule or all rules in the Workspace.',
    context: 'workspace',
    inputSchema: {
      oneOf: [
        objectSchema({ ruleId: opaqueIdSchema }, ['ruleId']),
        objectSchema({ all: booleanSchema({ const: true }) }, ['all']),
      ],
    },
    outputSchema: resultSchema('workspace', { removed: integerSchema({ minimum: 0 }) }, ['removed']),
    requiredCapabilities: ['network.modify'],
    mutating: true,
    idempotency: 'idempotent',
    cancellation: 'before_dispatch',
    sensitivity: { input: ['browser_data'], output: [] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.eval',
    title: 'Evaluate JavaScript',
    description: 'Evaluate JavaScript in a controlled target when the Agent host exposes developer capability.',
    context: 'target',
    inputSchema: objectSchema({ expression: boundedText, awaitPromise: booleanSchema() }, ['expression']),
    outputSchema: resultSchema('target', {
      value: sensitive({}, 'browser_data', 'credential'),
      truncated: booleanSchema(),
    }, ['value', 'truncated']),
    requiredCapabilities: ['developer.eval'],
    mutating: true,
    idempotency: 'non_idempotent',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data', 'credential'], output: ['browser_data', 'credential'] },
    artifactKinds: [],
  }),
];

const toolsByName = new Map(TOOL_DEFINITIONS.map(definition => [definition.name, definition]));

function schemaSensitivities(schema: JsonSchema, result = new Set<Sensitivity>()): Set<Sensitivity> {
  for (const value of schema['x-browser-pilot-sensitivity'] ?? []) result.add(value);
  for (const property of Object.values(schema.properties ?? {})) schemaSensitivities(property, result);
  for (const alternative of schema.oneOf ?? []) schemaSensitivities(alternative, result);
  if (schema.items) schemaSensitivities(schema.items, result);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    schemaSensitivities(schema.additionalProperties, result);
  }
  return result;
}

export function assertToolManifest(definitions: readonly ToolDefinition[] = TOOL_DEFINITIONS): void {
  const names = new Set<string>();
  const knownCapabilities = new Set<string>(CAPABILITIES);
  for (const definition of definitions) {
    if (!/^[a-z][a-z0-9]*(?:[._][a-z][a-z0-9]*)+$/.test(definition.name)) {
      throw new Error(`Invalid tool name: ${definition.name}`);
    }
    if (names.has(definition.name)) throw new Error(`Duplicate tool name: ${definition.name}`);
    names.add(definition.name);
    for (const capability of definition.requiredCapabilities) {
      if (!knownCapabilities.has(capability)) {
        throw new Error(`Tool ${definition.name} references unknown capability ${capability}`);
      }
    }
    if (!definition.mutating && definition.idempotency === 'non_idempotent') {
      throw new Error(`Read-only tool ${definition.name} cannot be non-idempotent`);
    }
    if (definition.mutating && definition.cancellation === 'not_applicable') {
      throw new Error(`Mutating tool ${definition.name} must declare cancellation semantics`);
    }
    for (const direction of ['input', 'output'] as const) {
      const sensitivity = definition.sensitivity[direction];
      if (new Set(sensitivity).size !== sensitivity.length) {
        throw new Error(`Tool ${definition.name} has duplicate ${direction} sensitivity`);
      }
      for (const value of sensitivity) {
        if (!(SENSITIVITIES as readonly string[]).includes(value)) {
          throw new Error(`Tool ${definition.name} references unknown sensitivity ${value}`);
        }
      }
      for (const value of schemaSensitivities(
        direction === 'input' ? definition.inputSchema : definition.outputSchema,
      )) {
        if (!(SENSITIVITIES as readonly string[]).includes(value)) {
          throw new Error(
            `Tool ${definition.name} ${direction} schema contains unknown sensitivity ${value}`,
          );
        }
        if (!sensitivity.includes(value)) {
          throw new Error(
            `Tool ${definition.name} ${direction} schema marks ${value} without declaring it`,
          );
        }
      }
    }
    assertSchemaDefinition(definition.inputSchema, `${definition.name}.inputSchema`);
    assertSchemaDefinition(definition.outputSchema, `${definition.name}.outputSchema`);
  }
}

export function getToolDefinition(name: string): ToolDefinition {
  const definition = toolsByName.get(name);
  if (!definition) throw invalidArgument(`Unknown tool: ${name}`, 'name');
  return definition;
}

export function validateToolArguments(name: string, value: unknown): JsonValue {
  const definition = getToolDefinition(name);
  assertSchemaValue(definition.inputSchema, value, `${name} arguments`);
  return value as JsonValue;
}

export function validateToolResult(name: string, value: unknown): JsonValue {
  const definition = getToolDefinition(name);
  assertSchemaValue(definition.outputSchema, value, `${name} result`);
  return value as JsonValue;
}

export function getToolManifest(
  capabilities?: readonly Capability[],
  availableTools?: readonly string[],
): ToolManifest {
  const granted = capabilities ? new Set<string>(capabilities) : null;
  const available = availableTools ? new Set(availableTools) : null;
  const tools = TOOL_DEFINITIONS.filter(definition => (
    (!granted || definition.requiredCapabilities.every(capability => granted.has(capability))) &&
    (!available || available.has(definition.name))
  ));
  return { schemaVersion: 1, tools };
}

assertToolManifest();
