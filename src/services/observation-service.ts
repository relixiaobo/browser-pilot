import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import { OBSERVATION_V1_LIMITS } from '../protocol/model.js';
import {
  MemoryRefStore,
  takeSnapshot,
  type RefStore,
  type SnapshotResult,
} from '../snapshot.js';
import { waitForLoad } from '../session.js';
import type { Transport } from '../transport.js';

export interface ElementLocation {
  x: number;
  y: number;
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface ObservationServiceOptions {
  refStore?: RefStore;
  settleDelayMs?: number;
  loadTimeoutMs?: number;
  waitForLoad?: (transport: Transport, sessionId: string, timeout: number) => Promise<void>;
  executionContextId?: number;
  frameId?: string;
  maxDomTextNodes?: number;
  onDomTextNode?: () => void;
}

export class ObservationService {
  private readonly refStore: RefStore;
  private readonly settleDelayMs: number;
  private readonly loadTimeoutMs: number;
  private readonly loadWaiter: (transport: Transport, sessionId: string, timeout: number) => Promise<void>;
  private readonly executionContextId?: number;
  private readonly frameId?: string;
  private readonly maxDomTextNodes?: number;
  private readonly onDomTextNode?: () => void;

  constructor(
    private readonly transport: Transport,
    private readonly sessionId: string,
    private readonly targetId: string,
    options: ObservationServiceOptions = {},
  ) {
    this.refStore = options.refStore ?? new MemoryRefStore();
    this.settleDelayMs = options.settleDelayMs ?? 300;
    this.loadTimeoutMs = options.loadTimeoutMs ?? 10_000;
    this.loadWaiter = options.waitForLoad ?? waitForLoad;
    this.executionContextId = options.executionContextId;
    this.frameId = options.frameId;
    this.maxDomTextNodes = options.maxDomTextNodes;
    this.onDomTextNode = options.onDomTextNode;
  }

  get refs(): RefStore {
    return this.refStore;
  }

  async observe(limit: number = OBSERVATION_V1_LIMITS.defaultElements): Promise<SnapshotResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > OBSERVATION_V1_LIMITS.maxElements) {
      throw invalidArgument(
        `Observation limit must be an integer from 1 through ${OBSERVATION_V1_LIMITS.maxElements}`,
        'limit',
      );
    }
    return takeSnapshot(this.transport, this.sessionId, this.targetId, limit, this.refStore, {
      ...(this.executionContextId !== undefined ? { executionContextId: this.executionContextId } : {}),
      ...(this.frameId !== undefined ? { frameId: this.frameId } : {}),
      ...(this.maxDomTextNodes !== undefined ? { maxDomTextNodes: this.maxDomTextNodes } : {}),
      ...(this.onDomTextNode ? { onDomTextNode: this.onDomTextNode } : {}),
    });
  }

  async observeAfterAction(limit: number = OBSERVATION_V1_LIMITS.defaultElements): Promise<SnapshotResult> {
    if (this.settleDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.settleDelayMs));
    }
    await this.loadWaiter(this.transport, this.sessionId, this.loadTimeoutMs);
    return this.observe(limit);
  }

  async locate(selector: string): Promise<ElementLocation> {
    if (!selector) throw invalidArgument('Selector must not be empty', 'selector');
    const params: Record<string, unknown> = {
      expression: `JSON.stringify((function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;el.scrollIntoView({block:'center',inline:'center'});var r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),top:Math.round(r.top),left:Math.round(r.left),width:Math.round(r.width),height:Math.round(r.height)}})())`,
      returnByValue: true,
    };
    if (this.executionContextId) params.contextId = this.executionContextId;
    const { result, exceptionDetails } = await this.transport.send('Runtime.evaluate', params, this.sessionId);
    if (exceptionDetails) {
      throw invalidArgument(
        exceptionDetails.exception?.description || exceptionDetails.text || 'Element query failed',
        'selector',
      );
    }
    if (!result.value || result.value === 'null') {
      throw invalidArgument(`Element not found: ${selector}`, 'selector');
    }
    let location: unknown;
    try {
      location = JSON.parse(result.value);
    } catch (cause) {
      throw new BrowserPilotError('internal_error', 'Chrome returned invalid element coordinates', { cause });
    }
    if (
      typeof location !== 'object' || location === null ||
      !['x', 'y', 'top', 'left', 'width', 'height']
        .every(key => Number.isFinite((location as Record<string, unknown>)[key]))
    ) {
      throw new BrowserPilotError('internal_error', 'Chrome returned invalid element coordinates');
    }
    return location as ElementLocation;
  }
}
