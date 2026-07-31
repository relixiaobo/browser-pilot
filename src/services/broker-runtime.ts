import { randomUUID } from 'node:crypto';
import {
  BrowserPilotError,
  invalidArgument,
  protocolIncompatible,
} from '../protocol/errors.js';
import {
  CAPABILITIES,
  DEFAULT_CAPABILITIES,
  type ArtifactDescriptor,
  type ArtifactId,
  type BrowserCandidate,
  type BrowserInstanceId,
  type BrowserInstance,
  type BrowserWorkspace,
  type BrowserWorkspaceId,
  type BrowserEvent,
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
  type ProfileContextId,
  type ToolCallParams,
  type ControlledTargetId,
} from '../protocol/model.js';
import {
  getToolDefinition,
  isToolAvailableInProtocol,
  minimumProtocolMinorForTool,
  validateToolArguments,
  validateToolResult,
  type ToolDefinition,
} from '../protocol/tools.js';
import {
  MIN_NEGOTIATED_TRANSPORT_BYTES,
  negotiateCapabilities,
  negotiateProtocolLimits,
  negotiateProtocol,
  validateArtifactAccessParams,
  validateArtifactExportParams,
  validateArtifactImportParams,
  validateArtifactListParams,
  validateCommandAccessParams,
  validateCommandListParams,
  validateEventsPollParams,
  validateInitializeParams,
  validateLeaseCreateParams,
  validateLeaseHeartbeatParams,
  validateLeaseReleaseParams,
  validateShutdownParams,
  validateToolCallParams,
  validateWorkspaceCreateParams,
  validateWorkspaceGetParams,
  validateWorkspaceReleaseParams,
} from '../protocol/validation.js';
import { MemoryCommandRuntime } from './command-runtime.js';
import {
  MemoryEventJournal,
  type PublishBrowserEventInput,
} from './event-journal.js';

export interface BrowserEventPublication extends PublishBrowserEventInput {
  preserveIfGenerationStale?: boolean;
}

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

function normalizeBrowserCandidate(candidate: BrowserCandidate): BrowserCandidate {
  const ready = candidate.state === 'ready';
  const authorizationRequired = candidate.state === 'authorization_required';
  const userDataRoot = candidate.userDataRoot ?? candidate.profile;
  return {
    ...candidate,
    ...(userDataRoot ? { userDataRoot, profile: userDataRoot } : {}),
    processState: candidate.processState ?? (ready || authorizationRequired ? 'running' : 'unknown'),
    remoteDebuggingState: candidate.remoteDebuggingState ?? (
      ready || authorizationRequired
        ? 'enabled'
        : candidate.state === 'disconnected' ? 'stale' : 'disabled'
    ),
    authorizationState: candidate.authorizationState ?? (
      ready
        ? 'authorized'
        : authorizationRequired ? 'required' : candidate.state === 'disconnected' ? 'unknown' : 'not_applicable'
    ),
  };
}

function browserCandidateForProtocol(candidate: BrowserCandidate, protocolMinor: number): BrowserCandidate {
  const { profile, userDataRoot, ...rest } = candidate;
  const root = userDataRoot ?? profile;
  if (!root) return rest;
  return protocolMinor >= 3
    ? { ...rest, userDataRoot: root }
    : { ...rest, profile: root };
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
  toolExecutor?: BrowserToolExecutor;
  artifactStore?: BrokerArtifactStore;
  commandRuntime?: MemoryCommandRuntime;
  eventJournal?: MemoryEventJournal;
}

export interface BrokerArtifactStore {
  list(
    workspaceId: BrowserWorkspaceId,
    kinds?: readonly ArtifactDescriptor['kind'][],
  ): Promise<ArtifactDescriptor[]>;
  get(workspaceId: BrowserWorkspaceId, artifactId: ArtifactId): Promise<{
    descriptor: ArtifactDescriptor;
    path: string;
  }>;
  export(
    workspaceId: BrowserWorkspaceId,
    artifactId: ArtifactId,
    destination: string,
    overwrite?: boolean,
  ): Promise<{ artifact: ArtifactDescriptor; path: string }>;
  retain(workspaceId: BrowserWorkspaceId, artifactId: ArtifactId): Promise<{
    descriptor: ArtifactDescriptor;
    path: string;
  }>;
  release(workspaceId: BrowserWorkspaceId, artifactId: ArtifactId): Promise<void>;
  releaseWorkspace(workspaceId: BrowserWorkspaceId): Promise<void>;
  importFile(
    workspaceId: BrowserWorkspaceId,
    sourcePath: string,
    mimeType?: string,
  ): Promise<{ descriptor: ArtifactDescriptor; path: string }>;
}

export interface BrokerToolCallContext {
  principal: ClientPrincipal;
  connection: ClientConnection;
  capabilities: Capability[];
  workspace?: BrowserWorkspace;
  managedTabSet?: ManagedTabSet;
  lease?: ControlLease;
  targetId?: ControlledTargetId;
  browser: BrokerBrowserBinding;
  signal: AbortSignal;
  markDispatched(): void;
  selectProfileContext?(profileContextId: ProfileContextId): void;
  managedTabSetForProfile?(profileContextId: ProfileContextId): ManagedTabSet;
}

export interface BrowserToolExecutor {
  readonly supportedTools: readonly string[];
  call(
    context: BrokerToolCallContext,
    definition: ToolDefinition,
    args: JsonValue,
  ): Promise<JsonValue>;
  actorKey?(
    context: BrokerToolCallContext,
    definition: ToolDefinition,
    args: JsonValue,
  ): string;
  commandTargetId?(
    context: BrokerToolCallContext,
    definition: ToolDefinition,
    args: JsonValue,
  ): ControlledTargetId | undefined;
  setEventPublisher?(publisher: (event: BrowserEventPublication) => void): void;
  browserConnectionChanged?(previous: BrowserInstance, current: BrowserInstance): void;
  releaseLease?(lease: ControlLease): void;
  releaseWorkspace?(
    principal: ClientPrincipal,
    workspace: BrowserWorkspace,
    managedTabSets: readonly ManagedTabSet[],
  ): void;
}

interface RuntimeConnection {
  value: ClientConnection;
  clientSessionId: string;
  client: ClientIdentity;
  grantedCapabilities: Capability[];
  limits: ProtocolLimits;
}

interface RuntimeWorkspace {
  value: BrowserWorkspace;
  managedTabSet: ManagedTabSet;
  additionalManagedTabSets: Map<ProfileContextId, ManagedTabSet>;
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

function runtimeManagedTabSets(record: RuntimeWorkspace): ManagedTabSet[] {
  return [record.managedTabSet, ...record.additionalManagedTabSets.values()];
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
  private readonly connectionsByClientSession = new Map<string, RuntimeConnection>();
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
  private readonly commands: MemoryCommandRuntime;
  private readonly events: MemoryEventJournal;
  private readonly listenerCleanup: Array<() => void> = [];
  private readonly workspaceCleanup = new Map<BrowserWorkspaceId, Promise<void>>();

  constructor(private readonly options: BrokerRuntimeOptions) {
    this.browserBindings = options.browsers.map(binding => ({
      candidate: normalizeBrowserCandidate(binding.candidate),
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
    this.commands = options.commandRuntime ?? new MemoryCommandRuntime({ now: this.now });
    this.events = options.eventJournal ?? new MemoryEventJournal({
      maxEventsPerWorkspace: this.limits.eventJournalSize,
      now: this.now,
    });
    this.listenerCleanup.push(this.commands.subscribe(outcome => {
      if (!outcome.command.workspaceId) return;
      this.publishBrowserEvent({
        workspaceId: outcome.command.workspaceId,
        browserConnectionGeneration: outcome.command.browserConnectionGeneration ??
          this.workspaceBrowserGeneration(outcome.command.workspaceId),
        ...(outcome.command.leaseId ? { leaseId: outcome.command.leaseId } : {}),
        ...(outcome.command.targetId ? { targetId: outcome.command.targetId } : {}),
        type: 'command.status',
        sensitivity: 'browser_data',
        payload: { command: outcome.command } as unknown as JsonValue,
        preserveIfGenerationStale: true,
      });
    }));
    options.toolExecutor?.setEventPublisher?.(event => { this.publishBrowserEvent(event); });
    if (
      this.minLeaseTtlMs <= 0 ||
      this.defaultLeaseTtlMs < this.minLeaseTtlMs ||
      this.maxLeaseTtlMs < this.defaultLeaseTtlMs
    ) {
      throw new Error('Invalid Broker Lease TTL configuration');
    }
    if (this.allowedCapabilities.some(capability => !(CAPABILITIES as readonly string[]).includes(capability))) {
      throw new Error('Broker allowedCapabilities contains an unknown capability');
    }
    if (Object.values(this.limits).some(limit => !Number.isSafeInteger(limit) || limit <= 0)) {
      throw new Error('Invalid Broker protocol limits');
    }
    if (
      this.limits.maxMessageBytes < MIN_NEGOTIATED_TRANSPORT_BYTES ||
      this.limits.maxResultBytes < MIN_NEGOTIATED_TRANSPORT_BYTES
    ) {
      throw new Error(`Broker transport limits must be at least ${MIN_NEGOTIATED_TRANSPORT_BYTES} bytes`);
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

  async call(clientSessionId: string, method: string, params?: JsonValue): Promise<JsonValue> {
    this.assertClientSessionId(clientSessionId);
    this.sweepExpiredLeases();
    if (method === 'initialize') return this.initialize(clientSessionId, params);

    const connection = this.requireConnection(clientSessionId);
    connection.value.lastSeenAt = this.now();
    switch (method) {
      case 'tools/call':
        return this.callTool(connection, params);
      case 'commands/get':
        return this.getCommand(connection, params);
      case 'commands/list':
        return this.listCommands(connection, params);
      case 'commands/cancel':
        return this.cancelCommand(connection, params);
      case 'events/poll':
        return this.pollEvents(connection, params);
      case 'artifacts/get':
        return this.getArtifact(connection, params);
      case 'artifacts/list':
        return this.listArtifacts(connection, params);
      case 'artifacts/export':
        return this.exportArtifact(connection, params);
      case 'artifacts/import':
        return this.importArtifact(connection, params);
      case 'artifacts/retain':
        return this.retainArtifact(connection, params);
      case 'artifacts/release':
        return this.releaseArtifact(connection, params);
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

  disconnect(clientSessionId: string): void {
    const connection = this.connectionsByClientSession.get(clientSessionId);
    if (!connection) return;
    this.commands.releaseConnection(connection.value.id);
    this.connectionsByClientSession.delete(clientSessionId);
    this.connectionsById.delete(connection.value.id);
    for (const [leaseId, lease] of this.leases) {
      if (lease.connectionId !== connection.value.id) continue;
      if (lease.state === 'active') this.releaseLeaseRecord(lease, 'released');
      this.leases.delete(leaseId);
    }
    this.cleanupUnusedPrincipal(connection.value.principalId);
  }

  close(): void {
    for (const clientSessionId of [...this.connectionsByClientSession.keys()]) {
      this.disconnect(clientSessionId);
    }
    for (const cleanup of this.listenerCleanup.splice(0)) cleanup();
  }

  publishBrowserEvent(input: BrowserEventPublication): BrowserEvent | undefined {
    const workspace = this.workspaces.get(input.workspaceId);
    if (!workspace || workspace.value.state !== 'active') return undefined;
    const binding = this.browserBindings.find(candidate => (
      candidate.instance.id === workspace.value.browserInstanceId
    ));
    if (!binding) return undefined;
    if (input.browserConnectionGeneration > binding.instance.connectionGeneration) return undefined;
    if (
      input.browserConnectionGeneration < binding.instance.connectionGeneration &&
      input.preserveIfGenerationStale !== true
    ) return undefined;
    const { preserveIfGenerationStale: _preserve, ...event } = input;
    return this.events.publish(event);
  }

  updateBrowserConnection(
    browserInstanceId: BrowserInstanceId,
    update: Pick<BrowserInstance, 'state' | 'connectionGeneration'> & { processIdentity?: string },
  ): BrowserInstance {
    const binding = this.browserBindings.find(candidate => candidate.instance.id === browserInstanceId);
    if (!binding) throw new BrowserPilotError('browser_not_found', 'Browser instance is not registered');
    if (!Number.isSafeInteger(update.connectionGeneration) || update.connectionGeneration < 1) {
      throw new BrowserPilotError('internal_error', 'Invalid browser connection generation');
    }
    const previous = { ...binding.instance };
    if (update.connectionGeneration < previous.connectionGeneration) {
      throw new BrowserPilotError('internal_error', 'Browser connection generation cannot move backwards');
    }
    if (
      update.connectionGeneration > previous.connectionGeneration &&
      !(update.state === 'connected' && previous.state !== 'connected')
    ) {
      throw new BrowserPilotError('internal_error', 'Browser generation advances only on connection restoration');
    }
    if (
      update.state === 'connected' &&
      previous.state !== 'connected' &&
      update.connectionGeneration <= previous.connectionGeneration
    ) {
      throw new BrowserPilotError('internal_error', 'Restored browser connection must advance generation');
    }

    binding.instance.state = update.state;
    binding.instance.connectionGeneration = update.connectionGeneration;
    if (update.processIdentity !== undefined) binding.instance.processIdentity = update.processIdentity;
    if (update.state === 'connected') {
      binding.candidate.state = 'ready';
      binding.candidate.processState = 'running';
      binding.candidate.remoteDebuggingState = 'enabled';
      binding.candidate.authorizationState = 'authorized';
      delete binding.candidate.remediation;
    } else {
      binding.candidate.state = 'disconnected';
      binding.candidate.remediation = {
        code: 'reconnect_browser',
        message: 'Browser Pilot is waiting for the authorized browser debugging endpoint.',
        actionRequired: false,
      };
    }

    const current = { ...binding.instance };
    const eventType = previous.state === 'connected' && current.state !== 'connected'
      ? 'connection.lost'
      : previous.state !== 'connected' && current.state === 'connected'
        ? 'connection.restored'
        : undefined;
    if (eventType) {
      for (const workspace of this.workspaces.values()) {
        if (
          workspace.value.state !== 'active' ||
          workspace.value.browserInstanceId !== browserInstanceId
        ) continue;
        this.publishBrowserEvent({
          workspaceId: workspace.value.id,
          browserConnectionGeneration: eventType === 'connection.lost'
            ? previous.connectionGeneration
            : current.connectionGeneration,
          type: eventType,
          sensitivity: 'browser_data',
          payload: {
            browserInstanceId,
            connectionGeneration: current.connectionGeneration,
            state: current.state,
          },
        });
      }
    }
    this.options.toolExecutor?.browserConnectionChanged?.(previous, current);
    return current;
  }

  registerBrowser(binding: BrokerBrowserBinding): BrokerBrowserBinding {
    if (this.browserBindings.some(candidate => (
      candidate.candidate.id === binding.candidate.id ||
      candidate.instance.id === binding.instance.id
    ))) {
      throw new Error('Browser candidate or instance is already registered');
    }
    const registered = {
      candidate: normalizeBrowserCandidate(binding.candidate),
      instance: { ...binding.instance },
    };
    this.browserBindings.push(registered);
    return {
      candidate: { ...registered.candidate },
      instance: { ...registered.instance },
    };
  }

  updateBrowserCandidate(
    browserInstanceId: BrowserInstanceId,
    candidate: BrowserCandidate,
  ): BrowserCandidate {
    const binding = this.browserBindings.find(current => current.instance.id === browserInstanceId);
    if (!binding) throw new BrowserPilotError('browser_not_found', 'Browser instance is not registered');
    if (candidate.id !== binding.candidate.id) {
      throw new BrowserPilotError('internal_error', 'Browser candidate identity cannot change');
    }
    binding.candidate = normalizeBrowserCandidate(candidate);
    return { ...binding.candidate };
  }

  sweepExpiredLeases(): number {
    const now = this.now();
    this.commands.sweep();
    let expired = 0;
    for (const lease of this.leases.values()) {
      if (lease.state === 'active' && lease.expiresAt <= now) {
        this.releaseLeaseRecord(lease, 'expired');
        expired += 1;
      }
    }
    for (const connection of [...this.connectionsByClientSession.values()]) {
      if (connection.value.lastSeenAt + this.connectionIdleTtlMs <= now) {
        this.disconnect(connection.clientSessionId);
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
      connections: this.connectionsByClientSession.size,
      activeWorkspaces: [...this.workspaces.values()].filter(record => record.value.state === 'active').length,
      activeLeases: [...this.leases.values()].filter(lease => lease.state === 'active').length,
    };
  }

  lifecycleSummary(): {
    connections: number;
    activeWorkspaces: number;
    activeLeases: number;
  } {
    const stats = this.stats();
    return {
      connections: stats.connections,
      activeWorkspaces: stats.activeWorkspaces,
      activeLeases: stats.activeLeases,
    };
  }

  private initialize(clientSessionId: string, value: unknown): JsonValue {
    const params = validateInitializeParams(value);
    const existing = this.connectionsByClientSession.get(clientSessionId);
    if (existing) {
      if (
        existing.client.id !== params.client.id ||
        existing.client.name !== params.client.name ||
        existing.client.version !== params.client.version ||
        existing.client.instanceId !== params.client.instanceId
      ) {
        throw invalidArgument('This client session is already initialized', 'method');
      }
      const protocol = negotiateProtocol(params.protocol);
      if (params.limits && (protocol.major < 1 || (protocol.major === 1 && protocol.minor < 1))) {
        throw protocolIncompatible('Transport limit negotiation requires protocol 1.1 or newer', {
          selectedProtocol: `${protocol.major}.${protocol.minor}`,
        });
      }
      const capabilities = negotiateCapabilities(params.requestedCapabilities, this.allowedCapabilities);
      const limits = negotiateProtocolLimits(params.limits, this.limits);
      if (
        protocol.major !== existing.value.protocol.major ||
        protocol.minor !== existing.value.protocol.minor ||
        capabilities.granted.length !== existing.grantedCapabilities.length ||
        capabilities.granted.some((capability, index) => capability !== existing.grantedCapabilities[index]) ||
        limits.maxMessageBytes !== existing.limits.maxMessageBytes ||
        limits.maxResultBytes !== existing.limits.maxResultBytes ||
        limits.maxArtifactBytes !== existing.limits.maxArtifactBytes ||
        limits.eventJournalSize !== existing.limits.eventJournalSize
      ) {
        throw new BrowserPilotError('protocol_incompatible', 'Client session cannot change its negotiated contract', {
          remediation: {
            code: 'restart_browser_pilot',
            message: 'Restart Browser Pilot before using a different client protocol contract.',
            actionRequired: true,
          },
        });
      }
      existing.value.lastSeenAt = this.now();
      return asJson({
        serviceVersion: this.options.serviceVersion,
        executableVersion: this.options.executableVersion ?? this.options.serviceVersion,
        protocol: { ...existing.value.protocol },
        supportedCapabilities: [...CAPABILITIES],
        capabilities,
        brokerProcessIdentity: this.options.brokerProcessIdentity,
        connectionId: existing.value.id,
        browsers: this.browserBindings.map(binding => (
          browserCandidateForProtocol(binding.candidate, existing.value.protocol.minor)
        )),
        limits: { ...existing.limits },
      } satisfies InitializeResult);
    }
    if (this.connectionsByClientSession.size >= this.maxConnections) {
      throw new BrowserPilotError('result_too_large', 'Broker connection limit reached', {
        context: { maxConnections: this.maxConnections },
      });
    }
    const protocol = negotiateProtocol(params.protocol);
    if (params.limits && (protocol.major < 1 || (protocol.major === 1 && protocol.minor < 1))) {
      throw protocolIncompatible('Transport limit negotiation requires protocol 1.1 or newer', {
        selectedProtocol: `${protocol.major}.${protocol.minor}`,
      });
    }
    const capabilities = negotiateCapabilities(params.requestedCapabilities, this.allowedCapabilities);
    const limits = negotiateProtocolLimits(params.limits, this.limits);
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
      browsers: this.browserBindings.map(binding => browserCandidateForProtocol(binding.candidate, protocol.minor)),
      limits: { ...limits },
    };
    const connection: RuntimeConnection = {
      value: connectionValue,
      clientSessionId,
      client: { ...params.client },
      grantedCapabilities: [...capabilities.granted],
      limits,
    };
    this.connectionsByClientSession.set(clientSessionId, connection);
    this.connectionsById.set(connectionId, connection);
    return asJson(initializeResult);
  }

  private createWorkspace(connection: RuntimeConnection, value: unknown): JsonValue {
    this.assertCapabilities(connection, ['workspace.manage']);
    const params = validateWorkspaceCreateParams(value);
    if (params.clientKey && connection.value.protocol.minor < 1) {
      throw protocolIncompatible('Keyed Workspace creation requires protocol 1.1 or newer');
    }
    const principalId = connection.value.principalId;
    const existing = params.clientKey
      ? [...this.workspaces.values()].find(record => (
        record.value.principalId === principalId &&
        record.value.state === 'active' &&
        record.value.clientKey === params.clientKey
      ))
      : undefined;
    if (existing) {
      if (params.browserId) {
        const requested = this.browserBindings.find(candidate => candidate.candidate.id === params.browserId);
        if (!requested) {
          throw new BrowserPilotError('browser_not_found', 'Selected browser is not registered', {
            context: { browserId: params.browserId },
          });
        }
        if (existing.value.browserInstanceId !== requested.instance.id) {
          throw invalidArgument('clientKey already belongs to another browser instance', 'clientKey');
        }
      }
      existing.value.updatedAt = this.now();
      return asJson({
        workspace: cloneWorkspace(existing.value),
        managedTabSet: cloneManagedTabSet(existing.managedTabSet),
        managedTabSets: runtimeManagedTabSets(existing).map(cloneManagedTabSet),
        eventCursor: this.events.currentCursor(existing.value.id),
      });
    }
    const binding = params.browserId
      ? this.browserBindings.find(candidate => candidate.candidate.id === params.browserId)
      : this.browserBindings.find(candidate => (
        candidate.candidate.state === 'ready' && candidate.instance.state === 'connected'
      )) ?? this.browserBindings[0];
    if (!binding) {
      throw new BrowserPilotError('browser_not_found', 'No supported browser is registered', {
        context: params.browserId ? { browserId: params.browserId } : undefined,
        remediation: {
          code: 'install_or_select_supported_browser',
          message: 'Install or select a supported browser returned by browser discovery.',
          actionRequired: true,
        },
      });
    }
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

    const now = this.now();
    const workspaceId = this.nextId('workspace', this.workspaces) as BrowserWorkspaceId;
    const managedTabSetId = this.nextManagedTabSetId();
    const workspace: BrowserWorkspace = {
      id: workspaceId,
      principalId,
      browserInstanceId: binding.instance.id,
      ...(params.clientKey ? { clientKey: params.clientKey } : {}),
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
    this.workspaces.set(workspaceId, {
      value: workspace,
      managedTabSet,
      additionalManagedTabSets: new Map(),
    });
    const eventCursor = this.events.createWorkspace(workspaceId);
    return asJson({
      workspace: cloneWorkspace(workspace),
      managedTabSet: cloneManagedTabSet(managedTabSet),
      managedTabSets: [cloneManagedTabSet(managedTabSet)],
      eventCursor,
    });
  }

  private getWorkspace(connection: RuntimeConnection, value: unknown): JsonValue {
    this.assertCapabilities(connection, ['workspace.manage']);
    const params = validateWorkspaceGetParams(value);
    const record = this.requireWorkspace(connection, params.workspaceId, true);
    return asJson({
      workspace: cloneWorkspace(record.value),
      managedTabSet: cloneManagedTabSet(record.managedTabSet),
      managedTabSets: runtimeManagedTabSets(record).map(cloneManagedTabSet),
      eventCursor: this.events.currentCursor(record.value.id),
    });
  }

  private async releaseWorkspace(connection: RuntimeConnection, value: unknown): Promise<JsonValue> {
    this.assertCapabilities(connection, ['workspace.manage']);
    const params = validateWorkspaceReleaseParams(value);
    const record = this.requireWorkspace(connection, params.workspaceId, true);
    if (record.value.state !== 'released') this.releaseWorkspaceRecord(record);
    await this.workspaceCleanup.get(record.value.id);
    return asJson({ workspaceId: params.workspaceId, released: true });
  }

  private createLease(connection: RuntimeConnection, value: unknown): JsonValue {
    this.assertCapabilities(connection, ['workspace.manage']);
    const params = validateLeaseCreateParams(value);
    if (params.clientKey && connection.value.protocol.minor < 1) {
      throw protocolIncompatible('Keyed Lease creation requires protocol 1.1 or newer');
    }
    this.requireWorkspace(connection, params.workspaceId, false);
    const ttlMs = this.validateLeaseTtl(params.ttlMs);
    if (params.clientKey) {
      const existing = [...this.leases.values()].find(lease => (
        lease.connectionId === connection.value.id &&
        lease.workspaceId === params.workspaceId &&
        lease.state === 'active' &&
        lease.clientKey === params.clientKey
      ));
      if (existing) {
        const now = this.now();
        existing.lastHeartbeatAt = now;
        existing.expiresAt = now + ttlMs;
        this.workspaces.get(params.workspaceId)!.value.updatedAt = now;
        return asJson({ lease: cloneLease(existing) });
      }
    }
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
    const now = this.now();
    const leaseId = this.nextId('lease', this.leases) as ControlLeaseId;
    const lease: ControlLease = {
      id: leaseId,
      workspaceId: params.workspaceId,
      connectionId: connection.value.id,
      ...(params.clientKey ? { clientKey: params.clientKey } : {}),
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
    this.assertCapabilities(connection, ['workspace.manage']);
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
    this.assertCapabilities(connection, ['workspace.manage']);
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

  private requireConnection(clientSessionId: string): RuntimeConnection {
    const connection = this.connectionsByClientSession.get(clientSessionId);
    if (connection) return connection;
    throw new BrowserPilotError('not_initialized', 'Client session is not initialized', {
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

  private selectWorkspaceProfileContext(
    record: RuntimeWorkspace,
    profileContextId: ProfileContextId,
  ): void {
    if (record.value.state !== 'active') {
      throw new BrowserPilotError('workspace_not_found', 'Workspace is not active', {
        context: { workspaceId: record.value.id },
      });
    }
    record.value.selectedProfileContextId = profileContextId;
    record.value.updatedAt = this.now();
  }

  private managedTabSetForProfile(
    record: RuntimeWorkspace,
    profileContextId: ProfileContextId,
  ): ManagedTabSet {
    if (record.value.state !== 'active') {
      throw new BrowserPilotError('workspace_not_found', 'Workspace is not active', {
        context: { workspaceId: record.value.id },
      });
    }
    if (record.managedTabSet.profileContextId === profileContextId) {
      return cloneManagedTabSet(record.managedTabSet);
    }
    if (!record.managedTabSet.profileContextId) {
      record.managedTabSet.profileContextId = profileContextId;
      return cloneManagedTabSet(record.managedTabSet);
    }
    const existing = record.additionalManagedTabSets.get(profileContextId);
    if (existing) return cloneManagedTabSet(existing);
    if (record.additionalManagedTabSets.size >= 127) {
      throw new BrowserPilotError('result_too_large', 'ManagedTabSet Profile context limit reached', {
        context: { workspaceId: record.value.id, maxManagedTabSets: 128 },
      });
    }
    const managedTabSet: ManagedTabSet = {
      id: this.nextManagedTabSetId(),
      workspaceId: record.value.id,
      browserInstanceId: record.value.browserInstanceId,
      profileContextId,
      createdAt: this.now(),
      state: 'active',
    };
    record.additionalManagedTabSets.set(profileContextId, managedTabSet);
    return cloneManagedTabSet(managedTabSet);
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
    if (state === 'expired') {
      this.publishBrowserEvent({
        workspaceId: lease.workspaceId,
        browserConnectionGeneration: this.workspaceBrowserGeneration(lease.workspaceId),
        leaseId: lease.id,
        type: 'lease.expired',
        sensitivity: 'public',
        payload: { expiresAt: lease.expiresAt },
      });
    }
    this.commands.releaseLease(lease.id);
    this.options.toolExecutor?.releaseLease?.(cloneLease(lease));
    this.options.onLeaseReleased?.(cloneLease(lease));
  }

  private releaseWorkspaceRecord(record: RuntimeWorkspace): void {
    record.value.state = 'releasing';
    this.commands.releaseWorkspace(record.value.id);
    for (const lease of this.leases.values()) {
      if (lease.workspaceId === record.value.id && lease.state === 'active') {
        this.releaseLeaseRecord(lease, 'released');
      }
    }
    const managedTabSets = runtimeManagedTabSets(record);
    for (const managedTabSet of managedTabSets) managedTabSet.state = 'closed';
    record.value.updatedAt = this.now();
    record.value.state = 'released';
    const principal = this.principals.get(record.value.principalId);
    if (principal) {
      this.options.toolExecutor?.releaseWorkspace?.(
        { ...principal, capabilities: [...principal.capabilities] },
        cloneWorkspace(record.value),
        managedTabSets.map(cloneManagedTabSet),
      );
    }
    this.options.onWorkspaceReleased?.(
      cloneWorkspace(record.value),
      cloneManagedTabSet(record.managedTabSet),
    );
    const cleanup = this.options.artifactStore?.releaseWorkspace(record.value.id).catch(() => {})
      ?? Promise.resolve();
    this.workspaceCleanup.set(record.value.id, cleanup);
    void cleanup.finally(() => {
      if (this.workspaceCleanup.get(record.value.id) === cleanup) {
        this.workspaceCleanup.delete(record.value.id);
      }
    });
  }

  private pruneReleasedWorkspaces(): void {
    if (this.workspaces.size < this.maxWorkspaceRecords) return;
    const released = [...this.workspaces.values()]
      .filter(record => record.value.state === 'released')
      .sort((left, right) => left.value.updatedAt - right.value.updatedAt);
    for (const record of released) {
      this.workspaces.delete(record.value.id);
      this.events.releaseWorkspace(record.value.id);
      for (const managedTabSet of runtimeManagedTabSets(record)) {
        this.managedTabSetIds.delete(managedTabSet.id);
      }
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
    const hasConnection = [...this.connectionsByClientSession.values()].some(connection => (
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

  private async callTool(connection: RuntimeConnection, value: unknown): Promise<JsonValue> {
    const params = validateToolCallParams(value);
    const definition = getToolDefinition(params.name);
    if (!isToolAvailableInProtocol(definition.name, connection.value.protocol)) {
      const requiredMinor = minimumProtocolMinorForTool(definition.name);
      throw protocolIncompatible(`${definition.name} requires protocol 1.${requiredMinor} or newer`, {
        tool: definition.name,
        requiredProtocol: { major: 1, minor: requiredMinor },
        selectedProtocol: `${connection.value.protocol.major}.${connection.value.protocol.minor}`,
      });
    }
    const isBrowserConnectTool = definition.name === 'browser.connect';
    const executor = this.options.toolExecutor;
    if (!executor || !executor.supportedTools.includes(definition.name)) {
      throw invalidArgument(`Tool is not available in this Broker: ${definition.name}`, 'name');
    }
    this.assertCapabilities(connection, definition.requiredCapabilities);
    const args = validateToolArguments(definition.name, params.arguments);
    if (
      definition.name === 'browser.open' &&
      connection.value.protocol.minor < 2 &&
      args &&
      typeof args === 'object' &&
      !Array.isArray(args) &&
      args.profileContextId !== undefined
    ) {
      throw protocolIncompatible('browser.open profileContextId requires protocol 1.2 or newer', {
        tool: definition.name,
        selectedProtocol: `${connection.value.protocol.major}.${connection.value.protocol.minor}`,
      });
    }
    if (definition.name === 'browser.discover') {
      return this.callBrowserDiscover(connection, params, args, definition);
    }
    const principal = this.principals.get(connection.value.principalId)!;
    let workspaceRecord: RuntimeWorkspace | undefined;
    let lease: ControlLease | undefined;

    if (definition.context !== 'connection') {
      if (!params.workspaceId || !params.leaseId) {
        throw invalidArgument(`${definition.name} requires workspaceId and leaseId`, 'params');
      }
      workspaceRecord = this.requireWorkspace(connection, params.workspaceId, false);
      lease = this.requireLease(connection, params.leaseId, true);
      if (lease.workspaceId !== workspaceRecord.value.id) {
        throw new BrowserPilotError('lease_expired', 'Lease does not belong to the requested Workspace', {
          context: { workspaceId: params.workspaceId, leaseId: params.leaseId },
        });
      }
      this.assertLeaseCapabilities(lease, definition.requiredCapabilities);
      workspaceRecord.value.updatedAt = this.now();
    }
    if (definition.context === 'target' && !params.targetId) {
      throw invalidArgument(`${definition.name} requires targetId`, 'targetId');
    }

    const binding = workspaceRecord
      ? this.browserBindings.find(candidate => candidate.instance.id === workspaceRecord!.value.browserInstanceId)
      : this.browserBindings.find(candidate => (
        candidate.candidate.state === 'ready' && candidate.instance.state === 'connected'
      ));
    if (!binding || (!isBrowserConnectTool && binding.instance.state !== 'connected')) {
      throw new BrowserPilotError('browser_disconnected', 'Workspace browser is disconnected', {
        retryable: true,
        context: workspaceRecord ? { workspaceId: workspaceRecord.value.id } : undefined,
        remediation: binding?.candidate.remediation ?? {
          code: 'connect_browser',
          message: "Run 'bp browsers', follow its setup remediation, then run one explicit 'bp connect'.",
          actionRequired: true,
        },
      });
    }
    const isBrowserConnectionAttempt = isBrowserConnectTool && binding.instance.state !== 'connected';

    const context: Omit<BrokerToolCallContext, 'signal' | 'markDispatched'> = {
      principal: { ...principal, capabilities: [...principal.capabilities] },
      connection: { ...connection.value, protocol: { ...connection.value.protocol } },
      capabilities: [...connection.grantedCapabilities],
      ...(workspaceRecord ? {
        workspace: cloneWorkspace(workspaceRecord.value),
        managedTabSet: cloneManagedTabSet(workspaceRecord.managedTabSet),
        selectProfileContext: (profileContextId: ProfileContextId) => {
          this.selectWorkspaceProfileContext(workspaceRecord!, profileContextId);
        },
        managedTabSetForProfile: (profileContextId: ProfileContextId) => (
          this.managedTabSetForProfile(workspaceRecord!, profileContextId)
        ),
      } : {}),
      ...(lease ? { lease: cloneLease(lease) } : {}),
      ...(params.targetId ? { targetId: params.targetId } : {}),
      browser: {
        candidate: { ...binding.candidate },
        instance: { ...binding.instance },
      },
    };
    const actorContext: BrokerToolCallContext = {
      ...context,
      signal: new AbortController().signal,
      markDispatched() {},
    };
    const commandTargetId = params.targetId ?? executor.commandTargetId?.(actorContext, definition, args);
    const actorKey = executor.actorKey?.(actorContext, definition, args) ?? this.defaultActorKey(
      connection,
      workspaceRecord?.value.id,
      commandTargetId,
    );
    const request = asJson({
      name: definition.name,
      arguments: args,
      ...(workspaceRecord ? { workspaceId: workspaceRecord.value.id } : {}),
      ...(lease ? { leaseId: lease.id } : {}),
      ...(commandTargetId ? { targetId: commandTargetId } : {}),
    });
    return asJson(await this.commands.run({
      principalId: principal.id,
      connectionId: connection.value.id,
      ...(workspaceRecord ? { workspaceId: workspaceRecord.value.id } : {}),
      ...(lease ? { leaseId: lease.id } : {}),
      ...(commandTargetId ? { targetId: commandTargetId } : {}),
      ...(params.commandId ? { commandId: params.commandId } : {}),
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
      ...(params.deadlineMs !== undefined ? { deadlineMs: params.deadlineMs } : {}),
      ...(context.browser.instance.connectionGeneration > 0
        ? { browserConnectionGeneration: context.browser.instance.connectionGeneration }
        : {}),
      method: definition.name,
      mutating: definition.mutating,
      ...(isBrowserConnectionAttempt ? { browserDisconnectOutcomeKnown: true } : {}),
      cancellation: definition.cancellation,
      actorKey,
      request,
    }, async ({ signal, markDispatched }) => {
      const assertCurrentBrowserGeneration = (): void => {
        const current = this.browserBindings.find(candidate => (
          candidate.instance.id === context.browser.instance.id
        ));
        if (isBrowserConnectionAttempt) {
          if (!current) {
            throw new BrowserPilotError('browser_disconnected', 'Browser instance disappeared during connection', {
              retryable: true,
            });
          }
          return;
        }
        if (
          !current ||
          current.instance.state !== 'connected' ||
          current.instance.connectionGeneration !== context.browser.instance.connectionGeneration
        ) {
          throw new BrowserPilotError('browser_disconnected', 'Browser connection changed during command execution', {
            retryable: true,
            context: {
              browserInstanceId: context.browser.instance.id,
              expectedConnectionGeneration: context.browser.instance.connectionGeneration,
              ...(current ? {
                currentConnectionGeneration: current.instance.connectionGeneration,
                browserState: current.instance.state,
              } : {}),
            },
          });
        }
      };
      const guardedMarkDispatched = (): void => {
        assertCurrentBrowserGeneration();
        markDispatched();
      };
      assertCurrentBrowserGeneration();
      if (!definition.mutating) guardedMarkDispatched();
      const result = await executor.call(
        { ...context, signal, markDispatched: guardedMarkDispatched },
        definition,
        args,
      );
      if (isBrowserConnectionAttempt) {
        const current = this.browserBindings.find(candidate => (
          candidate.instance.id === context.browser.instance.id
        ));
        if (!current || current.instance.state !== 'connected') {
          throw new BrowserPilotError('browser_disconnected', 'Browser connection did not become ready', {
            retryable: true,
          });
        }
      } else {
        assertCurrentBrowserGeneration();
      }
      return validateToolResult(definition.name, result);
    }));
  }

  private async callBrowserDiscover(
    connection: RuntimeConnection,
    params: ToolCallParams,
    args: JsonValue,
    definition: ToolDefinition,
  ): Promise<JsonValue> {
    const record = args as Record<string, JsonValue>;
    const filter = typeof record.browser === 'string' ? record.browser.toLowerCase() : undefined;
    const browsers = this.browserBindings
      .map(binding => ({ ...binding.candidate }))
      .filter(candidate => !filter || [candidate.id, candidate.product, candidate.channel]
        .some(value => value?.toLowerCase().includes(filter)));
    return asJson(await this.commands.run({
      principalId: connection.value.principalId,
      connectionId: connection.value.id,
      ...(params.commandId ? { commandId: params.commandId } : {}),
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
      ...(params.deadlineMs !== undefined ? { deadlineMs: params.deadlineMs } : {}),
      method: definition.name,
      mutating: false,
      cancellation: definition.cancellation,
      actorKey: `${connection.value.id}\u0000browser-discovery`,
      request: asJson({ name: definition.name, arguments: args }),
    }, async ({ markDispatched }) => {
      markDispatched();
      return validateToolResult(definition.name, asJson({ browsers }));
    }));
  }

  private workspaceBrowserGeneration(workspaceId: BrowserWorkspaceId): number {
    const workspace = this.workspaces.get(workspaceId);
    const binding = workspace && this.browserBindings.find(candidate => (
      candidate.instance.id === workspace.value.browserInstanceId
    ));
    return binding?.instance.connectionGeneration ?? 1;
  }

  private pollEvents(connection: RuntimeConnection, value: unknown): JsonValue {
    this.assertCapabilities(connection, ['event.read']);
    const params = validateEventsPollParams(value);
    this.requireWorkspace(connection, params.workspaceId, true);
    return asJson(this.events.poll(params.workspaceId, params.cursor, params.limit));
  }

  private getCommand(connection: RuntimeConnection, value: unknown): JsonValue {
    const params = validateCommandAccessParams(value);
    if (params.workspaceId) this.requireWorkspace(connection, params.workspaceId, true);
    return asJson(this.commands.get({
      principalId: connection.value.principalId,
      commandId: params.commandId,
      ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
    }));
  }

  private listCommands(connection: RuntimeConnection, value: unknown): JsonValue {
    const params = validateCommandListParams(value);
    this.requireWorkspace(connection, params.workspaceId, true);
    return asJson({
      commands: this.commands.list({
        principalId: connection.value.principalId,
        workspaceId: params.workspaceId,
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        ...(params.statuses ? { statuses: params.statuses } : {}),
      }),
    });
  }

  private cancelCommand(connection: RuntimeConnection, value: unknown): JsonValue {
    const params = validateCommandAccessParams(value);
    if (params.workspaceId) this.requireWorkspace(connection, params.workspaceId, true);
    return asJson(this.commands.cancel({
      principalId: connection.value.principalId,
      commandId: params.commandId,
      ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
    }));
  }

  private defaultActorKey(
    connection: RuntimeConnection,
    workspaceId?: BrowserWorkspaceId,
    targetId?: ControlledTargetId,
  ): string {
    if (targetId) return `target:${targetId}`;
    if (workspaceId) return `workspace:${workspaceId}`;
    return `connection:${connection.value.id}`;
  }

  private async getArtifact(connection: RuntimeConnection, value: unknown): Promise<JsonValue> {
    const params = validateArtifactAccessParams(value);
    this.requireArtifactContext(connection, params.workspaceId, params.leaseId);
    const record = await this.requireArtifactStore().get(params.workspaceId, params.artifactId);
    return asJson({ artifact: record.descriptor, path: record.path });
  }

  private async listArtifacts(connection: RuntimeConnection, value: unknown): Promise<JsonValue> {
    const params = validateArtifactListParams(value);
    this.requireArtifactContext(connection, params.workspaceId, params.leaseId);
    return asJson({
      artifacts: await this.requireArtifactStore().list(params.workspaceId, params.kinds),
    });
  }

  private async exportArtifact(connection: RuntimeConnection, value: unknown): Promise<JsonValue> {
    const params = validateArtifactExportParams(value);
    this.requireArtifactContext(connection, params.workspaceId, params.leaseId);
    return asJson(await this.requireArtifactStore().export(
      params.workspaceId,
      params.artifactId,
      params.path,
      params.overwrite,
    ));
  }

  private async importArtifact(connection: RuntimeConnection, value: unknown): Promise<JsonValue> {
    const params = validateArtifactImportParams(value);
    this.requireArtifactContext(connection, params.workspaceId, params.leaseId);
    const record = await this.requireArtifactStore().importFile(
      params.workspaceId,
      params.path,
      params.mimeType,
    );
    return asJson({ artifact: record.descriptor });
  }

  private async retainArtifact(connection: RuntimeConnection, value: unknown): Promise<JsonValue> {
    const params = validateArtifactAccessParams(value);
    this.requireArtifactContext(connection, params.workspaceId, params.leaseId);
    const record = await this.requireArtifactStore().retain(params.workspaceId, params.artifactId);
    return asJson({ artifact: record.descriptor, path: record.path });
  }

  private async releaseArtifact(connection: RuntimeConnection, value: unknown): Promise<JsonValue> {
    const params = validateArtifactAccessParams(value);
    this.requireArtifactContext(connection, params.workspaceId, params.leaseId);
    await this.requireArtifactStore().release(params.workspaceId, params.artifactId);
    return asJson({ artifactId: params.artifactId, released: true });
  }

  private requireArtifactContext(
    connection: RuntimeConnection,
    workspaceId: BrowserWorkspaceId,
    leaseId: ControlLeaseId,
  ): void {
    this.assertCapabilities(connection, ['artifact.read']);
    this.requireWorkspace(connection, workspaceId, false);
    const lease = this.requireLease(connection, leaseId, true);
    if (lease.workspaceId !== workspaceId) {
      throw new BrowserPilotError('lease_expired', 'Lease does not belong to the requested Workspace', {
        context: { workspaceId, leaseId },
      });
    }
    this.assertLeaseCapabilities(lease, ['artifact.read']);
  }

  private requireArtifactStore(): BrokerArtifactStore {
    if (this.options.artifactStore) return this.options.artifactStore;
    throw new BrowserPilotError('artifact_not_found', 'Artifact storage is unavailable');
  }

  private assertCapabilities(connection: RuntimeConnection, required: readonly Capability[]): void {
    const granted = new Set(connection.grantedCapabilities);
    const missing = required.filter(capability => !granted.has(capability));
    if (missing.length === 0) return;
    throw new BrowserPilotError('capability_denied', 'Required capability was not negotiated', {
      context: { missingCapabilities: missing },
    });
  }

  private assertLeaseCapabilities(lease: ControlLease, required: readonly Capability[]): void {
    const granted = new Set(lease.capabilities);
    const missing = required.filter(capability => !granted.has(capability));
    if (missing.length === 0) return;
    throw new BrowserPilotError('capability_denied', 'Lease does not carry the required capability', {
      context: { leaseId: lease.id, missingCapabilities: missing },
    });
  }

  private assertClientSessionId(value: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value)) {
      throw invalidArgument('Invalid internal client session ID', 'clientSessionId');
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
