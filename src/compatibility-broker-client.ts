import { createHash, randomUUID } from 'node:crypto';
import { BROKER_RPC_VERSION, DaemonClient, isDaemonRunning } from './client.js';
import { connectDaemon } from './session.js';
import { createExecutableMetadataSync } from './broker-locator.js';
import { publicExecutablePath } from './runtime-layout.js';
import { BrowserPilotError } from './protocol/errors.js';
import {
  CAPABILITIES,
  type ArtifactDescriptor,
  type BrowserCandidate,
  type BrowserWorkspace,
  type CommandDescriptor,
  type CommandId,
  type CommandOutcome,
  type CommandStatus,
  type ControlledTargetId,
  type ControlLease,
  type InitializeResult,
  type JsonValue,
  type ObservationId,
  type ProfileContextId,
} from './protocol/model.js';

const CLIENT_KEY = 'browser-pilot-cli';
const LEASE_TTL_MS = 5 * 60_000;

interface BrokerRpcTransport {
  brokerCall(clientSessionId: string, method: string, params?: JsonValue): Promise<JsonValue>;
}

interface WorkspaceCreateResult {
  workspace: BrowserWorkspace;
}

interface LeaseCreateResult {
  lease: ControlLease;
}

interface CommandListResult {
  commands: CommandDescriptor[];
}

export interface CompatibilityInvocationOptions {
  requestId?: string;
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface CompatibilityTarget {
  targetId: ControlledTargetId;
  profileContextId: ProfileContextId;
  title: string;
  url: string;
  active?: boolean;
  selected?: boolean;
  origin: 'managed' | 'managed_popup' | 'user_tab';
  managedTabSetId?: string;
  controlState: 'available' | 'controlled' | 'busy';
}

export interface CompatibilityProfile {
  profileContextId: ProfileContextId;
  label: string;
  displayName?: string;
  identityStatus?: 'unidentified' | 'verified' | 'unavailable';
  profileName?: string;
  accountName?: string;
  accountEmail?: string;
  profileDirectory?: string;
  identityErrorCode?: string;
  tabCount: number;
  eligibleTabCount: number;
  selected: boolean;
  representativeTabs: Array<{
    targetId: ControlledTargetId;
    title: string;
    url: string;
  }>;
}

function compatibilityIdentity(clientKey: string, executableVersion: string): {
  clientSessionId: string;
  instanceId: string;
} {
  const principalDigest = createHash('sha256')
    .update(clientKey)
    .digest('base64url')
    .slice(0, 24);
  const sessionDigest = createHash('sha256')
    .update(clientKey)
    .update('\0')
    .update(executableVersion)
    .digest('base64url')
    .slice(0, 24);
  return {
    clientSessionId: `client:browser-pilot-cli:${sessionDigest}`,
    instanceId: `local:browser-pilot-cli:${principalDigest}`,
  };
}

function isSelected(target: CompatibilityTarget): boolean {
  return target.selected ?? target.active === true;
}

function asRecord(value: JsonValue, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrowserPilotError('internal_error', `${label} returned an invalid result`);
  }
  return value as Record<string, JsonValue>;
}

function commandResult(value: JsonValue, method: string): Record<string, JsonValue> {
  const outcome = asRecord(value, method);
  const command = asRecord(outcome.command, `${method} command`);
  if (command.status !== 'completed' || command.method !== method) {
    throw new BrowserPilotError('internal_error', `${method} did not return a completed command`);
  }
  return asRecord(outcome.result, `${method} result`);
}

export class CompatibilityBrokerClient {
  private commandSequence = 0;

  private constructor(
    private readonly transport: BrokerRpcTransport,
    private readonly clientSessionId: string,
    readonly initialized: InitializeResult,
    readonly workspace: BrowserWorkspace,
    readonly lease: ControlLease,
    private readonly invocation: CompatibilityInvocationOptions,
  ) {}

  static async create(
    transport: BrokerRpcTransport,
    executableVersion: string,
    clientKey = CLIENT_KEY,
    invocation: CompatibilityInvocationOptions = {},
  ): Promise<CompatibilityBrokerClient> {
    const identity = compatibilityIdentity(clientKey, executableVersion);
    const initialized = asRecord(await transport.brokerCall(identity.clientSessionId, 'initialize', {
      client: {
        id: 'org.browser-pilot.cli',
        name: 'Browser Pilot CLI',
        version: executableVersion,
        instanceId: identity.instanceId,
      },
      protocol: { min: { major: 1, minor: 1 }, max: { major: 1, minor: 3 } },
      requestedCapabilities: [...CAPABILITIES],
    }), 'initialize') as unknown as InitializeResult;
    const created = asRecord(await transport.brokerCall(identity.clientSessionId, 'workspaces/create', {
      clientKey,
    }), 'workspaces/create') as unknown as WorkspaceCreateResult;
    const leased = asRecord(await transport.brokerCall(identity.clientSessionId, 'leases/create', {
      workspaceId: created.workspace.id,
      clientKey,
      ttlMs: LEASE_TTL_MS,
    }), 'leases/create') as unknown as LeaseCreateResult;
    return new CompatibilityBrokerClient(
      transport,
      identity.clientSessionId,
      initialized,
      created.workspace,
      leased.lease,
      invocation,
    );
  }

  async callTool(
    name: string,
    args: Record<string, JsonValue> = {},
    targetId?: ControlledTargetId,
  ): Promise<Record<string, JsonValue>> {
    this.commandSequence += 1;
    if (this.invocation.signal?.aborted) {
      throw new BrowserPilotError('command_cancelled', 'Command was cancelled before dispatch');
    }
    const commandId = this.commandId(this.commandSequence);
    const request = this.transport.brokerCall(this.clientSessionId, 'tools/call', {
      name,
      arguments: args,
      workspaceId: this.workspace.id,
      leaseId: this.lease.id,
      ...(targetId ? { targetId } : {}),
      commandId,
      ...(this.invocation.requestId
        ? { idempotencyKey: `cli-request:${this.invocation.requestId}:${this.commandSequence}` }
        : {}),
      deadlineMs: this.invocation.deadlineMs ?? 60_000,
    });
    const cancel = (): void => {
      void this.transport.brokerCall(this.clientSessionId, 'commands/cancel', {
        commandId,
        workspaceId: this.workspace.id,
      }).catch(() => {});
    };
    this.invocation.signal?.addEventListener('abort', cancel, { once: true });
    try {
      return commandResult(await request, name);
    } finally {
      this.invocation.signal?.removeEventListener('abort', cancel);
    }
  }

  async listCommands(
    limit = 20,
    statuses?: readonly CommandStatus[],
  ): Promise<CommandDescriptor[]> {
    const result = asRecord(await this.transport.brokerCall(this.clientSessionId, 'commands/list', {
      workspaceId: this.workspace.id,
      limit,
      ...(statuses ? { statuses: [...statuses] } : {}),
    }), 'commands/list') as unknown as CommandListResult;
    return result.commands;
  }

  async getCommand(commandId: string): Promise<CommandOutcome> {
    return asRecord(await this.transport.brokerCall(this.clientSessionId, 'commands/get', {
      workspaceId: this.workspace.id,
      commandId,
    }), 'commands/get') as unknown as CommandOutcome;
  }

  async cancelCommand(commandId: string): Promise<CommandOutcome> {
    return asRecord(await this.transport.brokerCall(this.clientSessionId, 'commands/cancel', {
      workspaceId: this.workspace.id,
      commandId,
    }), 'commands/cancel') as unknown as CommandOutcome;
  }

  async connectBrowser(browserId?: string): Promise<void> {
    const selected = browserId
      ? this.initialized.browsers.find(candidate => candidate.id === browserId)
      : this.initialized.browsers.find(candidate => candidate.state === 'ready') ?? this.initialized.browsers[0];
    if (!selected) {
      throw new BrowserPilotError('browser_not_found', 'No supported browser is available');
    }
    await this.callTool('browser.connect', { browserId: selected.id });
  }

  async listBrowsers(browser?: string): Promise<BrowserCandidate[]> {
    const result = await this.callTool('browser.discover', browser ? { browser } : {});
    if (!Array.isArray(result.browsers)) {
      throw new BrowserPilotError('internal_error', 'browser.discover returned invalid browsers');
    }
    return result.browsers as unknown as BrowserCandidate[];
  }

  async listTabs(scope: 'all' | 'managed_only' | 'user_tabs' = 'all'): Promise<CompatibilityTarget[]> {
    const result = await this.callTool('browser.tabs.list', { scope });
    if (!Array.isArray(result.targets)) {
      throw new BrowserPilotError('internal_error', 'browser.tabs.list returned invalid targets');
    }
    return result.targets as unknown as CompatibilityTarget[];
  }

  async listProfiles(): Promise<CompatibilityProfile[]> {
    const result = await this.callTool('browser.profiles.list');
    if (!Array.isArray(result.profiles)) {
      throw new BrowserPilotError('internal_error', 'browser.profiles.list returned invalid Profiles');
    }
    return result.profiles as unknown as CompatibilityProfile[];
  }

  async identifyProfiles(
    profileContextId?: ProfileContextId,
    refresh = false,
  ): Promise<CompatibilityProfile[]> {
    const result = await this.callTool('browser.profiles.identify', {
      ...(profileContextId ? { profileContextId } : {}),
      ...(refresh ? { refresh: true } : {}),
    });
    if (!Array.isArray(result.profiles)) {
      throw new BrowserPilotError('internal_error', 'browser.profiles.identify returned invalid Profiles');
    }
    return result.profiles as unknown as CompatibilityProfile[];
  }

  async selectProfile(profileContextId: ProfileContextId): Promise<CompatibilityProfile> {
    const result = await this.callTool('browser.profiles.select', { profileContextId });
    const profiles = await this.listProfiles();
    const selected = profiles.find(profile => profile.profileContextId === result.profileContextId);
    if (!selected) {
      throw new BrowserPilotError('profile_context_stale', 'Selected Profile context is no longer available', {
        retryable: true,
      });
    }
    return selected;
  }

  async ensureTarget(): Promise<CompatibilityTarget> {
    const targets = await this.listTabs('all');
    const selected = targets.find(isSelected) ??
      targets.find(target => target.origin !== 'user_tab');
    if (selected) {
      if (!isSelected(selected)) {
        await this.callTool('browser.tabs.switch', { targetId: selected.targetId });
        selected.selected = true;
      }
      return selected;
    }
    return this.openManagedTarget();
  }

  async ensureManagedTarget(): Promise<CompatibilityTarget> {
    const targets = await this.listTabs('managed_only');
    const selected = targets.find(isSelected) ?? targets[0];
    if (selected) {
      if (!isSelected(selected)) {
        await this.callTool('browser.tabs.switch', { targetId: selected.targetId });
        selected.selected = true;
      }
      return selected;
    }
    return this.openManagedTarget();
  }

  private async openManagedTarget(): Promise<CompatibilityTarget> {
    const opened = await this.callTool('browser.open', {
      url: 'about:blank',
      newTarget: true,
      observationLimit: 50,
    });
    return {
      targetId: opened.targetId as ControlledTargetId,
      profileContextId: opened.profileContextId as ProfileContextId,
      title: String(opened.title ?? ''),
      url: String(opened.url),
      selected: true,
      origin: 'managed',
      controlState: 'controlled',
    };
  }

  async latestObservation(targetId: ControlledTargetId): Promise<ObservationId> {
    const result = await this.callTool('browser.observation.latest', {}, targetId);
    if (typeof result.observationId !== 'string') {
      throw new BrowserPilotError('stale_ref', 'No current Observation exists for this target');
    }
    return result.observationId as ObservationId;
  }

  async importArtifact(path: string, mimeType?: string): Promise<ArtifactDescriptor> {
    const result = asRecord(await this.transport.brokerCall(this.clientSessionId, 'artifacts/import', {
      workspaceId: this.workspace.id,
      leaseId: this.lease.id,
      path,
      ...(mimeType ? { mimeType } : {}),
    }), 'artifacts/import');
    return asRecord(result.artifact, 'imported Artifact') as unknown as ArtifactDescriptor;
  }

  async listArtifacts(
    kinds?: readonly ArtifactDescriptor['kind'][],
  ): Promise<ArtifactDescriptor[]> {
    const result = asRecord(await this.transport.brokerCall(this.clientSessionId, 'artifacts/list', {
      workspaceId: this.workspace.id,
      leaseId: this.lease.id,
      ...(kinds ? { kinds: [...kinds] } : {}),
    }), 'artifacts/list');
    if (!Array.isArray(result.artifacts)) {
      throw new BrowserPilotError('internal_error', 'artifacts/list returned invalid Artifacts');
    }
    return result.artifacts as unknown as ArtifactDescriptor[];
  }

  async exportArtifact(artifactId: string, path: string): Promise<void> {
    await this.transport.brokerCall(this.clientSessionId, 'artifacts/export', {
      workspaceId: this.workspace.id,
      leaseId: this.lease.id,
      artifactId,
      path,
      overwrite: true,
    });
  }

  async releaseArtifact(artifactId: string): Promise<void> {
    await this.transport.brokerCall(this.clientSessionId, 'artifacts/release', {
      workspaceId: this.workspace.id,
      leaseId: this.lease.id,
      artifactId,
    });
  }

  async releaseWorkspace(): Promise<void> {
    await this.transport.brokerCall(this.clientSessionId, 'workspaces/release', {
      workspaceId: this.workspace.id,
    });
  }

  private commandId(sequence: number): CommandId {
    if (!this.invocation.requestId) {
      return `command:cli-${process.pid}-${sequence}-${randomUUID()}` as CommandId;
    }
    const digest = createHash('sha256')
      .update(this.workspace.clientKey ?? CLIENT_KEY)
      .update('\0')
      .update(this.invocation.requestId)
      .update('\0')
      .update(String(sequence))
      .digest('base64url')
      .slice(0, 32);
    return `command:cli-${digest}-${sequence}` as CommandId;
  }
}

async function validateDaemon(client: DaemonClient): Promise<void> {
  const health = await client.healthInfo();
  if (!health.ok) throw new BrowserPilotError('browser_disconnected', 'Browser Pilot daemon is unavailable');
  if (health.brokerProtocol !== BROKER_RPC_VERSION) {
    throw new BrowserPilotError('protocol_incompatible', 'Running Browser Pilot Broker uses an incompatible private transport', {
      context: {
        brokerRpcVersion: health.brokerProtocol,
        requiredBrokerRpcVersion: BROKER_RPC_VERSION,
        serviceVersion: health.serviceVersion,
        executableVersion: health.executableVersion,
      },
      remediation: {
        code: 'stop_incompatible_broker_or_isolate',
        message: 'Stop the running Broker with the Browser Pilot executable that started it, or set BROWSER_PILOT_HOME for a deliberately isolated Broker.',
        actionRequired: true,
      },
    });
  }
}

export async function connectCompatibility(
  executableVersion: string,
  browserFilter?: string,
  clientKey = CLIENT_KEY,
  invocation: CompatibilityInvocationOptions = {},
): Promise<CompatibilityBrokerClient> {
  const daemon = await connectDaemon(browserFilter);
  await validateDaemon(daemon);
  return CompatibilityBrokerClient.create(daemon, executableVersion, clientKey, invocation);
}

export async function resumeCompatibility(
  executableVersion: string,
  clientKey = CLIENT_KEY,
  invocation: CompatibilityInvocationOptions = {},
): Promise<CompatibilityBrokerClient | null> {
  if (!isDaemonRunning()) return null;
  const daemon = new DaemonClient();
  try {
    await validateDaemon(daemon);
    return await CompatibilityBrokerClient.create(daemon, executableVersion, clientKey, invocation);
  } catch (error) {
    if (error instanceof BrowserPilotError && error.code === 'protocol_incompatible') throw error;
    return null;
  }
}

export async function withCompatibilityTarget<T>(
  executableVersion: string,
  operation: (client: CompatibilityBrokerClient, target: CompatibilityTarget) => Promise<T>,
  clientKey = CLIENT_KEY,
  invocation: CompatibilityInvocationOptions = {},
): Promise<T> {
  const client = await resumeCompatibility(executableVersion, clientKey, invocation);
  if (!client) throw new Error('Not connected');
  const target = await client.ensureTarget();
  return operation(client, target);
}

export async function shutdownCompatibility(
  executableVersion: string,
  clientKey = CLIENT_KEY,
): Promise<void> {
  if (!isDaemonRunning()) return;
  const daemon = new DaemonClient();
  await validateDaemon(daemon);
  try {
    const client = await CompatibilityBrokerClient.create(daemon, executableVersion, clientKey);
    await client.releaseWorkspace();
  } catch (error) {
    // With no ready browser there cannot be a compatibility Workspace to release.
    if (!(error instanceof BrowserPilotError) || error.code !== 'browser_not_found') throw error;
  }
  const afterRelease = await daemon.healthInfo();
  if ((afterRelease.clients?.activeLeases ?? 0) > 0) {
    return;
  }
  if (
    !afterRelease.ok ||
    !afterRelease.brokerProcessIdentity ||
    !afterRelease.executableVersion ||
    !afterRelease.executableIdentity
  ) return;
  const requester = createExecutableMetadataSync(
    executableVersion,
    publicExecutablePath(import.meta.url),
  );
  if (
    requester.version !== afterRelease.executableVersion ||
    requester.identity !== afterRelease.executableIdentity
  ) return;
  await daemon.shutdown({
    brokerProcessIdentity: afterRelease.brokerProcessIdentity,
    executableVersion: requester.version,
    executableIdentity: requester.identity,
  });
}
