export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

declare const opaqueId: unique symbol;
export type OpaqueId<T extends string> = string & { readonly [opaqueId]: T };

export type ClientPrincipalId = OpaqueId<'ClientPrincipalId'>;
export type ClientConnectionId = OpaqueId<'ClientConnectionId'>;
export type BrowserInstanceId = OpaqueId<'BrowserInstanceId'>;
export type BrowserWorkspaceId = OpaqueId<'BrowserWorkspaceId'>;
export type ManagedTabSetId = OpaqueId<'ManagedTabSetId'>;
export type ControlLeaseId = OpaqueId<'ControlLeaseId'>;
export type ControlledTargetId = OpaqueId<'ControlledTargetId'>;
export type ObservationId = OpaqueId<'ObservationId'>;
export type CommandId = OpaqueId<'CommandId'>;
export type ArtifactId = OpaqueId<'ArtifactId'>;
export type BrowserEventId = OpaqueId<'BrowserEventId'>;

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

export type LaunchMode = 'one-shot' | 'embedded';

export interface InitializeParams {
  client: ClientIdentity;
  protocol: ProtocolRange;
  requestedCapabilities: string[];
  launchMode: LaunchMode;
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

export interface BrowserCandidate {
  id: string;
  product: string;
  channel?: string;
  profile?: string;
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
}

export interface WorkspaceReleaseResult {
  workspaceId: BrowserWorkspaceId;
  released: true;
}

export interface LeaseCreateParams {
  workspaceId: BrowserWorkspaceId;
  ttlMs?: number;
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
}

export interface ArtifactAccessParams {
  workspaceId: BrowserWorkspaceId;
  leaseId: ControlLeaseId;
  artifactId: ArtifactId;
}

export interface ArtifactExportParams extends ArtifactAccessParams {
  path: string;
  overwrite?: boolean;
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
  profilePath: string;
  processIdentity: string;
  connectionGeneration: number;
  state: 'connected' | 'disconnected' | 'reconnecting';
}

export interface BrowserWorkspace {
  id: BrowserWorkspaceId;
  principalId: ClientPrincipalId;
  browserInstanceId: BrowserInstanceId;
  createdAt: number;
  updatedAt: number;
  state: 'active' | 'releasing' | 'released';
}

export interface ManagedTabSet {
  id: ManagedTabSetId;
  workspaceId: BrowserWorkspaceId;
  browserInstanceId: BrowserInstanceId;
  windowId?: number;
  createdAt: number;
  state: 'active' | 'closing' | 'closed';
}

export interface ControlLease {
  id: ControlLeaseId;
  workspaceId: BrowserWorkspaceId;
  connectionId: ClientConnectionId;
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

export type ObservationInvalidationReason =
  | 'navigation'
  | 'loader_replaced'
  | 'frame_detached'
  | 'session_replaced'
  | 'target_detached'
  | 'browser_reconnected'
  | 'target_ineligible'
  | 'target_closed'
  | 'expired';

export interface ObservationDescriptor {
  id: ObservationId;
  workspaceId: BrowserWorkspaceId;
  targetId: ControlledTargetId;
  browserConnectionGeneration: number;
  createdAt: number;
  expiresAt: number;
  elementCount: number;
  truncated: boolean;
  truncationReasons: Array<'element_limit' | 'text_limit' | 'depth_limit' | 'byte_limit'>;
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
  workspaceId: BrowserWorkspaceId;
  leaseId: ControlLeaseId;
  targetId: ControlledTargetId;
  idempotencyKey: string;
  method: string;
  mutating: boolean;
  status: CommandStatus;
  acceptedAt: number;
  deadlineAt: number;
  dispatchedAt?: number;
  completedAt?: number;
}

export type Sensitivity = 'public' | 'browser_data' | 'credential' | 'user_file';

export interface ArtifactDescriptor {
  id: ArtifactId;
  workspaceId: BrowserWorkspaceId;
  kind: 'screenshot' | 'screenshot_preview' | 'pdf' | 'download' | 'upload_receipt';
  mimeType: string;
  byteSize: number;
  width?: number;
  height?: number;
  sensitivity: Sensitivity;
  createdAt: number;
  expiresAt: number;
  retained: boolean;
  previewOf?: ArtifactId;
}

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
  | 'lease.expired';

export interface BrowserEvent {
  id: BrowserEventId;
  sequence: number;
  timestamp: number;
  workspaceId: BrowserWorkspaceId;
  leaseId?: ControlLeaseId;
  targetId?: ControlledTargetId;
  type: BrowserEventType;
  payloadVersion: number;
  sensitivity: Sensitivity;
  payload: JsonValue;
}
