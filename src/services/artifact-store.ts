import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  realpath,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ARTIFACT_DIR } from '../paths.js';
import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import type {
  ArtifactDescriptor,
  ArtifactId,
  BrowserWorkspaceId,
  Sensitivity,
} from '../protocol/model.js';

export interface ArtifactRecord {
  descriptor: ArtifactDescriptor;
  path: string;
}

export interface CreateArtifactInput {
  workspaceId: BrowserWorkspaceId;
  kind: ArtifactDescriptor['kind'];
  mimeType: string;
  bytes: Uint8Array;
  fileName?: string;
  width?: number;
  height?: number;
  sensitivity?: Sensitivity;
  previewOf?: ArtifactId;
}

export interface ArtifactStoreOptions {
  directory?: string;
  ttlMs?: number;
  retainedTtlMs?: number;
  maxArtifactBytes?: number;
  maxWorkspaceBytes?: number;
  maxTotalBytes?: number;
  expiredTombstoneTtlMs?: number;
  maxExpiredTombstones?: number;
  purgeOrphansOnInitialize?: boolean;
  now?: () => number;
  idFactory?: () => string;
}

interface ExpiredArtifact {
  workspaceId: BrowserWorkspaceId;
  expiredAt: number;
}

const ARTIFACT_ID_PATTERN = /^artifact:[A-Za-z0-9][A-Za-z0-9._:-]{0,118}$/;

function clone(record: ArtifactRecord): ArtifactRecord {
  return { descriptor: { ...record.descriptor }, path: record.path };
}

function inferredMimeType(path: string): string {
  const known: Record<string, string> = {
    '.csv': 'text/csv',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.txt': 'text/plain',
    '.webp': 'image/webp',
    '.xml': 'application/xml',
    '.zip': 'application/zip',
  };
  return known[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export class ArtifactStore {
  private readonly records = new Map<ArtifactId, ArtifactRecord>();
  private readonly expired = new Map<ArtifactId, ExpiredArtifact>();
  private readonly directory: string;
  private readonly ttlMs: number;
  private readonly retainedTtlMs: number;
  private readonly maxArtifactBytes: number;
  private readonly maxWorkspaceBytes: number;
  private readonly maxTotalBytes: number;
  private readonly expiredTombstoneTtlMs: number;
  private readonly maxExpiredTombstones: number;
  private readonly purgeOrphansOnInitialize: boolean;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private initialized = false;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: ArtifactStoreOptions = {}) {
    this.directory = resolve(options.directory ?? ARTIFACT_DIR);
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.retainedTtlMs = options.retainedTtlMs ?? 24 * 60 * 60_000;
    this.maxArtifactBytes = options.maxArtifactBytes ?? 100 * 1024 * 1024;
    this.maxWorkspaceBytes = options.maxWorkspaceBytes ?? 250 * 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 1024 * 1024 * 1024;
    this.expiredTombstoneTtlMs = options.expiredTombstoneTtlMs ?? 60 * 60_000;
    this.maxExpiredTombstones = options.maxExpiredTombstones ?? 4096;
    this.purgeOrphansOnInitialize = options.purgeOrphansOnInitialize ?? true;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => `artifact:${randomUUID()}`);
    for (const value of [
      this.ttlMs,
      this.retainedTtlMs,
      this.maxArtifactBytes,
      this.maxWorkspaceBytes,
      this.maxTotalBytes,
      this.expiredTombstoneTtlMs,
      this.maxExpiredTombstones,
    ]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid Artifact Store limit');
    }
    if (this.maxWorkspaceBytes > this.maxTotalBytes || this.maxArtifactBytes > this.maxWorkspaceBytes) {
      throw new Error('Artifact Store limits are inconsistent');
    }
  }

  async create(input: CreateArtifactInput): Promise<ArtifactRecord> {
    return this.withLock(() => this.createUnlocked(input));
  }

  async importFile(
    workspaceId: BrowserWorkspaceId,
    sourcePath: string,
    mimeType?: string,
  ): Promise<ArtifactRecord> {
    if (!isAbsolute(sourcePath)) throw invalidArgument('Artifact import path must be absolute', 'path');
    const source = resolve(sourcePath);
    if (this.isInsideStore(source)) {
      throw invalidArgument('Artifact import path must be outside Broker storage', 'path');
    }
    return this.withLock(async () => {
      await this.sweepUnlocked();
      await this.ensureDirectory();
      const canonicalStore = await realpath(this.directory);
      let canonicalSource: string;
      try {
        canonicalSource = await realpath(source);
      } catch (cause) {
        throw new BrowserPilotError('invalid_argument', 'Artifact import file is not accessible', {
          context: { field: 'path' },
          rpcCode: -32602,
          cause,
        });
      }
      if (this.isWithin(canonicalStore, canonicalSource)) {
        throw invalidArgument('Artifact import path must be outside Broker storage', 'path');
      }
      let sourceInfo;
      try {
        sourceInfo = await stat(canonicalSource);
      } catch (cause) {
        throw new BrowserPilotError('invalid_argument', 'Artifact import file is not accessible', {
          context: { field: 'path' },
          rpcCode: -32602,
          cause,
        });
      }
      if (!sourceInfo.isFile()) throw invalidArgument('Artifact import path must identify a regular file', 'path');
      this.assertQuota(workspaceId, sourceInfo.size);
      const fileName = basename(source);
      if (!fileName || fileName.length > 4096) {
        throw invalidArgument('Artifact import filename is invalid or too long', 'path');
      }
      const resolvedMimeType = mimeType ?? inferredMimeType(source);
      if (!resolvedMimeType || resolvedMimeType.length > 256 || /[\r\n]/.test(resolvedMimeType)) {
        throw invalidArgument('Artifact MIME type is invalid or too long', 'mimeType');
      }

      const id = this.nextArtifactId();
      const storageDirectory = join(this.directory, randomUUID());
      const destination = join(storageDirectory, fileName);
      await mkdir(storageDirectory, { mode: 0o700 });
      try {
        await copyFile(canonicalSource, destination, fsConstants.COPYFILE_EXCL);
        await chmod(destination, 0o600).catch(() => {});
        const copied = await stat(destination);
        if (!copied.isFile() || copied.size !== sourceInfo.size) {
          throw new BrowserPilotError('invalid_argument', 'Artifact import file changed while it was being copied', {
            context: { field: 'path' },
            rpcCode: -32602,
          });
        }
        const createdAt = this.now();
        const descriptor: ArtifactDescriptor = {
          id,
          workspaceId,
          kind: 'upload_input',
          mimeType: resolvedMimeType,
          byteSize: copied.size,
          fileName,
          sensitivity: 'user_file',
          createdAt,
          expiresAt: createdAt + this.ttlMs,
          retained: false,
        };
        const record = { descriptor, path: destination };
        this.records.set(id, record);
        return clone(record);
      } catch (error) {
        await rm(storageDirectory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    });
  }

  async initialize(): Promise<void> {
    await this.withLock(() => this.ensureDirectory());
  }

  async get(workspaceId: BrowserWorkspaceId, artifactId: ArtifactId): Promise<ArtifactRecord> {
    return this.withLock(async () => clone(await this.requireRecordUnlocked(workspaceId, artifactId)));
  }

  async export(
    workspaceId: BrowserWorkspaceId,
    artifactId: ArtifactId,
    destination: string,
    overwrite = false,
  ): Promise<{ artifact: ArtifactDescriptor; path: string }> {
    if (!isAbsolute(destination)) throw invalidArgument('Artifact export path must be absolute', 'path');
    const target = resolve(destination);
    if (this.isInsideStore(target)) {
      throw invalidArgument('Artifact export path must be outside Broker storage', 'path');
    }
    return this.withLock(async () => {
      const record = await this.requireRecordUnlocked(workspaceId, artifactId);
      let canonicalParent: string;
      try {
        canonicalParent = await realpath(dirname(target));
      } catch (cause) {
        throw new BrowserPilotError('invalid_argument', 'Artifact export directory is not accessible', {
          context: { field: 'path' },
          rpcCode: -32602,
          cause,
        });
      }
      const canonicalStore = await realpath(this.directory);
      if (this.isWithin(canonicalStore, join(canonicalParent, basename(target)))) {
        throw invalidArgument('Artifact export path must be outside Broker storage', 'path');
      }
      if (overwrite) {
        const existing = await lstat(target).catch(() => undefined);
        if (existing?.isSymbolicLink()) {
          throw invalidArgument('Artifact export does not follow symbolic links', 'path');
        }
      }
      await copyFile(
        record.path,
        target,
        overwrite ? 0 : fsConstants.COPYFILE_EXCL,
      ).catch(cause => {
        throw new BrowserPilotError('invalid_argument', `Cannot export Artifact to ${target}`, {
          context: { field: 'path' },
          rpcCode: -32602,
          cause,
        });
      });
      await chmod(target, 0o600).catch(() => {});
      return { artifact: { ...record.descriptor }, path: target };
    });
  }

  async retain(workspaceId: BrowserWorkspaceId, artifactId: ArtifactId): Promise<ArtifactRecord> {
    return this.withLock(async () => {
      await this.requireRecordUnlocked(workspaceId, artifactId);
      const stored = this.records.get(artifactId)!;
      stored.descriptor.retained = true;
      stored.descriptor.expiresAt = this.now() + this.retainedTtlMs;
      return clone(stored);
    });
  }

  async release(workspaceId: BrowserWorkspaceId, artifactId: ArtifactId): Promise<void> {
    await this.withLock(async () => {
      const record = this.records.get(artifactId);
      if (!record || record.descriptor.workspaceId !== workspaceId) return;
      this.records.delete(artifactId);
      this.expired.delete(artifactId);
      await this.removeStoredFile(record.path);
    });
  }

  async releaseWorkspace(workspaceId: BrowserWorkspaceId): Promise<void> {
    await this.withLock(async () => {
      const records = [...this.records.values()].filter(record => (
        record.descriptor.workspaceId === workspaceId
      ));
      for (const record of records) this.records.delete(record.descriptor.id);
      for (const [artifactId, tombstone] of this.expired) {
        if (tombstone.workspaceId === workspaceId) this.expired.delete(artifactId);
      }
      await Promise.all(records.map(record => this.removeStoredFile(record.path)));
    });
  }

  async sweep(): Promise<number> {
    return this.withLock(() => this.sweepUnlocked());
  }

  async clear(): Promise<void> {
    await this.withLock(async () => {
      const records = [...this.records.values()];
      this.records.clear();
      this.expired.clear();
      await Promise.all(records.map(record => this.removeStoredFile(record.path)));
    });
  }

  size(): number {
    return this.records.size;
  }

  private async createUnlocked(input: CreateArtifactInput): Promise<ArtifactRecord> {
    await this.sweepUnlocked();
    const byteSize = input.bytes.byteLength;
    this.assertQuota(input.workspaceId, byteSize);

    await this.ensureDirectory();
    const id = this.nextArtifactId();
    const file = join(this.directory, `${randomUUID()}.bin`);
    const createdAt = this.now();
    await writeFile(file, input.bytes, { mode: 0o600, flag: 'wx' });
    await chmod(file, 0o600).catch(() => {});
    const descriptor: ArtifactDescriptor = {
      id,
      workspaceId: input.workspaceId,
      kind: input.kind,
      mimeType: input.mimeType,
      byteSize,
      ...(input.fileName !== undefined ? { fileName: input.fileName } : {}),
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
      sensitivity: input.sensitivity ?? 'browser_data',
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      retained: false,
      ...(input.previewOf ? { previewOf: input.previewOf } : {}),
    };
    const record = { descriptor, path: file };
    this.records.set(id, record);
    return clone(record);
  }

  private async requireRecordUnlocked(
    workspaceId: BrowserWorkspaceId,
    artifactId: ArtifactId,
  ): Promise<ArtifactRecord> {
    await this.sweepUnlocked();
    const record = this.records.get(artifactId);
    if (!record || record.descriptor.workspaceId !== workspaceId) {
      const tombstone = this.expired.get(artifactId);
      if (tombstone?.workspaceId === workspaceId) throw this.artifactExpired(artifactId);
      throw this.notFound(artifactId);
    }
    try {
      const info = await stat(record.path);
      if (!info.isFile() || info.size !== record.descriptor.byteSize) throw new Error('Artifact file mismatch');
    } catch {
      this.records.delete(artifactId);
      throw this.notFound(artifactId);
    }
    return record;
  }

  private async sweepUnlocked(): Promise<number> {
    const now = this.now();
    const expiredRecords = [...this.records.values()].filter(record => record.descriptor.expiresAt <= now);
    for (const record of expiredRecords) {
      this.records.delete(record.descriptor.id);
      this.expired.set(record.descriptor.id, {
        workspaceId: record.descriptor.workspaceId,
        expiredAt: now,
      });
    }
    this.pruneExpiredTombstones(now);
    await Promise.all(expiredRecords.map(record => this.removeStoredFile(record.path)));
    return expiredRecords.length;
  }

  private async ensureDirectory(): Promise<void> {
    if (!this.initialized) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (this.purgeOrphansOnInitialize) {
        const entries = await readdir(this.directory, { withFileTypes: true });
        await Promise.all(entries
          .filter(entry => (entry.isFile() && entry.name.endsWith('.bin')) || entry.isDirectory())
          .map(entry => rm(join(this.directory, entry.name), { recursive: true, force: true }).catch(() => {})));
      }
      this.initialized = true;
    }
    await chmod(this.directory, 0o700).catch(() => {});
  }

  private notFound(artifactId: ArtifactId): BrowserPilotError {
    return new BrowserPilotError('artifact_not_found', 'Artifact was not found for this Workspace', {
      context: { artifactId },
    });
  }

  private artifactExpired(artifactId: ArtifactId): BrowserPilotError {
    return new BrowserPilotError('artifact_expired', 'Artifact has expired', {
      context: { artifactId },
    });
  }

  private isInsideStore(path: string): boolean {
    const child = relative(this.directory, path);
    return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
  }

  private isWithin(parent: string, path: string): boolean {
    const child = relative(parent, path);
    return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
  }

  private nextArtifactId(): ArtifactId {
    const id = this.idFactory() as ArtifactId;
    if (!ARTIFACT_ID_PATTERN.test(id) || this.records.has(id) || this.expired.has(id)) {
      throw new BrowserPilotError('internal_error', 'Invalid or duplicate Artifact ID');
    }
    return id;
  }

  private assertQuota(workspaceId: BrowserWorkspaceId, byteSize: number): void {
    if (!Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > this.maxArtifactBytes) {
      throw new BrowserPilotError('result_too_large', 'Artifact exceeds the per-item size limit', {
        context: { maxArtifactBytes: this.maxArtifactBytes, byteSize },
      });
    }
    const workspaceBytes = [...this.records.values()]
      .filter(record => record.descriptor.workspaceId === workspaceId)
      .reduce((sum, record) => sum + record.descriptor.byteSize, 0);
    const totalBytes = [...this.records.values()]
      .reduce((sum, record) => sum + record.descriptor.byteSize, 0);
    if (workspaceBytes + byteSize > this.maxWorkspaceBytes || totalBytes + byteSize > this.maxTotalBytes) {
      throw new BrowserPilotError('result_too_large', 'Artifact Store quota exceeded', {
        context: {
          workspaceId,
          maxWorkspaceBytes: this.maxWorkspaceBytes,
          maxTotalBytes: this.maxTotalBytes,
        },
      });
    }
  }

  private async removeStoredFile(path: string): Promise<void> {
    await unlink(path).catch(() => {});
    const parent = dirname(path);
    if (parent !== this.directory && this.isInsideStore(parent)) {
      await rm(parent, { recursive: true, force: true }).catch(() => {});
    }
  }

  private pruneExpiredTombstones(now: number): void {
    for (const [artifactId, tombstone] of this.expired) {
      if (tombstone.expiredAt + this.expiredTombstoneTtlMs <= now) this.expired.delete(artifactId);
    }
    while (this.expired.size > this.maxExpiredTombstones) {
      const oldest = this.expired.keys().next().value as ArtifactId | undefined;
      if (!oldest) break;
      this.expired.delete(oldest);
    }
  }

  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => {}, () => {});
    return result;
  }
}
