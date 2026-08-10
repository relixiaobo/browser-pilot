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
      // Searches this document and its same-origin frames, matching what a
      // snapshot reports and what `bp find` resolves. Coordinates are measured
      // relative to THIS context's document, not the page: the caller adds the
      // observed frame's own page offset when dispatching, so walking past
      // `window` here would count that offset twice.
      //
      // The frame chain is summed after scrollIntoView, never before -- scrolling
      // an element into view can move the frames above it, which would leave a
      // pre-computed offset describing where the frame used to be.
      expression: `JSON.stringify((function(){
        var queue=[document];var scanned=0;
        while(queue.length&&scanned<512){
          var doc=queue.shift();scanned+=1;
          var el=doc.querySelector(${JSON.stringify(selector)});
          if(el){
            el.scrollIntoView({block:'center',inline:'center'});
            var r=el.getBoundingClientRect();var x=r.x;var y=r.y;
            for(var w=doc.defaultView;w&&w!==window&&w.frameElement;w=w.parent){
              var f=w.frameElement.getBoundingClientRect();x+=f.x;y+=f.y;
            }
            return{x:Math.round(x+r.width/2),y:Math.round(y+r.height/2),top:Math.round(y),left:Math.round(x),width:Math.round(r.width),height:Math.round(r.height)};
          }
          var frames=doc.querySelectorAll('iframe');
          for(var i=0;i<frames.length;i++){
            var child=null;
            try{child=frames[i].contentDocument;}catch(error){child=null;}
            if(child)queue.push(child);
          }
        }
        return null;
      })())`,
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
