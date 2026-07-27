import { BrowserPilotError } from '../protocol/errors.js';
import type { JsonValue } from '../protocol/model.js';

export const MIN_BROKER_REQUEST_TIMEOUT_MS = 60_000;
export const BROKER_REQUEST_TIMEOUT_MARGIN_MS = 5_000;

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function brokerRequestTimeoutMs(method: string, params?: JsonValue): number {
  if (method !== 'tools/call' || !isRecord(params)) return MIN_BROKER_REQUEST_TIMEOUT_MS;
  const deadlineMs = params.deadlineMs;
  if (!Number.isSafeInteger(deadlineMs) || Number(deadlineMs) < 1) {
    return MIN_BROKER_REQUEST_TIMEOUT_MS;
  }
  return Math.max(
    MIN_BROKER_REQUEST_TIMEOUT_MS,
    Number(deadlineMs) + BROKER_REQUEST_TIMEOUT_MARGIN_MS,
  );
}

export function brokerRequestTimeoutError(method: string, params?: JsonValue): BrowserPilotError {
  if (method !== 'tools/call' || !isRecord(params)) {
    return new BrowserPilotError(
      'browser_disconnected',
      'Timed out waiting for the Browser Pilot Broker',
      { retryable: true },
    );
  }
  const commandId = typeof params.commandId === 'string' ? params.commandId : undefined;
  const toolName = typeof params.name === 'string' ? params.name : undefined;
  return new BrowserPilotError(
    'unknown_outcome',
    'Timed out waiting for the Browser Pilot command result',
    {
      retryable: true,
      context: {
        ...(commandId ? { commandId } : {}),
        ...(toolName ? { method: toolName } : {}),
      },
      remediation: {
        code: 'inspect_command_before_retry',
        message: commandId
          ? `Run bp command ${commandId} and inspect browser state before retrying.`
          : 'Inspect recent commands and browser state before retrying.',
        actionRequired: true,
      },
    },
  );
}
