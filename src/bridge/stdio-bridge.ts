import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import {
  BrowserPilotError,
  asBrowserPilotError,
  invalidArgument,
} from '../protocol/errors.js';
import type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonValue,
} from '../protocol/model.js';
import { parseJsonRpcMessage } from '../protocol/validation.js';
import { DEFAULT_PROTOCOL_LIMITS } from '../services/broker-runtime.js';

export interface StdioBridgeBackend {
  call(bridgeSessionId: string, method: string, params?: JsonValue): Promise<JsonValue>;
  disconnect(bridgeSessionId: string): Promise<void> | void;
  notifications?(
    bridgeSessionId: string,
    signal: AbortSignal,
  ): AsyncIterable<JsonRpcNotification>;
}

export interface StdioBridgeOptions {
  input: Readable;
  output: Writable;
  backend: StdioBridgeBackend;
  bridgeSessionId?: string;
  maxMessageBytes?: number;
  maxResultBytes?: number;
}

export interface StdioBridgeResult {
  exitCode: 0 | 1;
  reason: 'eof' | 'shutdown' | 'protocol_error' | 'output_closed';
}

function isIncomingCall(message: JsonRpcMessage): message is Extract<JsonRpcMessage, { method: string }> {
  return 'method' in message;
}

function isOutOfBandControl(message: Extract<JsonRpcMessage, { method: string }>): boolean {
  if (message.method === 'commands/get' || message.method === 'commands/cancel') return true;
  if (message.method !== 'tools/call' || !message.params || typeof message.params !== 'object') return false;
  if (Array.isArray(message.params)) return false;
  const name = message.params.name;
  return name === 'browser.dialogs.list' || name === 'browser.dialogs.respond';
}

function errorResponse(id: string | number | null, error: unknown): JsonRpcResponse {
  const stable = asBrowserPilotError(error);
  return { jsonrpc: '2.0', id, error: stable.toJsonRpcError() };
}

async function writeLine(
  output: Writable,
  value: JsonRpcResponse | JsonRpcNotification,
  maxResultBytes: number,
): Promise<void> {
  let serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > maxResultBytes) {
    if (!('id' in value)) return;
    serialized = JSON.stringify(errorResponse(value.id, new BrowserPilotError(
      'result_too_large',
      `Protocol result exceeds ${maxResultBytes} bytes`,
      { context: { maxResultBytes } },
    )));
  }
  if (output.destroyed || !output.writable) throw new Error('Protocol output is closed');
  if (!output.write(`${serialized}\n`)) await once(output, 'drain');
}

function decodeLine(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new BrowserPilotError('invalid_argument', 'Protocol message is not valid UTF-8', {
      rpcCode: -32700,
      cause,
    });
  }
}

export async function runStdioBridge(options: StdioBridgeOptions): Promise<StdioBridgeResult> {
  const bridgeSessionId = options.bridgeSessionId ?? `bridge:${randomUUID()}`;
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_PROTOCOL_LIMITS.maxMessageBytes;
  const maxResultBytes = options.maxResultBytes ?? DEFAULT_PROTOCOL_LIMITS.maxResultBytes;
  let pending = Buffer.alloc(0);
  let reason: StdioBridgeResult['reason'] = 'eof';
  let exitCode: StdioBridgeResult['exitCode'] = 0;
  let stopped = false;
  let framingFailed = false;
  let outputTail = Promise.resolve();
  let normalTail = Promise.resolve();
  let initialization: Promise<void> | undefined;
  let notificationController: AbortController | undefined;
  let notificationTask: Promise<void> | undefined;
  const inFlight = new Set<Promise<void>>();

  const queueWrite = (value: JsonRpcResponse | JsonRpcNotification): Promise<void> => {
    const write = outputTail.then(() => writeLine(options.output, value, maxResultBytes));
    outputTail = write.catch(() => {});
    return write;
  };

  const failFraming = async (error: unknown): Promise<void> => {
    exitCode = 1;
    reason = 'protocol_error';
    stopped = true;
    framingFailed = true;
    await queueWrite(errorResponse(null, error));
  };

  const track = (task: Promise<void>): void => {
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  };

  const startNotifications = (): void => {
    if (notificationTask || !options.backend.notifications) return;
    notificationController = new AbortController();
    notificationTask = (async () => {
      for await (const notification of options.backend.notifications!(
        bridgeSessionId,
        notificationController!.signal,
      )) {
        if (notificationController!.signal.aborted || stopped) break;
        await queueWrite(notification);
      }
    })().catch(() => {
      if (notificationController?.signal.aborted) return;
      stopped = true;
      reason = 'output_closed';
      exitCode = 1;
      options.input.destroy();
    });
  };

  const processLine = async (rawLine: Buffer): Promise<void> => {
    const line = rawLine.at(-1) === 0x0d ? rawLine.subarray(0, -1) : rawLine;
    let message: JsonRpcMessage;
    try {
      message = parseJsonRpcMessage(decodeLine(line), maxMessageBytes);
    } catch (error) {
      await failFraming(error);
      return;
    }
    if (!isIncomingCall(message)) {
      await failFraming(invalidArgument('Bridge accepts JSON-RPC requests and notifications only', undefined, -32600));
      return;
    }

    const dispatch = async (): Promise<void> => {
      const requestId = 'id' in message ? message.id : undefined;
      try {
        const result = await options.backend.call(bridgeSessionId, message.method, message.params);
        if (requestId !== undefined && reason !== 'protocol_error') {
          await queueWrite({ jsonrpc: '2.0', id: requestId, result });
        }
        if (message.method === 'initialize' && reason !== 'protocol_error') startNotifications();
      } catch (error) {
        if (requestId !== undefined && reason !== 'protocol_error') {
          try {
            await queueWrite(errorResponse(requestId, error));
          } catch {
            stopped = true;
            reason = 'output_closed';
            exitCode = 1;
          }
        }
      }
    };

    const outOfBand = isOutOfBandControl(message);
    const task = outOfBand
      ? (initialization ?? Promise.resolve()).then(dispatch)
      : normalTail.then(dispatch);
    if (!outOfBand) normalTail = task.catch(() => {});
    if (message.method === 'initialize') initialization = task.catch(() => {});
    track(task);
    if (message.method === 'shutdown') {
      stopped = true;
      reason = 'shutdown';
    }
  };

  try {
    for await (const value of options.input) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let offset = 0;
      while (!stopped && offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        if (newline === -1) {
          const remaining = chunk.subarray(offset);
          if (pending.length + remaining.length > maxMessageBytes) {
            await failFraming(new BrowserPilotError(
              'result_too_large',
              `Protocol message exceeds ${maxMessageBytes} bytes`,
              { context: { maxMessageBytes }, rpcCode: -32600 },
            ));
            break;
          }
          pending = pending.length === 0 ? Buffer.from(remaining) : Buffer.concat([pending, remaining]);
          offset = chunk.length;
          continue;
        }

        const part = chunk.subarray(offset, newline);
        if (pending.length + part.length > maxMessageBytes) {
          await failFraming(new BrowserPilotError(
            'result_too_large',
            `Protocol message exceeds ${maxMessageBytes} bytes`,
            { context: { maxMessageBytes }, rpcCode: -32600 },
          ));
          break;
        }
        const line = pending.length === 0 ? part : Buffer.concat([pending, part]);
        pending = Buffer.alloc(0);
        offset = newline + 1;
        await processLine(line);
      }
      if (stopped) break;
    }
    if (!stopped && pending.length > 0) await processLine(pending);
    notificationController?.abort();
    await notificationTask;
    if (!framingFailed) await Promise.allSettled([...inFlight]);
    await outputTail;
  } catch {
    if (!stopped) {
      reason = 'output_closed';
      exitCode = 1;
    }
  } finally {
    notificationController?.abort();
    await notificationTask;
    try { await options.backend.disconnect(bridgeSessionId); } catch { /* disconnect is best-effort */ }
  }
  return { exitCode, reason };
}
