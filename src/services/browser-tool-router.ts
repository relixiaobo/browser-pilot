import { invalidArgument } from '../protocol/errors.js';
import type {
  BrowserInstance,
  BrowserInstanceId,
  BrowserWorkspace,
  ClientPrincipal,
  ControlledTargetId,
  ControlLease,
  JsonValue,
  ManagedTabSet,
} from '../protocol/model.js';
import type { ToolDefinition } from '../protocol/tools.js';
import {
  ALL_BROWSER_TOOL_NAMES,
  type BrowserToolService,
} from './browser-tool-service.js';
import type {
  BrowserEventPublication,
  BrokerToolCallContext,
  BrowserToolExecutor,
} from './broker-runtime.js';

export class BrowserToolRouter implements BrowserToolExecutor {
  readonly supportedTools = ALL_BROWSER_TOOL_NAMES;

  private readonly services = new Map<BrowserInstanceId, BrowserToolService>();
  private eventPublisher?: (event: BrowserEventPublication) => void;

  register(browserInstanceId: BrowserInstanceId, service: BrowserToolService): void {
    if (this.services.has(browserInstanceId)) {
      throw new Error(`Browser tool service is already registered: ${browserInstanceId}`);
    }
    this.services.set(browserInstanceId, service);
    if (this.eventPublisher) service.setEventPublisher(this.eventPublisher);
  }

  has(browserInstanceId: BrowserInstanceId): boolean {
    return this.services.has(browserInstanceId);
  }

  call(
    context: BrokerToolCallContext,
    definition: ToolDefinition,
    args: JsonValue,
  ): Promise<JsonValue> {
    return this.service(context.browser.instance.id).call(context, definition, args);
  }

  actorKey(
    context: BrokerToolCallContext,
    definition: ToolDefinition,
    args: JsonValue,
  ): string {
    return this.service(context.browser.instance.id).actorKey(context, definition, args);
  }

  commandTargetId(
    context: BrokerToolCallContext,
    definition: ToolDefinition,
    args: JsonValue,
  ): ControlledTargetId | undefined {
    return this.service(context.browser.instance.id).commandTargetId(context, definition, args);
  }

  setEventPublisher(publisher: (event: BrowserEventPublication) => void): void {
    this.eventPublisher = publisher;
    for (const service of this.services.values()) service.setEventPublisher(publisher);
  }

  browserConnectionChanged(previous: BrowserInstance, current: BrowserInstance): void {
    this.services.get(current.id)?.browserConnectionChanged(previous, current);
  }

  releaseLease(lease: ControlLease): void {
    for (const service of this.services.values()) service.releaseLease(lease);
  }

  releaseWorkspace(
    principal: ClientPrincipal,
    workspace: BrowserWorkspace,
    managedTabSet: ManagedTabSet,
  ): void {
    this.services.get(workspace.browserInstanceId)?.releaseWorkspace(
      principal,
      workspace,
      managedTabSet,
    );
  }

  private service(browserInstanceId: BrowserInstanceId): BrowserToolService {
    const service = this.services.get(browserInstanceId);
    if (service) return service;
    throw invalidArgument('Browser control service is unavailable for this browser instance', 'browserId');
  }
}
