import { createHash, randomUUID } from 'node:crypto';
import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import {
  OBSERVATION_V1_LIMITS,
  type AgentHint,
  type ArtifactDescriptor,
  type ArtifactId,
  type BrowserInstance,
  type BrowserOperation,
  type BrowserWorkspaceId,
  type ControlledTargetId,
  type ControlLease,
  type ControlLeaseId,
  type FrameId,
  type JsonValue,
  type ManagedTabSetId,
  type NetworkRequestId,
  type NetworkRuleId,
  type ObservationId,
  type ObservationInvalidationReason,
  type ProfileContextId,
} from '../protocol/model.js';
import type { ToolDefinition } from '../protocol/tools.js';
import { INJECT_BORDER } from '../page-scripts.js';
import { MemoryRefStore, type RefStore, type SnapshotResult } from '../snapshot.js';
import type { Transport } from '../transport.js';
import { PageLoadTimeoutError, waitForLoad } from '../session.js';
import {
  ActionService,
  type ClickActionResult,
  type ClickEffect,
  type ClickVerificationEvidence,
  type InputVerificationEvidence,
  type PressActionResult,
  type PressEffect,
  type PressVerificationEvidence,
} from './action-service.js';
import {
  CdpActionContinuityGuard,
  type ActionContinuityFailureReason,
} from './action-continuity.js';
import { ArtifactStore } from './artifact-store.js';
import { DownloadController } from './download-controller.js';
import { CdpBrowserTargetCatalog } from './browser-target-catalog.js';
import { createBrowserControlPolicy } from './browser-control-policy.js';
import {
  observationAgentHints,
} from './agent-hint-service.js';
import {
  BrowserWatchdogService,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
} from './browser-watchdog-service.js';
import {
  MemoryControlledTargetRegistry,
  type ControlledTargetRecord,
} from './controlled-target-registry.js';
import { CookieService } from './cookie-service.js';
import { CaptureService } from './capture-service.js';
import {
  DropdownService,
  type DropdownChoice,
  type DropdownInfo,
  type DropdownOption,
  type SelectVerificationEvidence,
} from './dropdown-service.js';
import {
  FrameService,
  type FrameTargetAttachment,
  type FrameTargetInfo,
  type SessionPageFrame,
} from './frame-service.js';
import { MemoryObservationStore, type StoredObservation } from './observation-store.js';
import { ObservationService } from './observation-service.js';
import { PageContentService } from './page-content-service.js';
import { PageInspectionService } from './page-inspection-service.js';
import { RefRevalidationService } from './ref-revalidation-service.js';
import {
  ScrollService,
  type ElementScrollInput,
  type ScrollEvidence,
} from './scroll-service.js';
import {
  ScreenshotAnnotationService,
  type ScreenshotAnnotation,
  type ScreenshotViewport,
} from './screenshot-annotation-service.js';
import {
  ManagedTargetCreationRejectedError,
  TransportManagedTargetLifecycle,
  type ManagedTargetLifecycle,
} from './managed-target-lifecycle.js';
import { TargetInventoryService, type TargetInventoryContext } from './target-inventory-service.js';
import {
  MemoryProfileContextRegistry,
  type ProfileContextRecord,
} from './profile-context-registry.js';
import { UploadService, type UploadVerificationEvidence } from './upload-service.js';
import {
  WorkspaceNetworkController,
  type WorkspaceNetworkRuleInput,
} from './workspace-network-controller.js';
import type {
  BrokerBrowserBinding,
  BrowserEventPublication,
  BrokerToolCallContext,
  BrowserToolExecutor,
} from './broker-runtime.js';

export const BASE_BROWSER_TOOL_NAMES = [
  'browser.discover',
  'browser.connect',
  'browser.profiles.list',
  'browser.profiles.select',
  'browser.open',
  'browser.observe',
  'browser.observation.latest',
  'browser.locate',
  'browser.read',
  'browser.search',
  'browser.elements.find',
  'browser.scroll',
  'browser.dropdown.options',
  'browser.dropdown.select',
  'browser.click',
  'browser.type',
  'browser.keyboard',
  'browser.press',
  'browser.tabs.list',
  'browser.tabs.switch',
  'browser.tabs.close',
  'browser.tabs.release',
  'browser.frames.list',
  'browser.frames.switch',
  'browser.dialogs.list',
  'browser.dialogs.respond',
  'browser.auth.set',
  'browser.auth.clear',
  'browser.cookies.list',
  'browser.network.requests',
  'browser.network.request',
  'browser.network.clear',
  'browser.network.rules.list',
  'browser.network.rules.add',
  'browser.network.rules.remove',
  'browser.eval',
] as const;

export const ARTIFACT_BROWSER_TOOL_NAMES = [
  'browser.capture',
  'browser.pdf',
  'browser.upload',
] as const;

export const ALL_BROWSER_TOOL_NAMES = [
  ...BASE_BROWSER_TOOL_NAMES,
  ...ARTIFACT_BROWSER_TOOL_NAMES,
] as const;

const PREVIEW_MAX_DIMENSION = 1600;
const PREVIEW_MAX_PIXELS = 2_000_000;

interface TargetSession {
  workspaceId: BrowserWorkspaceId;
  leaseId: ControlLeaseId;
  targetId: ControlledTargetId;
  browserConnectionGeneration: number;
  cdpTargetId: string;
  sessionId: string;
  activeFrame?: ActiveFrame;
}

interface ActiveFrame {
  id: FrameId;
  cdpFrameId: string;
  sessionId: string;
  cdpTargetId: string;
  executionContextId?: number;
}

interface BrokerFrameRecord extends ActiveFrame {
  parentCdpFrameId?: string;
  loaderId?: string;
  url: string;
  name: string;
}

interface SessionFrames {
  byId: Map<FrameId, BrokerFrameRecord>;
  byCdpId: Map<string, BrokerFrameRecord>;
  topFrameId: FrameId;
}

interface ChildFrameSession extends FrameTargetAttachment {
  parentFrameId: string;
}

interface CreatedObservation {
  snapshot: SnapshotResult;
  record: StoredObservation;
  hints: AgentHint[];
}

interface ObservationContextIdentity {
  frameId: string;
  loaderId: string;
  documentGeneration: string;
}

interface ActionServiceHarness {
  service: ActionService;
  observation(): CreatedObservation | undefined;
}

type ElementAddress =
  | { observationId: ObservationId; ref: number }
  | { selector: string };

interface ActionSignalSnapshot {
  loaderId: string;
  url?: string;
  dialogSequence: number;
  popupSequence: number;
}

type BrokerActionEffect =
  | 'navigation'
  | 'document_changed'
  | 'dialog_opened'
  | 'popup_opened';

type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload';

interface PendingDialog {
  id: string;
  workspaceId: BrowserWorkspaceId;
  leaseId: ControlLeaseId;
  targetId: ControlledTargetId;
  browserConnectionGeneration: number;
  sessionId: string;
  type: DialogType;
  message: string;
  defaultPrompt: string;
  url: string;
  openedAt: number;
}

interface PendingDialogResponse extends Record<string, JsonValue> {
  action: 'accept' | 'dismiss';
  promptTextProvided: boolean;
}

interface PopupSignal {
  sequence: number;
  openerCdpTargetId: string;
}

const DIALOG_TYPES = new Set<DialogType>(['alert', 'confirm', 'prompt', 'beforeunload']);
const READ_ANNOTATION_RECT = `function() {
  if(!this||this.nodeType!==1||!this.isConnected)return null;
  const style=getComputedStyle(this);
  if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return null;
  const rect=this.getBoundingClientRect();
  if(!Number.isFinite(rect.x)||!Number.isFinite(rect.y)||rect.width<=0||rect.height<=0)return null;
  return{x:rect.x,y:rect.y,width:rect.width,height:rect.height};
}`;

function asRecord(value: JsonValue): Record<string, JsonValue> {
  return value as Record<string, JsonValue>;
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function stateFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
}

function elementAddress(value: JsonValue): ElementAddress {
  const record = asRecord(value);
  if (typeof record.selector === 'string') return { selector: record.selector };
  return {
    observationId: record.observationId as ObservationId,
    ref: Number(record.ref),
  };
}

function dropdownChoice(value: JsonValue): DropdownChoice {
  const record = asRecord(value);
  if (record.by === 'index') return { by: 'index', index: Number(record.index) };
  if (record.by === 'label') {
    return { by: 'label', label: String(record.label), exact: record.exact !== false };
  }
  return { by: 'value', value: String(record.value), exact: record.exact !== false };
}

function optionMatches(option: Pick<DropdownOption, 'index' | 'label' | 'value'>, choice: DropdownChoice): boolean {
  if (choice.by === 'index') return option.index === choice.index;
  const actual = (choice.by === 'label' ? option.label : option.value).trim().toLocaleLowerCase();
  const expected = (choice.by === 'label' ? choice.label : choice.value).trim().toLocaleLowerCase();
  return choice.exact ? actual === expected : actual.includes(expected);
}

function sessionKey(leaseId: ControlLeaseId, targetId: ControlledTargetId): string {
  return `${leaseId}\u0000${targetId}`;
}

function fixedRefStore(targetId: ControlledTargetId, observation: StoredObservation): RefStore {
  const store = new MemoryRefStore();
  store.save(targetId, observation.refs);
  return store;
}

function refsChanged(before: StoredObservation, after: StoredObservation): boolean {
  const sharedLength = Math.min(before.refs.length, after.refs.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const ref = before.refs[index];
    const next = after.refs[index];
    if (!next ||
      ref.backendNodeId !== next.backendNodeId ||
      ref.role !== next.role ||
      ref.name !== next.name
    ) return true;
  }
  if (before.refs.length === after.refs.length) return false;
  return !before.truncated && !after.truncated;
}

export interface BrowserToolServiceOptions {
  observations?: MemoryObservationStore;
  artifactStore?: ArtifactStore;
  managedTargets?: ManagedTargetLifecycle;
  navigationTimeoutMs?: number;
  dialogTimeoutMs?: number;
  noProgressThreshold?: number;
  loadWaiter?: typeof waitForLoad;
  connectBrowser?: () => Promise<void>;
}

export class BrowserToolService implements BrowserToolExecutor {
  readonly supportedTools: readonly string[];

  private readonly registry = new MemoryControlledTargetRegistry();
  private readonly observations: MemoryObservationStore;
  private readonly inventory: TargetInventoryService;
  private readonly profileContexts: MemoryProfileContextRegistry;
  private readonly sessions = new Map<string, TargetSession>();
  private readonly guidanceBySession = new Map<string, {
    frameId?: string;
    guidance: SnapshotResult['guidance'];
  }>();
  private readonly managedWindowIds = new Map<ManagedTabSetId, number>();
  private readonly ownedSessionIds = new Set<string>();
  private readonly framesBySession = new Map<string, SessionFrames>();
  private readonly childFrameSessions = new Map<string, Map<string, ChildFrameSession>>();
  private readonly pendingDialogs = new Map<string, PendingDialog>();
  private readonly pendingDialogBySession = new Map<string, string>();
  private readonly dialogResponseBySession = new Map<string, PendingDialogResponse>();
  private readonly dialogOpenSequenceBySession = new Map<string, number>();
  private dialogOpenSequence = 0;
  private readonly popupSignals: PopupSignal[] = [];
  private popupSequence = 0;
  private readonly artifactStore?: ArtifactStore;
  private readonly managedTargets: ManagedTargetLifecycle;
  private readonly downloads?: DownloadController;
  private readonly network: WorkspaceNetworkController;
  private readonly watchdogs: BrowserWatchdogService;
  private readonly navigationTimeoutMs: number;
  private readonly loadWaiter: typeof waitForLoad;
  private readonly connectBrowser?: () => Promise<void>;
  private eventPublisher?: (event: BrowserEventPublication) => void;

  constructor(
    private readonly transport: Transport,
    private readonly binding: BrokerBrowserBinding,
    options: BrowserToolServiceOptions = {},
  ) {
    this.observations = options.observations ?? new MemoryObservationStore();
    this.artifactStore = options.artifactStore;
    this.managedTargets = options.managedTargets ?? new TransportManagedTargetLifecycle(transport);
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.navigationTimeoutMs) || this.navigationTimeoutMs <= 0) {
      throw new Error('navigationTimeoutMs must be a positive integer');
    }
    this.loadWaiter = options.loadWaiter ?? waitForLoad;
    this.connectBrowser = options.connectBrowser;
    this.watchdogs = new BrowserWatchdogService(event => this.publishEvent(event), {
      dialogTimeoutMs: options.dialogTimeoutMs,
      noProgressThreshold: options.noProgressThreshold,
    });
    this.downloads = this.artifactStore
      ? new DownloadController(transport, this.artifactStore, {
        publishEvent: event => this.publishEvent(event),
      })
      : undefined;
    this.network = new WorkspaceNetworkController(transport, {
      publishEvent: event => this.publishEvent(event),
    });
    this.supportedTools = this.artifactStore
      ? ALL_BROWSER_TOOL_NAMES
      : BASE_BROWSER_TOOL_NAMES;
    this.profileContexts = new MemoryProfileContextRegistry(binding.instance.id);
    const catalog = new CdpBrowserTargetCatalog(
      transport,
      binding.instance.id,
      () => ({
        profileIdentity: binding.instance.profilePath,
        connectionGeneration: binding.instance.connectionGeneration,
      }),
      {
        profileContexts: this.profileContexts,
        isExcludedTarget: target => this.registry.isManagedCdpTarget(
          binding.instance.id,
          target.cdpTargetId,
        ),
      },
    );
    const policy = createBrowserControlPolicy(catalog);
    this.inventory = new TargetInventoryService(
      transport,
      binding.instance.id,
      policy,
      this.registry,
      {
        profileContexts: this.profileContexts,
        onInvalidated: invalidation => {
          this.observations.invalidateTarget(invalidation.targetId, invalidation.reason);
          this.publishEvent({
            workspaceId: invalidation.workspaceId,
            browserConnectionGeneration: invalidation.browserConnectionGeneration,
            targetId: invalidation.targetId,
            type: 'observation.invalidated',
            sensitivity: 'browser_data',
            payload: { reason: invalidation.reason },
          });
          this.publishEvent({
            workspaceId: invalidation.workspaceId,
            browserConnectionGeneration: invalidation.browserConnectionGeneration,
            targetId: invalidation.targetId,
            type: 'target.detached',
            sensitivity: 'browser_data',
            payload: { reason: invalidation.reason },
          });
        },
        onTargetAttached: target => this.publishTargetEvent('target.attached', target),
        onPopup: target => this.publishTargetEvent('popup', target),
        onControlAcquired: (target, leaseId) => this.publishEvent({
          workspaceId: target.workspaceId,
          browserConnectionGeneration: target.browserConnectionGeneration,
          leaseId,
          targetId: target.id,
          type: 'target_control.acquired',
          sensitivity: 'browser_data',
          payload: { origin: target.origin, url: target.url },
        }),
        onControlReleased: (target, leaseId) => this.publishEvent({
          workspaceId: target.workspaceId,
          browserConnectionGeneration: target.browserConnectionGeneration,
          leaseId,
          targetId: target.id,
          type: 'target_control.released',
          sensitivity: 'browser_data',
          payload: { origin: target.origin, url: target.url },
        }),
        isCurrentContext: context => (
          this.binding.instance.state === 'connected' &&
          this.binding.instance.connectionGeneration === context.browserConnectionGeneration
        ),
      },
    );
    this.installDialogHandlers();
    this.installSessionHandlers();
  }

  setEventPublisher(publisher: (event: BrowserEventPublication) => void): void {
    this.eventPublisher = publisher;
  }

  browserConnectionChanged(previous: BrowserInstance, current: BrowserInstance): void {
    if (previous.connectionGeneration !== current.connectionGeneration || current.state !== 'connected') {
      this.profileContexts.invalidate();
    }
    this.binding.instance = { ...current };
    this.binding.candidate.state = current.state === 'connected' ? 'ready' : 'disconnected';
    if (current.state === 'connected') {
      this.binding.candidate.processState = 'running';
      this.binding.candidate.remoteDebuggingState = 'enabled';
      this.binding.candidate.authorizationState = 'authorized';
      delete this.binding.candidate.remediation;
    }
    if (current.state !== 'connected') {
      this.watchdogs.reset();
      for (const session of [...this.sessions.values()]) {
        this.downloads?.detachSession(session.sessionId, 'connection_lost');
        this.observations.invalidateSession(session.sessionId);
        this.publishEvent({
          workspaceId: session.workspaceId,
          browserConnectionGeneration: session.browserConnectionGeneration,
          leaseId: session.leaseId,
          targetId: session.targetId,
          type: 'observation.invalidated',
          sensitivity: 'browser_data',
          payload: { reason: 'session_replaced' },
        });
        this.forgetSession(session.sessionId);
      }
      this.deleteDialogs(() => true);
      return;
    }
    if (previous.state === 'connected' || current.connectionGeneration === previous.connectionGeneration) return;

    this.managedWindowIds.clear();
    for (const invalidation of this.registry.invalidateBrowserConnection(current.id)) {
      this.observations.invalidateTarget(invalidation.targetId, 'browser_reconnected');
      this.publishEvent({
        workspaceId: invalidation.workspaceId,
        browserConnectionGeneration: invalidation.browserConnectionGeneration,
        targetId: invalidation.targetId,
        type: 'observation.invalidated',
        sensitivity: 'browser_data',
        payload: { reason: 'browser_reconnected' },
        preserveIfGenerationStale: true,
      });
      this.publishEvent({
        workspaceId: invalidation.workspaceId,
        browserConnectionGeneration: invalidation.browserConnectionGeneration,
        targetId: invalidation.targetId,
        type: 'target.detached',
        sensitivity: 'browser_data',
        payload: { reason: 'browser_reconnected' },
        preserveIfGenerationStale: true,
      });
    }
  }

  ownsSession(sessionId: string): boolean {
    return this.ownedSessionIds.has(sessionId);
  }

  async call(
    context: BrokerToolCallContext,
    definition: ToolDefinition,
    argsValue: JsonValue,
  ): Promise<JsonValue> {
    const args = asRecord(argsValue);
    switch (definition.name) {
      case 'browser.discover': return this.discover();
      case 'browser.connect': return this.connect(context, args);
      case 'browser.profiles.list': return this.listProfiles(context);
      case 'browser.profiles.select': return this.selectProfile(context, args);
      case 'browser.tabs.list': return this.listTabs(context, args);
      case 'browser.tabs.switch': return this.switchTab(context, args);
      case 'browser.tabs.close': return this.closeTab(context);
      case 'browser.tabs.release': return this.releaseTab(context);
      case 'browser.frames.list': return this.listFrames(context);
      case 'browser.frames.switch': return this.switchFrame(context, args);
      case 'browser.open': return this.open(context, args);
      case 'browser.observe': return this.observe(context, args);
      case 'browser.observation.latest': return this.latestObservation(context);
      case 'browser.locate': return this.locate(context, args);
      case 'browser.read': return this.read(context, args);
      case 'browser.search': return this.search(context, args);
      case 'browser.elements.find': return this.findElements(context, args);
      case 'browser.scroll': return this.scroll(context, args);
      case 'browser.dropdown.options': return this.dropdownOptions(context, args);
      case 'browser.dropdown.select': return this.selectDropdown(context, args);
      case 'browser.click': return this.click(context, args);
      case 'browser.type': return this.type(context, args);
      case 'browser.keyboard': return this.keyboard(context, args);
      case 'browser.press': return this.press(context, args);
      case 'browser.upload': return this.upload(context, args);
      case 'browser.capture': return this.capture(context, args);
      case 'browser.pdf': return this.pdf(context, args);
      case 'browser.cookies.list': return this.cookies(context, args);
      case 'browser.dialogs.list': return this.listDialogs(context);
      case 'browser.dialogs.respond': return this.respondToDialog(context, args);
      case 'browser.auth.set': return this.setAuth(context, args);
      case 'browser.auth.clear': return this.clearAuth(context);
      case 'browser.network.requests': return this.networkRequests(context, args);
      case 'browser.network.request': return this.networkRequest(context, args);
      case 'browser.network.clear': return this.clearNetwork(context);
      case 'browser.network.rules.list': return this.listNetworkRules(context);
      case 'browser.network.rules.add': return this.addNetworkRule(context, args);
      case 'browser.network.rules.remove': return this.removeNetworkRules(context, args);
      case 'browser.eval': return this.evaluate(context, args);
      default: throw invalidArgument(`Unsupported browser tool: ${definition.name}`, 'name');
    }
  }

  actorKey(
    context: BrokerToolCallContext,
    definition: ToolDefinition,
    argsValue: JsonValue,
  ): string {
    const browserId = context.browser.instance.id;
    if (definition.name.startsWith('browser.dialogs.')) {
      return `${browserId}\u0000dialogs\u0000${context.workspace?.id ?? context.connection.id}`;
    }
    const targetId = this.commandTargetId(context, definition, argsValue);
    if (targetId && context.workspace) {
      try {
        const target = this.registry.get({
          principalId: context.principal.id,
          workspaceId: context.workspace.id,
        }, targetId);
        return `${browserId}\u0000target\u0000${target.cdpTargetId}`;
      } catch {
        return `${browserId}\u0000invalid-target\u0000${targetId}`;
      }
    }
    if (context.workspace) return `${browserId}\u0000workspace\u0000${context.workspace.id}`;
    return `${browserId}\u0000connection\u0000${context.connection.id}`;
  }

  commandTargetId(
    context: BrokerToolCallContext,
    definition: ToolDefinition,
    argsValue: JsonValue,
  ): ControlledTargetId | undefined {
    if (context.targetId) return context.targetId;
    const args = asRecord(argsValue);
    const argumentTarget = args.targetId as ControlledTargetId | undefined;
    if (argumentTarget) return argumentTarget;
    if (definition.name !== 'browser.open' || !context.workspace || !context.lease || args.newTarget === true) {
      return undefined;
    }
    return this.registry.activeTarget(
      { principalId: context.principal.id, workspaceId: context.workspace.id },
      context.lease.id,
    )?.id;
  }

  releaseLease(lease: ControlLease): void {
    this.watchdogs.releaseLease(lease.id);
    this.downloads?.releaseLease(lease.id);
    this.inventory.releaseLease(lease.id);
    this.observations.releaseLease(lease.id);
    for (const [key, session] of this.sessions) {
      if (session.leaseId !== lease.id) continue;
      this.retireSession(key, session);
    }
    this.deleteDialogs(dialog => dialog.leaseId === lease.id);
  }

  releaseWorkspace(
    principal: BrokerToolCallContext['principal'],
    workspace: NonNullable<BrokerToolCallContext['workspace']>,
    managedTabSets: readonly NonNullable<BrokerToolCallContext['managedTabSet']>[],
  ): void {
    const caller = { principalId: principal.id, workspaceId: workspace.id };
    const records = this.registry.activeRecords(caller);
    this.watchdogs.releaseWorkspace(workspace.id);
    this.downloads?.releaseWorkspace(workspace.id);
    this.inventory.releaseWorkspace(caller);
    this.observations.releaseWorkspace(workspace.id);
    for (const managedTabSet of managedTabSets) this.managedWindowIds.delete(managedTabSet.id);
    this.network.releaseWorkspace(workspace.id);
    for (const [key, session] of this.sessions) {
      if (session.workspaceId !== workspace.id) continue;
      this.retireSession(key, session);
    }
    for (const target of records) {
      if (target.origin === 'user_tab') continue;
      void this.transport.send('Target.closeTarget', { targetId: target.cdpTargetId }).catch(() => {});
    }
    this.deleteDialogs(dialog => dialog.workspaceId === workspace.id);
  }

  private discover(): JsonValue {
    const candidate = this.binding.candidate;
    return asJson({
      browsers: [{
        id: candidate.id,
        product: candidate.product,
        ...(candidate.channel !== undefined ? { channel: candidate.channel } : {}),
        ...(candidate.profile !== undefined ? { profile: candidate.profile } : {}),
        processState: candidate.processState ?? (candidate.state === 'ready' ? 'running' : 'unknown'),
        remoteDebuggingState: candidate.remoteDebuggingState ?? (
          candidate.state === 'ready' ? 'enabled' : candidate.state === 'disconnected' ? 'stale' : 'disabled'
        ),
        authorizationState: candidate.authorizationState ?? (
          candidate.state === 'ready'
            ? 'authorized'
            : candidate.state === 'authorization_required' ? 'required' : 'not_applicable'
        ),
        state: candidate.state,
        ...(candidate.remediation !== undefined ? { remediation: { ...candidate.remediation } } : {}),
      }],
    });
  }

  private async connect(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const { workspace, lease } = this.requireWorkspaceContext(context);
    if (args.browserId !== this.binding.candidate.id) {
      throw new BrowserPilotError('browser_not_found', 'Browser candidate does not match this Workspace', {
        context: { workspaceId: workspace.id, browserId: String(args.browserId) },
      });
    }
    if (this.binding.instance.state !== 'connected') {
      if (!this.connectBrowser) {
        throw new BrowserPilotError('browser_disconnected', 'Workspace browser is disconnected', {
          retryable: true,
          context: { workspaceId: workspace.id },
        });
      }
      await this.connectBrowser();
    }
    if (this.binding.instance.state !== 'connected') {
      throw new BrowserPilotError('browser_disconnected', 'Browser connection did not become ready', {
        retryable: true,
        context: { workspaceId: workspace.id },
      });
    }
    this.markDispatched(context);
    return asJson({
      workspaceId: workspace.id,
      leaseId: lease.id,
      browserInstanceId: this.binding.instance.id,
      connectionGeneration: this.binding.instance.connectionGeneration,
      state: 'connected',
    });
  }

  private async listTabs(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const inventoryContext = this.inventoryContext(context);
    const scope = (args.scope ?? 'all') as 'all' | 'managed_only' | 'user_tabs';
    const targets = await this.inventory.list(inventoryContext, scope);
    return asJson({
      workspaceId: inventoryContext.workspaceId,
      leaseId: inventoryContext.leaseId,
      targets,
    });
  }

  private async listProfiles(context: BrokerToolCallContext): Promise<JsonValue> {
    const inventoryContext = this.inventoryContext(context);
    const targets = await this.inventory.list(inventoryContext, 'all');
    const profiles = this.profileContexts.list(inventoryContext.browserConnectionGeneration);
    return asJson({
      workspaceId: inventoryContext.workspaceId,
      leaseId: inventoryContext.leaseId,
      profiles: profiles.map(profile => ({
        profileContextId: profile.id,
        label: profile.label,
        ...(profile.displayName ? { displayName: profile.displayName } : {}),
        tabCount: profile.tabCount,
        eligibleTabCount: profile.eligibleTabCount,
        selected: context.workspace?.selectedProfileContextId === profile.id,
        representativeTabs: targets
          .filter(target => target.profileContextId === profile.id)
          .slice(0, 3)
          .map(target => ({
            targetId: target.targetId,
            title: target.title,
            url: target.url,
          })),
      })),
    });
  }

  private async selectProfile(
    context: BrokerToolCallContext,
    args: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    const inventoryContext = this.inventoryContext(context);
    await this.inventory.refresh(inventoryContext);
    const profile = this.profileContexts.resolve(
      args.profileContextId as ProfileContextId,
      inventoryContext.browserConnectionGeneration,
    );
    this.markDispatched(context);
    this.inventory.clearActive(inventoryContext);
    this.selectWorkspaceProfile(context, profile.id);
    return asJson({
      workspaceId: inventoryContext.workspaceId,
      leaseId: inventoryContext.leaseId,
      profileContextId: profile.id,
      label: profile.label,
      ...(profile.displayName ? { displayName: profile.displayName } : {}),
    });
  }

  private async switchTab(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const inventoryContext = this.inventoryContext(context);
    const targetId = args.targetId as ControlledTargetId;
    await this.inventory.refresh(inventoryContext);
    this.markDispatched(context);
    const resolved = await this.inventory.activate(inventoryContext, targetId);
    const record = this.registry.get(inventoryContext, targetId);
    await this.ensureSession(inventoryContext, targetId, resolved.cdpTargetId);
    this.selectWorkspaceProfile(context, record.profileContextId);
    return asJson(this.targetResult(context, targetId, record.url));
  }

  private async closeTab(context: BrokerToolCallContext): Promise<JsonValue> {
    const inventoryContext = this.inventoryContext(context);
    const targetId = this.requireTargetId(context);
    this.markDispatched(context);
    await this.inventory.close(inventoryContext, targetId);
    this.cleanupTarget(targetId, 'target_closed');
    return asJson({
      workspaceId: inventoryContext.workspaceId,
      leaseId: inventoryContext.leaseId,
      closedTargetId: targetId,
    });
  }

  private async releaseTab(context: BrokerToolCallContext): Promise<JsonValue> {
    const inventoryContext = this.inventoryContext(context);
    const targetId = this.requireTargetId(context);
    const target = this.registry.get(inventoryContext, targetId);
    this.markDispatched(context);
    const released = this.inventory.releaseTarget(inventoryContext, targetId);
    if (released) {
      this.watchdogs.resetTarget(inventoryContext.leaseId, targetId);
      this.observations.invalidateTarget(targetId, 'control_released');
      this.publishEvent({
        workspaceId: inventoryContext.workspaceId,
        browserConnectionGeneration: inventoryContext.browserConnectionGeneration,
        leaseId: inventoryContext.leaseId,
        targetId,
        type: 'observation.invalidated',
        sensitivity: 'browser_data',
        payload: { reason: 'control_released' },
      });
      const key = sessionKey(inventoryContext.leaseId, targetId);
      const session = this.sessions.get(key);
      if (session) await this.retireSessionAndWait(key, session);
      this.deleteDialogs(dialog => (
        dialog.leaseId === inventoryContext.leaseId && dialog.targetId === targetId
      ));
    }
    return asJson({ ...this.targetResult(context, targetId, target.url), released });
  }

  private async listFrames(context: BrokerToolCallContext): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.observe');
    const frames = this.syncFrames(session, await this.listSessionFrames(session));
    const target = this.registry.get(this.inventoryContext(context), targetId);
    return asJson({
      ...this.targetResult(context, targetId, target.url),
      frames: [...frames.byId.values()].map(frame => ({
        frameId: frame.id,
        ...(frame.parentCdpFrameId ? {
          parentFrameId: frames.byCdpId.get(frame.parentCdpFrameId)?.id,
        } : {}),
        url: frame.url,
        name: frame.name,
      })),
    });
  }

  private async switchFrame(
    context: BrokerToolCallContext,
    args: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.observe');
    const frames = this.syncFrames(session, await this.listSessionFrames(session));
    const selected = args.top === true
      ? frames.byId.get(frames.topFrameId)
      : frames.byId.get(args.frameId as FrameId);
    if (!selected) throw invalidArgument('Frame is stale or does not belong to this target session', 'frameId');
    this.markDispatched(context);
    const service = new FrameService(this.transport, selected.sessionId);
    const selection = await service.selectById(selected.cdpFrameId);
    session.activeFrame = {
      id: selected.id,
      cdpFrameId: selected.cdpFrameId,
      sessionId: selected.sessionId,
      cdpTargetId: selected.cdpTargetId,
      ...(selection.executionContextId !== undefined
        ? { executionContextId: selection.executionContextId }
        : {}),
    };
    this.watchdogs.resetTarget(session.leaseId, targetId);
    this.observations.invalidateTarget(targetId, 'frame_changed');
    this.publishEvent({
      workspaceId: session.workspaceId,
      browserConnectionGeneration: session.browserConnectionGeneration,
      leaseId: session.leaseId,
      targetId,
      type: 'observation.invalidated',
      sensitivity: 'browser_data',
      payload: { reason: 'frame_changed', frameId: selected.id },
    });
    const target = this.registry.get(this.inventoryContext(context), targetId);
    return asJson({
      ...this.targetResult(context, targetId, target.url),
      frameId: selected.id,
    });
  }

  private async open(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const inventoryContext = this.inventoryContext(context);
    const url = args.url as string;
    const requestedTargetId = args.targetId as ControlledTargetId | undefined;
    const newTarget = args.newTarget === true;
    if (newTarget && requestedTargetId) {
      throw invalidArgument('targetId and newTarget cannot be used together', 'arguments');
    }

    await this.inventory.refresh(inventoryContext);
    let targetId = requestedTargetId;
    if (!targetId && !newTarget) targetId = this.inventory.activeTarget(inventoryContext)?.id;
    if (!targetId) {
      const profile = this.resolveNewTargetProfile(context, args, inventoryContext);
      this.markDispatched(context);
      targetId = await this.createManagedTarget(context, inventoryContext, profile);
      this.selectWorkspaceProfile(context, profile.id);
    } else if (args.profileContextId) {
      const target = this.registry.get(inventoryContext, targetId);
      const requestedProfile = this.profileContexts.resolve(
        args.profileContextId as ProfileContextId,
        inventoryContext.browserConnectionGeneration,
      );
      if (requestedProfile.id !== target.profileContextId) {
        throw invalidArgument('profileContextId does not match the existing target', 'profileContextId');
      }
    }

    const resolved = await this.inventory.resolveForOperation(inventoryContext, targetId, 'page.navigate');
    this.markDispatched(context);
    this.registry.setActive(inventoryContext, inventoryContext.leaseId, targetId);
    const activeTarget = this.registry.get(inventoryContext, targetId);
    this.selectWorkspaceProfile(context, activeTarget.profileContextId);
    const session = await this.ensureSession(inventoryContext, targetId, resolved.cdpTargetId);
    session.activeFrame = undefined;
    await Promise.all(
      [...(this.childFrameSessions.get(session.sessionId)?.values() ?? [])]
        .map(child => this.detachFrameTargetSession(session, child, true, 'navigation')),
    );
    this.framesBySession.delete(session.sessionId);
    this.watchdogs.resetTarget(inventoryContext.leaseId, targetId);
    this.observations.invalidateTarget(targetId, 'navigation');
    this.publishEvent({
      workspaceId: inventoryContext.workspaceId,
      browserConnectionGeneration: inventoryContext.browserConnectionGeneration,
      leaseId: inventoryContext.leaseId,
      targetId,
      type: 'observation.invalidated',
      sensitivity: 'browser_data',
      payload: { reason: 'navigation' },
    });
    const navigation = await this.transport.send('Page.navigate', { url }, session.sessionId);
    if (navigation?.errorText) {
      throw new BrowserPilotError('invalid_argument', `Navigation failed: ${navigation.errorText}`, {
        context: { targetId, url },
      });
    }
    this.publishEvent({
      workspaceId: inventoryContext.workspaceId,
      browserConnectionGeneration: inventoryContext.browserConnectionGeneration,
      leaseId: inventoryContext.leaseId,
      targetId,
      type: 'navigation',
      sensitivity: 'browser_data',
      payload: {
        url,
        ...(typeof navigation?.loaderId === 'string' ? { loaderId: navigation.loaderId } : {}),
      },
    });
    try {
      await this.loadWaiter(this.transport, session.sessionId, this.navigationTimeoutMs);
    } catch (cause) {
      if (!(cause instanceof PageLoadTimeoutError)) throw cause;
      this.watchdogs.navigationStalled({
        workspaceId: inventoryContext.workspaceId,
        leaseId: inventoryContext.leaseId,
        targetId,
        browserConnectionGeneration: inventoryContext.browserConnectionGeneration,
      }, {
        url,
        timeoutMs: cause.timeoutMs,
      });
      throw new BrowserPilotError('unknown_outcome', 'Navigation did not become interactive before the watchdog timeout', {
        retryable: true,
        context: {
          workspaceId: inventoryContext.workspaceId,
          leaseId: inventoryContext.leaseId,
          targetId,
          url,
          reason: 'navigation_stalled',
          timeoutMs: cause.timeoutMs,
        },
        remediation: {
          code: 'inspect_navigation_state',
          message: 'Inspect the target before deciding whether to navigate again.',
          actionRequired: false,
        },
        cause,
      });
    }
    return this.observationResult(
      context,
      targetId,
      await this.createObservation(
        context,
        targetId,
        session,
        Number(args.observationLimit ?? OBSERVATION_V1_LIMITS.defaultElements),
        false,
      ),
    );
  }

  private async observe(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.observe');
    const created = await this.createObservation(
      context,
      targetId,
      session,
      Number(args.limit ?? OBSERVATION_V1_LIMITS.defaultElements),
      false,
    );
    return this.observationResult(context, targetId, created);
  }

  private latestObservation(context: BrokerToolCallContext): JsonValue {
    const targetId = this.requireTargetId(context);
    const observation = this.observations.latest(
      context.workspace!.id,
      context.lease!.id,
      targetId,
    );
    return asJson({
      ...this.targetResult(context, targetId, observation.url),
      observationId: observation.id,
      createdAt: observation.createdAt,
      expiresAt: observation.expiresAt,
      elementCount: observation.elementCount,
    });
  }

  private async locate(
    context: BrokerToolCallContext,
    args: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.observe');
    const location = await new ObservationService(
      this.transport,
      this.activeCdpSessionId(session),
      targetId,
      {
        refStore: new MemoryRefStore(),
        ...(session.activeFrame?.executionContextId !== undefined
          ? { executionContextId: session.activeFrame.executionContextId }
          : {}),
        ...(session.activeFrame ? { frameId: session.activeFrame.cdpFrameId } : {}),
      },
    ).locate(args.selector as string);
    const record = this.registry.get(this.inventoryContext(context), targetId);
    return asJson({ ...this.targetResult(context, targetId, record.url), ...location });
  }

  private async read(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.observe');
    const result = await new PageContentService(this.transport, this.activeCdpSessionId(session)).read(
      args.selector as string | undefined,
      Number(args.limit ?? 100_000),
      session.activeFrame?.executionContextId !== undefined
        ? { executionContextId: session.activeFrame.executionContextId }
        : {},
    );
    return asJson({
      ...this.targetResult(context, targetId, result.url),
      title: result.title,
      text: result.text,
      length: result.length,
      truncated: result.truncated,
    });
  }

  private async search(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.observe');
    const result = await new PageInspectionService(
      this.transport,
      this.activeCdpSessionId(session),
    ).search(args.query as string, {
      selector: args.selector as string | undefined,
      caseSensitive: args.caseSensitive as boolean | undefined,
      wholeWord: args.wholeWord as boolean | undefined,
      limit: args.limit as number | undefined,
      context: session.activeFrame?.executionContextId !== undefined
        ? { executionContextId: session.activeFrame.executionContextId }
        : {},
    });
    return asJson({
      ...this.targetResult(context, targetId, result.url),
      title: result.title,
      totalMatches: result.totalMatches,
      matches: result.matches,
      truncated: result.truncated,
    });
  }

  private async findElements(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.observe');
    const result = await new PageInspectionService(
      this.transport,
      this.activeCdpSessionId(session),
    ).find(args.selector as string, {
      limit: args.limit as number | undefined,
      attributeNames: args.attributeNames as string[] | undefined,
      pierceShadow: args.pierceShadow as boolean | undefined,
      context: session.activeFrame?.executionContextId !== undefined
        ? { executionContextId: session.activeFrame.executionContextId }
        : {},
    });
    return asJson({
      ...this.targetResult(context, targetId, result.url),
      title: result.title,
      totalMatches: result.totalMatches,
      elements: result.elements,
      truncated: result.truncated,
    });
  }

  private async scroll(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.interact');
    const modes = [args.direction !== undefined, args.position !== undefined, args.text !== undefined]
      .filter(Boolean).length;
    if (modes > 1) {
      throw invalidArgument('Use only one of direction, position, or text', 'arguments');
    }
    if (args.text !== undefined && args.target !== undefined) {
      throw invalidArgument('Text scrolling cannot also specify an element target', 'target');
    }
    const scroll = new ScrollService(
      this.transport,
      this.activeCdpSessionId(session),
      session.activeFrame?.executionContextId !== undefined
        ? { executionContextId: session.activeFrame.executionContextId }
        : {},
    );
    let evidence: ScrollEvidence;
    let actionSignature: unknown;
    if (args.text !== undefined) {
      actionSignature = { action: 'scroll', text: args.text, exact: args.exact === true };
      this.markDispatched(context);
      evidence = await scroll.text(args.text as string, args.exact === true);
    } else {
      const input: ElementScrollInput = args.position !== undefined
        ? { mode: 'position', position: args.position as 'start' | 'end' }
        : {
          mode: 'relative',
          direction: (args.direction ?? 'down') as 'up' | 'down' | 'left' | 'right',
          amount: Number(args.amount ?? 0.8),
          unit: (args.unit ?? 'viewport') as 'pixels' | 'viewport',
        };
      const address = args.target === undefined ? undefined : elementAddress(args.target);
      if (!address) {
        actionSignature = { action: 'scroll', target: 'page', input };
        this.markDispatched(context);
        evidence = await scroll.page(input);
      } else if ('selector' in address) {
        actionSignature = { action: 'scroll', target: { selector: address.selector }, input };
        this.markDispatched(context);
        evidence = await scroll.selector(address.selector, input);
      } else {
        evidence = await this.withElementObject(context, targetId, session, address, async (objectId, observation) => {
          actionSignature = {
            action: 'scroll',
            target: { backendNodeId: observation.refs[address.ref - 1].backendNodeId },
            input,
          };
          this.markDispatched(context);
          return scroll.object(objectId, input);
        });
      }
    }
    const next = await this.createObservation(
      context,
      targetId,
      session,
      Number(args.observationLimit ?? OBSERVATION_V1_LIMITS.defaultElements),
      true,
    );
    const hint = this.recordActionEvidence(context, targetId, evidence, actionSignature, next);
    return this.observationResult(context, targetId, next, evidence, hint ? [hint] : []);
  }

  private async dropdownOptions(
    context: BrokerToolCallContext,
    args: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.observe');
    const service = this.dropdownService(session);
    const address = elementAddress(args.target);
    const result = 'selector' in address
      ? await service.inspectSelector(address.selector)
      : await this.withElementObject(
        context,
        targetId,
        session,
        address,
        objectId => service.inspectObject(objectId),
      );
    const record = this.registry.get(this.inventoryContext(context), targetId);
    return asJson({ ...this.targetResult(context, targetId, record.url), ...result });
  }

  private async selectDropdown(
    context: BrokerToolCallContext,
    args: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.interact');
    const service = this.dropdownService(session);
    const address = elementAddress(args.target);
    const choice = dropdownChoice(args.choice);
    const limit = Number(args.observationLimit ?? OBSERVATION_V1_LIMITS.defaultElements);
    let info: DropdownInfo;
    let initialObservation: StoredObservation | undefined;
    if ('selector' in address) {
      info = await service.inspectSelector(address.selector);
    } else {
      initialObservation = await this.resolveObservation(
        context,
        targetId,
        session,
        address.observationId,
        address.ref,
      );
      info = await this.withElementObject(
        context,
        targetId,
        session,
        address,
        objectId => service.inspectObject(objectId),
      );
    }

    if (info.kind === 'native') {
      const evidence = 'selector' in address
        ? await (async () => {
          this.markDispatched(context);
          return service.selectNativeSelector(address.selector, choice);
        })()
        : await this.withElementObject(context, targetId, session, address, async objectId => {
          this.markDispatched(context);
          return service.selectNativeObject(objectId, choice);
        });
      const next = await this.createObservation(context, targetId, session, limit, true);
      const hint = this.recordActionEvidence(context, targetId, evidence, {
        action: 'select',
        target: 'selector' in address
          ? { selector: address.selector }
          : { backendNodeId: initialObservation?.refs[address.ref - 1]?.backendNodeId },
        choice,
      }, next);
      this.publishDocumentChanged(context, targetId, next);
      return this.observationResult(context, targetId, next, evidence, hint ? [hint] : []);
    }

    if ('selector' in address || !initialObservation) {
      throw invalidArgument('ARIA dropdown selection requires an Observation ref', 'target');
    }
    return this.selectAriaDropdown(
      context,
      targetId,
      session,
      initialObservation,
      address.ref,
      info,
      choice,
      limit,
    );
  }

  private async click(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.interact');
    const target = args.target as Record<string, JsonValue>;
    if ('observationId' in target) {
      const observation = await this.resolveObservation(
        context,
        targetId,
        session,
        target.observationId as ObservationId,
        Number(target.ref),
      );
      return this.runClickAction(context, targetId, session, observation, {
        action: 'click',
        backendNodeId: observation.refs[Number(target.ref) - 1].backendNodeId,
        button: args.button ?? 'left',
        clickCount: args.clickCount ?? 1,
      }, service => service.click(
        { kind: 'ref', ref: String(target.ref) },
        {
          button: args.button as 'left' | 'right' | undefined,
          clickCount: args.clickCount as 1 | 2 | undefined,
          observationLimit: args.observationLimit as number | undefined,
        },
      ));
    }
    return this.runClickAction(context, targetId, session, undefined, {
      action: 'click',
      x: Number(target.x),
      y: Number(target.y),
      button: args.button ?? 'left',
      clickCount: args.clickCount ?? 1,
    }, service => service.click({
      kind: 'coordinates',
      x: Number(target.x),
      y: Number(target.y),
    }, {
      button: args.button as 'left' | 'right' | undefined,
      clickCount: args.clickCount as 1 | 2 | undefined,
      observationLimit: args.observationLimit as number | undefined,
    }));
  }

  private async type(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.interact');
    const observation = await this.resolveObservation(
      context,
      targetId,
      session,
      args.observationId as ObservationId,
      Number(args.ref),
    );
    return this.runInputAction(context, targetId, session, observation, {
      action: 'type',
      backendNodeId: observation.refs[Number(args.ref) - 1].backendNodeId,
      textLength: String(args.text).length,
      clear: args.clear === true,
      submit: args.submit === true,
    }, service => service.type(
      String(args.ref),
      args.text as string,
      {
        clear: args.clear as boolean | undefined,
        submit: args.submit as boolean | undefined,
        verification: args.verification as 'report' | 'require_exact' | undefined,
        observationLimit: args.observationLimit as number | undefined,
      },
    ));
  }

  private async keyboard(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.interact');
    return this.runInputAction(context, targetId, session, undefined, {
      action: 'keyboard',
      textLength: String(args.text).length,
      focusSelector: args.focusSelector ?? null,
      clear: args.clear === true,
      submit: args.submit === true,
    }, service => service.keyboard(
      args.text as string,
      {
        clear: args.clear as boolean | undefined,
        submit: args.submit as boolean | undefined,
        delayMs: args.delayMs as number | undefined,
        focusSelector: args.focusSelector as string | undefined,
        verification: args.verification as 'report' | 'require_exact' | undefined,
        observationLimit: args.observationLimit as number | undefined,
      },
    ));
  }

  private async press(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.interact');
    return this.runPressAction(
      context,
      targetId,
      session,
      { action: 'press', key: args.key },
      service => service.press(
        args.key as string,
        Number(args.observationLimit ?? OBSERVATION_V1_LIMITS.defaultElements),
      ),
    );
  }

  private async upload(
    context: BrokerToolCallContext,
    args: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    if (!this.artifactStore || !context.workspace) {
      throw new BrowserPilotError('internal_error', 'Browser Artifact storage is unavailable');
    }
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'files.upload');
    const artifact = await this.artifactStore.get(context.workspace.id, args.artifactId as ArtifactId);
    if (artifact.descriptor.kind !== 'upload_input' || artifact.descriptor.sensitivity !== 'user_file') {
      throw invalidArgument('browser.upload requires an imported upload_input Artifact', 'artifactId');
    }
    let backendNodeId: number | undefined;
    if (args.observationId !== undefined) {
      const observation = await this.resolveObservation(
        context,
        targetId,
        session,
        args.observationId as ObservationId,
        Number(args.ref),
      );
      const observedRef = observation.refs[Number(args.ref) - 1];
      await new RefRevalidationService(
        this.transport,
        this.activeCdpSessionId(session),
      ).validate(observedRef, {
        workspaceId: context.workspace.id,
        leaseId: context.lease!.id,
        targetId,
        observationId: observation.id,
        ref: Number(args.ref),
      });
      backendNodeId = observedRef.backendNodeId;
    }

    let next: CreatedObservation | undefined;
    const observations = {
      observeAfterAction: async (limit = OBSERVATION_V1_LIMITS.defaultElements) => {
        next = await this.createObservation(context, targetId, session, limit, true);
        return next.snapshot;
      },
    };
    this.markDispatched(context);
    const result = await new UploadService(
      this.transport,
      this.activeCdpSessionId(session),
      observations,
    ).upload(artifact.path, {
      inputIndex: args.inputIndex as number | undefined,
      observationLimit: args.observationLimit as number | undefined,
      ...(backendNodeId !== undefined ? { backendNodeId } : {}),
      ...(session.activeFrame?.executionContextId !== undefined
        ? { executionContextId: session.activeFrame.executionContextId }
        : {}),
    });
    if (!next) throw new BrowserPilotError('internal_error', 'Upload did not produce an Observation');
    const hint = this.recordActionEvidence(context, targetId, result.evidence, {
      action: 'upload',
      artifactId: artifact.descriptor.id,
      backendNodeId: backendNodeId ?? null,
      inputIndex: args.inputIndex ?? null,
    }, next);
    this.publishDocumentChanged(context, targetId, next);
    return this.observationResult(context, targetId, next, result.evidence, hint ? [hint] : []);
  }

  private async capture(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.capture');
    const annotationRequest = args.annotations as Record<string, JsonValue> | undefined;
    if (annotationRequest && (args.fullPage === true || args.selector !== undefined)) {
      throw invalidArgument('Annotated screenshots support viewport capture only', 'annotations');
    }
    const annotationPlan = annotationRequest
      ? await this.screenshotAnnotations(context, targetId, session, annotationRequest)
      : undefined;
    const capture = new CaptureService(this.transport, this.activeCdpSessionId(session));
    const options = {
      fullPage: args.fullPage as boolean | undefined,
      selector: args.selector as string | undefined,
    };
    let media = await capture.screenshot(options);
    if (annotationPlan) {
      media = await new ScreenshotAnnotationService(this.transport, session.sessionId).annotate(
        media,
        annotationPlan.annotations,
        annotationPlan.viewport,
      );
    }
    const scale = this.previewScale(media.width, media.height);
    const record = this.registry.get(this.inventoryContext(context), targetId);
    if (scale === undefined) {
      const artifact = await this.createArtifact(context, {
        kind: 'screenshot',
        mimeType: media.mimeType,
        bytes: media.bytes,
        ...(media.width !== undefined ? { width: media.width } : {}),
        ...(media.height !== undefined ? { height: media.height } : {}),
      });
      return asJson({
        ...this.targetResult(context, targetId, record.url),
        artifact,
        ...(annotationPlan ? { annotationCount: annotationPlan.annotations.length } : {}),
      });
    }

    let previewMedia = await capture.screenshot({ ...options, scale });
    if (annotationPlan) {
      previewMedia = await new ScreenshotAnnotationService(this.transport, session.sessionId).annotate(
        previewMedia,
        annotationPlan.annotations,
        annotationPlan.viewport,
      );
    }
    if (args.includeOriginal !== true) {
      const artifact = await this.createArtifact(context, {
        kind: 'screenshot_preview',
        mimeType: previewMedia.mimeType,
        bytes: previewMedia.bytes,
        ...(previewMedia.width !== undefined ? { width: previewMedia.width } : {}),
        ...(previewMedia.height !== undefined ? { height: previewMedia.height } : {}),
      });
      return asJson({
        ...this.targetResult(context, targetId, record.url),
        artifact,
        ...(annotationPlan ? { annotationCount: annotationPlan.annotations.length } : {}),
      });
    }

    const artifact = await this.createArtifact(context, {
      kind: 'screenshot',
      mimeType: media.mimeType,
      bytes: media.bytes,
      ...(media.width !== undefined ? { width: media.width } : {}),
      ...(media.height !== undefined ? { height: media.height } : {}),
    });
    try {
      const preview = await this.createArtifact(context, {
        kind: 'screenshot_preview',
        mimeType: previewMedia.mimeType,
        bytes: previewMedia.bytes,
        ...(previewMedia.width !== undefined ? { width: previewMedia.width } : {}),
        ...(previewMedia.height !== undefined ? { height: previewMedia.height } : {}),
        previewOf: artifact.id,
      });
      return asJson({
        ...this.targetResult(context, targetId, record.url),
        artifact,
        preview,
        ...(annotationPlan ? { annotationCount: annotationPlan.annotations.length } : {}),
      });
    } catch (error) {
      await this.artifactStore!.release(context.workspace!.id, artifact.id);
      throw error;
    }
  }

  private async pdf(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.capture');
    const media = await new CaptureService(this.transport, session.sessionId).pdf({
      landscape: args.landscape as boolean | undefined,
    });
    const artifact = await this.createArtifact(context, {
      kind: 'pdf',
      mimeType: media.mimeType,
      bytes: media.bytes,
    });
    const record = this.registry.get(this.inventoryContext(context), targetId);
    return asJson({ ...this.targetResult(context, targetId, record.url), artifact });
  }

  private async cookies(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'cookies.read');
    const cookies = await new CookieService(this.transport, session.sessionId).list(args.domain as string | undefined);
    const record = this.registry.get(this.inventoryContext(context), targetId);
    return asJson({ ...this.targetResult(context, targetId, record.url), cookies });
  }

  private async setAuth(
    context: BrokerToolCallContext,
    args: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    const { workspace, lease } = this.requireWorkspaceContext(context);
    this.markDispatched(context);
    await this.network.setAuth(workspace.id, args.username as string, args.password as string);
    return asJson({ workspaceId: workspace.id, leaseId: lease.id, configured: true });
  }

  private async clearAuth(context: BrokerToolCallContext): Promise<JsonValue> {
    const { workspace, lease } = this.requireWorkspaceContext(context);
    this.markDispatched(context);
    await this.network.clearAuth(workspace.id);
    return asJson({ workspaceId: workspace.id, leaseId: lease.id, configured: false });
  }

  private networkRequests(
    context: BrokerToolCallContext,
    args: Record<string, JsonValue>,
  ): JsonValue {
    const { workspace, lease } = this.requireWorkspaceContext(context);
    const result = this.network.listRequests(workspace.id, {
      limit: args.limit as number | undefined,
      after: args.after as number | undefined,
      url: args.url as string | undefined,
      method: args.method as string | undefined,
      status: args.status as string | undefined,
      type: args.type as string[] | undefined,
    });
    return asJson({ workspaceId: workspace.id, leaseId: lease.id, ...result });
  }

  private async networkRequest(
    context: BrokerToolCallContext,
    args: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    const { workspace, lease } = this.requireWorkspaceContext(context);
    const result = await this.network.request(
      workspace.id,
      args.requestId as NetworkRequestId,
      args.includeBody !== false,
    );
    return asJson({ workspaceId: workspace.id, leaseId: lease.id, ...result });
  }

  private clearNetwork(context: BrokerToolCallContext): JsonValue {
    const { workspace, lease } = this.requireWorkspaceContext(context);
    this.markDispatched(context);
    this.network.clearRequests(workspace.id);
    return asJson({ workspaceId: workspace.id, leaseId: lease.id, cleared: true });
  }

  private listNetworkRules(context: BrokerToolCallContext): JsonValue {
    const { workspace, lease } = this.requireWorkspaceContext(context);
    return asJson({
      workspaceId: workspace.id,
      leaseId: lease.id,
      rules: this.network.listRules(workspace.id),
    });
  }

  private async addNetworkRule(
    context: BrokerToolCallContext,
    args: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    const { workspace, lease } = this.requireWorkspaceContext(context);
    this.markDispatched(context);
    const ruleId = await this.network.addRule(workspace.id, args as unknown as WorkspaceNetworkRuleInput);
    return asJson({ workspaceId: workspace.id, leaseId: lease.id, ruleId });
  }

  private async removeNetworkRules(
    context: BrokerToolCallContext,
    args: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    const { workspace, lease } = this.requireWorkspaceContext(context);
    this.markDispatched(context);
    const removed = await this.network.removeRules(workspace.id, {
      ruleId: args.ruleId as NetworkRuleId | undefined,
      all: args.all === true,
    });
    return asJson({ workspaceId: workspace.id, leaseId: lease.id, removed });
  }

  private async evaluate(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'developer.eval');
    this.markDispatched(context);
    const { result, exceptionDetails } = await this.transport.send('Runtime.evaluate', {
      expression: args.expression,
      returnByValue: true,
      awaitPromise: args.awaitPromise ?? true,
      ...(session.activeFrame?.executionContextId !== undefined
        ? { contextId: session.activeFrame.executionContextId }
        : {}),
    }, this.activeCdpSessionId(session));
    if (exceptionDetails) {
      throw invalidArgument(
        exceptionDetails.exception?.description || exceptionDetails.text || 'Evaluation error',
        'expression',
      );
    }
    const record = this.registry.get(this.inventoryContext(context), targetId);
    let value: JsonValue = result?.value ?? result?.unserializableValue ?? null;
    let truncated = false;
    const serialized = JSON.stringify(value);
    if (serialized && Buffer.byteLength(serialized, 'utf8') > 1_000_000) {
      value = serialized.slice(0, 1_000_000);
      truncated = true;
    }
    return asJson({ ...this.targetResult(context, targetId, record.url), value, truncated });
  }

  private listDialogs(context: BrokerToolCallContext): JsonValue {
    const { workspace, lease } = this.requireWorkspaceContext(context);
    const dialogs = [...this.pendingDialogs.values()]
      .filter(dialog => dialog.workspaceId === workspace.id && dialog.leaseId === lease.id)
      .sort((left, right) => left.openedAt - right.openedAt)
      .map(dialog => ({
        dialogId: dialog.id,
        targetId: dialog.targetId,
        type: dialog.type,
        message: dialog.message,
      }));
    return asJson({ workspaceId: workspace.id, leaseId: lease.id, dialogs });
  }

  private async respondToDialog(
    context: BrokerToolCallContext,
    args: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    const { workspace, lease } = this.requireWorkspaceContext(context);
    const targetId = this.requireTargetId(context);
    const dialogId = args.dialogId as string;
    const dialog = this.pendingDialogs.get(dialogId);
    if (
      !dialog ||
      dialog.workspaceId !== workspace.id ||
      dialog.leaseId !== lease.id ||
      dialog.targetId !== targetId
    ) {
      throw new BrowserPilotError('target_not_owned', 'Dialog is not pending for this Lease and target', {
        context: { workspaceId: workspace.id, leaseId: lease.id, targetId, dialogId },
      });
    }
    const promptText = args.promptText as string | undefined;
    if (promptText !== undefined && dialog.type !== 'prompt') {
      throw invalidArgument('promptText is valid only for prompt dialogs', 'promptText');
    }
    const accept = args.action === 'accept';
    const response: PendingDialogResponse = {
      action: accept ? 'accept' : 'dismiss',
      promptTextProvided: promptText !== undefined,
    };
    this.markDispatched(context);
    this.dialogResponseBySession.set(dialog.sessionId, response);
    try {
      await this.transport.send('Page.handleJavaScriptDialog', {
        accept,
        ...(promptText !== undefined ? { promptText } : {}),
      }, dialog.sessionId);
      if (this.pendingDialogs.get(dialog.id) === dialog) {
        this.removeDialog(dialog);
        this.publishDialogEvent(dialog, 'closed', response);
      }
    } finally {
      if (this.dialogResponseBySession.get(dialog.sessionId) === response) {
        this.dialogResponseBySession.delete(dialog.sessionId);
      }
    }
    const target = this.registry.get(this.inventoryContext(context), targetId);
    return asJson({
      ...this.targetResult(context, targetId, target.url),
      dialogId,
      action: accept ? 'accept' : 'dismiss',
    });
  }

  private async createManagedTarget(
    context: BrokerToolCallContext,
    inventoryContext: TargetInventoryContext,
    profile: ProfileContextRecord,
  ): Promise<ControlledTargetId> {
    if (!context.managedTabSetForProfile) {
      throw new BrowserPilotError('internal_error', 'Broker cannot bind a ManagedTabSet to a Profile context');
    }
    const managedTabSet = context.managedTabSetForProfile(profile.id);
    const windowId = this.managedWindowIds.get(managedTabSet.id);
    let createdTargetId: string | undefined;

    if (windowId !== undefined) {
      try {
        createdTargetId = await this.tryCreateManagedTarget({ url: 'about:blank', windowId }, profile);
      } catch (error) {
        this.managedWindowIds.delete(managedTabSet.id);
        if (!(error instanceof ManagedTargetCreationRejectedError)) throw error;
      }
    }

    if (!createdTargetId) {
      try {
        createdTargetId = await this.tryCreateManagedTarget({
          url: 'about:blank',
          newWindow: true,
          ...(profile.cdpBrowserContextId
            ? { browserContextId: profile.cdpBrowserContextId }
            : {}),
        }, profile);
      } catch (error) {
        // Regular Chrome Profile contexts do not consistently support direct creation.
        if (!(error instanceof ManagedTargetCreationRejectedError)) throw error;
      }
    }

    if (!createdTargetId) {
      createdTargetId = await this.createManagedProfileWindow(profile);
    }

    try {
      if (!this.managedWindowIds.has(managedTabSet.id)) {
        const window = await this.transport.send('Browser.getWindowForTarget', { targetId: createdTargetId });
        if (!Number.isSafeInteger(window?.windowId)) {
          throw new BrowserPilotError('internal_error', 'Chrome returned an invalid managed window ID');
        }
        this.managedWindowIds.set(managedTabSet.id, window.windowId);
      }
      const registered = this.inventory.registerManagedTarget({
        ...inventoryContext,
        managedTabSetId: managedTabSet.id,
        profileContextId: profile.id,
        cdpTargetId: createdTargetId,
        title: '',
        url: 'about:blank',
      });
      this.publishTargetEvent('target.attached', registered);
      await this.inventory.activate(inventoryContext, registered.id);
      return registered.id;
    } catch (error) {
      await this.transport.send('Target.closeTarget', { targetId: createdTargetId }).catch(() => {});
      throw error;
    }
  }

  private async tryCreateManagedTarget(
    params: Parameters<ManagedTargetLifecycle['createTarget']>[0],
    profile: ProfileContextRecord,
  ): Promise<string | undefined> {
    let targetId: string | undefined;
    try {
      targetId = (await this.managedTargets.createTarget(params)).targetId;
      if (await this.targetMatchesProfile(targetId, profile)) return targetId;
      if (!(await this.closeTargetAndVerify(targetId))) {
        throw this.managedTargetUnknownOutcome(profile);
      }
      return undefined;
    } catch (error) {
      if (!targetId) {
        if (error instanceof BrowserPilotError) throw error;
        throw error instanceof ManagedTargetCreationRejectedError
          ? error
          : new ManagedTargetCreationRejectedError(
            error instanceof Error ? error.message : String(error),
          );
      }
      if (!(await this.closeTargetAndVerify(targetId))) {
        throw this.managedTargetUnknownOutcome(profile, error);
      }
      if (error instanceof BrowserPilotError && error.code === 'unknown_outcome') throw error;
      return undefined;
    }
  }

  private async closeTargetAndVerify(targetId: string): Promise<boolean> {
    try {
      await this.transport.send('Target.closeTarget', { targetId });
    } catch {
      // Target inventory below is authoritative for whether cleanup completed.
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const current = await this.transport.send('Target.getTargets');
        if (
          Array.isArray(current?.targetInfos) &&
          !current.targetInfos.some((target: any) => target?.targetId === targetId)
        ) return true;
      } catch {
        // Retry the bounded verification before declaring the outcome unknown.
      }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  }

  private managedTargetUnknownOutcome(
    profile: ProfileContextRecord,
    cause?: unknown,
  ): BrowserPilotError {
    return new BrowserPilotError(
      'unknown_outcome',
      'Managed Profile window creation could not be safely verified',
      {
        retryable: true,
        context: { profileContextId: profile.id },
        remediation: {
          code: 'inspect_profile_tabs',
          message: 'List tabs and Profile contexts before deciding whether to retry target creation.',
          actionRequired: true,
        },
        ...(cause !== undefined ? { cause } : {}),
      },
    );
  }

  private async targetMatchesProfile(
    targetId: string,
    profile: ProfileContextRecord,
  ): Promise<boolean> {
    let target: any;
    try {
      const result = await this.transport.send('Target.getTargetInfo', { targetId });
      target = result?.targetInfo;
    } catch {
      // Older Chromium builds and test transports may not expose this method.
    }
    if (!target || target.targetId !== targetId) {
      const result = await this.transport.send('Target.getTargets');
      target = Array.isArray(result?.targetInfos)
        ? result.targetInfos.find((candidate: any) => candidate?.targetId === targetId)
        : undefined;
    }
    if (!target || target.targetId !== targetId || target.type !== 'page') return false;
    const rawContextId = typeof target.browserContextId === 'string'
      ? target.browserContextId
      : undefined;
    return rawContextId === profile.cdpBrowserContextId;
  }

  private async createManagedProfileWindow(profile: ProfileContextRecord): Promise<string> {
    const representative = profile.targets.find(target => target.type === 'page');
    if (!representative) {
      throw new BrowserPilotError('profile_context_unavailable', 'Profile has no representative page target', {
        retryable: true,
        context: { profileContextId: profile.id },
        remediation: {
          code: 'open_profile_tab',
          message: 'Open a neutral tab in the intended Chrome Profile, then retry.',
          actionRequired: true,
        },
      });
    }

    const attached = await this.transport.send('Target.attachToTarget', {
      targetId: representative.cdpTargetId,
      flatten: true,
    });
    if (typeof attached?.sessionId !== 'string') {
      throw new BrowserPilotError('profile_context_unavailable', 'Chrome could not attach to a Profile representative', {
        retryable: true,
        context: { profileContextId: profile.id },
      });
    }
    const sessionId = attached.sessionId;
    const marker = `about:blank#browser-pilot-${randomUUID()}`;
    const windowName = `browser-pilot-${randomUUID()}`;
    let candidateTargetId: string | undefined;
    let adoptedTargetId: string | undefined;
    const spawnedTargetIds = new Set<string>();
    try {
      await this.transport.send('Page.enable', {}, sessionId);
      const frameTree = await this.transport.send('Page.getFrameTree', {}, sessionId);
      const frameId = frameTree?.frameTree?.frame?.id;
      if (typeof frameId !== 'string') {
        throw new BrowserPilotError('profile_context_unavailable', 'Profile representative has no attachable top frame', {
          retryable: true,
          context: { profileContextId: profile.id },
        });
      }
      const isolated = await this.transport.send('Page.createIsolatedWorld', {
        frameId,
        worldName: 'browser-pilot-managed-window',
        grantUniveralAccess: false,
      }, sessionId);
      if (!Number.isSafeInteger(isolated?.executionContextId)) {
        throw new BrowserPilotError('profile_context_unavailable', 'Chrome could not create an isolated Profile world', {
          retryable: true,
          context: { profileContextId: profile.id },
        });
      }
      const before = await this.transport.send('Target.getTargets');
      const existing = new Set<string>(
        Array.isArray(before?.targetInfos)
          ? before.targetInfos
            .filter((target: unknown) => target && typeof target === 'object' && typeof (target as any).targetId === 'string')
            .map((target: any) => target.targetId)
          : [],
      );
      const expression = `window.open(${JSON.stringify(marker)}, ${JSON.stringify(windowName)}, ` +
        `${JSON.stringify('popup=yes,width=1280,height=900')}) !== null`;
      const opened = await this.transport.send('Runtime.evaluate', {
        expression,
        contextId: isolated.executionContextId,
        userGesture: true,
        returnByValue: true,
      }, sessionId);
      if (opened?.result?.value !== true) {
        throw new BrowserPilotError('profile_context_unavailable', 'Chrome blocked managed window creation', {
          retryable: true,
          context: { profileContextId: profile.id },
        });
      }

      for (let attempt = 0; attempt < 40; attempt += 1) {
        const current = await this.transport.send('Target.getTargets');
        const markerTargets = Array.isArray(current?.targetInfos)
          ? current.targetInfos.filter((target: any) => (
            target &&
            typeof target.targetId === 'string' &&
            !existing.has(target.targetId) &&
            target.type === 'page' &&
            target.openerId === representative.cdpTargetId &&
            target.url === marker
          ))
          : [];
        for (const target of markerTargets) spawnedTargetIds.add(target.targetId);
        if (markerTargets.length > 1) {
          throw new BrowserPilotError('profile_context_unavailable', 'Chrome created ambiguous managed window targets', {
            retryable: true,
            context: { profileContextId: profile.id },
          });
        }
        if (markerTargets.length === 1) {
          const candidate = markerTargets[0];
          const candidateContextId = typeof candidate.browserContextId === 'string'
            ? candidate.browserContextId
            : undefined;
          if (candidateContextId !== profile.cdpBrowserContextId) {
            throw new BrowserPilotError(
              'profile_context_unavailable',
              'Chrome created the managed window in a different Profile context',
              {
                retryable: true,
                context: { profileContextId: profile.id },
                remediation: {
                  code: 'relist_profile_contexts',
                  message: 'List Profile contexts again and retry with a current Profile context.',
                  actionRequired: true,
                },
              },
            );
          }
          candidateTargetId = candidate.targetId;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!candidateTargetId) {
        throw this.managedTargetUnknownOutcome(profile);
      }
      try {
        await this.managedTargets.adoptTarget(candidateTargetId);
        adoptedTargetId = candidateTargetId;
      } catch (error) {
        throw error;
      }
      return candidateTargetId;
    } finally {
      const unadopted = [...spawnedTargetIds].filter(targetId => targetId !== adoptedTargetId);
      const cleanup = await Promise.all(unadopted.map(targetId => this.closeTargetAndVerify(targetId)));
      await this.transport.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      if (cleanup.some(closed => !closed)) throw this.managedTargetUnknownOutcome(profile);
    }
  }

  private async resolveTargetSession(
    context: BrokerToolCallContext,
    targetId: ControlledTargetId,
    operation: BrowserOperation,
  ): Promise<TargetSession> {
    const inventoryContext = this.inventoryContext(context);
    await this.inventory.refresh(inventoryContext);
    const resolved = await this.inventory.resolveForOperation(inventoryContext, targetId, operation);
    const session = await this.ensureSession(inventoryContext, targetId, resolved.cdpTargetId);
    await this.refreshActiveFrameContext(session);
    return session;
  }

  private async ensureSession(
    context: TargetInventoryContext,
    targetId: ControlledTargetId,
    cdpTargetId: string,
  ): Promise<TargetSession> {
    const key = sessionKey(context.leaseId, targetId);
    const existing = this.sessions.get(key);
    if (existing && existing.cdpTargetId === cdpTargetId) {
      try {
        await this.transport.send('Runtime.evaluate', { expression: '1' }, existing.sessionId);
        return existing;
      } catch {
        this.retireSession(key, existing);
        this.observations.invalidateSession(existing.sessionId);
        this.publishEvent({
          workspaceId: existing.workspaceId,
          browserConnectionGeneration: existing.browserConnectionGeneration,
          leaseId: existing.leaseId,
          targetId: existing.targetId,
          type: 'observation.invalidated',
          sensitivity: 'browser_data',
          payload: { reason: 'session_replaced' },
        });
      }
    }
    const attached = await this.transport.send('Target.attachToTarget', {
      targetId: cdpTargetId,
      flatten: true,
    });
    if (typeof attached?.sessionId !== 'string') {
      throw new BrowserPilotError('internal_error', 'Chrome returned an invalid CDP session');
    }
    const session: TargetSession = {
      workspaceId: context.workspaceId,
      leaseId: context.leaseId,
      targetId,
      browserConnectionGeneration: context.browserConnectionGeneration,
      cdpTargetId,
      sessionId: attached.sessionId,
    };
    this.sessions.set(key, session);
    this.ownedSessionIds.add(attached.sessionId);
    try {
      await this.network.attachSession(session);
      await this.transport.send('Page.enable', {}, attached.sessionId).catch(() => {});
      await this.downloads?.attachSession(session);
      await this.transport.send('Runtime.evaluate', { expression: INJECT_BORDER }, attached.sessionId).catch(() => {});
      return session;
    } catch (error) {
      this.retireSession(key, session);
      throw error;
    }
  }

  private async createObservation(
    context: BrokerToolCallContext,
    targetId: ControlledTargetId,
    session: TargetSession,
    limit: number,
    afterAction: boolean,
  ): Promise<CreatedObservation> {
    const refs = new MemoryRefStore();
    const cdpSessionId = this.activeCdpSessionId(session);
    const service = new ObservationService(this.transport, cdpSessionId, targetId, {
      refStore: refs,
      ...(session.activeFrame?.executionContextId !== undefined
        ? { executionContextId: session.activeFrame.executionContextId }
        : {}),
      ...(session.activeFrame ? { frameId: session.activeFrame.cdpFrameId } : {}),
    });
    const snapshot = afterAction
      ? await service.observeAfterAction(limit)
      : await service.observe(limit);
    const identity = await this.observationContextIdentity(session);
    const record = this.observations.create({
      workspaceId: context.workspace!.id,
      leaseId: context.lease!.id,
      targetId,
      browserProcessIdentity: context.browser.instance.processIdentity,
      browserConnectionGeneration: context.browser.instance.connectionGeneration,
      sessionId: cdpSessionId,
      frameId: identity.frameId,
      loaderId: identity.loaderId,
      documentGeneration: identity.documentGeneration,
      title: snapshot.data.title,
      url: snapshot.data.url,
      refs: refs.load(targetId),
      truncated: snapshot.truncated ?? false,
      truncationReasons: snapshot.truncationReasons ?? [],
    });
    const previous = this.guidanceBySession.get(session.sessionId);
    const frameId = session.activeFrame?.cdpFrameId;
    const hints = observationAgentHints(
      snapshot.guidance,
      previous && previous.frameId === frameId ? previous.guidance : undefined,
    );
    this.guidanceBySession.set(session.sessionId, { frameId, guidance: snapshot.guidance });
    return { snapshot, record, hints };
  }

  private async resolveObservation(
    context: BrokerToolCallContext,
    targetId: ControlledTargetId,
    session: TargetSession,
    observationId: ObservationId,
    ref?: number,
  ): Promise<StoredObservation> {
    const cdpSessionId = this.activeCdpSessionId(session);
    const identity = await this.observationContextIdentity(session);
    const observation = this.observations.resolve({
      workspaceId: context.workspace!.id,
      leaseId: context.lease!.id,
      targetId,
      observationId,
      browserProcessIdentity: context.browser.instance.processIdentity,
      browserConnectionGeneration: context.browser.instance.connectionGeneration,
      sessionId: cdpSessionId,
      frameId: identity.frameId,
      loaderId: identity.loaderId,
      documentGeneration: identity.documentGeneration,
      ref,
    });
    return observation;
  }

  private async screenshotAnnotations(
    context: BrokerToolCallContext,
    targetId: ControlledTargetId,
    session: TargetSession,
    request: Record<string, JsonValue>,
  ): Promise<{ annotations: ScreenshotAnnotation[]; viewport: ScreenshotViewport }> {
    const observation = await this.resolveObservation(
      context,
      targetId,
      session,
      request.observationId as ObservationId,
    );
    const requestedRefs = Array.isArray(request.refs)
      ? request.refs.map(Number)
      : observation.refs.slice(0, 200).map((_, index) => index + 1);
    for (const ref of requestedRefs) {
      if (!Number.isSafeInteger(ref) || ref < 1 || ref > observation.refs.length) {
        throw new BrowserPilotError('stale_ref', 'Screenshot annotation ref is outside the Observation', {
          context: { targetId, observationId: observation.id, ref },
        });
      }
    }
    const metrics = await this.transport.send('Page.getLayoutMetrics', {}, session.sessionId);
    const viewportData = metrics?.cssVisualViewport ?? metrics?.cssLayoutViewport;
    if (
      !viewportData || !Number.isFinite(viewportData.clientWidth) || !Number.isFinite(viewportData.clientHeight) ||
      Number(viewportData.clientWidth) <= 0 || Number(viewportData.clientHeight) <= 0
    ) throw new BrowserPilotError('internal_error', 'Chrome returned invalid screenshot viewport metrics');
    const viewport = {
      width: Number(viewportData.clientWidth),
      height: Number(viewportData.clientHeight),
    };
    const offset = await this.activeFramePointerOffset(session);
    const annotations: ScreenshotAnnotation[] = [];
    const cdpSessionId = this.activeCdpSessionId(session);
    const validator = new RefRevalidationService(this.transport, cdpSessionId);
    for (const ref of requestedRefs) {
      const entry = observation.refs[ref - 1];
      let objectId: string | undefined;
      try {
        const { object } = await this.transport.send('DOM.resolveNode', {
          backendNodeId: entry.backendNodeId,
        }, cdpSessionId);
        if (typeof object?.objectId !== 'string' || !object.objectId) {
          throw new BrowserPilotError('stale_ref', 'Screenshot annotation ref no longer resolves', {
            context: { targetId, observationId: observation.id, ref },
          });
        }
        const resolvedObjectId = object.objectId;
        objectId = resolvedObjectId;
        await validator.validateResolved(resolvedObjectId, entry, {
          workspaceId: context.workspace!.id,
          leaseId: context.lease!.id,
          targetId,
          observationId: observation.id,
          ref,
        });
        const { result } = await this.transport.send('Runtime.callFunctionOn', {
          objectId: resolvedObjectId,
          functionDeclaration: READ_ANNOTATION_RECT,
          returnByValue: true,
        }, cdpSessionId);
        const rect = result?.value as Record<string, unknown> | null | undefined;
        if (!rect) continue;
        const left = Math.max(0, Number(rect.x) + offset.x);
        const top = Math.max(0, Number(rect.y) + offset.y);
        const right = Math.min(viewport.width, Number(rect.x) + offset.x + Number(rect.width));
        const bottom = Math.min(viewport.height, Number(rect.y) + offset.y + Number(rect.height));
        if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) continue;
        annotations.push({ ref, x: left, y: top, width: right - left, height: bottom - top });
      } finally {
        if (objectId) {
          await this.transport.send('Runtime.releaseObject', { objectId }, cdpSessionId).catch(() => {});
        }
      }
    }
    return { annotations, viewport };
  }

  private dropdownService(session: TargetSession): DropdownService {
    return new DropdownService(
      this.transport,
      this.activeCdpSessionId(session),
      session.activeFrame?.executionContextId !== undefined
        ? { executionContextId: session.activeFrame.executionContextId }
        : {},
    );
  }

  private async withElementObject<T>(
    context: BrokerToolCallContext,
    targetId: ControlledTargetId,
    session: TargetSession,
    address: Extract<ElementAddress, { observationId: ObservationId }>,
    operation: (objectId: string, observation: StoredObservation) => Promise<T>,
  ): Promise<T> {
    const observation = await this.resolveObservation(
      context,
      targetId,
      session,
      address.observationId,
      address.ref,
    );
    const entry = observation.refs[address.ref - 1];
    const cdpSessionId = this.activeCdpSessionId(session);
    let objectId: string | undefined;
    try {
      const { object } = await this.transport.send('DOM.resolveNode', {
        backendNodeId: entry.backendNodeId,
      }, cdpSessionId);
      if (typeof object?.objectId !== 'string' || !object.objectId) {
        throw new BrowserPilotError('stale_ref', 'Ref no longer resolves to the observed element', {
          context: { targetId, observationId: observation.id, ref: address.ref },
        });
      }
      const resolvedObjectId = object.objectId;
      objectId = resolvedObjectId;
      await new RefRevalidationService(this.transport, cdpSessionId).validateResolved(
        resolvedObjectId,
        entry,
        {
          workspaceId: context.workspace!.id,
          leaseId: context.lease!.id,
          targetId,
          observationId: observation.id,
          ref: address.ref,
        },
      );
      return await operation(resolvedObjectId, observation);
    } finally {
      if (objectId) {
        await this.transport.send('Runtime.releaseObject', { objectId }, cdpSessionId).catch(() => {});
      }
    }
  }

  private async selectAriaDropdown(
    context: BrokerToolCallContext,
    targetId: ControlledTargetId,
    session: TargetSession,
    initial: StoredObservation,
    targetRef: number,
    info: DropdownInfo,
    choice: DropdownChoice,
    limit: number,
  ): Promise<JsonValue> {
    const originalEntry = initial.refs[targetRef - 1];
    let current: CreatedObservation;
    let openedControl = false;
    if (!info.expanded || info.requiresOpen) {
      const openHarness = this.createActionHarness(context, targetId, session, initial);
      await openHarness.service.click({ kind: 'ref', ref: String(targetRef) }, { observationLimit: limit });
      const opened = openHarness.observation();
      if (!opened) throw new BrowserPilotError('internal_error', 'Opening dropdown did not produce an Observation');
      current = opened;
      openedControl = true;
    } else {
      current = await this.createObservation(context, targetId, session, limit, true);
    }

    const currentRecord = current.record;
    const refreshedTargetIndex = currentRecord.refs.findIndex(entry => (
      entry.backendNodeId === originalEntry.backendNodeId
    ));
    if (refreshedTargetIndex < 0) {
      throw new BrowserPilotError('stale_ref', 'ARIA dropdown is absent from the refreshed Observation', {
        context: { targetId, observationId: currentRecord.id, ref: targetRef },
      });
    }
    const candidateRefs = currentRecord.refs
      .map((entry, index) => ({ entry, ref: index + 1 }))
      .filter(({ entry }) => ['option', 'menuitemradio'].includes(entry.role));
    const candidates = await this.withElementObject(
      context,
      targetId,
      session,
      { observationId: currentRecord.id, ref: refreshedTargetIndex + 1 },
      async targetObjectId => {
        const scoped: Array<{ ref: number; option: DropdownOption }> = [];
        for (const candidate of candidateRefs) {
          const option = await this.withElementObject(
            context,
            targetId,
            session,
            { observationId: currentRecord.id, ref: candidate.ref },
            optionObjectId => this.dropdownService(session).inspectOwnedAriaOption(
              targetObjectId,
              optionObjectId,
            ),
          );
          if (option) scoped.push({ ref: candidate.ref, option });
        }
        return scoped;
      },
    );
    const selectedCandidate = candidates.find(candidate => (
      !candidate.option.disabled && optionMatches(candidate.option, choice)
    ));
    if (!selectedCandidate) {
      const evidence: SelectVerificationEvidence = {
        action: 'select',
        status: 'mismatch',
        kind: 'aria',
        selected: [],
        reason: 'option_not_found',
      };
      const hint = this.recordActionEvidence(context, targetId, evidence, {
        action: 'select',
        backendNodeId: originalEntry.backendNodeId,
        choice,
      }, current);
      if (openedControl) this.publishDocumentChanged(context, targetId, current);
      return this.observationResult(context, targetId, current, evidence, hint ? [hint] : []);
    }

    const selectHarness = this.createActionHarness(context, targetId, session, currentRecord);
    const clickResult = await selectHarness.service.click(
      { kind: 'ref', ref: String(selectedCandidate.ref) },
      { observationLimit: limit },
    );
    const next = selectHarness.observation();
    if (!next) throw new BrowserPilotError('internal_error', 'Dropdown selection did not produce an Observation');

    let selected: DropdownOption[] = [];
    const selectedTargetIndex = next.record.refs.findIndex(entry => (
      entry.backendNodeId === originalEntry.backendNodeId
    ));
    if (selectedTargetIndex >= 0) {
      try {
        const refreshed = await this.withElementObject(
          context,
          targetId,
          session,
          { observationId: next.record.id, ref: selectedTargetIndex + 1 },
          objectId => this.dropdownService(session).inspectObject(objectId),
        );
        selected = refreshed.options.filter(option => option.selected);
      } catch (error) {
        if (!(error instanceof BrowserPilotError) || error.code !== 'stale_ref') throw error;
      }
    }

    const refreshedTargetValue = selectedTargetIndex >= 0
      ? next.snapshot.data.elements[selectedTargetIndex]?.value
      : undefined;
    const expectedText = choice.by === 'index'
      ? selectedCandidate.option.label
      : choice.by === 'label' ? choice.label : choice.value;
    const exposedValueMatches = typeof refreshedTargetValue === 'string' && (
      choice.by === 'index'
        ? refreshedTargetValue.trim().toLocaleLowerCase().includes(expectedText.trim().toLocaleLowerCase())
        : optionMatches({
          index: selectedCandidate.option.index,
          label: refreshedTargetValue,
          value: refreshedTargetValue,
        }, choice)
    );
    const verified = selected.some(option => optionMatches(option, choice)) ||
      exposedValueMatches ||
      (clickResult.evidence.status === 'verified' && clickResult.evidence.effects.includes('selected_changed'));
    if (verified && selected.length === 0) {
      selected = [{ ...selectedCandidate.option, selected: true }];
    }
    const evidence: SelectVerificationEvidence = clickResult.evidence.status === 'mismatch'
      ? {
        action: 'select',
        status: 'mismatch',
        kind: 'aria',
        selected,
        reason: 'selection_mismatch',
      }
      : verified
        ? { action: 'select', status: 'verified', kind: 'aria', selected }
        : DropdownService.unavailableAriaSelection();
    const hint = this.recordActionEvidence(context, targetId, evidence, {
      action: 'select',
      backendNodeId: initial.refs[targetRef - 1].backendNodeId,
      choice,
    }, next);
    this.publishDocumentChanged(context, targetId, next);
    return this.observationResult(context, targetId, next, evidence, hint ? [hint] : []);
  }

  private async captureActionSignals(
    session: TargetSession,
    observation?: StoredObservation,
  ): Promise<ActionSignalSnapshot> {
    const cdpSessionId = this.activeCdpSessionId(session);
    return {
      loaderId: observation?.loaderId ?? await this.loaderId(session),
      url: observation?.url ?? await this.currentUrl(session),
      dialogSequence: this.dialogOpenSequenceBySession.get(cdpSessionId) ?? 0,
      popupSequence: this.popupSequence,
    };
  }

  private collectActionSignalEffects(
    session: TargetSession,
    before: ActionSignalSnapshot,
    next: CreatedObservation,
    observation?: StoredObservation,
  ): BrokerActionEffect[] {
    const effects: BrokerActionEffect[] = [];
    const navigated = before.loaderId !== next.record.loaderId ||
      (before.url !== undefined && before.url !== next.record.url);
    const documentChanged = before.loaderId !== next.record.loaderId ||
      (observation !== undefined && (
        observation.title !== next.record.title || refsChanged(observation, next.record)
      ));
    if (navigated) effects.push('navigation');
    if (documentChanged) effects.push('document_changed');
    if ((this.dialogOpenSequenceBySession.get(this.activeCdpSessionId(session)) ?? 0) > before.dialogSequence) {
      effects.push('dialog_opened');
    }
    if (this.popupSignals.some(signal => (
      signal.sequence > before.popupSequence && signal.openerCdpTargetId === session.cdpTargetId
    ))) {
      effects.push('popup_opened');
    }
    return effects;
  }

  private async runClickAction(
    context: BrokerToolCallContext,
    targetId: ControlledTargetId,
    session: TargetSession,
    observation: StoredObservation | undefined,
    actionSignature: unknown,
    action: (service: ActionService) => Promise<ClickActionResult>,
  ): Promise<JsonValue> {
    const before = await this.captureActionSignals(session, observation);
    const harness = this.createActionHarness(context, targetId, session, observation);
    const result = await action(harness.service);
    const next = harness.observation();
    if (!next) throw new BrowserPilotError('internal_error', 'Click did not produce an Observation');
    const extraEffects = this.collectActionSignalEffects(session, before, next, observation);
    const evidence = this.mergeClickEvidence(result.evidence, extraEffects);
    const hint = this.recordActionEvidence(context, targetId, evidence, actionSignature, next);
    this.publishDocumentChanged(context, targetId, next);
    return this.observationResult(context, targetId, next, evidence, hint ? [hint] : []);
  }

  private async runPressAction(
    context: BrokerToolCallContext,
    targetId: ControlledTargetId,
    session: TargetSession,
    actionSignature: unknown,
    action: (service: ActionService) => Promise<PressActionResult>,
  ): Promise<JsonValue> {
    const before = await this.captureActionSignals(session);
    const harness = this.createActionHarness(context, targetId, session, undefined);
    const result = await action(harness.service);
    const next = harness.observation();
    if (!next) throw new BrowserPilotError('internal_error', 'Key action did not produce an Observation');
    const extraEffects = this.collectActionSignalEffects(session, before, next);
    const evidence = this.mergePressEvidence(result.evidence, extraEffects);
    const hint = this.recordActionEvidence(context, targetId, evidence, actionSignature, next);
    this.publishDocumentChanged(context, targetId, next);
    return this.observationResult(context, targetId, next, evidence, hint ? [hint] : []);
  }

  private async runInputAction(
    context: BrokerToolCallContext,
    targetId: ControlledTargetId,
    session: TargetSession,
    observation: StoredObservation | undefined,
    actionSignature: unknown,
    action: (service: ActionService) => Promise<{ observation: SnapshotResult; evidence: InputVerificationEvidence }>,
  ): Promise<JsonValue> {
    const harness = this.createActionHarness(context, targetId, session, observation);
    const result = await action(harness.service);
    const next = harness.observation();
    if (!next) throw new BrowserPilotError('internal_error', 'Action did not produce an Observation');
    const hint = this.recordActionEvidence(context, targetId, result.evidence, actionSignature, next);
    this.publishDocumentChanged(context, targetId, next);
    return this.observationResult(context, targetId, next, result.evidence, hint ? [hint] : []);
  }

  private createActionHarness(
    context: BrokerToolCallContext,
    targetId: ControlledTargetId,
    session: TargetSession,
    observation: StoredObservation | undefined,
  ): ActionServiceHarness {
    let next: CreatedObservation | undefined;
    const cdpSessionId = this.activeCdpSessionId(session);
    const refStore = observation ? fixedRefStore(targetId, observation) : new MemoryRefStore();
    const observationOptions = {
      refStore,
      ...(session.activeFrame?.executionContextId !== undefined
        ? { executionContextId: session.activeFrame.executionContextId }
        : {}),
      ...(session.activeFrame ? { frameId: session.activeFrame.cdpFrameId } : {}),
    };
    const expectedConnectionGeneration = this.binding.instance.connectionGeneration;
    const expectedFrameId = session.activeFrame?.cdpFrameId;
    const expectedExecutionContextId = session.activeFrame?.executionContextId;
    const observationService = {
      refs: refStore,
      locate: (selector: string) => new ObservationService(
        this.transport,
        cdpSessionId,
        targetId,
        observationOptions,
      ).locate(selector),
      observeAfterAction: async (limit = OBSERVATION_V1_LIMITS.defaultElements) => {
        next = await this.createObservation(context, targetId, session, limit, true);
        return next.snapshot;
      },
    };
    return {
      service: new ActionService(this.transport, cdpSessionId, targetId, {
        refStore,
        observationService,
        refValidator: input => new RefRevalidationService(
          this.transport,
          cdpSessionId,
        ).validateResolved(input.objectId, input.entry, {
          workspaceId: context.workspace!.id,
          leaseId: context.lease!.id,
          targetId,
          ...(observation ? { observationId: observation.id } : {}),
          ref: input.ref,
        }),
        pointerOffset: () => this.activeFramePointerOffset(session),
        onWillDispatch: () => this.markDispatched(context),
        continuityFactory: action => CdpActionContinuityGuard.create(
          this.transport,
          cdpSessionId,
          action,
          {
            ...(expectedFrameId ? { frameId: expectedFrameId } : {}),
            externalCheck: () => this.actionContinuityFailure(
              session,
              expectedConnectionGeneration,
              cdpSessionId,
              expectedFrameId,
              expectedExecutionContextId,
            ),
          },
        ),
        ...(session.activeFrame?.executionContextId !== undefined
          ? { executionContextId: session.activeFrame.executionContextId }
          : {}),
      }),
      observation: () => next,
    };
  }

  private actionContinuityFailure(
    session: TargetSession,
    expectedConnectionGeneration: number,
    expectedCdpSessionId: string,
    expectedFrameId: string | undefined,
    expectedExecutionContextId: number | undefined,
  ): ActionContinuityFailureReason | undefined {
    if (
      this.binding.instance.state !== 'connected' ||
      this.binding.instance.connectionGeneration !== expectedConnectionGeneration
    ) {
      return 'session_changed';
    }
    const current = this.sessions.get(sessionKey(session.leaseId, session.targetId));
    if (!current || current !== session || current.sessionId !== session.sessionId) {
      return 'session_changed';
    }
    if (current.cdpTargetId !== session.cdpTargetId || current.targetId !== session.targetId) {
      return 'target_changed';
    }
    if (this.activeCdpSessionId(current) !== expectedCdpSessionId) return 'session_changed';
    if (current.activeFrame?.cdpFrameId !== expectedFrameId) return 'frame_changed';
    if (current.activeFrame?.executionContextId !== expectedExecutionContextId) {
      return 'document_changed';
    }
    return undefined;
  }

  private observationResult(
    context: BrokerToolCallContext,
    targetId: ControlledTargetId,
    created: CreatedObservation,
    evidence?:
      | InputVerificationEvidence
      | ClickVerificationEvidence
      | PressVerificationEvidence
      | UploadVerificationEvidence
      | ScrollEvidence
      | SelectVerificationEvidence,
    additionalHints: readonly AgentHint[] = [],
  ): JsonValue {
    return asJson({
      ...this.targetResult(context, targetId, created.snapshot.data.url),
      observationId: created.record.id,
      title: created.snapshot.data.title,
      ...(created.snapshot.data.page ? { page: created.snapshot.data.page } : {}),
      elements: created.snapshot.data.elements,
      truncated: created.record.truncated,
      truncationReasons: created.record.truncationReasons,
      hints: [...created.hints, ...additionalHints],
      ...(evidence ? { evidence } : {}),
    });
  }

  private targetResult(
    context: BrokerToolCallContext,
    targetId: ControlledTargetId,
    url: string,
  ): Record<string, JsonValue> {
    const target = this.registry.get({
      principalId: context.principal.id,
      workspaceId: context.workspace!.id,
    }, targetId);
    return {
      workspaceId: context.workspace!.id,
      leaseId: context.lease!.id,
      targetId,
      profileContextId: target.profileContextId,
      url,
    };
  }

  private resolveNewTargetProfile(
    context: BrokerToolCallContext,
    args: Record<string, JsonValue>,
    inventoryContext: TargetInventoryContext,
  ): ProfileContextRecord {
    const explicit = args.profileContextId as ProfileContextId | undefined;
    if (explicit) {
      return this.profileContexts.resolve(explicit, inventoryContext.browserConnectionGeneration);
    }
    const active = this.inventory.activeTarget(inventoryContext);
    if (active) {
      return this.profileContexts.resolve(
        active.profileContextId,
        inventoryContext.browserConnectionGeneration,
      );
    }
    if (context.workspace?.selectedProfileContextId) {
      return this.profileContexts.resolve(
        context.workspace.selectedProfileContextId,
        inventoryContext.browserConnectionGeneration,
      );
    }
    const profiles = this.profileContexts.list(inventoryContext.browserConnectionGeneration);
    if (profiles.length === 1) return profiles[0];
    if (profiles.length === 0) {
      throw new BrowserPilotError('profile_context_unavailable', 'Chrome exposes no live Profile context', {
        retryable: true,
        context: { workspaceId: inventoryContext.workspaceId },
        remediation: {
          code: 'open_profile_window',
          message: 'Open a Chrome window in the intended Profile, then list Profile contexts again.',
          actionRequired: true,
        },
      });
    }
    throw new BrowserPilotError('profile_selection_required', 'Select a Chrome Profile before opening a new target', {
      context: {
        workspaceId: inventoryContext.workspaceId,
        profiles: profiles.map(profile => ({
          profileContextId: profile.id,
          label: profile.label,
          tabCount: profile.tabCount,
          eligibleTabCount: profile.eligibleTabCount,
        })),
      },
      remediation: {
        code: 'select_profile_context',
        message: 'List Profile contexts, ask the user which one to use, and select that context.',
        actionRequired: true,
      },
    });
  }

  private selectWorkspaceProfile(
    context: BrokerToolCallContext,
    profileContextId: ProfileContextId,
  ): void {
    if (!context.selectProfileContext) {
      throw new BrowserPilotError('internal_error', 'Broker cannot update Workspace Profile selection');
    }
    context.selectProfileContext(profileContextId);
  }

  private requireWorkspaceContext(context: BrokerToolCallContext): {
    workspace: NonNullable<BrokerToolCallContext['workspace']>;
    managedTabSet: NonNullable<BrokerToolCallContext['managedTabSet']>;
    lease: NonNullable<BrokerToolCallContext['lease']>;
  } {
    if (!context.workspace || !context.managedTabSet || !context.lease) {
      throw new BrowserPilotError('internal_error', 'Browser tool is missing Workspace context');
    }
    return {
      workspace: context.workspace,
      managedTabSet: context.managedTabSet,
      lease: context.lease,
    };
  }

  private inventoryContext(context: BrokerToolCallContext): TargetInventoryContext {
    const { workspace, lease } = this.requireWorkspaceContext(context);
    return {
      principalId: context.principal.id,
      workspaceId: workspace.id,
      leaseId: lease.id,
      browserConnectionGeneration: context.browser.instance.connectionGeneration,
    };
  }

  private requireTargetId(context: BrokerToolCallContext): ControlledTargetId {
    if (!context.targetId) throw new BrowserPilotError('internal_error', 'Browser tool is missing target context');
    return context.targetId;
  }

  private markDispatched(context: BrokerToolCallContext): void {
    if (context.signal.aborted) {
      throw new BrowserPilotError('command_cancelled', 'Command was cancelled before browser dispatch');
    }
    context.markDispatched();
  }

  private async createArtifact(
    context: BrokerToolCallContext,
    input: Omit<Parameters<ArtifactStore['create']>[0], 'workspaceId' | 'sensitivity'>,
  ): Promise<ArtifactDescriptor> {
    if (!this.artifactStore || !context.workspace) {
      throw new BrowserPilotError('internal_error', 'Browser Artifact storage is unavailable');
    }
    const record = await this.artifactStore.create({
      workspaceId: context.workspace.id,
      sensitivity: 'browser_data',
      ...input,
    });
    return record.descriptor;
  }

  private previewScale(width: number | undefined, height: number | undefined): number | undefined {
    if (!width || !height) return undefined;
    const scale = Math.min(
      1,
      PREVIEW_MAX_DIMENSION / Math.max(width, height),
      Math.sqrt(PREVIEW_MAX_PIXELS / (width * height)),
    );
    return scale < 0.999 ? scale : undefined;
  }

  private activeCdpSessionId(session: TargetSession): string {
    return session.activeFrame?.sessionId ?? session.sessionId;
  }

  private async activeFramePointerOffset(session: TargetSession): Promise<{ x: number; y: number }> {
    const activeFrame = session.activeFrame;
    if (!activeFrame) return { x: 0, y: 0 };
    const frames = this.framesBySession.get(session.sessionId);
    const selected = frames?.byId.get(activeFrame.id);
    const parent = selected?.parentCdpFrameId
      ? frames?.byCdpId.get(selected.parentCdpFrameId)
      : undefined;
    if (!selected || !parent || parent.sessionId !== selected.sessionId) {
      return { x: 0, y: 0 };
    }

    const owner = await this.transport.send('DOM.getFrameOwner', {
      frameId: selected.cdpFrameId,
    }, selected.sessionId);
    if (!Number.isSafeInteger(owner?.backendNodeId) || owner.backendNodeId <= 0) {
      throw new BrowserPilotError('internal_error', 'Chrome returned an invalid frame owner');
    }
    const { model } = await this.transport.send('DOM.getBoxModel', {
      backendNodeId: owner.backendNodeId,
    }, selected.sessionId);
    const content = model?.content;
    if (
      !Array.isArray(content) || content.length < 8 ||
      !content.every((coordinate: unknown) => Number.isFinite(coordinate))
    ) {
      throw new BrowserPilotError('internal_error', 'Chrome returned an invalid frame content box');
    }
    return { x: Number(content[0]), y: Number(content[1]) };
  }

  private async frameLoaderIdentity(
    session: TargetSession,
  ): Promise<{ frameId: string; loaderId: string }> {
    const cdpSessionId = this.activeCdpSessionId(session);
    const { frameTree } = await this.transport.send('Page.getFrameTree', {}, cdpSessionId);
    const findFrame = (node: any): any => {
      if (!session.activeFrame || node?.frame?.id === session.activeFrame.cdpFrameId) return node?.frame;
      for (const child of node?.childFrames ?? []) {
        const match = findFrame(child);
        if (match?.id === session.activeFrame.cdpFrameId) return match;
      }
      return undefined;
    };
    const frame = findFrame(frameTree);
    if (
      typeof frame?.id !== 'string' || frame.id.length === 0 ||
      typeof frame.loaderId !== 'string' || frame.loaderId.length === 0
    ) {
      throw new BrowserPilotError('internal_error', 'Chrome returned an invalid document loader');
    }
    return { frameId: frame.id, loaderId: frame.loaderId };
  }

  private async observationContextIdentity(session: TargetSession): Promise<ObservationContextIdentity> {
    const frame = await this.frameLoaderIdentity(session);
    const params: Record<string, unknown> = {
      expression: 'document',
      returnByValue: false,
    };
    if (session.activeFrame?.executionContextId !== undefined) {
      params.contextId = session.activeFrame.executionContextId;
    }
    const cdpSessionId = this.activeCdpSessionId(session);
    const { result } = await this.transport.send('Runtime.evaluate', params, cdpSessionId);
    if (typeof result?.objectId !== 'string' || result.objectId.length === 0) {
      throw new BrowserPilotError('internal_error', 'Chrome returned an invalid Document identity');
    }
    try {
      const { node } = await this.transport.send('DOM.describeNode', {
        objectId: result.objectId,
        depth: 0,
      }, cdpSessionId);
      if (!Number.isSafeInteger(node?.backendNodeId) || node.backendNodeId <= 0) {
        throw new BrowserPilotError('internal_error', 'Chrome returned an invalid Document identity');
      }
      return {
        ...frame,
        documentGeneration: `document:${node.backendNodeId}`,
      };
    } finally {
      await this.transport.send('Runtime.releaseObject', {
        objectId: result.objectId,
      }, cdpSessionId).catch(() => {});
    }
  }

  private async loaderId(session: TargetSession): Promise<string> {
    return (await this.frameLoaderIdentity(session)).loaderId;
  }

  private async currentUrl(session: TargetSession): Promise<string> {
    const params: Record<string, unknown> = {
      expression: 'location.href',
      returnByValue: true,
    };
    if (session.activeFrame?.executionContextId !== undefined) {
      params.contextId = session.activeFrame.executionContextId;
    }
    const { result } = await this.transport.send(
      'Runtime.evaluate',
      params,
      this.activeCdpSessionId(session),
    );
    if (typeof result?.value !== 'string' || result.value.length === 0 || result.value.length > 16_384) {
      throw new BrowserPilotError('internal_error', 'Chrome returned an invalid document URL');
    }
    return result.value;
  }

  private cleanupTarget(targetId: ControlledTargetId, reason: 'target_closed'): void {
    this.observations.invalidateTarget(targetId, reason);
    const session = [...this.sessions.values()].find(candidate => candidate.targetId === targetId);
    if (session) {
      this.watchdogs.resetTarget(session.leaseId, targetId);
      this.publishEvent({
        workspaceId: session.workspaceId,
        browserConnectionGeneration: session.browserConnectionGeneration,
        leaseId: session.leaseId,
        targetId,
        type: 'observation.invalidated',
        sensitivity: 'browser_data',
        payload: { reason },
      });
    }
    for (const [key, session] of this.sessions) {
      if (session.targetId !== targetId) continue;
      this.retireSession(key, session);
    }
    this.deleteDialogs(dialog => dialog.targetId === targetId);
  }

  private installDialogHandlers(): void {
    this.transport.on?.('Page.javascriptDialogOpening', (params: any, sessionId?: string) => {
      if (!sessionId) return;
      const session = this.targetSessionForCdpSession(sessionId);
      const type = params?.type as DialogType | undefined;
      if (!session || !type || !DIALOG_TYPES.has(type)) return;
      const existingId = this.pendingDialogBySession.get(sessionId);
      if (existingId) {
        const existing = this.pendingDialogs.get(existingId);
        if (existing) this.removeDialog(existing);
      }
      const dialog: PendingDialog = {
        id: `dialog:${randomUUID()}`,
        workspaceId: session.workspaceId,
        leaseId: session.leaseId,
        targetId: session.targetId,
        browserConnectionGeneration: session.browserConnectionGeneration,
        sessionId,
        type,
        message: typeof params.message === 'string' ? params.message : '',
        defaultPrompt: typeof params.defaultPrompt === 'string' ? params.defaultPrompt : '',
        url: typeof params.url === 'string' ? params.url : '',
        openedAt: Date.now(),
      };
      this.dialogOpenSequence += 1;
      this.dialogOpenSequenceBySession.set(sessionId, this.dialogOpenSequence);
      this.pendingDialogs.set(dialog.id, dialog);
      this.pendingDialogBySession.set(sessionId, dialog.id);
      this.watchdogs.resetTarget(dialog.leaseId, dialog.targetId);
      this.publishDialogEvent(dialog, 'opened');
      this.watchdogs.dialogOpened({
        workspaceId: dialog.workspaceId,
        leaseId: dialog.leaseId,
        targetId: dialog.targetId,
        browserConnectionGeneration: dialog.browserConnectionGeneration,
      }, {
        dialogId: dialog.id,
        dialogType: dialog.type,
        openedAt: dialog.openedAt,
      });
    });
    this.transport.on?.('Page.javascriptDialogClosed', (params: any, sessionId?: string) => {
      if (!sessionId) return;
      const dialogId = this.pendingDialogBySession.get(sessionId);
      const dialog = dialogId ? this.pendingDialogs.get(dialogId) : undefined;
      if (!dialog) return;
      const response = this.dialogResponseBySession.get(sessionId);
      this.removeDialog(dialog);
      this.publishDialogEvent(dialog, 'closed', response ?? {
        action: params?.result === true ? 'accept' : 'dismiss',
        externallyHandled: true,
      });
    });
  }

  private installSessionHandlers(): void {
    this.transport.on?.('Target.targetCreated', (params: any) => {
      const info = params?.targetInfo;
      if (info?.type !== 'page' || typeof info.openerId !== 'string') return;
      this.popupSequence += 1;
      this.popupSignals.push({
        sequence: this.popupSequence,
        openerCdpTargetId: info.openerId,
      });
      if (this.popupSignals.length > 256) this.popupSignals.shift();
    });
    this.transport.on?.('Target.detachedFromTarget', (params: any) => {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : undefined;
      if (!sessionId || !this.ownedSessionIds.has(sessionId)) return;
      this.forgetSession(sessionId);
    });
    this.transport.on?.('Page.frameDetached', (params: any, sessionId?: string) => {
      if (!sessionId || typeof params?.frameId !== 'string') return;
      const session = this.targetSessionForCdpSession(sessionId);
      const frames = session ? this.framesBySession.get(session.sessionId) : undefined;
      const detached = frames?.byCdpId.get(params.frameId);
      if (!session || !frames || !detached) return;
      frames.byCdpId.delete(detached.cdpFrameId);
      frames.byId.delete(detached.id);
      if (session.activeFrame?.id !== detached.id) return;
      this.selectedFrameDetached(session, detached.id);
    });
    this.transport.on?.('Page.frameNavigated', (params: any, sessionId?: string) => {
      if (!sessionId || typeof params?.frame?.id !== 'string') return;
      const session = this.targetSessionForCdpSession(sessionId);
      if (session) this.watchdogs.resetTarget(session.leaseId, session.targetId);
      if (
        session?.activeFrame &&
        session.activeFrame.sessionId === sessionId &&
        session.activeFrame.cdpFrameId === params.frame.id
      ) {
        session.activeFrame.executionContextId = undefined;
      }
    });
    this.transport.on?.('Runtime.executionContextDestroyed', (params: any, sessionId?: string) => {
      if (!sessionId || !Number.isSafeInteger(params?.executionContextId)) return;
      const session = this.targetSessionForCdpSession(sessionId);
      if (
        session?.activeFrame &&
        session.activeFrame.sessionId === sessionId &&
        session.activeFrame.executionContextId === params.executionContextId
      ) {
        session.activeFrame.executionContextId = undefined;
      }
    });
    this.transport.on?.('Runtime.executionContextsCleared', (_params: any, sessionId?: string) => {
      if (!sessionId) return;
      const session = this.targetSessionForCdpSession(sessionId);
      if (session?.activeFrame?.sessionId === sessionId) session.activeFrame.executionContextId = undefined;
    });
  }

  private async refreshActiveFrameContext(session: TargetSession): Promise<void> {
    if (!session.activeFrame) return;
    const activeFrameId = session.activeFrame.id;
    const frames = this.syncFrames(session, await this.listSessionFrames(session));
    const frame = frames.byId.get(activeFrameId);
    if (!frame) {
      if (session.activeFrame?.id === activeFrameId) this.selectedFrameDetached(session, activeFrameId);
      throw invalidArgument('Active frame is no longer attached; switch frames and observe again', 'frameId');
    }
    if (frame.id === frames.topFrameId) {
      session.activeFrame = {
        id: frame.id,
        cdpFrameId: frame.cdpFrameId,
        sessionId: frame.sessionId,
        cdpTargetId: frame.cdpTargetId,
      };
      return;
    }
    if (
      session.activeFrame.sessionId === frame.sessionId &&
      session.activeFrame.executionContextId !== undefined
    ) return;
    const service = new FrameService(this.transport, frame.sessionId);
    const selection = await service.selectById(frame.cdpFrameId);
    session.activeFrame = {
      id: frame.id,
      cdpFrameId: frame.cdpFrameId,
      sessionId: frame.sessionId,
      cdpTargetId: frame.cdpTargetId,
      ...(selection.executionContextId !== undefined
        ? { executionContextId: selection.executionContextId }
        : {}),
    };
  }

  private async listSessionFrames(session: TargetSession): Promise<SessionPageFrame[]> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const traversal = await new FrameService(this.transport, session.sessionId).listAcrossTargets({
          rootTargetId: session.cdpTargetId,
          attachment: targetId => this.childFrameSessions.get(session.sessionId)?.get(targetId),
          attach: target => this.attachFrameTarget(session, target),
        });
        await this.pruneFrameTargetSessions(session, new Set(traversal.attachedTargetIds));
        return traversal.frames;
      } catch (error) {
        const children = [...(this.childFrameSessions.get(session.sessionId)?.values() ?? [])];
        if (attempt > 0 || children.length === 0) throw error;
        await Promise.all(children.map(child => (
          this.detachFrameTargetSession(session, child, false, 'frame_detached')
        )));
      }
    }
    throw new BrowserPilotError('internal_error', 'Unable to rebuild the frame tree');
  }

  private async attachFrameTarget(
    session: TargetSession,
    target: FrameTargetInfo,
  ): Promise<ChildFrameSession> {
    const attached = await this.transport.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    if (typeof attached?.sessionId !== 'string' || !attached.sessionId) {
      throw new BrowserPilotError('internal_error', 'Chrome returned an invalid iframe CDP session');
    }
    const child: ChildFrameSession = {
      targetId: target.targetId,
      sessionId: attached.sessionId,
      parentFrameId: target.parentFrameId,
    };
    let children = this.childFrameSessions.get(session.sessionId);
    if (!children) {
      children = new Map();
      this.childFrameSessions.set(session.sessionId, children);
    }
    children.set(target.targetId, child);
    this.ownedSessionIds.add(child.sessionId);
    try {
      await this.network.attachSession({ ...session, sessionId: child.sessionId });
      await this.transport.send('Page.enable', {}, child.sessionId);
      await this.transport.send('Runtime.enable', {}, child.sessionId);
      return child;
    } catch (error) {
      children.delete(target.targetId);
      if (children.size === 0) this.childFrameSessions.delete(session.sessionId);
      this.network.detachSession(child.sessionId);
      this.ownedSessionIds.delete(child.sessionId);
      await this.transport.send('Target.detachFromTarget', { sessionId: child.sessionId }).catch(() => {});
      throw error;
    }
  }

  private async pruneFrameTargetSessions(
    session: TargetSession,
    liveTargetIds: ReadonlySet<string>,
  ): Promise<void> {
    const children = this.childFrameSessions.get(session.sessionId);
    if (!children) return;
    const stale = [...children.values()].filter(child => !liveTargetIds.has(child.targetId));
    await Promise.all(stale.map(child => (
      this.detachFrameTargetSession(session, child, true, 'frame_detached')
    )));
  }

  private syncFrames(session: TargetSession, pageFrames: SessionPageFrame[]): SessionFrames {
    if (pageFrames.length === 0) {
      throw new BrowserPilotError('internal_error', 'Chrome returned an empty frame tree');
    }
    let frames = this.framesBySession.get(session.sessionId);
    if (!frames) {
      const top: BrokerFrameRecord = {
        id: `frame:${randomUUID()}` as FrameId,
        cdpFrameId: pageFrames[0].id,
        sessionId: pageFrames[0].sessionId,
        cdpTargetId: pageFrames[0].cdpTargetId,
        ...(pageFrames[0].loaderId ? { loaderId: pageFrames[0].loaderId } : {}),
        url: pageFrames[0].url,
        name: pageFrames[0].name,
      };
      frames = {
        byId: new Map([[top.id, top]]),
        byCdpId: new Map([[top.cdpFrameId, top]]),
        topFrameId: top.id,
      };
      this.framesBySession.set(session.sessionId, frames);
    }
    const liveCdpIds = new Set(pageFrames.map(frame => frame.id));
    for (const pageFrame of pageFrames) {
      let frame = frames.byCdpId.get(pageFrame.id);
      if (!frame) {
        frame = {
          id: `frame:${randomUUID()}` as FrameId,
          cdpFrameId: pageFrame.id,
          sessionId: pageFrame.sessionId,
          cdpTargetId: pageFrame.cdpTargetId,
          url: pageFrame.url,
          name: pageFrame.name,
        };
        frames.byCdpId.set(pageFrame.id, frame);
        frames.byId.set(frame.id, frame);
      }
      frame.parentCdpFrameId = pageFrame.parentId;
      frame.sessionId = pageFrame.sessionId;
      frame.cdpTargetId = pageFrame.cdpTargetId;
      frame.loaderId = pageFrame.loaderId;
      frame.url = pageFrame.url;
      frame.name = pageFrame.name;
    }
    for (const frame of [...frames.byId.values()]) {
      if (liveCdpIds.has(frame.cdpFrameId)) continue;
      frames.byId.delete(frame.id);
      frames.byCdpId.delete(frame.cdpFrameId);
    }
    const top = frames.byCdpId.get(pageFrames[0].id);
    if (!top) throw new BrowserPilotError('internal_error', 'Chrome returned an invalid top frame');
    frames.topFrameId = top.id;
    return frames;
  }

  private targetSessionForCdpSession(sessionId: string): TargetSession | undefined {
    const root = [...this.sessions.values()].find(candidate => candidate.sessionId === sessionId);
    if (root) return root;
    for (const [rootSessionId, children] of this.childFrameSessions) {
      if (![...children.values()].some(child => child.sessionId === sessionId)) continue;
      return [...this.sessions.values()].find(candidate => candidate.sessionId === rootSessionId);
    }
    return undefined;
  }

  private childFrameSessionById(sessionId: string): {
    session: TargetSession;
    child: ChildFrameSession;
  } | undefined {
    for (const [rootSessionId, children] of this.childFrameSessions) {
      const child = [...children.values()].find(candidate => candidate.sessionId === sessionId);
      if (!child) continue;
      const session = [...this.sessions.values()].find(candidate => candidate.sessionId === rootSessionId);
      if (session) return { session, child };
    }
    return undefined;
  }

  private async detachFrameTargetSession(
    session: TargetSession,
    child: ChildFrameSession,
    requestDetach: boolean,
    reason: ObservationInvalidationReason,
  ): Promise<void> {
    const children = this.childFrameSessions.get(session.sessionId);
    if (children?.get(child.targetId) !== child) return;
    const frames = this.framesBySession.get(session.sessionId);
    const detachedFrameIds = new Set(
      [...(frames?.byId.values() ?? [])]
        .filter(frame => frame.sessionId === child.sessionId)
        .map(frame => frame.cdpFrameId),
    );
    const descendants = [...children.values()].filter(candidate => (
      candidate !== child && detachedFrameIds.has(candidate.parentFrameId)
    ));
    children.delete(child.targetId);
    if (children?.size === 0) this.childFrameSessions.delete(session.sessionId);
    this.observations.invalidateSession(child.sessionId, reason);
    this.network.detachSession(child.sessionId);
    this.ownedSessionIds.delete(child.sessionId);
    this.dialogOpenSequenceBySession.delete(child.sessionId);
    this.deleteDialogs(dialog => dialog.sessionId === child.sessionId);

    if (frames) {
      for (const frame of [...frames.byId.values()]) {
        if (frame.sessionId !== child.sessionId) continue;
        frames.byId.delete(frame.id);
        frames.byCdpId.delete(frame.cdpFrameId);
        if (session.activeFrame?.id === frame.id) this.selectedFrameDetached(session, frame.id);
      }
    }
    await Promise.all(descendants.map(descendant => (
      this.detachFrameTargetSession(session, descendant, requestDetach, reason)
    )));
    if (requestDetach) {
      await this.transport.send('Target.detachFromTarget', { sessionId: child.sessionId }).catch(() => {});
    }
  }

  private retireSession(key: string, session: TargetSession): void {
    void this.retireSessionAndWait(key, session).catch(() => {});
  }

  private async retireSessionAndWait(key: string, session: TargetSession): Promise<void> {
    if (this.sessions.get(key) === session) this.sessions.delete(key);
    this.guidanceBySession.delete(session.sessionId);
    this.downloads?.detachSession(session.sessionId, 'session_replaced');
    await Promise.all(
      [...(this.childFrameSessions.get(session.sessionId)?.values() ?? [])]
        .map(child => this.detachFrameTargetSession(session, child, true, 'session_replaced')),
    );
    await this.transport.send('Target.detachFromTarget', { sessionId: session.sessionId }).catch(() => {});
    this.forgetSession(session.sessionId);
  }

  private forgetSession(sessionId: string): void {
    const child = this.childFrameSessionById(sessionId);
    if (child) {
      void this.detachFrameTargetSession(child.session, child.child, false, 'frame_detached');
      return;
    }
    this.guidanceBySession.delete(sessionId);
    for (const [key, session] of this.sessions) {
      if (session.sessionId !== sessionId) continue;
      for (const childSession of [...(this.childFrameSessions.get(sessionId)?.values() ?? [])]) {
        void this.detachFrameTargetSession(session, childSession, false, 'session_replaced');
      }
      this.watchdogs.resetTarget(session.leaseId, session.targetId);
      this.sessions.delete(key);
    }
    this.network.detachSession(sessionId);
    this.downloads?.detachSession(sessionId, 'target_detached');
    this.framesBySession.delete(sessionId);
    this.dialogOpenSequenceBySession.delete(sessionId);
    this.ownedSessionIds.delete(sessionId);
    this.deleteDialogs(dialog => dialog.sessionId === sessionId);
  }

  private publishTargetEvent(
    type: 'target.attached' | 'popup',
    target: ControlledTargetRecord,
  ): void {
    this.publishEvent({
      workspaceId: target.workspaceId,
      browserConnectionGeneration: target.browserConnectionGeneration,
      ...(target.controllerLeaseId ? { leaseId: target.controllerLeaseId } : {}),
      targetId: target.id,
      type,
      sensitivity: 'browser_data',
      payload: {
        origin: target.origin,
        url: target.url,
        title: target.title,
        ...(target.managedTabSetId ? { managedTabSetId: target.managedTabSetId } : {}),
      },
    });
  }

  private mergeClickEvidence(
    evidence: ClickVerificationEvidence,
    extraEffects: readonly ClickEffect[],
  ): ClickVerificationEvidence {
    const effects = [...new Set([...evidence.effects, ...extraEffects])];
    if (evidence.status !== 'unavailable' || extraEffects.length === 0) {
      return { ...evidence, effects };
    }
    const { reason: _reason, ...rest } = evidence;
    return {
      ...rest,
      status: 'verified',
      effects,
    };
  }

  private mergePressEvidence(
    evidence: PressVerificationEvidence,
    extraEffects: readonly PressEffect[],
  ): PressVerificationEvidence {
    const effects = [...new Set([...evidence.effects, ...extraEffects])];
    if (evidence.status !== 'unavailable' || extraEffects.length === 0) {
      return { ...evidence, effects };
    }
    const { reason: _reason, ...rest } = evidence;
    return {
      ...rest,
      status: 'verified',
      effects,
    };
  }

  private publishDialogEvent(
    dialog: PendingDialog,
    state: 'opened' | 'closed',
    extra: Record<string, JsonValue> = {},
  ): void {
    this.publishEvent({
      workspaceId: dialog.workspaceId,
      browserConnectionGeneration: dialog.browserConnectionGeneration,
      leaseId: dialog.leaseId,
      targetId: dialog.targetId,
      type: 'dialog',
      sensitivity: 'browser_data',
      payload: {
        dialogId: dialog.id,
        state,
        type: dialog.type,
        message: dialog.message,
        url: dialog.url,
        ...(dialog.type === 'prompt' ? { defaultPrompt: dialog.defaultPrompt } : {}),
        ...extra,
      },
    });
  }

  private publishEvent(event: BrowserEventPublication): void {
    try { this.eventPublisher?.(event); } catch { /* browser event handlers must stay non-throwing */ }
  }

  private publishDocumentChanged(
    context: BrokerToolCallContext,
    targetId: ControlledTargetId,
    observation: CreatedObservation,
  ): void {
    this.publishEvent({
      workspaceId: context.workspace!.id,
      browserConnectionGeneration: context.browser.instance.connectionGeneration,
      leaseId: context.lease!.id,
      targetId,
      type: 'document.changed',
      sensitivity: 'browser_data',
      payload: {
        source: 'action',
        observationId: observation.record.id,
        url: observation.snapshot.data.url,
        ...(observation.hints.length > 0 ? { hints: observation.hints } : {}),
      },
    });
  }

  private recordActionEvidence(
    context: BrokerToolCallContext,
    targetId: ControlledTargetId,
    evidence:
      | InputVerificationEvidence
      | ClickVerificationEvidence
      | PressVerificationEvidence
      | UploadVerificationEvidence
      | ScrollEvidence
      | SelectVerificationEvidence,
    actionSignature?: unknown,
    observation?: CreatedObservation,
  ): AgentHint | undefined {
    return this.watchdogs.actionCompleted({
      workspaceId: context.workspace!.id,
      leaseId: context.lease!.id,
      targetId,
      browserConnectionGeneration: context.browser.instance.connectionGeneration,
    }, evidence, actionSignature !== undefined && observation ? {
      actionSignature: stateFingerprint(actionSignature),
      pageFingerprint: stateFingerprint(observation.snapshot.data),
    } : undefined);
  }

  private selectedFrameDetached(session: TargetSession, frameId: FrameId): void {
    session.activeFrame = undefined;
    this.observations.invalidateTarget(session.targetId, 'frame_detached');
    const context = {
      workspaceId: session.workspaceId,
      leaseId: session.leaseId,
      targetId: session.targetId,
      browserConnectionGeneration: session.browserConnectionGeneration,
    };
    this.publishEvent({
      ...context,
      type: 'observation.invalidated',
      sensitivity: 'browser_data',
      payload: { reason: 'frame_detached', frameId },
    });
    this.watchdogs.frameDetached(context, frameId);
  }

  private removeDialog(dialog: PendingDialog): void {
    this.watchdogs.dialogClosed(dialog.id);
    this.pendingDialogs.delete(dialog.id);
    if (this.pendingDialogBySession.get(dialog.sessionId) === dialog.id) {
      this.pendingDialogBySession.delete(dialog.sessionId);
    }
  }

  private deleteDialogs(predicate: (dialog: PendingDialog) => boolean): void {
    for (const dialog of [...this.pendingDialogs.values()]) {
      if (predicate(dialog)) this.removeDialog(dialog);
    }
  }
}
