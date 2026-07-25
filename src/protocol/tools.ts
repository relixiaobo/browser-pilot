import { invalidArgument } from './errors.js';
import {
  CAPABILITIES,
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
const boundedText = stringSchema({ minLength: 1, maxLength: 1_000_000 });
const boundedSelector = stringSchema({ minLength: 1, maxLength: 4096 });
const boundedUrl = stringSchema({ minLength: 1, maxLength: 16_384 });
const opaqueIdSchema = stringSchema({ minLength: 3, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]+$' });
const headerSchema = objectSchema({
  name: stringSchema({ minLength: 1, maxLength: 256 }),
  value: stringSchema({ maxLength: 8192 }),
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
  method: stringSchema({ maxLength: 32 }),
  url: boundedUrl,
  type: stringSchema({ maxLength: 128 }),
  requestHeaders: arraySchema(headerSchema, { maxItems: 256 }),
  postData: stringSchema({ maxLength: 65_536 }),
  postDataTruncated: booleanSchema(),
  status: integerSchema({ minimum: 100, maximum: 999 }),
  statusText: stringSchema({ maxLength: 4096 }),
  responseHeaders: arraySchema(headerSchema, { maxItems: 256 }),
  mimeType: stringSchema({ maxLength: 256 }),
  size: integerSchema({ minimum: 0 }),
  durationMs: numberSchema({ minimum: 0 }),
  error: stringSchema({ maxLength: 4096 }),
  bodyAvailable: booleanSchema(),
}, [
  'requestId',
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
  name: stringSchema({ maxLength: 4096 }),
  value: stringSchema({ maxLength: 65_536 }),
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
  title: stringSchema({ maxLength: 4096 }),
  elements: arraySchema(elementSchema, { maxItems: 10_000 }),
  truncated: booleanSchema(),
  truncationReasons: arraySchema(stringSchema({
    enum: ['element_limit', 'text_limit', 'depth_limit', 'byte_limit'],
  }), { uniqueItems: true }),
  evidence: { oneOf: [inputEvidenceSchema, clickEvidenceSchema, pressEvidenceSchema, uploadEvidenceSchema] },
}, ['observationId', 'title', 'elements', 'truncated', 'truncationReasons']);

const artifactOutput = resultSchema('target', {
  artifact: artifactSchema,
  preview: artifactSchema,
}, ['artifact']);

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
        profile: stringSchema({ maxLength: 4096 }),
        state: stringSchema({ enum: ['ready', 'not_running', 'remote_debugging_disabled', 'authorization_required', 'disconnected'] }),
      }, ['id', 'product', 'state'])),
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
      observationLimit: integerSchema({ minimum: 1, maximum: 10_000 }),
    }, ['url']),
    outputSchema: observationOutput,
    requiredCapabilities: ['browser.control', 'observation.read'],
    mutating: true,
    idempotency: 'non_idempotent',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data'], output: ['browser_data'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.observe',
    title: 'Observe page',
    description: 'Create an immutable bounded Observation with numbered refs.',
    context: 'target',
    inputSchema: objectSchema({ limit: integerSchema({ minimum: 1, maximum: 10_000 }) }),
    outputSchema: observationOutput,
    requiredCapabilities: ['observation.read'],
    mutating: false,
    idempotency: 'read_only',
    cancellation: 'best_effort',
    sensitivity: { input: [], output: ['browser_data'] },
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
      title: stringSchema({ maxLength: 4096 }),
      text: stringSchema({ maxLength: 1_000_000 }),
      length: integerSchema({ minimum: 0 }),
      truncated: booleanSchema(),
    }, ['title', 'text', 'length', 'truncated']),
    requiredCapabilities: ['observation.read'],
    mutating: false,
    idempotency: 'read_only',
    cancellation: 'best_effort',
    sensitivity: { input: [], output: ['browser_data'] },
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
    }, ['target']),
    outputSchema: observationOutput,
    requiredCapabilities: ['action.input', 'observation.read'],
    mutating: true,
    idempotency: 'non_idempotent',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data'], output: ['browser_data'] },
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
    }, ['observationId', 'ref', 'text']),
    outputSchema: observationOutput,
    requiredCapabilities: ['action.input', 'observation.read'],
    mutating: true,
    idempotency: 'non_idempotent',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data', 'credential'], output: ['browser_data'] },
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
    }, ['text']),
    outputSchema: observationOutput,
    requiredCapabilities: ['action.input', 'observation.read'],
    mutating: true,
    idempotency: 'non_idempotent',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data', 'credential'], output: ['browser_data'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.press',
    title: 'Press key',
    description: 'Dispatch a key or key combination and report bounded observable effects.',
    context: 'target',
    inputSchema: objectSchema({ key: stringSchema({ minLength: 1, maxLength: 128 }) }, ['key']),
    outputSchema: observationOutput,
    requiredCapabilities: ['action.input', 'observation.read'],
    mutating: true,
    idempotency: 'non_idempotent',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data'], output: ['browser_data'] },
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
    }),
    outputSchema: artifactOutput,
    requiredCapabilities: ['artifact.read'],
    mutating: false,
    idempotency: 'idempotent',
    cancellation: 'best_effort',
    sensitivity: { input: [], output: ['browser_data'] },
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
          artifactId: opaqueIdSchema,
          observationId: opaqueIdSchema,
          ref: integerSchema({ minimum: 1 }),
        }, ['artifactId', 'observationId', 'ref']),
        objectSchema({
          artifactId: opaqueIdSchema,
          inputIndex: integerSchema({ minimum: 1 }),
        }, ['artifactId', 'inputIndex']),
        objectSchema({ artifactId: opaqueIdSchema }, ['artifactId']),
      ],
    },
    outputSchema: observationOutput,
    requiredCapabilities: ['action.input', 'artifact.read', 'observation.read'],
    mutating: true,
    idempotency: 'non_idempotent',
    cancellation: 'best_effort',
    sensitivity: { input: ['user_file'], output: ['browser_data'] },
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
        title: stringSchema({ maxLength: 4096 }),
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
        name: stringSchema({ maxLength: 4096 }),
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
        message: stringSchema({ maxLength: 65_536 }),
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
      promptText: stringSchema({ maxLength: 65_536 }),
    }, ['dialogId', 'action']),
    outputSchema: resultSchema('target', { dialogId: opaqueIdSchema, action: stringSchema({ enum: ['accept', 'dismiss'] }) }, ['dialogId', 'action']),
    requiredCapabilities: ['action.input'],
    mutating: true,
    idempotency: 'idempotent',
    cancellation: 'before_dispatch',
    sensitivity: { input: ['browser_data'], output: ['browser_data'] },
    artifactKinds: [],
  }),
  tool({
    name: 'browser.auth.set',
    title: 'Set HTTP auth',
    description: 'Set Workspace-scoped HTTP authentication credentials.',
    context: 'workspace',
    inputSchema: objectSchema({
      username: stringSchema({ minLength: 1, maxLength: 4096 }),
      password: stringSchema({ maxLength: 65_536 }),
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
    inputSchema: objectSchema({ domain: stringSchema({ minLength: 1, maxLength: 2048 }) }),
    outputSchema: resultSchema('target', {
      cookies: arraySchema(objectSchema({
        name: stringSchema({ maxLength: 4096 }),
        value: stringSchema({ maxLength: 1_000_000 }),
        domain: stringSchema({ maxLength: 2048 }),
        path: stringSchema({ maxLength: 4096 }),
        httpOnly: booleanSchema(),
        secure: booleanSchema(),
        expires: numberSchema(),
      }, ['name', 'value', 'domain', 'path', 'httpOnly', 'secure', 'expires'])),
    }, ['cookies']),
    requiredCapabilities: ['cookies.read'],
    mutating: false,
    idempotency: 'read_only',
    cancellation: 'best_effort',
    sensitivity: { input: ['browser_data'], output: ['credential'] },
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
      url: stringSchema({ maxLength: 16_384 }),
      method: stringSchema({ maxLength: 32 }),
      status: stringSchema({ maxLength: 16 }),
      type: arraySchema(stringSchema({ minLength: 1, maxLength: 128 }), { uniqueItems: true }),
    }),
    outputSchema: resultSchema('workspace', {
      requests: arraySchema(objectSchema({
        requestId: opaqueIdSchema,
        method: stringSchema({ maxLength: 32 }),
        url: boundedUrl,
        status: integerSchema({ minimum: 100, maximum: 999 }),
        type: stringSchema({ maxLength: 128 }),
        size: integerSchema({ minimum: 0 }),
        durationMs: numberSchema({ minimum: 0 }),
        error: stringSchema({ maxLength: 4096 }),
      }, ['requestId', 'method', 'url', 'type'])),
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
      body: stringSchema({ maxLength: 1_000_000 }),
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
          body: stringSchema({ maxLength: 1_000_000 }),
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
      value: {},
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
