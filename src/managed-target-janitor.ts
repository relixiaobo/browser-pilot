import {
  CDPClient,
  CDPError,
  type CDPClientOptions,
} from './cdp.js';
import { BrowserPilotError } from './protocol/errors.js';

const MAX_LINE_BYTES = 64 * 1024;
const MAX_TRACKED_TARGETS = 4096;
const CLEANUP_TIMEOUT_MS = 5_000;

interface RequestMessage {
  id: number;
  method: 'create' | 'adopt' | 'cdp.send';
  params: Record<string, unknown>;
}

const wsUrl = process.argv[2];
if (!wsUrl || !/^wss?:\/\//.test(wsUrl)) {
  process.stderr.write('Managed target janitor requires a CDP WebSocket URL\n');
  process.exit(2);
}

function clientOptions(value: string | undefined): CDPClientOptions {
  if (!value) return {};
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid managed target janitor CDP options');
  }
  const allowed = new Set(['handshakeTimeoutMs', 'pingIntervalMs', 'pongTimeoutMs']);
  if (Object.keys(parsed).some(key => !allowed.has(key))) {
    throw new Error('Invalid managed target janitor CDP options');
  }
  return parsed as CDPClientOptions;
}

const cdp = new CDPClient(clientOptions(process.argv[3]));
const ownedTargets = new Map<string, string | undefined>();
let pending: Buffer = Buffer.alloc(0);
let commandTail = Promise.resolve();
let finishing = false;
let shutdownRequested = false;
let outputAvailable = true;

function emit(value: unknown): void {
  if (typeof process.send === 'function' && process.connected) {
    process.send(value);
    return;
  }
  if (!outputAvailable || process.stdout.destroyed || !process.stdout.writable) return;
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1024);
}

interface SerializedError {
  code: number | string;
  message: string;
  data?: unknown;
}

function serializeError(error: unknown, fallbackCode: string): SerializedError {
  if (error instanceof CDPError) {
    return {
      code: error.code,
      message: boundedMessage(error),
      ...(error.data !== undefined ? { data: error.data } : {}),
    };
  }
  if (error instanceof BrowserPilotError) {
    return { code: error.code, message: boundedMessage(error) };
  }
  return { code: fallbackCode, message: boundedMessage(error) };
}

function validateRequest(value: unknown): RequestMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid janitor request');
  const request = value as Record<string, unknown>;
  if (!Number.isSafeInteger(request.id) || Number(request.id) < 1) throw new Error('Invalid janitor request ID');
  if (request.method !== 'create' && request.method !== 'adopt' && request.method !== 'cdp.send') {
    throw new Error('Invalid janitor method');
  }
  if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)) {
    throw new Error('Invalid janitor params');
  }
  return request as unknown as RequestMessage;
}

function parseRequest(line: Buffer): RequestMessage {
  if (line.length === 0 || line.length > MAX_LINE_BYTES) throw new Error('Invalid janitor request size');
  return validateRequest(JSON.parse(line.toString('utf8')));
}

function notifyOwned(targetId: string, openerTargetId?: string): void {
  emit({ event: 'owned', targetId, ...(openerTargetId ? { openerTargetId } : {}) });
}

async function trackTarget(targetId: string, openerTargetId?: string): Promise<boolean> {
  if (ownedTargets.has(targetId)) return true;
  if (ownedTargets.size >= MAX_TRACKED_TARGETS) {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    return false;
  }
  ownedTargets.set(targetId, openerTargetId);
  notifyOwned(targetId, openerTargetId);
  return true;
}

async function createTarget(params: Record<string, unknown>): Promise<{ targetId: string }> {
  if (params.url !== 'about:blank') throw new Error('Managed targets must start at about:blank');
  const newWindow = params.newWindow === true;
  const windowId = params.windowId;
  const browserContextId = params.browserContextId;
  if (newWindow === (windowId !== undefined)) throw new Error('Exactly one managed target window selector is required');
  if (windowId !== undefined && (!Number.isSafeInteger(windowId) || Number(windowId) < 0)) {
    throw new Error('Invalid managed target window ID');
  }
  if (browserContextId !== undefined && (
    typeof browserContextId !== 'string' || browserContextId.length === 0 || browserContextId.length > 1024
  )) {
    throw new Error('Invalid managed target browser context ID');
  }
  const created = await cdp.send('Target.createTarget', {
    url: 'about:blank',
    ...(newWindow ? { newWindow: true } : { windowId }),
    ...(browserContextId ? { browserContextId } : {}),
  });
  if (typeof created?.targetId !== 'string' || created.targetId.length === 0) {
    throw new Error('Chrome returned an invalid managed target ID');
  }
  if (!(await trackTarget(created.targetId))) throw new Error('Managed target capacity reached');
  return { targetId: created.targetId };
}

async function adoptTargets(
  params: Record<string, unknown>,
): Promise<{ adopted: number; owned: Record<string, boolean> }> {
  if (!Array.isArray(params.targetIds) || params.targetIds.length > MAX_TRACKED_TARGETS) {
    throw new Error('Invalid managed target adoption list');
  }
  const requested = params.targetIds;
  if (requested.some(value => typeof value !== 'string' || value.length === 0 || value.length > 1024)) {
    throw new Error('Invalid managed target ID');
  }
  const result = await cdp.send('Target.getTargets');
  const infos = Array.isArray(result?.targetInfos) ? result.targetInfos : [];
  const live = new Map<string, string | undefined>();
  for (const info of infos) {
    if (!info || typeof info.targetId !== 'string') continue;
    live.set(info.targetId, typeof info.openerId === 'string' ? info.openerId : undefined);
  }
  const before = ownedTargets.size;
  for (const targetId of requested) {
    if (live.has(targetId)) await trackTarget(targetId, live.get(targetId));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [targetId, openerTargetId] of live) {
      if (!openerTargetId || !ownedTargets.has(openerTargetId) || ownedTargets.has(targetId)) continue;
      if (await trackTarget(targetId, openerTargetId)) changed = true;
    }
  }
  return {
    adopted: ownedTargets.size - before,
    owned: Object.fromEntries(requested.map(targetId => [targetId, ownedTargets.has(targetId)])),
  };
}

async function forwardCdp(params: Record<string, unknown>): Promise<unknown> {
  if (typeof params.method !== 'string' || params.method.length === 0 || params.method.length > 256) {
    throw new Error('Invalid CDP method');
  }
  if (params.params !== undefined && (
    !params.params || typeof params.params !== 'object' || Array.isArray(params.params)
  )) {
    throw new Error('Invalid CDP params');
  }
  if (params.sessionId !== undefined && (
    typeof params.sessionId !== 'string' || params.sessionId.length === 0 || params.sessionId.length > 1024
  )) {
    throw new Error('Invalid CDP session ID');
  }
  return cdp.send(
    params.method,
    params.params as Record<string, unknown> | undefined,
    params.sessionId as string | undefined,
  );
}

async function handle(request: RequestMessage): Promise<void> {
  try {
    const result = request.method === 'create'
      ? await createTarget(request.params)
      : request.method === 'adopt'
        ? await adoptTargets(request.params)
        : await forwardCdp(request.params);
    emit({ id: request.id, result });
  } catch (error) {
    emit({
      id: request.id,
      error: request.method === 'cdp.send'
        ? serializeError(error, 'cdp_error')
        : { code: 'janitor_error', message: boundedMessage(error) },
    });
  }
}

function cleanupOrder(): string[] {
  const depth = (targetId: string): number => {
    const seen = new Set<string>();
    let current: string | undefined = targetId;
    let value = 0;
    while (current && !seen.has(current)) {
      seen.add(current);
      const opener = ownedTargets.get(current);
      if (!opener || !ownedTargets.has(opener)) break;
      value += 1;
      current = opener;
    }
    return value;
  };
  return [...ownedTargets.keys()].sort((left, right) => depth(right) - depth(left));
}

async function closeOwnedTargets(): Promise<void> {
  const targetIds = cleanupOrder();
  for (let offset = 0; offset < targetIds.length; offset += 32) {
    await Promise.all(targetIds.slice(offset, offset + 32).map(targetId => (
      cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    )));
  }
}

async function finish(cleanup: boolean, exitCode = 0): Promise<void> {
  if (finishing) return;
  finishing = true;
  process.stdin.pause();
  if (cleanup && cdp.connectionState === 'connected') {
    await Promise.race([
      closeOwnedTargets(),
      new Promise<void>(resolve => setTimeout(resolve, CLEANUP_TIMEOUT_MS)),
    ]).catch(() => {});
  }
  await cdp.close();
  process.exitCode = exitCode;
  setImmediate(() => process.exit(exitCode));
}

async function main(): Promise<void> {
  process.stdout.on('error', () => { outputAvailable = false; });
  process.stderr.on('error', () => {});
  process.stdin.on('end', () => {
    shutdownRequested = true;
    void commandTail.finally(() => finish(true));
  });
  process.stdin.on('error', () => {
    shutdownRequested = true;
    void finish(true, 1);
  });
  process.on('disconnect', () => {
    shutdownRequested = true;
    void commandTail.finally(() => finish(true));
  });
  process.on('SIGTERM', () => {
    shutdownRequested = true;
    void finish(true);
  });
  process.on('SIGINT', () => {
    shutdownRequested = true;
    void finish(true);
  });
  process.stdin.resume();
  cdp.on('Target.targetCreated', params => {
    const info = params?.targetInfo;
    if (
      typeof info?.targetId !== 'string' ||
      typeof info?.openerId !== 'string' ||
      !ownedTargets.has(info.openerId)
    ) return;
    void trackTarget(info.targetId, info.openerId);
  });
  cdp.on('Target.targetDestroyed', params => {
    if (typeof params?.targetId !== 'string' || !ownedTargets.delete(params.targetId)) return;
    emit({ event: 'destroyed', targetId: params.targetId });
  });
  cdp.onAny((method, params, sessionId) => {
    emit({ event: 'cdp', method, params, ...(sessionId ? { sessionId } : {}) });
  });
  cdp.onConnectionState(event => {
    if (event.state === 'disconnected' && !finishing) void finish(false, 1);
  });
  await cdp.connect(wsUrl);
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  emit({ event: 'ready' });

  const enqueue = (request: RequestMessage): void => {
    if (request.method === 'cdp.send') {
      void handle(request);
      return;
    }
    commandTail = commandTail.then(() => handle(request));
  };
  if (typeof process.send === 'function') {
    process.on('message', value => {
      try {
        enqueue(validateRequest(value));
      } catch (error) {
        process.stderr.write(`${boundedMessage(error)}\n`);
        void finish(true, 2);
      }
    });
  } else {
    process.stdin.on('data', (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (pending.length + chunk.length > MAX_LINE_BYTES * 2) {
        void finish(true, 2);
        return;
      }
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        try {
          enqueue(parseRequest(line));
        } catch (error) {
          process.stderr.write(`${boundedMessage(error)}\n`);
          void finish(true, 2);
          return;
        }
        newline = pending.indexOf(0x0a);
      }
    });
  }
}

main().catch(error => {
  if (!shutdownRequested) {
    emit({ event: 'startup_error', error: serializeError(error, 'janitor_error') });
  }
  if (!finishing) process.stderr.write(`${boundedMessage(error)}\n`);
  void finish(false, 1);
});
