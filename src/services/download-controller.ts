import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type {
  AgentHint,
  ArtifactId,
  BrowserWorkspaceId,
  ControlledTargetId,
  ControlLeaseId,
  JsonValue,
} from '../protocol/model.js';
import type { Transport } from '../transport.js';
import type { ArtifactStore } from './artifact-store.js';
import type { PublishBrowserEventInput } from './event-journal.js';
import { downloadAgentHint } from './agent-hint-service.js';

export interface DownloadSessionContext {
  workspaceId: BrowserWorkspaceId;
  leaseId: ControlLeaseId;
  targetId: ControlledTargetId;
  browserConnectionGeneration: number;
  sessionId: string;
  cdpBrowserContextId?: string;
}

export type DownloadCleanupReason =
  | 'connection_lost'
  | 'lease_released'
  | 'session_replaced'
  | 'target_detached'
  | 'workspace_released';

export interface DownloadControllerOptions {
  maxDownloadBytes?: number;
  maxActivePerSession?: number;
  maxActivePerWorkspace?: number;
  maxActiveTotal?: number;
  publishEvent?: (event: PublishBrowserEventInput) => void;
}

interface DownloadSession {
  context: DownloadSessionContext;
  available: boolean;
  closed: boolean;
  downloads: Map<string, DownloadRecord>;
}

interface DownloadRecord {
  id: string;
  guid: string;
  url: string;
  fileName: string;
  receivedBytes: number;
  totalBytes?: number;
  state: 'active' | 'finalizing' | 'terminal';
}

interface DownloadBinding {
  session: DownloadSession;
  download: DownloadRecord;
}

const MAX_EVENT_URL_LENGTH = 16_384;
const MAX_FILE_NAME_LENGTH = 4096;
const MAX_FILE_PATH_LENGTH = 32_768;

class DownloadFinalizeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'DownloadFinalizeError';
    this.code = code;
  }
}

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function finiteBytes(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
    : undefined;
}

function safeFileName(value: unknown): string {
  const candidate = boundedString(value, MAX_FILE_NAME_LENGTH)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  const leaf = candidate.split(/[\\/]/).at(-1) ?? '';
  return leaf && leaf !== '.' && leaf !== '..' ? leaf : 'download';
}

export class DownloadController {
  private readonly sessions = new Map<string, DownloadSession>();
  private readonly attachments = new Map<string, Promise<boolean>>();
  private readonly downloadsByGuid = new Map<string, DownloadBinding>();
  private readonly configurations = new Map<number, Map<string, Promise<boolean>>>();
  private readonly maxDownloadBytes: number;
  private readonly maxActivePerSession: number;
  private readonly maxActivePerWorkspace: number;
  private readonly maxActiveTotal: number;
  private readonly publishEvent?: (event: PublishBrowserEventInput) => void;
  private latestConfigurationGeneration = 0;

  constructor(
    private readonly transport: Transport,
    private readonly artifacts: ArtifactStore,
    options: DownloadControllerOptions = {},
  ) {
    this.maxDownloadBytes = options.maxDownloadBytes ?? artifacts.maxItemBytes;
    this.maxActivePerSession = options.maxActivePerSession ?? 8;
    this.maxActivePerWorkspace = options.maxActivePerWorkspace ?? 32;
    this.maxActiveTotal = options.maxActiveTotal ?? 128;
    this.publishEvent = options.publishEvent;
    if ([
      this.maxDownloadBytes,
      this.maxActivePerSession,
      this.maxActivePerWorkspace,
      this.maxActiveTotal,
    ].some(value => !Number.isSafeInteger(value) || value <= 0) ||
      this.maxDownloadBytes > artifacts.maxItemBytes) {
      throw new Error('Invalid DownloadController limit');
    }
    this.installHandlers();
  }

  attachSession(context: DownloadSessionContext): Promise<boolean> {
    const pending = this.attachments.get(context.sessionId);
    if (pending) return pending;
    const existing = this.sessions.get(context.sessionId);
    if (existing) return Promise.resolve(existing.available);

    const attachment = this.configureSession(context).finally(() => {
      if (this.attachments.get(context.sessionId) === attachment) {
        this.attachments.delete(context.sessionId);
      }
    });
    this.attachments.set(context.sessionId, attachment);
    return attachment;
  }

  private async configureSession(context: DownloadSessionContext): Promise<boolean> {
    const session: DownloadSession = {
      context: { ...context },
      available: false,
      closed: false,
      downloads: new Map(),
    };
    this.sessions.set(context.sessionId, session);
    const available = await this.enableBrowserDownloadEvents(context);
    if (session.closed || this.sessions.get(context.sessionId) !== session) return false;
    session.available = available;
    if (!available) {
      this.publish(session, {
        state: 'capture_unavailable',
        reason: 'browser_download_events_unavailable',
      });
    }
    return available;
  }

  private enableBrowserDownloadEvents(context: DownloadSessionContext): Promise<boolean> {
    if (context.browserConnectionGeneration > this.latestConfigurationGeneration) {
      this.latestConfigurationGeneration = context.browserConnectionGeneration;
      for (const generation of this.configurations.keys()) {
        if (generation < context.browserConnectionGeneration) this.configurations.delete(generation);
      }
    }
    let contexts = this.configurations.get(context.browserConnectionGeneration);
    if (!contexts) {
      contexts = new Map();
      this.configurations.set(context.browserConnectionGeneration, contexts);
    }
    const key = context.cdpBrowserContextId ?? '';
    const existing = contexts.get(key);
    if (existing) return existing;
    const configured = this.transport.send('Browser.setDownloadBehavior', {
      behavior: 'default',
      eventsEnabled: true,
      ...(context.cdpBrowserContextId ? { browserContextId: context.cdpBrowserContextId } : {}),
    }).then(() => true, () => {
      if (contexts?.get(key) === configured) contexts.delete(key);
      return false;
    });
    contexts.set(key, configured);
    return configured;
  }

  detachSession(sessionId: string, reason: DownloadCleanupReason): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.closed = true;
    for (const download of [...session.downloads.values()]) {
      if (download.state === 'terminal') continue;
      download.state = 'terminal';
      this.removeBinding(session, download);
      this.publish(session, {
        downloadId: download.id,
        state: 'cancelled',
        reason,
        receivedBytes: download.receivedBytes,
        ...(download.totalBytes !== undefined ? { totalBytes: download.totalBytes } : {}),
      });
    }
  }

  releaseLease(leaseId: ControlLeaseId): void {
    for (const session of [...this.sessions.values()]) {
      if (session.context.leaseId === leaseId) this.detachSession(session.context.sessionId, 'lease_released');
    }
  }

  releaseWorkspace(workspaceId: BrowserWorkspaceId): void {
    for (const session of [...this.sessions.values()]) {
      if (session.context.workspaceId === workspaceId) {
        this.detachSession(session.context.sessionId, 'workspace_released');
      }
    }
  }

  private installHandlers(): void {
    this.transport.on?.('Page.downloadWillBegin', (params: any, sessionId?: string) => {
      if (!sessionId) return;
      const session = this.sessions.get(sessionId);
      const guid = boundedString(params?.guid, 512);
      if (!session || !session.available || session.closed || !/^[A-Za-z0-9._-]{1,512}$/.test(guid)) return;

      const collision = this.downloadsByGuid.get(guid);
      if (collision) {
        if (collision.session === session) return;
        this.failDownload(collision.session, collision.download, 'download_identity_collision');
        this.publish(session, {
          downloadId: `download:${randomUUID()}`,
          state: 'failed',
          reason: 'download_identity_collision',
        });
        return;
      }
      if (!this.hasDownloadCapacity(session)) {
        this.publish(session, {
          downloadId: `download:${randomUUID()}`,
          state: 'failed',
          reason: 'concurrency_limit_exceeded',
        });
        return;
      }

      const download: DownloadRecord = {
        id: `download:${randomUUID()}`,
        guid,
        url: boundedString(params?.url, MAX_EVENT_URL_LENGTH),
        fileName: safeFileName(params?.suggestedFilename),
        receivedBytes: 0,
        state: 'active',
      };
      session.downloads.set(guid, download);
      this.downloadsByGuid.set(guid, { session, download });
      this.publish(session, {
        downloadId: download.id,
        state: 'started',
        url: download.url,
        suggestedFileName: download.fileName,
      });
    });

    this.transport.on?.('Page.downloadProgress', (params: any, sessionId?: string) => {
      if (!sessionId) return;
      const binding = this.downloadsByGuid.get(boundedString(params?.guid, 512));
      if (!binding || binding.session.context.sessionId !== sessionId) return;
      this.updateBytes(binding.download, params);
      if (this.isOversized(binding.download)) {
        this.failOversized(binding.session, binding.download);
      } else if (params?.state === 'canceled') {
        this.cancelDownload(binding.session, binding.download, 'browser_cancelled');
      }
    });

    this.transport.on?.('Browser.downloadProgress', (params: any) => {
      const binding = this.downloadsByGuid.get(boundedString(params?.guid, 512));
      if (!binding) return;
      this.updateBytes(binding.download, params);
      if (this.isOversized(binding.download)) {
        this.failOversized(binding.session, binding.download);
        return;
      }
      if (params?.state === 'completed' && binding.download.state === 'active') {
        binding.download.state = 'finalizing';
        void this.finalize(binding.session, binding.download, params?.filePath);
      } else if (params?.state === 'canceled') {
        this.cancelDownload(binding.session, binding.download, 'browser_cancelled');
      }
    });
  }

  private updateBytes(download: DownloadRecord, params: any): void {
    const receivedBytes = finiteBytes(params?.receivedBytes);
    const totalBytes = finiteBytes(params?.totalBytes);
    if (receivedBytes !== undefined) download.receivedBytes = receivedBytes;
    if (totalBytes !== undefined) download.totalBytes = totalBytes;
  }

  private isOversized(download: DownloadRecord): boolean {
    return download.receivedBytes > this.maxDownloadBytes ||
      (download.totalBytes !== undefined && download.totalBytes > this.maxDownloadBytes);
  }

  private failOversized(session: DownloadSession, download: DownloadRecord): void {
    this.failDownload(session, download, 'size_limit_exceeded', {
      maxDownloadBytes: this.maxDownloadBytes,
    });
  }

  private failDownload(
    session: DownloadSession,
    download: DownloadRecord,
    reason: string,
    limits: Record<string, JsonValue> = {},
  ): void {
    if (download.state === 'terminal') return;
    download.state = 'terminal';
    this.removeBinding(session, download);
    this.publish(session, {
      downloadId: download.id,
      state: 'failed',
      reason,
      receivedBytes: download.receivedBytes,
      ...(download.totalBytes !== undefined ? { totalBytes: download.totalBytes } : {}),
      ...limits,
    });
  }

  private cancelDownload(session: DownloadSession, download: DownloadRecord, reason: string): void {
    if (download.state === 'terminal') return;
    download.state = 'terminal';
    this.removeBinding(session, download);
    this.publish(session, {
      downloadId: download.id,
      state: 'cancelled',
      reason,
      receivedBytes: download.receivedBytes,
      ...(download.totalBytes !== undefined ? { totalBytes: download.totalBytes } : {}),
    });
  }

  private async finalize(
    session: DownloadSession,
    download: DownloadRecord,
    rawFilePath: unknown,
  ): Promise<void> {
    try {
      const completedFile = await this.validateCompletedFile(rawFilePath);
      if (completedFile.size > this.maxDownloadBytes) {
        download.receivedBytes = completedFile.size;
        this.failOversized(session, download);
        return;
      }
      if (!this.isTracked(session, download)) return;
      const record = await this.artifacts.ingestDownloadCopy(
        session.context.workspaceId,
        completedFile.path,
        download.fileName,
      );
      if (!this.isTracked(session, download)) {
        await this.artifacts.release(session.context.workspaceId, record.descriptor.id);
        return;
      }
      download.state = 'terminal';
      this.removeBinding(session, download);
      this.publish(session, {
        downloadId: download.id,
        state: 'completed',
        artifact: record.descriptor as unknown as JsonValue,
      });
    } catch (error) {
      if (download.state === 'terminal') return;
      const code = error instanceof DownloadFinalizeError
        ? error.code
        : error instanceof Error && 'code' in error && error.code === 'result_too_large'
          ? 'artifact_quota_exceeded'
          : error instanceof Error && 'code' in error && error.code === 'invalid_argument'
            ? 'download_file_unavailable'
            : 'artifact_ingest_failed';
      this.failDownload(session, download, code);
    }
  }

  private async validateCompletedFile(rawFilePath: unknown): Promise<{ path: string; size: number }> {
    if (typeof rawFilePath !== 'string' || rawFilePath.length === 0) {
      throw new DownloadFinalizeError('download_file_path_unavailable');
    }
    if (
      rawFilePath.length > MAX_FILE_PATH_LENGTH ||
      rawFilePath.includes('\u0000') ||
      !isAbsolute(rawFilePath)
    ) {
      throw new DownloadFinalizeError('download_file_path_invalid');
    }
    try {
      const info = await lstat(rawFilePath);
      if (info.isSymbolicLink() || !info.isFile()) {
          throw new DownloadFinalizeError('download_not_regular_file');
      }
      return { path: rawFilePath, size: info.size };
    } catch (error) {
      if (error instanceof DownloadFinalizeError) throw error;
      throw new DownloadFinalizeError('download_file_unavailable');
    }
  }

  private removeBinding(session: DownloadSession, download: DownloadRecord): void {
    if (session.downloads.get(download.guid) === download) session.downloads.delete(download.guid);
    const binding = this.downloadsByGuid.get(download.guid);
    if (binding?.session === session && binding.download === download) {
      this.downloadsByGuid.delete(download.guid);
    }
  }

  private isTracked(session: DownloadSession, download: DownloadRecord): boolean {
    return !session.closed &&
      session.downloads.get(download.guid) === download &&
      this.downloadsByGuid.get(download.guid)?.download === download;
  }

  private publish(session: DownloadSession, payload: Record<string, JsonValue>): void {
    if (!this.publishEvent) return;
    const hint = this.agentHint(payload);
    try {
      this.publishEvent({
        workspaceId: session.context.workspaceId,
        leaseId: session.context.leaseId,
        targetId: session.context.targetId,
        browserConnectionGeneration: session.context.browserConnectionGeneration,
        type: 'download',
        sensitivity: 'user_file',
        payload: {
          ...payload,
          ...(hint ? { hints: [hint] as unknown as JsonValue } : {}),
        },
      });
    } catch { /* Event delivery cannot change browser or download state. */ }
  }

  private agentHint(payload: Record<string, JsonValue>): AgentHint | undefined {
    if (payload.state === 'started') return downloadAgentHint({ state: 'started' });
    if (payload.state === 'completed') {
      const artifact = payload.artifact;
      if (
        artifact && typeof artifact === 'object' && !Array.isArray(artifact) &&
        typeof artifact.id === 'string'
      ) {
        return downloadAgentHint({ state: 'completed', artifactId: artifact.id as ArtifactId });
      }
      return undefined;
    }
    if (payload.state === 'failed' || payload.state === 'cancelled') {
      return downloadAgentHint({
        state: payload.state,
        reason: typeof payload.reason === 'string' ? payload.reason : 'unknown',
      });
    }
    return undefined;
  }

  private hasDownloadCapacity(session: DownloadSession): boolean {
    const sessionCount = session.downloads.size;
    let workspaceCount = 0;
    for (const binding of this.downloadsByGuid.values()) {
      if (binding.session.context.workspaceId === session.context.workspaceId) workspaceCount += 1;
    }
    return sessionCount < this.maxActivePerSession &&
      workspaceCount < this.maxActivePerWorkspace &&
      this.downloadsByGuid.size < this.maxActiveTotal;
  }
}
