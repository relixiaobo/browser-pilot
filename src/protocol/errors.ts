import type { JsonRpcErrorObject, JsonValue } from './model.js';

export const ERROR_CODES = [
  'protocol_incompatible',
  'not_initialized',
  'capability_denied',
  'browser_not_found',
  'browser_not_authorized',
  'browser_disconnected',
  'broker_in_use',
  'profile_selection_required',
  'profile_context_stale',
  'profile_context_unavailable',
  'workspace_not_found',
  'lease_expired',
  'target_not_owned',
  'target_busy',
  'stale_ref',
  'action_not_verified',
  'command_cancelled',
  'command_expired',
  'wait_timeout',
  'unknown_outcome',
  'artifact_not_found',
  'artifact_expired',
  'cursor_expired',
  'result_too_large',
  'invalid_argument',
  'internal_error',
] as const;

export type BrowserPilotErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorContext {
  workspaceId?: string;
  leaseId?: string;
  targetId?: string;
  observationId?: string;
  commandId?: string;
  artifactId?: string;
  field?: string;
  [key: string]: JsonValue | undefined;
}

export interface ErrorRemediation {
  code: string;
  message: string;
  actionRequired: boolean;
}

export interface BrowserPilotErrorData {
  code: BrowserPilotErrorCode;
  retryable: boolean;
  context?: ErrorContext;
  remediation?: ErrorRemediation;
}

export class BrowserPilotError extends Error {
  readonly code: BrowserPilotErrorCode;
  readonly retryable: boolean;
  readonly context?: ErrorContext;
  readonly remediation?: ErrorRemediation;
  readonly rpcCode: number;

  constructor(
    code: BrowserPilotErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      context?: ErrorContext;
      remediation?: ErrorRemediation;
      rpcCode?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'BrowserPilotError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.context = options.context;
    this.remediation = options.remediation;
    this.rpcCode = options.rpcCode ?? -32000;
  }

  toData(): BrowserPilotErrorData {
    return {
      code: this.code,
      retryable: this.retryable,
      ...(this.context ? { context: this.context } : {}),
      ...(this.remediation ? { remediation: this.remediation } : {}),
    };
  }

  toJsonRpcError(): JsonRpcErrorObject {
    return {
      code: this.rpcCode,
      message: this.message,
      data: this.toData() as unknown as JsonValue,
    };
  }
}

export function invalidArgument(message: string, field?: string, rpcCode = -32602): BrowserPilotError {
  return new BrowserPilotError('invalid_argument', message, {
    context: field ? { field } : undefined,
    rpcCode,
  });
}

export function protocolIncompatible(message: string, context?: ErrorContext): BrowserPilotError {
  return new BrowserPilotError('protocol_incompatible', message, {
    context,
    rpcCode: -32001,
  });
}

export function asBrowserPilotError(error: unknown): BrowserPilotError {
  if (error instanceof BrowserPilotError) return error;
  if (
    error instanceof Error &&
    typeof (error as Partial<BrowserPilotError>).code === 'string' &&
    (ERROR_CODES as readonly string[]).includes((error as Partial<BrowserPilotError>).code!)
  ) {
    const stable = error as Partial<BrowserPilotError>;
    return new BrowserPilotError(stable.code as BrowserPilotErrorCode, error.message, {
      retryable: stable.retryable,
      context: stable.context,
      remediation: stable.remediation,
      rpcCode: stable.rpcCode,
      cause: error,
    });
  }
  return new BrowserPilotError('internal_error', 'Internal Browser Pilot error', {
    retryable: false,
    cause: error,
  });
}

export function browserPilotErrorFromJsonRpc(error: JsonRpcErrorObject): BrowserPilotError {
  const data = error.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return new BrowserPilotError('internal_error', error.message, { rpcCode: error.code });
  }
  const code = data.code;
  if (typeof code !== 'string' || !(ERROR_CODES as readonly string[]).includes(code)) {
    return new BrowserPilotError('internal_error', error.message, { rpcCode: error.code });
  }
  const retryable = typeof data.retryable === 'boolean' ? data.retryable : false;
  const context = data.context && typeof data.context === 'object' && !Array.isArray(data.context)
    ? data.context as ErrorContext
    : undefined;
  const remediation = data.remediation && typeof data.remediation === 'object' && !Array.isArray(data.remediation)
    ? data.remediation as unknown as ErrorRemediation
    : undefined;
  return new BrowserPilotError(code as BrowserPilotErrorCode, error.message, {
    retryable,
    context,
    remediation,
    rpcCode: error.code,
  });
}
