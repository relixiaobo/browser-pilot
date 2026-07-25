import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, rm, stat, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { DOWNLOAD_DIR } from '../paths.js';
import type {
  BrowserWorkspaceId,
  ControlledTargetId,
  ControlLeaseId,
  JsonValue,
} from '../protocol/model.js';
import type { Transport } from '../transport.js';
import type { ArtifactStore } from './artifact-store.js';
import type { PublishBrowserEventInput } from './event-journal.js';

export interface DownloadSessionContext {
  workspaceId: BrowserWorkspaceId;
  leaseId: ControlLeaseId;
  targetId: ControlledTargetId;
  browserConnectionGeneration: number;
  sessionId: string;
}

export type DownloadCleanupReason =
  | 'connection_lost'
  | 'lease_released'
  | 'session_replaced'
  | 'target_detached'
  | 'workspace_released';

export interface DownloadControllerOptions {
  directory?: string;
  maxDownloadBytes?: number;
  maxActivePerSession?: number;
  maxActivePerWorkspace?: number;
  maxActiveTotal?: number;
  publishEvent?: (event: PublishBrowserEventInput) => void;
}

interface DownloadSession {
  context: DownloadSessionContext;
  directory: string;
  available: boolean;
  closed: boolean;
  downloads: Map<string, DownloadRecord>;
}

interface DownloadRecord {
  id: string;
  guid: string;
  path: string;
  url: string;
  fileName: string;
  receivedBytes: number;
  totalBytes?: number;
  state: 'active' | 'finalizing' | 'terminal';
}

const MAX_EVENT_URL_LENGTH = 16_384;
const MAX_FILE_NAME_LENGTH = 4096;

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
  const leaf = basename(candidate);
  return leaf && leaf !== '.' && leaf !== '..' ? leaf : 'download';
}

export class DownloadController {
  private readonly sessions = new Map<string, DownloadSession>();
  private readonly attachments = new Map<string, Promise<boolean>>();
  private readonly attachmentContexts = new Map<string, DownloadSessionContext>();
  private readonly cancelledAttachments = new Set<string>();
  private readonly directory: string;
  private readonly maxDownloadBytes: number;
  private readonly maxActivePerSession: number;
  private readonly maxActivePerWorkspace: number;
  private readonly maxActiveTotal: number;
  private readonly publishEvent?: (event: PublishBrowserEventInput) => void;
  private initializePromise?: Promise<void>;

  constructor(
    private readonly transport: Transport,
    private readonly artifacts: ArtifactStore,
    options: DownloadControllerOptions = {},
  ) {
    this.directory = resolve(options.directory ?? DOWNLOAD_DIR);
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
      throw new Error('Invalid download size limit');
    }
    this.installHandlers();
  }

  attachSession(context: DownloadSessionContext): Promise<boolean> {
    if (this.sessions.has(context.sessionId)) {
      return Promise.resolve(this.sessions.get(context.sessionId)!.available);
    }
    const pending = this.attachments.get(context.sessionId);
    if (pending) return pending;
    const attachment = this.configureSession(context).finally(() => {
      if (this.attachments.get(context.sessionId) === attachment) {
        this.attachments.delete(context.sessionId);
      }
      this.attachmentContexts.delete(context.sessionId);
      this.cancelledAttachments.delete(context.sessionId);
    });
    this.attachments.set(context.sessionId, attachment);
    this.attachmentContexts.set(context.sessionId, { ...context });
    return attachment;
  }

  private async configureSession(context: DownloadSessionContext): Promise<boolean> {
    const directory = join(this.directory, randomUUID());
    const session: DownloadSession = {
      context: { ...context },
      directory,
      available: false,
      closed: false,
      downloads: new Map(),
    };
    let stagingReady = false;
    try {
      await this.initialize();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700).catch(() => {});
      stagingReady = true;
      if (this.cancelledAttachments.has(context.sessionId)) {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
        return false;
      }
      this.sessions.set(context.sessionId, session);
      await this.transport.send('Page.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: directory,
        eventsEnabled: true,
      }, context.sessionId);
      if (session.closed || this.sessions.get(context.sessionId) !== session) {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
        return false;
      }
      session.available = true;
      return true;
    } catch {
      this.sessions.delete(context.sessionId);
      session.closed = true;
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      this.publish(session, {
        state: 'capture_unavailable',
        reason: stagingReady ? 'target_session_api_unavailable' : 'staging_unavailable',
      });
      return false;
    }
  }

  detachSession(sessionId: string, reason: DownloadCleanupReason): void {
    if (this.attachments.has(sessionId)) this.cancelledAttachments.add(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.closed = true;
    if (session.available) {
      void this.transport.send('Page.setDownloadBehavior', {
        behavior: 'default',
        eventsEnabled: false,
      }, sessionId).catch(() => {});
    }
    for (const download of session.downloads.values()) {
      if (download.state === 'terminal') continue;
      download.state = 'terminal';
      void this.transport.send('Browser.cancelDownload', { guid: download.guid }).catch(() => {});
      this.publish(session, {
        downloadId: download.id,
        state: 'cancelled',
        reason,
        receivedBytes: download.receivedBytes,
        ...(download.totalBytes !== undefined ? { totalBytes: download.totalBytes } : {}),
      });
    }
    void rm(session.directory, { recursive: true, force: true }).catch(() => {});
  }

  releaseLease(leaseId: ControlLeaseId): void {
    for (const context of [...this.attachmentContexts.values()]) {
      if (context.leaseId === leaseId) this.detachSession(context.sessionId, 'lease_released');
    }
    for (const session of [...this.sessions.values()]) {
      if (session.context.leaseId === leaseId) this.detachSession(session.context.sessionId, 'lease_released');
    }
  }

  releaseWorkspace(workspaceId: BrowserWorkspaceId): void {
    for (const context of [...this.attachmentContexts.values()]) {
      if (context.workspaceId === workspaceId) this.detachSession(context.sessionId, 'workspace_released');
    }
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
      if (session.downloads.has(guid)) return;
      if (!this.hasDownloadCapacity(session)) {
        const downloadId = `download:${randomUUID()}`;
        void this.transport.send('Browser.cancelDownload', { guid }).catch(() => {});
        this.publish(session, {
          downloadId,
          state: 'failed',
          reason: 'concurrency_limit_exceeded',
        });
        return;
      }
      const download: DownloadRecord = {
        id: `download:${randomUUID()}`,
        guid,
        path: join(session.directory, guid),
        url: boundedString(params?.url, MAX_EVENT_URL_LENGTH),
        fileName: safeFileName(params?.suggestedFilename),
        receivedBytes: 0,
        state: 'active',
      };
      session.downloads.set(guid, download);
      this.publish(session, {
        downloadId: download.id,
        state: 'started',
        url: download.url,
        suggestedFileName: download.fileName,
      });
    });

    this.transport.on?.('Page.downloadProgress', (params: any, sessionId?: string) => {
      if (!sessionId) return;
      const session = this.sessions.get(sessionId);
      const guid = boundedString(params?.guid, 512);
      const download = session?.downloads.get(guid);
      if (!session || !download) return;
      const receivedBytes = finiteBytes(params?.receivedBytes);
      const totalBytes = finiteBytes(params?.totalBytes);
      if (receivedBytes !== undefined) download.receivedBytes = receivedBytes;
      if (totalBytes !== undefined) download.totalBytes = totalBytes;

      if (download.state === 'terminal') {
        if (params?.state === 'completed' || params?.state === 'canceled') {
          session.downloads.delete(download.guid);
          void unlink(download.path).catch(() => {});
        }
        return;
      }

      if (
        download.receivedBytes > this.maxDownloadBytes ||
        (download.totalBytes !== undefined && download.totalBytes > this.maxDownloadBytes)
      ) {
        this.failOversized(session, download);
        return;
      }
      if (this.exceedsStagingQuota(session)) {
        this.failDownload(session, download, 'staging_quota_exceeded', {
          maxWorkspaceBytes: this.artifacts.maxWorkspaceCapacityBytes,
          maxTotalBytes: this.artifacts.maxTotalCapacityBytes,
        });
        return;
      }
      if (params?.state === 'completed' && download.state === 'active') {
        download.state = 'finalizing';
        void this.finalize(session, download);
      } else if (params?.state === 'canceled') {
        download.state = 'terminal';
        this.publish(session, {
          downloadId: download.id,
          state: 'cancelled',
          reason: 'browser_cancelled',
          receivedBytes: download.receivedBytes,
          ...(download.totalBytes !== undefined ? { totalBytes: download.totalBytes } : {}),
        });
        void unlink(download.path).catch(() => {});
        session.downloads.delete(download.guid);
      }
    });
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
    limits: Record<string, JsonValue>,
  ): void {
    if (download.state === 'terminal') return;
    download.state = 'terminal';
    void this.transport.send('Browser.cancelDownload', { guid: download.guid }).catch(() => {});
    void unlink(download.path).catch(() => {});
    this.publish(session, {
      downloadId: download.id,
      state: 'failed',
      reason,
      receivedBytes: download.receivedBytes,
      ...(download.totalBytes !== undefined ? { totalBytes: download.totalBytes } : {}),
      ...limits,
    });
  }

  private async finalize(session: DownloadSession, download: DownloadRecord): Promise<void> {
    try {
      const linkInfo = await lstat(download.path);
      if (linkInfo.isSymbolicLink()) throw new Error('download_not_regular_file');
      const info = await stat(download.path);
      if (!info.isFile()) throw new Error('download_not_regular_file');
      if (info.size > this.maxDownloadBytes) {
        download.receivedBytes = info.size;
        this.failOversized(session, download);
        return;
      }
      const record = await this.artifacts.ingestDownload(
        session.context.workspaceId,
        download.path,
        download.fileName,
      );
      if (session.closed || download.state === 'terminal') {
        await this.artifacts.release(session.context.workspaceId, record.descriptor.id);
        return;
      }
      download.state = 'terminal';
      this.publish(session, {
        downloadId: download.id,
        state: 'completed',
        artifact: record.descriptor as unknown as JsonValue,
      });
      session.downloads.delete(download.guid);
    } catch (error) {
      if (download.state === 'terminal') return;
      download.state = 'terminal';
      await unlink(download.path).catch(() => {});
      this.publish(session, {
        downloadId: download.id,
        state: 'failed',
        reason: error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code.slice(0, 128)
          : 'artifact_ingest_failed',
        receivedBytes: download.receivedBytes,
        ...(download.totalBytes !== undefined ? { totalBytes: download.totalBytes } : {}),
      });
      session.downloads.delete(download.guid);
    }
  }

  private publish(session: DownloadSession, payload: Record<string, JsonValue>): void {
    if (!this.publishEvent) return;
    try {
      this.publishEvent({
        workspaceId: session.context.workspaceId,
        leaseId: session.context.leaseId,
        targetId: session.context.targetId,
        browserConnectionGeneration: session.context.browserConnectionGeneration,
        type: 'download',
        sensitivity: 'user_file',
        payload,
      });
    } catch { /* event delivery cannot block download cleanup */ }
  }

  private hasDownloadCapacity(session: DownloadSession): boolean {
    const active = (candidate: DownloadRecord): boolean => candidate.state !== 'terminal';
    const sessionCount = [...session.downloads.values()].filter(active).length;
    let workspaceCount = 0;
    let totalCount = 0;
    for (const candidate of this.sessions.values()) {
      for (const download of candidate.downloads.values()) {
        if (!active(download)) continue;
        totalCount += 1;
        if (candidate.context.workspaceId === session.context.workspaceId) workspaceCount += 1;
      }
    }
    return sessionCount < this.maxActivePerSession &&
      workspaceCount < this.maxActivePerWorkspace &&
      totalCount < this.maxActiveTotal;
  }

  private exceedsStagingQuota(currentSession: DownloadSession): boolean {
    let workspaceBytes = 0;
    let totalBytes = 0;
    for (const session of this.sessions.values()) {
      for (const download of session.downloads.values()) {
        if (download.state === 'terminal') continue;
        const bytes = Math.max(download.receivedBytes, download.totalBytes ?? 0);
        totalBytes += bytes;
        if (session.context.workspaceId === currentSession.context.workspaceId) workspaceBytes += bytes;
      }
    }
    return workspaceBytes > this.artifacts.maxWorkspaceCapacityBytes ||
      totalBytes > this.artifacts.maxTotalCapacityBytes;
  }

  private initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await chmod(this.directory, 0o700).catch(() => {});
        const entries = await readdir(this.directory, { withFileTypes: true });
        await Promise.all(entries.map(entry => (
          rm(join(this.directory, entry.name), { recursive: true, force: true }).catch(() => {})
        )));
      })();
    }
    return this.initializePromise;
  }
}
