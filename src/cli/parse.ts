import type { Command } from 'commander';
import type { CompatibilityInvocationOptions } from '../compatibility-broker-client.js';
import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';

export function normalizeUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return `https://${url}`;
}

export function parseLimit(raw: string): number {
  return parsePositiveInteger(raw, '--limit must be a positive integer', 'limit');
}

export function parsePositiveInteger(raw: string, message: string, field: string): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw invalidArgument(message, field);
  }
  return value;
}

export function parseNonNegativeInteger(raw: string, message: string, field: string): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 0) {
    throw invalidArgument(message, field);
  }
  return value;
}

export function parseRef(raw: string): number {
  const ref = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(ref) || ref < 1) {
    throw invalidArgument('Ref must be a positive integer', 'ref');
  }
  return ref;
}

export function parseCoordinates(raw: string): { x: number; y: number } {
  const parts = raw.split(',');
  if (parts.length !== 2 || parts.some(part => part.trim() === '')) {
    throw invalidArgument('--xy must be x,y (e.g. --xy 400,300)', 'xy');
  }
  const [x, y] = parts.map(part => Number(part.trim()));
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw invalidArgument('--xy must be x,y (e.g. --xy 400,300)', 'xy');
  }
  return { x, y };
}

export function cliClientKey(program: Command): string {
  const value = program.opts().clientKey ?? process.env.BROWSER_PILOT_CLIENT_KEY;
  if (value === undefined) return 'browser-pilot-cli';
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value)) {
    throw new BrowserPilotError(
      'invalid_argument',
      'Client key must be 3-128 characters using letters, digits, dot, underscore, colon, or hyphen',
      { context: { field: 'clientKey' } },
    );
  }
  return value;
}

export function cliInvocationOptions(
  program: Command,
  signal: AbortSignal,
): CompatibilityInvocationOptions {
  const requestId = program.opts().requestId ?? process.env.BROWSER_PILOT_REQUEST_ID;
  if (
    requestId !== undefined &&
    (typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId))
  ) {
    throw invalidArgument(
      'Request ID must be 1-128 characters using letters, digits, dot, underscore, colon, or hyphen',
      'requestId',
    );
  }
  const rawTimeout = String(program.opts().timeout ?? '60000');
  const deadlineMs = Number(rawTimeout);
  if (!/^\d+$/.test(rawTimeout) || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 300_000) {
    throw invalidArgument('--timeout must be an integer from 1 through 300000', 'timeout');
  }
  return {
    ...(requestId ? { requestId } : {}),
    deadlineMs,
    signal,
  };
}
