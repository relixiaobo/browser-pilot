export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

declare const opaqueId: unique symbol;
export type OpaqueId<T extends string> = string & { readonly [opaqueId]: T };

export type ClientPrincipalId = OpaqueId<'ClientPrincipalId'>;
export type ClientConnectionId = OpaqueId<'ClientConnectionId'>;
export type BrowserInstanceId = OpaqueId<'BrowserInstanceId'>;
export type ProfileContextId = OpaqueId<'ProfileContextId'>;
export type BrowserWorkspaceId = OpaqueId<'BrowserWorkspaceId'>;
export type ManagedTabSetId = OpaqueId<'ManagedTabSetId'>;
export type ControlLeaseId = OpaqueId<'ControlLeaseId'>;
export type ControlledTargetId = OpaqueId<'ControlledTargetId'>;
export type ObservationId = OpaqueId<'ObservationId'>;
export type CommandId = OpaqueId<'CommandId'>;
export type ArtifactId = OpaqueId<'ArtifactId'>;
export type BrowserEventId = OpaqueId<'BrowserEventId'>;
export type EventCursor = OpaqueId<'EventCursor'>;
export type NetworkRequestId = OpaqueId<'NetworkRequestId'>;
export type NetworkRuleId = OpaqueId<'NetworkRuleId'>;
export type FrameId = OpaqueId<'FrameId'>;

export interface ProtocolVersion {
  major: number;
  minor: number;
}

export interface ProtocolRange {
  min: ProtocolVersion;
  max: ProtocolVersion;
}

export const SUPPORTED_PROTOCOL_VERSIONS = [
  { major: 1, minor: 0 },
  { major: 1, minor: 1 },
  { major: 1, minor: 2 },
  { major: 1, minor: 3 },
  { major: 1, minor: 4 },
] as const satisfies readonly ProtocolVersion[];

export const CAPABILITIES = [
  'browser.discovery',
  'browser.control',
  'workspace.manage',
  'observation.read',
  'action.input',
  'artifact.read',
  'event.read',
  'network.observe',
  'network.modify',
  'auth.manage',
  'cookies.read',
  'developer.eval',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const DEFAULT_CAPABILITIES: readonly Capability[] = CAPABILITIES;

export interface ClientIdentity {
  id: string;
  name: string;
  version: string;
  instanceId: string;
}

export interface TransportLimitPreferences {
  maxMessageBytes?: number;
  maxResultBytes?: number;
}

export interface InitializeParams {
  client: ClientIdentity;
  protocol: ProtocolRange;
  requestedCapabilities: string[];
  limits?: TransportLimitPreferences;
}

export interface CapabilityNegotiation {
  granted: Capability[];
  denied: Capability[];
  unsupported: string[];
}

export type BrowserSetupState =
  | 'ready'
  | 'not_running'
  | 'remote_debugging_disabled'
  | 'authorization_required'
  | 'disconnected';

export type BrowserProcessState = 'running' | 'not_running' | 'unknown';
export type BrowserRemoteDebuggingState = 'enabled' | 'disabled' | 'stale';
export type BrowserAuthorizationState = 'authorized' | 'required' | 'not_applicable' | 'unknown';

export interface BrowserCandidate {
  id: string;
  product: string;
  channel?: string;
  userDataRoot?: string;
  /** @deprecated Protocol 1.0-1.2 alias for userDataRoot. */
  profile?: string;
  processState: BrowserProcessState;
  remoteDebuggingState: BrowserRemoteDebuggingState;
  authorizationState: BrowserAuthorizationState;
  state: BrowserSetupState;
  remediation?: {
    code: string;
    message: string;
    actionRequired: boolean;
  };
}

export interface InitializeResult {
  serviceVersion: string;
  executableVersion: string;
  protocol: ProtocolVersion;
  supportedCapabilities: Capability[];
  capabilities: CapabilityNegotiation;
  brokerProcessIdentity: string;
  connectionId: ClientConnectionId;
  browsers: BrowserCandidate[];
  limits: ProtocolLimits;
}

export interface ProtocolLimits {
  maxMessageBytes: number;
  maxResultBytes: number;
  maxArtifactBytes: number;
  eventJournalSize: number;
}

export interface WorkspaceCreateParams {
  browserId?: string;
  clientKey?: string;
}

export interface WorkspaceGetParams {
  workspaceId: BrowserWorkspaceId;
}

export interface WorkspaceReleaseParams {
  workspaceId: BrowserWorkspaceId;
}

export interface WorkspaceResult {
  workspace: BrowserWorkspace;
  managedTabSet: ManagedTabSet;
  eventCursor: EventCursor;
}

export interface WorkspaceReleaseResult {
  workspaceId: BrowserWorkspaceId;
  released: true;
}

export interface LeaseCreateParams {
  workspaceId: BrowserWorkspaceId;
  ttlMs?: number;
  clientKey?: string;
}

export interface LeaseHeartbeatParams {
  leaseId: ControlLeaseId;
  ttlMs?: number;
}

export interface LeaseReleaseParams {
  leaseId: ControlLeaseId;
}

export interface LeaseResult {
  lease: ControlLease;
}

export interface LeaseReleaseResult {
  leaseId: ControlLeaseId;
  released: true;
}

export interface ToolCallParams {
  name: string;
  arguments: JsonValue;
  workspaceId?: BrowserWorkspaceId;
  leaseId?: ControlLeaseId;
  targetId?: ControlledTargetId;
  commandId?: CommandId;
  idempotencyKey?: string;
  deadlineMs?: number;
}

export interface CommandAccessParams {
  commandId: CommandId;
  workspaceId?: BrowserWorkspaceId;
}

export interface CommandListParams {
  workspaceId: BrowserWorkspaceId;
  limit?: number;
  statuses?: CommandStatus[];
}

export interface EventsPollParams {
  workspaceId: BrowserWorkspaceId;
  cursor: EventCursor;
  limit?: number;
}

export interface ArtifactAccessParams {
  workspaceId: BrowserWorkspaceId;
  leaseId: ControlLeaseId;
  artifactId: ArtifactId;
}

export interface ArtifactListParams {
  workspaceId: BrowserWorkspaceId;
  leaseId: ControlLeaseId;
  kinds?: ArtifactDescriptor['kind'][];
}

export interface ArtifactExportParams extends ArtifactAccessParams {
  path: string;
  overwrite?: boolean;
}

export interface ArtifactImportParams {
  workspaceId: BrowserWorkspaceId;
  leaseId: ControlLeaseId;
  path: string;
  mimeType?: string;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: JsonValue;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: JsonValue;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result: JsonValue;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface ClientPrincipal {
  id: ClientPrincipalId;
  productId: string;
  displayName: string;
  createdAt: number;
  capabilities: Capability[];
}

export interface ClientConnection {
  id: ClientConnectionId;
  principalId: ClientPrincipalId;
  clientInstanceId: string;
  protocol: ProtocolVersion;
  connectedAt: number;
  lastSeenAt: number;
}

export interface BrowserInstance {
  id: BrowserInstanceId;
  product: string;
  userDataRoot: string;
  processIdentity: string;
  connectionGeneration: number;
  state: 'connected' | 'disconnected' | 'reconnecting';
}

export const PROFILE_IDENTITY_ERROR_CODES = [
  'profile_path_unavailable',
  'profile_path_unverified',
  'local_state_unavailable',
  'profile_metadata_missing',
] as const;

export type ProfileIdentityErrorCode = (typeof PROFILE_IDENTITY_ERROR_CODES)[number];

export interface ProfileContext {
  id: ProfileContextId;
  browserInstanceId: BrowserInstanceId;
  browserConnectionGeneration: number;
  label: string;
  identityStatus: 'unidentified' | 'verified' | 'unavailable';
  profileName?: string;
  accountName?: string;
  accountEmail?: string;
  profileDirectory?: string;
  identityErrorCode?: ProfileIdentityErrorCode;
  /** @deprecated Protocol 1.2 alias for profileName. */
  displayName?: string;
  tabCount: number;
  eligibleTabCount: number;
}

export interface BrowserWorkspace {
  id: BrowserWorkspaceId;
  principalId: ClientPrincipalId;
  browserInstanceId: BrowserInstanceId;
  selectedProfileContextId?: ProfileContextId;
  clientKey?: string;
  createdAt: number;
  updatedAt: number;
  state: 'active' | 'releasing' | 'released';
}

export interface ManagedTabSet {
  id: ManagedTabSetId;
  workspaceId: BrowserWorkspaceId;
  browserInstanceId: BrowserInstanceId;
  profileContextId?: ProfileContextId;
  windowId?: number;
  createdAt: number;
  state: 'active' | 'closing' | 'closed';
}

export interface ControlLease {
  id: ControlLeaseId;
  workspaceId: BrowserWorkspaceId;
  connectionId: ClientConnectionId;
  clientKey?: string;
  capabilities: Capability[];
  createdAt: number;
  lastHeartbeatAt: number;
  expiresAt: number;
  state: 'active' | 'expired' | 'released';
}

export const BROWSER_OPERATIONS = [
  'tabs.list',
  'page.observe',
  'page.interact',
  'page.navigate',
  'page.capture',
  'files.upload',
  'tabs.close',
  'dialogs.manage',
  'auth.manage',
  'cookies.read',
  'network.observe',
  'network.modify',
  'developer.eval',
] as const;
export type BrowserOperation = (typeof BROWSER_OPERATIONS)[number];

export type ControlledTargetOrigin = 'managed' | 'managed_popup' | 'user_tab';

export interface ControlledTarget {
  id: ControlledTargetId;
  workspaceId: BrowserWorkspaceId;
  browserInstanceId: BrowserInstanceId;
  profileContextId: ProfileContextId;
  cdpTargetId: string;
  openerCdpTargetId?: string;
  origin: ControlledTargetOrigin;
  managedTabSetId?: ManagedTabSetId;
  controllerLeaseId?: ControlLeaseId;
  url: string;
  createdAt: number;
  state: 'active' | 'detached' | 'closed';
}

export interface ObservationRef {
  workspaceId: BrowserWorkspaceId;
  observationId: ObservationId;
  ref: number;
}

export const OBSERVATION_INVALIDATION_REASONS = [
  'navigation',
  'loader_replaced',
  'document_replaced',
  'frame_changed',
  'frame_detached',
  'session_replaced',
  'target_detached',
  'browser_reconnected',
  'target_ineligible',
  'target_closed',
  'control_released',
  'expired',
] as const;

export type ObservationInvalidationReason = (typeof OBSERVATION_INVALIDATION_REASONS)[number];

export const OBSERVATION_TRUNCATION_REASONS = [
  'element_limit',
  'text_limit',
  'depth_limit',
  'byte_limit',
  'work_limit',
] as const;

export type ObservationTruncationReason = (typeof OBSERVATION_TRUNCATION_REASONS)[number];

export const OBSERVATION_V1_LIMITS = {
  defaultElements: 50,
  maxElements: 10_000,
  maxTitleCharacters: 4_096,
  maxUrlCharacters: 16_384,
  maxElementNameCharacters: 4_096,
  maxElementValueCharacters: 65_536,
  maxTextCharacters: 1_000_000,
  maxTreeDepth: 128,
  maxDomTextNodes: 100_000,
  maxSerializedBytes: 2 * 1024 * 1024,
  ttlMs: 5 * 60_000,
  maxStoredObservations: 2_048,
} as const;

export interface ObservationElement {
  ref: number;
  role: string;
  name: string;
  value?: string;
  checked?: boolean;
}

export interface PageGeometry {
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
  scrollX: number;
  scrollY: number;
  pixelsAbove: number;
  pixelsBelow: number;
  pixelsLeft: number;
  pixelsRight: number;
  scrollPercentX: number;
  scrollPercentY: number;
}

export interface ObservationDescriptor {
  id: ObservationId;
  workspaceId: BrowserWorkspaceId;
  targetId: ControlledTargetId;
  browserConnectionGeneration: number;
  createdAt: number;
  expiresAt: number;
  elementCount: number;
  truncated: boolean;
  truncationReasons: ObservationTruncationReason[];
  invalidatedBy?: ObservationInvalidationReason;
}

export type CommandStatus =
  | 'accepted'
  | 'dispatched'
  | 'completed'
  | 'unknown_outcome'
  | 'cancelled'
  | 'expired';

export interface CommandDescriptor {
  id: CommandId;
  workspaceId?: BrowserWorkspaceId;
  leaseId?: ControlLeaseId;
  targetId?: ControlledTargetId;
  browserConnectionGeneration?: number;
  idempotencyKey: string;
  method: string;
  mutating: boolean;
  status: CommandStatus;
  acceptedAt: number;
  deadlineAt: number;
  dispatchedAt?: number;
  completedAt?: number;
  cancellationRequested?: boolean;
}

export interface CommandOutcome {
  command: CommandDescriptor;
  result?: JsonValue;
  error?: JsonRpcErrorObject;
}

export const SENSITIVITIES = [
  'public',
  'browser_data',
  'credential',
  'user_file',
] as const;

export type Sensitivity = (typeof SENSITIVITIES)[number];

export interface ArtifactDescriptor {
  id: ArtifactId;
  workspaceId: BrowserWorkspaceId;
  kind: 'screenshot' | 'screenshot_preview' | 'pdf' | 'download' | 'upload_input';
  mimeType: string;
  byteSize: number;
  fileName?: string;
  width?: number;
  height?: number;
  sensitivity: Sensitivity;
  createdAt: number;
  expiresAt: number;
  retained: boolean;
  previewOf?: ArtifactId;
}

export type AgentHint =
  | {
    code: 'autocomplete';
    source: 'observation';
    confidence: 'strong' | 'possible';
    recommendedAction: 'observe_then_select';
    refs: number[];
  }
  | {
    code: 'modal_overlay';
    source: 'observation';
    confidence: 'strong' | 'possible';
    recommendedAction: 'resolve_overlay_first';
    blocking: boolean;
    refs: number[];
  }
  | {
    code: 'filter_controls';
    source: 'observation';
    confidence: 'strong';
    recommendedAction: 'review_refinement_controls';
    refs: number[];
  }
  | {
    code: 'access_blocked';
    source: 'network';
    confidence: 'strong';
    recommendedAction: 'avoid_same_navigation_retry';
    status: 403 | 429;
  }
  | {
    code: 'authentication_surface';
    source: 'observation';
    confidence: 'strong';
    recommendedAction: 'inspect_authentication_state';
    state: 'present' | 'entered' | 'left';
  }
  | {
    code: 'download';
    source: 'download';
    confidence: 'strong';
    recommendedAction: 'wait_for_download';
    state: 'started';
  }
  | {
    code: 'download';
    source: 'download';
    confidence: 'strong';
    recommendedAction: 'inspect_download_artifact';
    state: 'completed';
    artifactId: ArtifactId;
  }
  | {
    code: 'download';
    source: 'download';
    confidence: 'strong';
    recommendedAction: 'inspect_download_failure';
    state: 'failed' | 'cancelled';
    reason: string;
  }
  | {
    code: 'repeated_action';
    source: 'watchdog';
    confidence: 'strong';
    recommendedAction: 'change_strategy';
    streak: number;
    reason: string;
  };

/**
 * Durable per-site knowledge matching the observed URL, delivered on the
 * observation itself so it reaches the Agent before it acts. Unlike AgentHint,
 * which is recomputed from the current page every time, a site entry is
 * user-owned reference prose the Broker never interprets. Protocol 1.4.
 */
export type SiteKnowledgeDelivery =
  | {
    /** First delivery of this version to this Agent: the whole file body. */
    status: 'full';
    name: string;
    summary: string;
    path: string;
    updated?: string;
    body: string;
  }
  | {
    /**
     * Already delivered at this version, or too large for the inline budget.
     * `path` lets an Agent whose context was compacted read the file again.
     */
    status: 'seen';
    name: string;
    summary: string;
    path: string;
  }
  | {
    /** A file that cannot be used, reported so its author can repair it. */
    status: 'invalid';
    path: string;
    reason: string;
  };

export type BrowserEventType =
  | 'navigation'
  | 'document.changed'
  | 'target.attached'
  | 'target.detached'
  | 'target_control.acquired'
  | 'target_control.released'
  | 'popup'
  | 'dialog'
  | 'download'
  | 'connection.lost'
  | 'connection.restored'
  | 'network.request'
  | 'network.response'
  | 'command.status'
  | 'observation.invalidated'
  | 'watchdog.navigation_stalled'
  | 'watchdog.frame_detached'
  | 'watchdog.dialog_unhandled'
  | 'watchdog.no_progress'
  | 'lease.expired';

export interface BrowserEvent {
  id: BrowserEventId;
  sequence: number;
  timestamp: number;
  workspaceId: BrowserWorkspaceId;
  browserConnectionGeneration: number;
  leaseId?: ControlLeaseId;
  targetId?: ControlledTargetId;
  type: BrowserEventType;
  payloadVersion: number;
  sensitivity: Sensitivity;
  payload: JsonValue;
}

export interface EventsPollResult {
  workspaceId: BrowserWorkspaceId;
  events: BrowserEvent[];
  nextCursor: EventCursor;
  hasMore: boolean;
}
