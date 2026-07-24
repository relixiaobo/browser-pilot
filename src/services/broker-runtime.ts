import { randomUUID } from 'node:crypto';
import {
  BrowserPilotError,
  invalidArgument,
} from '../protocol/errors.js';
import {
  CAPABILITIES,
  DEFAULT_CAPABILITIES,
  type BrowserCandidate,
  type BrowserInstance,
  type BrowserWorkspace,
  type BrowserWorkspaceId,
  type Capability,
  type ClientConnection,
  type ClientConnectionId,
  type ClientIdentity,
  type ClientPrincipal,
  type ClientPrincipalId,
  type ControlLease,
  type ControlLeaseId,
  type InitializeResult,
  type JsonValue,
  type ManagedTabSet,
  type ManagedTabSetId,
  type ProtocolLimits,
} from '../protocol/model.js';
import { getToolManifest } from '../protocol/tools.js';
import {
  negotiateCapabilities,
  negotiateProtocol,
  validateInitializeParams,
  validateLeaseCreateParams,
  validateLeaseHeartbeatParams,
  validateLeaseReleaseParams,
  validateShutdownParams,
  validateToolsListParams,
  validateWorkspaceCreateParams,
  validateWorkspaceGetParams,
  validateWorkspaceReleaseParams,
} from '../protocol/validation.js';

export const DEFAULT_PROTOCOL_LIMITS: Readonly<ProtocolLimits> = {
  maxMessageBytes: 1024 * 1024,
  maxResultBytes: 4 * 1024 * 1024,
  maxArtifactBytes: 100 * 1024 * 1024,
  eventJournalSize: 1000,
};

export interface BrokerBrowserBinding {
  candidate: BrowserCandidate;
  instance: BrowserInstance;
}

export interface BrokerRuntimeOptions {
  serviceVersion: string;
  executableVersion?: string;
  brokerProcessIdentity: string;
  browsers: readonly BrokerBrowserBinding[];
  allowedCapabilities?: readonly Capability[];
  limits?: Partial<ProtocolLimits>;
  defaultLeaseTtlMs?: number;
  minLeaseTtlMs?: number;
  maxLeaseTtlMs?: number;
  maxWorkspacesPerPrincipal?: number;
  maxLeasesPerConnection?: number;
  maxConnections?: number;
  maxWorkspaceRecords?: number;
  maxLeaseRecords?: number;
  connectionIdleTtlMs?: number;
  workspaceIdleTtlMs?: number;
  now?: () => number;
  idFactory?: (kind: 'principal' | 'connection' | 'workspace' | 'tabset' | 'lease') => string;
  onLeaseReleased?: (lease: ControlLease) => void;
  onWorkspaceReleased?: (workspace: BrowserWorkspace, managedTabSet: ManagedTabSet) => void;
}

interface RuntimeConnection {
  value: ClientConnection;
  bridgeSessionId: string;
  grantedCapabilities: Capability[];
}

interface RuntimeWorkspace {
  value: BrowserWorkspace;
  managedTabSet: ManagedTabSet;
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function cloneWorkspace(value: BrowserWorkspace): BrowserWorkspace {
  return { ...value };
}

function cloneManagedTabSet(value: ManagedTabSet): ManagedTabSet {
  return { ...value };
}

function cloneLease(value: ControlLease): ControlLease {
  return { ...value, capabilities: [...value.capabilities] };
}

function principalKey(client: ClientIdentity): string {
  return `${client.id}\u0000${client.instanceId}`;
}

export class MemoryBrokerRuntime {
  readonly limits: ProtocolLimits;

  private readonly principals = new Map<ClientPrincipalId, ClientPrincipal>();
  private readonly principalIdsByKey = new Map<string, ClientPrincipalId>();
  private readonly connectionsByBridge = new Map<string, RuntimeConnection>();
  private readonly connectionsById = new Map<ClientConnectionId, RuntimeConnection>();
  private readonly workspaces = new Map<BrowserWorkspaceId, RuntimeWorkspace>();
  private readonly leases = new Map<ControlLeaseId, ControlLease>();
  private readonly browserBindings: BrokerBrowserBinding[];
  private readonly allowedCapabilities: Capability[];
  private readonly now: () => number;
  private readonly idFactory: NonNullable<BrokerRuntimeOptions['idFactory']>;
  private readonly defaultLeaseTtlMs: number;
  private readonly minLeaseTtlMs: number;
  private readonly maxLeaseTtlMs: number;
  private readonly maxWorkspacesPerPrincipal: number;
  private readonly maxLeasesPerConnection: number;
  private readonly maxConnections: number;
  private readonly maxWorkspaceRecords: number;
  private readonly maxLeaseRecords: number;
  private readonly connectionIdleTtlMs: number;
  private readonly workspaceIdleTtlMs: number;
  private readonly managedTabSetIds = new Set<ManagedTabSetId>();

  constructor(private readonly options: BrokerRuntimeOptions) {
    this.browserBindings = options.browsers.map(binding => ({
      candidate: { ...binding.candidate },
      instance: { ...binding.instance },
    }));
    this.allowedCapabilities = [...(options.allowedCapabilities ?? DEFAULT_CAPABILITIES)];
    this.limits = { ...DEFAULT_PROTOCOL_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (kind => `${kind}:${randomUUID()}`);
    this.defaultLeaseTtlMs = options.defaultLeaseTtlMs ?? 30_000;
    this.minLeaseTtlMs = options.minLeaseTtlMs ?? 1_000;
    this.maxLeaseTtlMs = options.maxLeaseTtlMs ?? 5 * 60_000;
    this.maxWorkspacesPerPrincipal = options.maxWorkspacesPerPrincipal ?? 64;
    this.maxLeasesPerConnection = options.maxLeasesPerConnection ?? 32;
    this.maxConnections = options.maxConnections ?? 1024;
    this.maxWorkspaceRecords = options.maxWorkspaceRecords ?? 4096;
    this.maxLeaseRecords = options.maxLeaseRecords ?? 8192;
    this.connectionIdleTtlMs = options.connectionIdleTtlMs ?? 10 * 60_000;
    this.workspaceIdleTtlMs = options.workspaceIdleTtlMs ?? 24 * 60 * 60_000;
    if (
      this.minLeaseTtlMs <= 0 ||
      this.defaultLeaseTtlMs < this.minLeaseTtlMs ||
      this.maxLeaseTtlMs < this.defaultLeaseTtlMs
    ) {
      throw new Error('Invalid Broker Lease TTL configuration');
    }
    if (this.browserBindings.length === 0) throw new Error('Broker requires at least one browser binding');
    if (this.allowedCapabilities.some(capability => !(CAPABILITIES as readonly string[]).includes(capability))) {
      throw new Error('Broker allowedCapabilities contains an unknown capability');
    }
    if (Object.values(this.limits).some(limit => !Number.isSafeInteger(limit) || limit <= 0)) {
      throw new Error('Invalid Broker protocol limits');
    }
    const positiveIntegerOptions = [
      this.maxWorkspacesPerPrincipal,
      this.maxLeasesPerConnection,
      this.maxConnections,
      this.maxWorkspaceRecords,
      this.maxLeaseRecords,
      this.connectionIdleTtlMs,
      this.workspaceIdleTtlMs,
    ];
    if (positiveIntegerOptions.some(value => !Number.isSafeInteger(value) || value <= 0)) {
      throw new Error('Invalid Broker capacity or idle timeout configuration');
    }
    const browserIds = new Set<string>();
    for (const binding of this.browserBindings) {
      if (browserIds.has(binding.candidate.id)) throw new Error('Duplicate Broker browser candidate ID');
      browserIds.add(binding.candidate.id);
    }
  }

  async call(bridgeSessionId: string, method: string, params?: JsonValue): Promise<JsonValue> {
    this.assertBridgeSessionId(bridgeSessionId);
    this.sweepExpiredLeases();
    if (method === 'initialize') return this.initialize(bridgeSessionId, params);

    const connection = this.requireConnection(bridgeSessionId);
    connection.value.lastSeenAt = this.now();
    switch (method) {
      case 'tools/list':
        validateToolsListParams(params);
        return asJson(getToolManifest(connection.grantedCapabilities));
      case 'workspaces/create':
        return this.createWorkspace(connection, params);
      case 'workspaces/get':
        return this.getWorkspace(connection, params);
      case 'workspaces/release':
        return this.releaseWorkspace(connection, params);
      case 'leases/create':
        return this.createLease(connection, params);
      case 'leases/heartbeat':
        return this.heartbeatLease(connection, params);
      case 'leases/release':
        return this.releaseLease(connection, params);
      case 'shutdown':
        validateShutdownParams(params);
        return { ok: true };
      default:
        throw new BrowserPilotError('invalid_argument', `Method not found: ${method}`, {
          context: { method },
          rpcCode: -32601,
        });
    }
  }

  disconnect(bridgeSessionId: string): void {
    const connection = this.connectionsByBridge.get(bridgeSessionId);
    if (!connection) return;
    this.connectionsByBridge.delete(bridgeSessionId);
    this.connectionsById.delete(connection.value.id);
    for (const [leaseId, lease] of this.leases) {
      if (lease.connectionId !== connection.value.id) continue;
      if (lease.state === 'active') this.releaseLeaseRecord(lease, 'released');
      this.leases.delete(leaseId);
    }
    this.cleanupUnusedPrincipal(connection.value.principalId);
  }

  close(): void {
    for (const bridgeSessionId of [...this.connectionsByBridge.keys()]) {
      this.disconnect(bridgeSessionId);
    }
  }

  sweepExpiredLeases(): number {
    const now = this.now();
    let expired = 0;
    for (const lease of this.leases.values()) {
      if (lease.state === 'active' && lease.expiresAt <= now) {
        this.releaseLeaseRecord(lease, 'expired');
        expired += 1;
      }
    }
    for (const connection of [...this.connectionsByBridge.values()]) {
      if (connection.value.lastSeenAt + this.connectionIdleTtlMs <= now) {
        this.disconnect(connection.bridgeSessionId);
      }
    }
    const leasedWorkspaceIds = new Set<BrowserWorkspaceId>();
    for (const lease of this.leases.values()) {
      if (lease.state === 'active') leasedWorkspaceIds.add(lease.workspaceId);
    }
    for (const record of this.workspaces.values()) {
      if (
        record.value.state === 'active' &&
        record.value.updatedAt + this.workspaceIdleTtlMs <= now &&
        !leasedWorkspaceIds.has(record.value.id)
      ) {
        this.releaseWorkspaceRecord(record);
      }
    }
    return expired;
  }

  stats(): { principals: number; connections: number; activeWorkspaces: number; activeLeases: number } {
    return {
      principals: this.principals.size,
      connections: this.connectionsByBridge.size,
      activeWorkspaces: [...this.workspaces.values()].filter(record => record.value.state === 'active').length,
      activeLeases: [...this.leases.values()].filter(lease => lease.state === 'active').length,
    };
  }

  private initialize(bridgeSessionId: string, value: unknown): JsonValue {
    if (this.connectionsByBridge.has(bridgeSessionId)) {
      throw invalidArgument('This bridge connection is already initialized', 'method');
    }
    const params = validateInitializeParams(value);
    if (this.connectionsByBridge.size >= this.maxConnections) {
      throw new BrowserPilotError('result_too_large', 'Broker connection limit reached', {
        context: { maxConnections: this.maxConnections },
      });
    }
    const protocol = negotiateProtocol(params.protocol);
    const capabilities = negotiateCapabilities(params.requestedCapabilities, this.allowedCapabilities);
    const principal = this.getOrCreatePrincipal(params.client);
    const now = this.now();
    const connectionId = this.nextId('connection', this.connectionsById) as ClientConnectionId;
    const connectionValue: ClientConnection = {
      id: connectionId,
      principalId: principal.id,
      clientInstanceId: params.client.instanceId,
      protocol,
      connectedAt: now,
      lastSeenAt: now,
    };
    const initializeResult: InitializeResult = {
      serviceVersion: this.options.serviceVersion,
      executableVersion: this.options.executableVersion ?? this.options.serviceVersion,
      protocol,
      supportedCapabilities: [...CAPABILITIES],
      capabilities,
      brokerProcessIdentity: this.options.brokerProcessIdentity,
      connectionId,
      browsers: this.browserBindings.map(binding => ({ ...binding.candidate })),
      limits: { ...this.limits },
    };
    const connection: RuntimeConnection = {
      value: connectionValue,
      bridgeSessionId,
      grantedCapabilities: [...capabilities.granted],
    };
    this.connectionsByBridge.set(bridgeSessionId, connection);
    this.connectionsById.set(connectionId, connection);
    return asJson(initializeResult);
  }

  private createWorkspace(connection: RuntimeConnection, value: unknown): JsonValue {
    const params = validateWorkspaceCreateParams(value);
    const principalId = connection.value.principalId;
    const activeCount = [...this.workspaces.values()].filter(record => (
      record.value.principalId === principalId && record.value.state === 'active'
    )).length;
    if (activeCount >= this.maxWorkspacesPerPrincipal) {
      throw new BrowserPilotError('result_too_large', 'Workspace limit reached', {
        context: { maxWorkspacesPerPrincipal: this.maxWorkspacesPerPrincipal },
      });
    }
    this.pruneReleasedWorkspaces();
    if (this.workspaces.size >= this.maxWorkspaceRecords) {
      throw new BrowserPilotError('result_too_large', 'Broker Workspace record limit reached', {
        context: { maxWorkspaceRecords: this.maxWorkspaceRecords },
      });
    }

    const binding = params.browserId
      ? this.browserBindings.find(candidate => candidate.candidate.id === params.browserId)
      : this.browserBindings.find(candidate => candidate.candidate.state === 'ready');
    if (!binding || binding.candidate.state !== 'ready') {
      throw new BrowserPilotError('browser_not_found', 'Selected browser is not ready', {
        context: params.browserId ? { browserId: params.browserId } : undefined,
        remediation: {
          code: 'enable_remote_debugging',
          message: 'Start a supported browser and enable remote debugging.',
          actionRequired: true,
        },
      });
    }

    const now = this.now();
    const workspaceId = this.nextId('workspace', this.workspaces) as BrowserWorkspaceId;
    const managedTabSetId = this.nextManagedTabSetId();
    const workspace: BrowserWorkspace = {
      id: workspaceId,
      principalId,
      browserInstanceId: binding.instance.id,
      createdAt: now,
      updatedAt: now,
      state: 'active',
    };
    const managedTabSet: ManagedTabSet = {
      id: managedTabSetId,
      workspaceId,
      browserInstanceId: binding.instance.id,
      createdAt: now,
      state: 'active',
    };
    this.workspaces.set(workspaceId, { value: workspace, managedTabSet });
    return asJson({ workspace: cloneWorkspace(workspace), managedTabSet: cloneManagedTabSet(managedTabSet) });
  }

  private getWorkspace(connection: RuntimeConnection, value: unknown): JsonValue {
    const params = validateWorkspaceGetParams(value);
    const record = this.requireWorkspace(connection, params.workspaceId, true);
    return asJson({
      workspace: cloneWorkspace(record.value),
      managedTabSet: cloneManagedTabSet(record.managedTabSet),
    });
  }

  private releaseWorkspace(connection: RuntimeConnection, value: unknown): JsonValue {
    const params = validateWorkspaceReleaseParams(value);
    const record = this.requireWorkspace(connection, params.workspaceId, true);
    if (record.value.state !== 'released') this.releaseWorkspaceRecord(record);
    return asJson({ workspaceId: params.workspaceId, released: true });
  }

  private createLease(connection: RuntimeConnection, value: unknown): JsonValue {
    const params = validateLeaseCreateParams(value);
    this.requireWorkspace(connection, params.workspaceId, false);
    const activeCount = [...this.leases.values()].filter(lease => (
      lease.connectionId === connection.value.id && lease.state === 'active'
    )).length;
    if (activeCount >= this.maxLeasesPerConnection) {
      throw new BrowserPilotError('result_too_large', 'Lease limit reached', {
        context: { maxLeasesPerConnection: this.maxLeasesPerConnection },
      });
    }
    this.pruneTerminalLeases();
    if (this.leases.size >= this.maxLeaseRecords) {
      throw new BrowserPilotError('result_too_large', 'Broker Lease record limit reached', {
        context: { maxLeaseRecords: this.maxLeaseRecords },
      });
    }
    const ttlMs = this.validateLeaseTtl(params.ttlMs);
    const now = this.now();
    const leaseId = this.nextId('lease', this.leases) as ControlLeaseId;
    const lease: ControlLease = {
      id: leaseId,
      workspaceId: params.workspaceId,
      connectionId: connection.value.id,
      capabilities: [...connection.grantedCapabilities],
      createdAt: now,
      lastHeartbeatAt: now,
      expiresAt: now + ttlMs,
      state: 'active',
    };
    this.leases.set(leaseId, lease);
    this.workspaces.get(params.workspaceId)!.value.updatedAt = now;
    return asJson({ lease: cloneLease(lease) });
  }

  private heartbeatLease(connection: RuntimeConnection, value: unknown): JsonValue {
    const params = validateLeaseHeartbeatParams(value);
    const lease = this.requireLease(connection, params.leaseId, true);
    const now = this.now();
    if (lease.expiresAt <= now) {
      this.releaseLeaseRecord(lease, 'expired');
      throw this.leaseExpired(params.leaseId);
    }
    const ttlMs = this.validateLeaseTtl(params.ttlMs);
    lease.lastHeartbeatAt = now;
    lease.expiresAt = now + ttlMs;
    const workspace = this.workspaces.get(lease.workspaceId);
    if (workspace) workspace.value.updatedAt = now;
    return asJson({ lease: cloneLease(lease) });
  }

  private releaseLease(connection: RuntimeConnection, value: unknown): JsonValue {
    const params = validateLeaseReleaseParams(value);
    const lease = this.requireLease(connection, params.leaseId, false);
    if (lease.state === 'active') this.releaseLeaseRecord(lease, 'released');
    return asJson({ leaseId: params.leaseId, released: true });
  }

  private getOrCreatePrincipal(client: ClientIdentity): ClientPrincipal {
    const key = principalKey(client);
    const existingId = this.principalIdsByKey.get(key);
    if (existingId) return this.principals.get(existingId)!;
    const id = this.nextId('principal', this.principals) as ClientPrincipalId;
    const principal: ClientPrincipal = {
      id,
      productId: client.id,
      displayName: client.name,
      createdAt: this.now(),
      capabilities: [...this.allowedCapabilities],
    };
    this.principalIdsByKey.set(key, id);
    this.principals.set(id, principal);
    return principal;
  }

  private requireConnection(bridgeSessionId: string): RuntimeConnection {
    const connection = this.connectionsByBridge.get(bridgeSessionId);
    if (connection) return connection;
    throw new BrowserPilotError('not_initialized', 'Bridge connection is not initialized', {
      rpcCode: -32002,
    });
  }

  private requireWorkspace(
    connection: RuntimeConnection,
    workspaceId: BrowserWorkspaceId,
    allowReleased: boolean,
  ): RuntimeWorkspace {
    const record = this.workspaces.get(workspaceId);
    if (
      !record ||
      record.value.principalId !== connection.value.principalId ||
      (!allowReleased && record.value.state !== 'active')
    ) {
      throw new BrowserPilotError('workspace_not_found', 'Workspace was not found for this ClientPrincipal', {
        context: { workspaceId },
      });
    }
    return record;
  }

  private requireLease(
    connection: RuntimeConnection,
    leaseId: ControlLeaseId,
    requireActive: boolean,
  ): ControlLease {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.connectionId !== connection.value.id || (requireActive && lease.state !== 'active')) {
      throw this.leaseExpired(leaseId);
    }
    return lease;
  }

  private leaseExpired(leaseId: ControlLeaseId): BrowserPilotError {
    return new BrowserPilotError('lease_expired', 'Lease is unavailable or expired', {
      context: { leaseId },
    });
  }

  private releaseLeaseRecord(lease: ControlLease, state: 'released' | 'expired'): void {
    if (lease.state !== 'active') return;
    lease.state = state;
    this.options.onLeaseReleased?.(cloneLease(lease));
  }

  private releaseWorkspaceRecord(record: RuntimeWorkspace): void {
    record.value.state = 'releasing';
    for (const lease of this.leases.values()) {
      if (lease.workspaceId === record.value.id && lease.state === 'active') {
        this.releaseLeaseRecord(lease, 'released');
      }
    }
    record.managedTabSet.state = 'closed';
    record.value.updatedAt = this.now();
    record.value.state = 'released';
    this.options.onWorkspaceReleased?.(
      cloneWorkspace(record.value),
      cloneManagedTabSet(record.managedTabSet),
    );
  }

  private pruneReleasedWorkspaces(): void {
    if (this.workspaces.size < this.maxWorkspaceRecords) return;
    const released = [...this.workspaces.values()]
      .filter(record => record.value.state === 'released')
      .sort((left, right) => left.value.updatedAt - right.value.updatedAt);
    for (const record of released) {
      this.workspaces.delete(record.value.id);
      this.managedTabSetIds.delete(record.managedTabSet.id);
      for (const [leaseId, lease] of this.leases) {
        if (lease.workspaceId === record.value.id) this.leases.delete(leaseId);
      }
      this.cleanupUnusedPrincipal(record.value.principalId);
      if (this.workspaces.size < this.maxWorkspaceRecords) return;
    }
  }

  private pruneTerminalLeases(): void {
    if (this.leases.size < this.maxLeaseRecords) return;
    const terminal = [...this.leases.values()]
      .filter(lease => lease.state !== 'active')
      .sort((left, right) => left.expiresAt - right.expiresAt);
    for (const lease of terminal) {
      this.leases.delete(lease.id);
      if (this.leases.size < this.maxLeaseRecords) return;
    }
  }

  private cleanupUnusedPrincipal(principalId: ClientPrincipalId): void {
    const hasConnection = [...this.connectionsByBridge.values()].some(connection => (
      connection.value.principalId === principalId
    ));
    const hasWorkspace = [...this.workspaces.values()].some(record => (
      record.value.principalId === principalId
    ));
    if (hasConnection || hasWorkspace) return;
    const principal = this.principals.get(principalId);
    if (!principal) return;
    this.principals.delete(principalId);
    for (const [key, id] of this.principalIdsByKey) {
      if (id === principalId) this.principalIdsByKey.delete(key);
    }
  }

  private validateLeaseTtl(value: number | undefined): number {
    const ttlMs = value ?? this.defaultLeaseTtlMs;
    if (ttlMs < this.minLeaseTtlMs || ttlMs > this.maxLeaseTtlMs) {
      throw invalidArgument(
        `ttlMs must be between ${this.minLeaseTtlMs} and ${this.maxLeaseTtlMs}`,
        'ttlMs',
      );
    }
    return ttlMs;
  }

  private assertBridgeSessionId(value: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value)) {
      throw invalidArgument('Invalid internal bridge session ID', 'bridgeSessionId');
    }
  }

  private nextId<T>(
    kind: Parameters<NonNullable<BrokerRuntimeOptions['idFactory']>>[0],
    records: ReadonlyMap<string, T>,
  ): string {
    const id = this.idFactory(kind);
    if (!id.startsWith(`${kind}:`) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(id) || records.has(id)) {
      throw new BrowserPilotError('internal_error', `Invalid or duplicate ${kind} ID`);
    }
    return id;
  }

  private nextManagedTabSetId(): ManagedTabSetId {
    const id = this.idFactory('tabset') as ManagedTabSetId;
    if (
      !id.startsWith('tabset:') ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(id) ||
      this.managedTabSetIds.has(id)
    ) {
      throw new BrowserPilotError('internal_error', 'Invalid or duplicate tabset ID');
    }
    this.managedTabSetIds.add(id);
    return id;
  }
}
