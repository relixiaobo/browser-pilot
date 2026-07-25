import { CDPClient } from './cdp.js';

const MAX_LINE_BYTES = 64 * 1024;
const MAX_TRACKED_TARGETS = 4096;
const CLEANUP_TIMEOUT_MS = 5_000;

interface RequestMessage {
  id: number;
  method: 'create' | 'adopt';
  params: Record<string, unknown>;
}

const wsUrl = process.argv[2];
if (!wsUrl || !/^wss?:\/\//.test(wsUrl)) {
  process.stderr.write('Managed target janitor requires a CDP WebSocket URL\n');
  process.exit(2);
}

const cdp = new CDPClient();
const ownedTargets = new Map<string, string | undefined>();
let pending: Buffer = Buffer.alloc(0);
let commandTail = Promise.resolve();
let finishing = false;
let outputAvailable = true;

function send(value: unknown): void {
  if (!outputAvailable || process.stdout.destroyed || !process.stdout.writable) return;
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1024);
}

function parseRequest(line: Buffer): RequestMessage {
  if (line.length === 0 || line.length > MAX_LINE_BYTES) throw new Error('Invalid janitor request size');
  const value: unknown = JSON.parse(line.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid janitor request');
  const request = value as Record<string, unknown>;
  if (!Number.isSafeInteger(request.id) || Number(request.id) < 1) throw new Error('Invalid janitor request ID');
  if (request.method !== 'create' && request.method !== 'adopt') throw new Error('Invalid janitor method');
  if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)) {
    throw new Error('Invalid janitor params');
  }
  return request as unknown as RequestMessage;
}

function notifyOwned(targetId: string, openerTargetId?: string): void {
  send({ event: 'owned', targetId, ...(openerTargetId ? { openerTargetId } : {}) });
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
  if (newWindow === (windowId !== undefined)) throw new Error('Exactly one managed target window selector is required');
  if (windowId !== undefined && (!Number.isSafeInteger(windowId) || Number(windowId) < 0)) {
    throw new Error('Invalid managed target window ID');
  }
  const created = await cdp.send('Target.createTarget', {
    url: 'about:blank',
    ...(newWindow ? { newWindow: true } : { windowId }),
  });
  if (typeof created?.targetId !== 'string' || created.targetId.length === 0) {
    throw new Error('Chrome returned an invalid managed target ID');
  }
  if (!(await trackTarget(created.targetId))) throw new Error('Managed target capacity reached');
  return { targetId: created.targetId };
}

async function adoptTargets(params: Record<string, unknown>): Promise<{ adopted: number }> {
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
  return { adopted: ownedTargets.size - before };
}

async function handle(request: RequestMessage): Promise<void> {
  try {
    const result = request.method === 'create'
      ? await createTarget(request.params)
      : await adoptTargets(request.params);
    send({ id: request.id, result });
  } catch (error) {
    send({ id: request.id, error: { code: 'janitor_error', message: boundedMessage(error) } });
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
  cdp.close();
  process.exitCode = exitCode;
  setImmediate(() => process.exit(exitCode));
}

async function main(): Promise<void> {
  process.stdout.on('error', () => { outputAvailable = false; });
  process.stderr.on('error', () => {});
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
    send({ event: 'destroyed', targetId: params.targetId });
  });
  cdp.onConnectionState(event => {
    if (event.state === 'disconnected' && !finishing) void finish(false, 1);
  });
  await cdp.connect(wsUrl);
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  send({ event: 'ready' });

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
      commandTail = commandTail.then(async () => {
        try {
          await handle(parseRequest(line));
        } catch (error) {
          process.stderr.write(`${boundedMessage(error)}\n`);
          await finish(true, 2);
        }
      });
      newline = pending.indexOf(0x0a);
    }
  });
  process.stdin.on('end', () => { void commandTail.finally(() => finish(true)); });
  process.stdin.on('error', () => { void finish(true, 1); });
  process.on('SIGTERM', () => { void finish(true); });
  process.on('SIGINT', () => { void finish(true); });
  process.stdin.resume();
}

main().catch(error => {
  process.stderr.write(`${boundedMessage(error)}\n`);
  void finish(false, 1);
});
