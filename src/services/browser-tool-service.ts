import { randomUUID } from 'node:crypto';
import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import type {
  ArtifactDescriptor,
  BrowserOperation,
  BrowserWorkspaceId,
  ControlledTargetId,
  ControlLease,
  ControlLeaseId,
  JsonValue,
  ManagedTabSetId,
  ObservationId,
} from '../protocol/model.js';
import type { ToolDefinition } from '../protocol/tools.js';
import { INJECT_BORDER } from '../page-scripts.js';
import { MemoryRefStore, type RefStore, type SnapshotResult } from '../snapshot.js';
import type { Transport } from '../transport.js';
import { waitForLoad } from '../session.js';
import { ActionService, type InputVerificationEvidence } from './action-service.js';
import { ArtifactStore } from './artifact-store.js';
import { CdpBrowserTargetCatalog } from './browser-target-catalog.js';
import { createBrowserControlPolicy } from './browser-control-policy.js';
import { MemoryControlledTargetRegistry } from './controlled-target-registry.js';
import { CookieService } from './cookie-service.js';
import { CaptureService } from './capture-service.js';
import { MemoryObservationStore, type StoredObservation } from './observation-store.js';
import { ObservationService } from './observation-service.js';
import { PageContentService } from './page-content-service.js';
import { TargetInventoryService, type TargetInventoryContext } from './target-inventory-service.js';
import type {
  BrokerBrowserBinding,
  BrokerToolCallContext,
  BrowserToolExecutor,
} from './broker-runtime.js';

const BASE_SUPPORTED_TOOLS = [
  'browser.discover',
  'browser.connect',
  'browser.open',
  'browser.observe',
  'browser.read',
  'browser.click',
  'browser.type',
  'browser.keyboard',
  'browser.press',
  'browser.tabs.list',
  'browser.tabs.switch',
  'browser.tabs.close',
  'browser.cookies.list',
  'browser.eval',
] as const;

const PREVIEW_MAX_DIMENSION = 1600;
const PREVIEW_MAX_PIXELS = 2_000_000;

interface TargetSession {
  workspaceId: BrowserWorkspaceId;
  leaseId: ControlLeaseId;
  targetId: ControlledTargetId;
  cdpTargetId: string;
  sessionId: string;
}

interface CreatedObservation {
  snapshot: SnapshotResult;
  record: StoredObservation;
}

function asRecord(value: JsonValue): Record<string, JsonValue> {
  return value as Record<string, JsonValue>;
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function sessionKey(leaseId: ControlLeaseId, targetId: ControlledTargetId): string {
  return `${leaseId}\u0000${targetId}`;
}

function fixedRefStore(targetId: ControlledTargetId, observation: StoredObservation): RefStore {
  const store = new MemoryRefStore();
  store.save(targetId, observation.refs);
  return store;
}

export class BrowserToolService implements BrowserToolExecutor {
  readonly supportedTools: readonly string[];

  private readonly registry = new MemoryControlledTargetRegistry();
  private readonly observations: MemoryObservationStore;
  private readonly inventory: TargetInventoryService;
  private readonly sessions = new Map<string, TargetSession>();
  private readonly managedWindowIds = new Map<ManagedTabSetId, number>();
  private readonly artifactStore?: ArtifactStore;

  constructor(
    private readonly transport: Transport,
    private readonly binding: BrokerBrowserBinding,
    options: {
      observations?: MemoryObservationStore;
      artifactStore?: ArtifactStore;
    } = {},
  ) {
    this.observations = options.observations ?? new MemoryObservationStore();
    this.artifactStore = options.artifactStore;
    this.supportedTools = this.artifactStore
      ? [...BASE_SUPPORTED_TOOLS, 'browser.capture', 'browser.pdf']
      : BASE_SUPPORTED_TOOLS;
    const catalog = new CdpBrowserTargetCatalog(
      transport,
      binding.instance.id,
      () => ({
        profileIdentity: binding.instance.profilePath,
        connectionGeneration: binding.instance.connectionGeneration,
      }),
      {
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
        onInvalidated: invalidation => this.observations.invalidateTarget(
          invalidation.targetId,
          invalidation.reason,
        ),
      },
    );
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
      case 'browser.tabs.list': return this.listTabs(context, args);
      case 'browser.tabs.switch': return this.switchTab(context, args);
      case 'browser.tabs.close': return this.closeTab(context);
      case 'browser.open': return this.open(context, args);
      case 'browser.observe': return this.observe(context, args);
      case 'browser.read': return this.read(context, args);
      case 'browser.click': return this.click(context, args);
      case 'browser.type': return this.type(context, args);
      case 'browser.keyboard': return this.keyboard(context, args);
      case 'browser.press': return this.press(context, args);
      case 'browser.capture': return this.capture(context, args);
      case 'browser.pdf': return this.pdf(context, args);
      case 'browser.cookies.list': return this.cookies(context, args);
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
    const targetId = this.commandTargetId(context, definition, argsValue);
    if (targetId) return `${browserId}\u0000target\u0000${targetId}`;
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
    this.inventory.releaseLease(lease.id);
    this.observations.releaseLease(lease.id);
    for (const [key, session] of this.sessions) {
      if (session.leaseId !== lease.id) continue;
      this.sessions.delete(key);
      void this.transport.send('Target.detachFromTarget', { sessionId: session.sessionId }).catch(() => {});
    }
  }

  releaseWorkspace(
    principal: BrokerToolCallContext['principal'],
    workspace: NonNullable<BrokerToolCallContext['workspace']>,
    managedTabSet: NonNullable<BrokerToolCallContext['managedTabSet']>,
  ): void {
    const caller = { principalId: principal.id, workspaceId: workspace.id };
    const records = this.registry.activeRecords(caller);
    this.inventory.releaseWorkspace(caller);
    this.observations.releaseWorkspace(workspace.id);
    this.managedWindowIds.delete(managedTabSet.id);
    for (const [key, session] of this.sessions) {
      if (session.workspaceId !== workspace.id) continue;
      this.sessions.delete(key);
      void this.transport.send('Target.detachFromTarget', { sessionId: session.sessionId }).catch(() => {});
    }
    for (const target of records) {
      if (target.origin === 'user_tab') continue;
      void this.transport.send('Target.closeTarget', { targetId: target.cdpTargetId }).catch(() => {});
    }
  }

  private discover(): JsonValue {
    const candidate = this.binding.candidate;
    return asJson({
      browsers: [{
        id: candidate.id,
        product: candidate.product,
        ...(candidate.channel !== undefined ? { channel: candidate.channel } : {}),
        ...(candidate.profile !== undefined ? { profile: candidate.profile } : {}),
        state: candidate.state,
      }],
    });
  }

  private connect(context: BrokerToolCallContext, args: Record<string, JsonValue>): JsonValue {
    const { workspace, lease } = this.requireWorkspaceContext(context);
    if (args.browserId !== this.binding.candidate.id) {
      throw new BrowserPilotError('browser_not_found', 'Browser candidate does not match this Workspace', {
        context: { workspaceId: workspace.id, browserId: String(args.browserId) },
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

  private async switchTab(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const inventoryContext = this.inventoryContext(context);
    const targetId = args.targetId as ControlledTargetId;
    await this.inventory.refresh(inventoryContext);
    this.markDispatched(context);
    const resolved = await this.inventory.activate(inventoryContext, targetId);
    const record = this.registry.get(inventoryContext, targetId);
    await this.ensureSession(inventoryContext, targetId, resolved.cdpTargetId);
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
      this.markDispatched(context);
      targetId = await this.createManagedTarget(context, inventoryContext);
    }

    const resolved = await this.inventory.resolveForOperation(inventoryContext, targetId, 'page.navigate');
    this.markDispatched(context);
    this.registry.setActive(inventoryContext, inventoryContext.leaseId, targetId);
    const session = await this.ensureSession(inventoryContext, targetId, resolved.cdpTargetId);
    this.observations.invalidateTarget(targetId, 'navigation');
    const navigation = await this.transport.send('Page.navigate', { url }, session.sessionId);
    if (navigation?.errorText) {
      throw new BrowserPilotError('invalid_argument', `Navigation failed: ${navigation.errorText}`, {
        context: { targetId, url },
      });
    }
    await waitForLoad(this.transport, session.sessionId);
    return this.observationResult(
      context,
      targetId,
      await this.createObservation(context, targetId, session, Number(args.observationLimit ?? 50), false),
    );
  }

  private async observe(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.observe');
    const created = await this.createObservation(context, targetId, session, Number(args.limit ?? 50), false);
    return this.observationResult(context, targetId, created);
  }

  private async read(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.observe');
    const result = await new PageContentService(this.transport, session.sessionId).read(
      args.selector as string | undefined,
      Number(args.limit ?? 100_000),
    );
    return asJson({
      ...this.targetResult(context, targetId, result.url),
      title: result.title,
      text: result.text,
      length: result.length,
      truncated: result.truncated,
    });
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
      this.markDispatched(context);
      return this.runAction(context, targetId, session, observation, service => service.click(
        { kind: 'ref', ref: String(target.ref) },
        {
          button: args.button as 'left' | 'right' | undefined,
          clickCount: args.clickCount as 1 | 2 | undefined,
        },
      ));
    }
    this.markDispatched(context);
    return this.runAction(context, targetId, session, undefined, service => service.click({
      kind: 'coordinates',
      x: Number(target.x),
      y: Number(target.y),
    }, {
      button: args.button as 'left' | 'right' | undefined,
      clickCount: args.clickCount as 1 | 2 | undefined,
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
    this.markDispatched(context);
    return this.runInputAction(context, targetId, session, observation, service => service.type(
      String(args.ref),
      args.text as string,
      {
        clear: args.clear as boolean | undefined,
        submit: args.submit as boolean | undefined,
        verification: args.verification as 'report' | 'require_exact' | undefined,
      },
    ));
  }

  private async keyboard(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.interact');
    this.markDispatched(context);
    return this.runInputAction(context, targetId, session, undefined, service => service.keyboard(
      args.text as string,
      {
        clear: args.clear as boolean | undefined,
        submit: args.submit as boolean | undefined,
        delayMs: args.delayMs as number | undefined,
        focusSelector: args.focusSelector as string | undefined,
        verification: args.verification as 'report' | 'require_exact' | undefined,
      },
    ));
  }

  private async press(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.interact');
    this.markDispatched(context);
    return this.runAction(context, targetId, session, undefined, service => service.press(args.key as string));
  }

  private async capture(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'page.capture');
    const capture = new CaptureService(this.transport, session.sessionId);
    const options = {
      fullPage: args.fullPage as boolean | undefined,
      selector: args.selector as string | undefined,
    };
    const media = await capture.screenshot(options);
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
      return asJson({ ...this.targetResult(context, targetId, record.url), artifact });
    }

    const previewMedia = await capture.screenshot({ ...options, scale });
    if (args.includeOriginal !== true) {
      const artifact = await this.createArtifact(context, {
        kind: 'screenshot_preview',
        mimeType: previewMedia.mimeType,
        bytes: previewMedia.bytes,
        ...(previewMedia.width !== undefined ? { width: previewMedia.width } : {}),
        ...(previewMedia.height !== undefined ? { height: previewMedia.height } : {}),
      });
      return asJson({ ...this.targetResult(context, targetId, record.url), artifact });
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
      return asJson({ ...this.targetResult(context, targetId, record.url), artifact, preview });
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

  private async evaluate(context: BrokerToolCallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const targetId = this.requireTargetId(context);
    const session = await this.resolveTargetSession(context, targetId, 'developer.eval');
    this.markDispatched(context);
    const { result, exceptionDetails } = await this.transport.send('Runtime.evaluate', {
      expression: args.expression,
      returnByValue: true,
      awaitPromise: args.awaitPromise ?? true,
    }, session.sessionId);
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

  private async createManagedTarget(
    context: BrokerToolCallContext,
    inventoryContext: TargetInventoryContext,
  ): Promise<ControlledTargetId> {
    const { managedTabSet } = this.requireWorkspaceContext(context);
    const windowId = this.managedWindowIds.get(managedTabSet.id);
    const created = await this.transport.send('Target.createTarget', {
      url: 'about:blank',
      ...(windowId !== undefined ? { windowId } : { newWindow: true }),
    });
    if (typeof created?.targetId !== 'string') {
      throw new BrowserPilotError('internal_error', 'Chrome returned an invalid target ID');
    }
    try {
      if (windowId === undefined) {
        const window = await this.transport.send('Browser.getWindowForTarget', { targetId: created.targetId });
        if (Number.isSafeInteger(window?.windowId)) this.managedWindowIds.set(managedTabSet.id, window.windowId);
      }
      const registered = this.inventory.registerManagedTarget({
        ...inventoryContext,
        managedTabSetId: managedTabSet.id,
        cdpTargetId: created.targetId,
        title: '',
        url: 'about:blank',
      });
      await this.inventory.activate(inventoryContext, registered.id);
      return registered.id;
    } catch (error) {
      await this.transport.send('Target.closeTarget', { targetId: created.targetId }).catch(() => {});
      throw error;
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
    return this.ensureSession(inventoryContext, targetId, resolved.cdpTargetId);
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
        this.sessions.delete(key);
        this.observations.invalidateSession(existing.sessionId);
      }
    }
    const attached = await this.transport.send('Target.attachToTarget', {
      targetId: cdpTargetId,
      flatten: true,
    });
    if (typeof attached?.sessionId !== 'string') {
      throw new BrowserPilotError('internal_error', 'Chrome returned an invalid CDP session');
    }
    await this.transport.send('Page.enable', {}, attached.sessionId).catch(() => {});
    await this.transport.send('Runtime.evaluate', { expression: INJECT_BORDER }, attached.sessionId).catch(() => {});
    const session: TargetSession = {
      workspaceId: context.workspaceId,
      leaseId: context.leaseId,
      targetId,
      cdpTargetId,
      sessionId: attached.sessionId,
    };
    this.sessions.set(key, session);
    return session;
  }

  private async createObservation(
    context: BrokerToolCallContext,
    targetId: ControlledTargetId,
    session: TargetSession,
    limit: number,
    afterAction: boolean,
  ): Promise<CreatedObservation> {
    const refs = new MemoryRefStore();
    const service = new ObservationService(this.transport, session.sessionId, targetId, { refStore: refs });
    const snapshot = afterAction
      ? await service.observeAfterAction(limit)
      : await service.observe(limit);
    const loaderId = await this.loaderId(session.sessionId);
    const record = this.observations.create({
      workspaceId: context.workspace!.id,
      leaseId: context.lease!.id,
      targetId,
      browserConnectionGeneration: context.browser.instance.connectionGeneration,
      sessionId: session.sessionId,
      loaderId,
      refs: refs.load(targetId),
      truncated: snapshot.truncated ?? false,
      truncationReasons: snapshot.truncationReasons ?? [],
    });
    return { snapshot, record };
  }

  private async resolveObservation(
    context: BrokerToolCallContext,
    targetId: ControlledTargetId,
    session: TargetSession,
    observationId: ObservationId,
    ref: number,
  ): Promise<StoredObservation> {
    const loaderId = await this.loaderId(session.sessionId);
    const observation = this.observations.resolve({
      workspaceId: context.workspace!.id,
      leaseId: context.lease!.id,
      targetId,
      observationId,
      browserConnectionGeneration: context.browser.instance.connectionGeneration,
      sessionId: session.sessionId,
      loaderId,
      ref,
    });
    try {
      const resolved = await this.transport.send('DOM.resolveNode', {
        backendNodeId: observation.refs[ref - 1].backendNodeId,
      }, session.sessionId);
      if (resolved?.object?.objectId) {
        await this.transport.send('Runtime.releaseObject', {
          objectId: resolved.object.objectId,
        }, session.sessionId).catch(() => {});
      }
    } catch (cause) {
      this.observations.invalidateTarget(targetId, 'loader_replaced');
      throw new BrowserPilotError('stale_ref', 'Observation node is no longer resolvable', {
        context: { workspaceId: context.workspace!.id, targetId, observationId, ref },
        cause,
      });
    }
    return observation;
  }

  private async runAction(
    context: BrokerToolCallContext,
    targetId: ControlledTargetId,
    session: TargetSession,
    observation: StoredObservation | undefined,
    action: (service: ActionService) => Promise<SnapshotResult>,
  ): Promise<JsonValue> {
    let next: CreatedObservation | undefined;
    const refStore = observation ? fixedRefStore(targetId, observation) : new MemoryRefStore();
    const observationService = {
      refs: refStore,
      locate: (selector: string) => new ObservationService(
        this.transport,
        session.sessionId,
        targetId,
        { refStore },
      ).locate(selector),
      observeAfterAction: async (limit = 50) => {
        next = await this.createObservation(context, targetId, session, limit, true);
        return next.snapshot;
      },
    };
    await action(new ActionService(this.transport, session.sessionId, targetId, {
      refStore,
      observationService,
    }));
    if (!next) throw new BrowserPilotError('internal_error', 'Action did not produce an Observation');
    return this.observationResult(context, targetId, next);
  }

  private async runInputAction(
    context: BrokerToolCallContext,
    targetId: ControlledTargetId,
    session: TargetSession,
    observation: StoredObservation | undefined,
    action: (service: ActionService) => Promise<{ observation: SnapshotResult; evidence: InputVerificationEvidence }>,
  ): Promise<JsonValue> {
    let evidence: InputVerificationEvidence | undefined;
    let next: CreatedObservation | undefined;
    const refStore = observation ? fixedRefStore(targetId, observation) : new MemoryRefStore();
    const observationService = {
      refs: refStore,
      locate: (selector: string) => new ObservationService(
        this.transport,
        session.sessionId,
        targetId,
        { refStore },
      ).locate(selector),
      observeAfterAction: async (limit = 50) => {
        next = await this.createObservation(context, targetId, session, limit, true);
        return next.snapshot;
      },
    };
    const result = await action(new ActionService(this.transport, session.sessionId, targetId, {
      refStore,
      observationService,
    }));
    evidence = result.evidence;
    if (!next) throw new BrowserPilotError('internal_error', 'Action did not produce an Observation');
    return this.observationResult(context, targetId, next, evidence);
  }

  private observationResult(
    context: BrokerToolCallContext,
    targetId: ControlledTargetId,
    created: CreatedObservation,
    evidence?: InputVerificationEvidence,
  ): JsonValue {
    return asJson({
      ...this.targetResult(context, targetId, created.snapshot.data.url),
      observationId: created.record.id,
      title: created.snapshot.data.title,
      elements: created.snapshot.data.elements,
      truncated: created.record.truncated,
      truncationReasons: created.record.truncationReasons,
      ...(evidence ? { evidence } : {}),
    });
  }

  private targetResult(
    context: BrokerToolCallContext,
    targetId: ControlledTargetId,
    url: string,
  ): Record<string, JsonValue> {
    return {
      workspaceId: context.workspace!.id,
      leaseId: context.lease!.id,
      targetId,
      url,
    };
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

  private async loaderId(sessionId: string): Promise<string> {
    const { frameTree } = await this.transport.send('Page.getFrameTree', {}, sessionId);
    const loaderId = frameTree?.frame?.loaderId;
    if (typeof loaderId !== 'string' || loaderId.length === 0) {
      throw new BrowserPilotError('internal_error', 'Chrome returned an invalid document loader');
    }
    return loaderId;
  }

  private cleanupTarget(targetId: ControlledTargetId, reason: 'target_closed'): void {
    this.observations.invalidateTarget(targetId, reason);
    for (const [key, session] of this.sessions) {
      if (session.targetId !== targetId) continue;
      this.sessions.delete(key);
      void this.transport.send('Target.detachFromTarget', { sessionId: session.sessionId }).catch(() => {});
    }
  }
}
