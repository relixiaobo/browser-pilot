import {
  CAPABILITIES,
  SUPPORTED_PROTOCOL_VERSIONS,
  type Capability,
  type ArtifactAccessParams,
  type ArtifactExportParams,
  type CapabilityNegotiation,
  type CommandAccessParams,
  type InitializeParams,
  type LeaseCreateParams,
  type LeaseHeartbeatParams,
  type LeaseReleaseParams,
  type JsonRpcErrorObject,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonValue,
  type LaunchMode,
  type ProtocolRange,
  type ProtocolVersion,
  type ToolCallParams,
  type WorkspaceCreateParams,
  type WorkspaceGetParams,
  type WorkspaceReleaseParams,
} from './model.js';
import { BrowserPilotError, invalidArgument, protocolIncompatible } from './errors.js';

const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const MAX_ID_LENGTH = 256;
const WORKSPACE_ID_PATTERN = /^workspace:[A-Za-z0-9._:-]+$/;
const LEASE_ID_PATTERN = /^lease:[A-Za-z0-9._:-]+$/;
const TARGET_ID_PATTERN = /^target:[A-Za-z0-9._:-]+$/;
const ARTIFACT_ID_PATTERN = /^artifact:[A-Za-z0-9._:-]+$/;
const COMMAND_ID_PATTERN = /^command:[A-Za-z0-9._:-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], field = 'params'): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter(key => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw invalidArgument(`Unknown ${field} field: ${unknown[0]}`, `${field}.${unknown[0]}`, field === 'message' ? -32600 : -32602);
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return typeof value !== 'number' || Number.isFinite(value);
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  options: { pattern?: RegExp; maxLength?: number } = {},
): string {
  const value = record[key];
  const maxLength = options.maxLength ?? MAX_ID_LENGTH;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw invalidArgument(`${key} must be a non-empty string no longer than ${maxLength} characters`, key);
  }
  if (options.pattern && !options.pattern.test(value)) {
    throw invalidArgument(`${key} has an invalid format`, key);
  }
  return value;
}

function requireInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidArgument(`${key} must be a non-negative safe integer`, key);
  }
  return value as number;
}

function parseProtocolVersion(value: unknown, field: string): ProtocolVersion {
  if (!isRecord(value)) throw invalidArgument(`${field} must be an object`, field);
  return {
    major: requireInteger(value, 'major'),
    minor: requireInteger(value, 'minor'),
  };
}

function compareVersions(a: ProtocolVersion, b: ProtocolVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  return a.minor - b.minor;
}

export function parseProtocolRange(value: unknown): ProtocolRange {
  if (!isRecord(value)) throw invalidArgument('protocol must be an object', 'protocol');
  const range = {
    min: parseProtocolVersion(value.min, 'protocol.min'),
    max: parseProtocolVersion(value.max, 'protocol.max'),
  };
  if (compareVersions(range.min, range.max) > 0) {
    throw invalidArgument('protocol.min must not be greater than protocol.max', 'protocol');
  }
  return range;
}

export function negotiateProtocol(
  clientRange: ProtocolRange,
  supported: readonly ProtocolVersion[] = SUPPORTED_PROTOCOL_VERSIONS,
): ProtocolVersion {
  const selected = [...supported]
    .filter(version => compareVersions(version, clientRange.min) >= 0 && compareVersions(version, clientRange.max) <= 0)
    .sort(compareVersions)
    .at(-1);

  if (!selected) {
    const serviceVersions = supported.map(version => `${version.major}.${version.minor}`).join(', ');
    throw protocolIncompatible(
      `No compatible protocol version. Client requested ${clientRange.min.major}.${clientRange.min.minor}` +
      `-${clientRange.max.major}.${clientRange.max.minor}; service supports ${serviceVersions || 'none'}.`,
      {
        clientMin: `${clientRange.min.major}.${clientRange.min.minor}`,
        clientMax: `${clientRange.max.major}.${clientRange.max.minor}`,
        serviceVersions,
      },
    );
  }
  return { major: selected.major, minor: selected.minor };
}

export function negotiateCapabilities(
  requested: readonly string[],
  allowed: readonly Capability[],
): CapabilityNegotiation {
  const known = new Set<string>(CAPABILITIES);
  const allowedSet = new Set<string>(allowed);
  const granted: Capability[] = [];
  const denied: Capability[] = [];
  const unsupported: string[] = [];

  for (const capability of [...new Set(requested)]) {
    if (!known.has(capability)) unsupported.push(capability);
    else if (!allowedSet.has(capability)) denied.push(capability as Capability);
    else granted.push(capability as Capability);
  }

  return { granted, denied, unsupported };
}

export function validateInitializeParams(value: unknown): InitializeParams {
  if (!isRecord(value)) throw invalidArgument('initialize params must be an object', 'params');
  assertOnlyKeys(value, ['client', 'protocol', 'requestedCapabilities', 'launchMode']);
  if (!isRecord(value.client)) throw invalidArgument('client must be an object', 'client');
  assertOnlyKeys(value.client, ['id', 'name', 'version', 'instanceId'], 'client');

  const requested = value.requestedCapabilities;
  if (!Array.isArray(requested) || requested.some(item => typeof item !== 'string' || item.length === 0 || item.length > 128)) {
    throw invalidArgument('requestedCapabilities must be an array of non-empty strings', 'requestedCapabilities');
  }

  const launchMode = value.launchMode;
  if (launchMode !== 'one-shot' && launchMode !== 'embedded') {
    throw invalidArgument('launchMode must be one-shot or embedded', 'launchMode');
  }

  return {
    client: {
      id: requireString(value.client, 'id', { pattern: CLIENT_ID_PATTERN, maxLength: 128 }),
      name: requireString(value.client, 'name', { maxLength: 128 }),
      version: requireString(value.client, 'version', { maxLength: 64 }),
      instanceId: requireString(value.client, 'instanceId', { pattern: INSTANCE_ID_PATTERN, maxLength: 128 }),
    },
    protocol: parseProtocolRange(value.protocol),
    requestedCapabilities: [...new Set(requested as string[])],
    launchMode: launchMode as LaunchMode,
  };
}

function validateOptionalEmptyParams(value: unknown): Record<string, never> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw invalidArgument('params must be an object', 'params');
  assertOnlyKeys(value, []);
  return {};
}

function validateTtlMs(record: Record<string, unknown>): number | undefined {
  if (record.ttlMs === undefined) return undefined;
  if (!Number.isSafeInteger(record.ttlMs)) {
    throw invalidArgument('ttlMs must be a safe integer', 'ttlMs');
  }
  return record.ttlMs as number;
}

function validateOpaqueId(
  record: Record<string, unknown>,
  key: string,
  pattern: RegExp,
): string {
  return requireString(record, key, { pattern, maxLength: 128 });
}

export function validateToolsListParams(value: unknown): Record<string, never> {
  return validateOptionalEmptyParams(value);
}

export function validateShutdownParams(value: unknown): Record<string, never> {
  return validateOptionalEmptyParams(value);
}

export function validateToolCallParams(value: unknown): ToolCallParams {
  if (!isRecord(value)) throw invalidArgument('tools/call params must be an object', 'params');
  assertOnlyKeys(value, [
    'name',
    'arguments',
    'workspaceId',
    'leaseId',
    'targetId',
    'commandId',
    'idempotencyKey',
    'deadlineMs',
  ]);
  if (!Object.hasOwn(value, 'arguments') || !isJsonValue(value.arguments)) {
    throw invalidArgument('arguments must be valid JSON', 'arguments');
  }
  if (!isRecord(value.arguments)) {
    throw invalidArgument('arguments must be a JSON object', 'arguments');
  }
  if (
    value.deadlineMs !== undefined &&
    (!Number.isSafeInteger(value.deadlineMs) || Number(value.deadlineMs) < 1 || Number(value.deadlineMs) > 300_000)
  ) {
    throw invalidArgument('deadlineMs must be an integer from 1 through 300000', 'deadlineMs');
  }
  return {
    name: requireString(value, 'name', { maxLength: 256 }),
    arguments: value.arguments,
    ...(value.workspaceId !== undefined ? {
      workspaceId: validateOpaqueId(value, 'workspaceId', WORKSPACE_ID_PATTERN) as ToolCallParams['workspaceId'],
    } : {}),
    ...(value.leaseId !== undefined ? {
      leaseId: validateOpaqueId(value, 'leaseId', LEASE_ID_PATTERN) as ToolCallParams['leaseId'],
    } : {}),
    ...(value.targetId !== undefined ? {
      targetId: validateOpaqueId(value, 'targetId', TARGET_ID_PATTERN) as ToolCallParams['targetId'],
    } : {}),
    ...(value.commandId !== undefined ? {
      commandId: validateOpaqueId(value, 'commandId', COMMAND_ID_PATTERN) as ToolCallParams['commandId'],
    } : {}),
    ...(value.idempotencyKey !== undefined ? {
      idempotencyKey: requireString(value, 'idempotencyKey', { maxLength: 256 }),
    } : {}),
    ...(value.deadlineMs !== undefined ? { deadlineMs: Number(value.deadlineMs) } : {}),
  };
}

export function validateCommandAccessParams(value: unknown): CommandAccessParams {
  if (!isRecord(value)) throw invalidArgument('Command params must be an object', 'params');
  assertOnlyKeys(value, ['commandId', 'workspaceId']);
  return {
    commandId: validateOpaqueId(value, 'commandId', COMMAND_ID_PATTERN) as CommandAccessParams['commandId'],
    ...(value.workspaceId !== undefined ? {
      workspaceId: validateOpaqueId(value, 'workspaceId', WORKSPACE_ID_PATTERN) as CommandAccessParams['workspaceId'],
    } : {}),
  };
}

export function validateArtifactAccessParams(value: unknown): ArtifactAccessParams {
  if (!isRecord(value)) throw invalidArgument('Artifact params must be an object', 'params');
  assertOnlyKeys(value, ['workspaceId', 'leaseId', 'artifactId']);
  return {
    workspaceId: validateOpaqueId(value, 'workspaceId', WORKSPACE_ID_PATTERN) as ArtifactAccessParams['workspaceId'],
    leaseId: validateOpaqueId(value, 'leaseId', LEASE_ID_PATTERN) as ArtifactAccessParams['leaseId'],
    artifactId: validateOpaqueId(value, 'artifactId', ARTIFACT_ID_PATTERN) as ArtifactAccessParams['artifactId'],
  };
}

export function validateArtifactExportParams(value: unknown): ArtifactExportParams {
  if (!isRecord(value)) throw invalidArgument('artifacts/export params must be an object', 'params');
  assertOnlyKeys(value, ['workspaceId', 'leaseId', 'artifactId', 'path', 'overwrite']);
  if (value.overwrite !== undefined && typeof value.overwrite !== 'boolean') {
    throw invalidArgument('overwrite must be a boolean', 'overwrite');
  }
  return {
    workspaceId: validateOpaqueId(value, 'workspaceId', WORKSPACE_ID_PATTERN) as ArtifactExportParams['workspaceId'],
    leaseId: validateOpaqueId(value, 'leaseId', LEASE_ID_PATTERN) as ArtifactExportParams['leaseId'],
    artifactId: validateOpaqueId(value, 'artifactId', ARTIFACT_ID_PATTERN) as ArtifactExportParams['artifactId'],
    path: requireString(value, 'path', { maxLength: 16_384 }),
    ...(value.overwrite !== undefined ? { overwrite: value.overwrite } : {}),
  };
}

export function validateWorkspaceCreateParams(value: unknown): WorkspaceCreateParams {
  if (value === undefined) return {};
  if (!isRecord(value)) throw invalidArgument('workspaces/create params must be an object', 'params');
  assertOnlyKeys(value, ['browserId']);
  return value.browserId === undefined
    ? {}
    : { browserId: requireString(value, 'browserId', { maxLength: 128 }) };
}

export function validateWorkspaceGetParams(value: unknown): WorkspaceGetParams {
  if (!isRecord(value)) throw invalidArgument('workspaces/get params must be an object', 'params');
  assertOnlyKeys(value, ['workspaceId']);
  return { workspaceId: validateOpaqueId(value, 'workspaceId', WORKSPACE_ID_PATTERN) as WorkspaceGetParams['workspaceId'] };
}

export function validateWorkspaceReleaseParams(value: unknown): WorkspaceReleaseParams {
  return validateWorkspaceGetParams(value);
}

export function validateLeaseCreateParams(value: unknown): LeaseCreateParams {
  if (!isRecord(value)) throw invalidArgument('leases/create params must be an object', 'params');
  assertOnlyKeys(value, ['workspaceId', 'ttlMs']);
  const ttlMs = validateTtlMs(value);
  return {
    workspaceId: validateOpaqueId(value, 'workspaceId', WORKSPACE_ID_PATTERN) as LeaseCreateParams['workspaceId'],
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  };
}

export function validateLeaseHeartbeatParams(value: unknown): LeaseHeartbeatParams {
  if (!isRecord(value)) throw invalidArgument('leases/heartbeat params must be an object', 'params');
  assertOnlyKeys(value, ['leaseId', 'ttlMs']);
  const ttlMs = validateTtlMs(value);
  return {
    leaseId: validateOpaqueId(value, 'leaseId', LEASE_ID_PATTERN) as LeaseHeartbeatParams['leaseId'],
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  };
}

export function validateLeaseReleaseParams(value: unknown): LeaseReleaseParams {
  if (!isRecord(value)) throw invalidArgument('leases/release params must be an object', 'params');
  assertOnlyKeys(value, ['leaseId']);
  return { leaseId: validateOpaqueId(value, 'leaseId', LEASE_ID_PATTERN) as LeaseReleaseParams['leaseId'] };
}

function parseId(value: unknown, allowNull: boolean): string | number | null {
  if (allowNull && value === null) return null;
  if (typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  throw invalidArgument('JSON-RPC id must be a non-empty string or safe integer', 'id', -32600);
}

function parseParams(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if ((!Array.isArray(value) && !isRecord(value)) || !isJsonValue(value)) {
    throw invalidArgument('JSON-RPC params must be a JSON object or array', 'params', -32600);
  }
  return value;
}

function parseErrorObject(value: unknown): JsonRpcErrorObject {
  if (!isRecord(value)) throw invalidArgument('JSON-RPC error must be an object', 'error', -32600);
  if (!Number.isSafeInteger(value.code)) throw invalidArgument('JSON-RPC error.code must be an integer', 'error.code', -32600);
  const message = requireString(value, 'message', { maxLength: 4096 });
  if (value.data !== undefined && !isJsonValue(value.data)) {
    throw invalidArgument('JSON-RPC error.data must be valid JSON', 'error.data', -32600);
  }
  return { code: value.code as number, message, ...(value.data !== undefined ? { data: value.data } : {}) };
}

export function parseJsonRpcMessage(line: string, maxMessageBytes = 1024 * 1024): JsonRpcMessage {
  if (Buffer.byteLength(line, 'utf8') > maxMessageBytes) {
    throw new BrowserPilotError('result_too_large', `Protocol message exceeds ${maxMessageBytes} bytes`, {
      context: { maxMessageBytes },
      rpcCode: -32600,
    });
  }
  if (line.trim().length === 0) throw invalidArgument('Protocol message is empty', undefined, -32700);

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw new BrowserPilotError('invalid_argument', 'Invalid JSON', { rpcCode: -32700, cause });
  }

  if (!isRecord(parsed) || parsed.jsonrpc !== '2.0') {
    throw invalidArgument('Message must be a JSON-RPC 2.0 object', 'jsonrpc', -32600);
  }

  if (typeof parsed.method === 'string') {
    assertOnlyKeys(parsed, ['jsonrpc', 'id', 'method', 'params'], 'message');
    const method = requireString(parsed, 'method', { maxLength: 256 });
    const params = parseParams(parsed.params);
    if (parsed.id === undefined) {
      return { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) } satisfies JsonRpcNotification;
    }
    return {
      jsonrpc: '2.0',
      id: parseId(parsed.id, false) as string | number,
      method,
      ...(params !== undefined ? { params } : {}),
    } satisfies JsonRpcRequest;
  }

  if (parsed.id === undefined) {
    throw invalidArgument('JSON-RPC response must include id', 'id', -32600);
  }
  const id = parseId(parsed.id, true);
  const hasResult = Object.hasOwn(parsed, 'result');
  const hasError = Object.hasOwn(parsed, 'error');
  if (hasResult === hasError) {
    throw invalidArgument('JSON-RPC response must contain exactly one of result or error', undefined, -32600);
  }
  if (hasResult) {
    assertOnlyKeys(parsed, ['jsonrpc', 'id', 'result'], 'message');
    if (!isJsonValue(parsed.result)) throw invalidArgument('JSON-RPC result must be valid JSON', 'result', -32600);
    return { jsonrpc: '2.0', id, result: parsed.result } satisfies JsonRpcResponse;
  }
  assertOnlyKeys(parsed, ['jsonrpc', 'id', 'error'], 'message');
  return { jsonrpc: '2.0', id, error: parseErrorObject(parsed.error) } satisfies JsonRpcResponse;
}
