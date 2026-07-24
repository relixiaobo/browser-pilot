import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import {
  legacyRefStore,
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
}

export class ObservationService {
  private readonly refStore: RefStore;
  private readonly settleDelayMs: number;
  private readonly loadTimeoutMs: number;
  private readonly loadWaiter: (transport: Transport, sessionId: string, timeout: number) => Promise<void>;

  constructor(
    private readonly transport: Transport,
    private readonly sessionId: string,
    private readonly targetId: string,
    options: ObservationServiceOptions = {},
  ) {
    this.refStore = options.refStore ?? legacyRefStore;
    this.settleDelayMs = options.settleDelayMs ?? 300;
    this.loadTimeoutMs = options.loadTimeoutMs ?? 10_000;
    this.loadWaiter = options.waitForLoad ?? waitForLoad;
  }

  get refs(): RefStore {
    return this.refStore;
  }

  async observe(limit = 50): Promise<SnapshotResult> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw invalidArgument('Observation limit must be a positive integer', 'limit');
    }
    return takeSnapshot(this.transport, this.sessionId, this.targetId, limit, this.refStore);
  }

  async observeAfterAction(limit = 50): Promise<SnapshotResult> {
    if (this.settleDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.settleDelayMs));
    }
    await this.loadWaiter(this.transport, this.sessionId, this.loadTimeoutMs);
    return this.observe(limit);
  }

  async locate(selector: string): Promise<ElementLocation> {
    if (!selector) throw invalidArgument('Selector must not be empty', 'selector');
    const { result } = await this.transport.send('Runtime.evaluate', {
      expression: `JSON.stringify((function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;el.scrollIntoView({block:'center',inline:'center'});var r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),top:Math.round(r.top),left:Math.round(r.left),width:Math.round(r.width),height:Math.round(r.height)}})())`,
      returnByValue: true,
    }, this.sessionId);
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
