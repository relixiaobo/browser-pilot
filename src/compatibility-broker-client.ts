import { randomUUID } from 'node:crypto';
import { DaemonClient, isDaemonRunning } from './client.js';
import { connectDaemon } from './session.js';
import { createExecutableMetadataSync } from './broker-locator.js';
import { publicExecutablePath } from './runtime-layout.js';
import { BrowserPilotError } from './protocol/errors.js';
import {
  CAPABILITIES,
  type ArtifactDescriptor,
  type BrowserWorkspace,
  type ControlledTargetId,
  type ControlLease,
  type InitializeResult,
  type JsonValue,
  type ObservationId,
} from './protocol/model.js';

const BRIDGE_SESSION_ID = 'bridge:browser-pilot-cli';
const CLIENT_KEY = 'browser-pilot-cli';
const LEASE_TTL_MS = 5 * 60_000;

interface BrokerRpcTransport {
  brokerCall(bridgeSessionId: string, method: string, params?: JsonValue): Promise<JsonValue>;
}

interface WorkspaceCreateResult {
  workspace: BrowserWorkspace;
}

interface LeaseCreateResult {
  lease: ControlLease;
}

export interface CompatibilityTarget {
  targetId: ControlledTargetId;
  title: string;
  url: string;
  active: boolean;
  origin: 'managed' | 'managed_popup' | 'user_tab';
  managedTabSetId?: string;
  controlState: 'available' | 'controlled' | 'busy';
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
    readonly initialized: InitializeResult,
    readonly workspace: BrowserWorkspace,
    readonly lease: ControlLease,
  ) {}

  static async create(
    transport: BrokerRpcTransport,
    executableVersion: string,
  ): Promise<CompatibilityBrokerClient> {
    const initialized = asRecord(await transport.brokerCall(BRIDGE_SESSION_ID, 'initialize', {
      client: {
        id: 'org.browser-pilot.cli',
        name: 'Browser Pilot CLI',
        version: executableVersion,
        instanceId: 'local:one-shot',
      },
      protocol: { min: { major: 1, minor: 1 }, max: { major: 1, minor: 1 } },
      requestedCapabilities: [...CAPABILITIES],
      launchMode: 'one-shot',
    }), 'initialize') as unknown as InitializeResult;
    if (initialized.executableVersion !== executableVersion) {
      throw new BrowserPilotError('protocol_incompatible', 'Running Browser Pilot daemon is from another executable version', {
        remediation: {
          code: 'use_matching_executable_or_isolate',
          message: 'Use the matching Browser Pilot installation, or set BROWSER_PILOT_HOME for a deliberately isolated Broker.',
          actionRequired: true,
        },
      });
    }
    const created = asRecord(await transport.brokerCall(BRIDGE_SESSION_ID, 'workspaces/create', {
      clientKey: CLIENT_KEY,
    }), 'workspaces/create') as unknown as WorkspaceCreateResult;
    const leased = asRecord(await transport.brokerCall(BRIDGE_SESSION_ID, 'leases/create', {
      workspaceId: created.workspace.id,
      clientKey: CLIENT_KEY,
      ttlMs: LEASE_TTL_MS,
    }), 'leases/create') as unknown as LeaseCreateResult;
    return new CompatibilityBrokerClient(transport, initialized, created.workspace, leased.lease);
  }

  async callTool(
    name: string,
    args: Record<string, JsonValue> = {},
    targetId?: ControlledTargetId,
  ): Promise<Record<string, JsonValue>> {
    this.commandSequence += 1;
    return commandResult(await this.transport.brokerCall(BRIDGE_SESSION_ID, 'tools/call', {
      name,
      arguments: args,
      workspaceId: this.workspace.id,
      leaseId: this.lease.id,
      ...(targetId ? { targetId } : {}),
      commandId: `command:cli-${process.pid}-${this.commandSequence}-${randomUUID()}`,
      deadlineMs: 60_000,
    }), name);
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

  async listTabs(scope: 'all' | 'managed_only' | 'user_tabs' = 'all'): Promise<CompatibilityTarget[]> {
    const result = await this.callTool('browser.tabs.list', { scope });
    if (!Array.isArray(result.targets)) {
      throw new BrowserPilotError('internal_error', 'browser.tabs.list returned invalid targets');
    }
    return result.targets as unknown as CompatibilityTarget[];
  }

  async ensureTarget(): Promise<CompatibilityTarget> {
    const targets = await this.listTabs('all');
    const selected = targets.find(target => target.active) ??
      targets.find(target => target.origin !== 'user_tab');
    if (selected) {
      if (!selected.active) {
        await this.callTool('browser.tabs.switch', { targetId: selected.targetId });
        selected.active = true;
      }
      return selected;
    }
    return this.openManagedTarget();
  }

  async ensureManagedTarget(): Promise<CompatibilityTarget> {
    const targets = await this.listTabs('managed_only');
    const selected = targets.find(target => target.active) ?? targets[0];
    if (selected) {
      if (!selected.active) {
        await this.callTool('browser.tabs.switch', { targetId: selected.targetId });
        selected.active = true;
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
      title: String(opened.title ?? ''),
      url: String(opened.url),
      active: true,
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
    const result = asRecord(await this.transport.brokerCall(BRIDGE_SESSION_ID, 'artifacts/import', {
      workspaceId: this.workspace.id,
      leaseId: this.lease.id,
      path,
      ...(mimeType ? { mimeType } : {}),
    }), 'artifacts/import');
    return asRecord(result.artifact, 'imported Artifact') as unknown as ArtifactDescriptor;
  }

  async exportArtifact(artifactId: string, path: string): Promise<void> {
    await this.transport.brokerCall(BRIDGE_SESSION_ID, 'artifacts/export', {
      workspaceId: this.workspace.id,
      leaseId: this.lease.id,
      artifactId,
      path,
      overwrite: true,
    });
  }

  async releaseArtifact(artifactId: string): Promise<void> {
    await this.transport.brokerCall(BRIDGE_SESSION_ID, 'artifacts/release', {
      workspaceId: this.workspace.id,
      leaseId: this.lease.id,
      artifactId,
    });
  }

  async releaseWorkspace(): Promise<void> {
    await this.transport.brokerCall(BRIDGE_SESSION_ID, 'workspaces/release', {
      workspaceId: this.workspace.id,
    });
  }
}

async function validateDaemon(client: DaemonClient): Promise<void> {
  const health = await client.healthInfo();
  if (!health.ok) throw new BrowserPilotError('browser_disconnected', 'Browser Pilot daemon is unavailable');
  if (health.brokerProtocol !== 1) {
    throw new BrowserPilotError('protocol_incompatible', 'Running Browser Pilot daemon is from an older executable', {
      remediation: {
        code: 'use_compatible_executable_or_isolate',
        message: 'Use a compatible Browser Pilot executable, or set BROWSER_PILOT_HOME for a deliberately isolated Broker.',
        actionRequired: true,
      },
    });
  }
}

export async function connectCompatibility(
  executableVersion: string,
  browserFilter?: string,
): Promise<CompatibilityBrokerClient> {
  const daemon = await connectDaemon(browserFilter);
  await validateDaemon(daemon);
  return CompatibilityBrokerClient.create(daemon, executableVersion);
}

export async function resumeCompatibility(
  executableVersion: string,
): Promise<CompatibilityBrokerClient | null> {
  if (!isDaemonRunning()) return null;
  const daemon = new DaemonClient();
  try {
    await validateDaemon(daemon);
    return await CompatibilityBrokerClient.create(daemon, executableVersion);
  } catch (error) {
    if (error instanceof BrowserPilotError && error.code === 'protocol_incompatible') throw error;
    return null;
  }
}

export async function withCompatibilityTarget<T>(
  executableVersion: string,
  operation: (client: CompatibilityBrokerClient, target: CompatibilityTarget) => Promise<T>,
): Promise<T> {
  const client = await resumeCompatibility(executableVersion);
  if (!client) throw new Error('Not connected');
  const target = await client.ensureTarget();
  return operation(client, target);
}

export async function shutdownCompatibility(executableVersion: string): Promise<void> {
  if (!isDaemonRunning()) return;
  const daemon = new DaemonClient();
  await validateDaemon(daemon);
  const health = await daemon.healthInfo();
  if (
    !health.ok ||
    !health.brokerProcessIdentity ||
    !health.executableVersion ||
    !health.executableIdentity
  ) {
    throw new BrowserPilotError('protocol_incompatible', 'Running Browser Pilot Broker does not support protected shutdown', {
      remediation: {
        code: 'use_matching_executable_or_isolate',
        message: 'Use the Browser Pilot installation that started the Broker, or set BROWSER_PILOT_HOME for a deliberately isolated Broker.',
        actionRequired: true,
      },
    });
  }
  const requester = createExecutableMetadataSync(
    executableVersion,
    publicExecutablePath(import.meta.url),
  );
  if (
    requester.version !== health.executableVersion ||
    requester.identity !== health.executableIdentity
  ) {
    throw new BrowserPilotError('protocol_incompatible', 'This Browser Pilot installation does not own the running Broker', {
      context: {
        brokerExecutableVersion: health.executableVersion,
        requesterExecutableVersion: requester.version,
      },
      remediation: {
        code: 'use_matching_executable_or_isolate',
        message: 'Use the matching Browser Pilot installation, or set BROWSER_PILOT_HOME for a deliberately isolated Broker.',
        actionRequired: true,
      },
    });
  }
  try {
    const client = await CompatibilityBrokerClient.create(daemon, executableVersion);
    await client.releaseWorkspace();
  } catch (error) {
    // With no ready browser there cannot be a compatibility Workspace to release.
    if (!(error instanceof BrowserPilotError) || error.code !== 'browser_not_found') throw error;
  }
  await daemon.shutdown({
    brokerProcessIdentity: health.brokerProcessIdentity,
    executableVersion: requester.version,
    executableIdentity: requester.identity,
  });
}
