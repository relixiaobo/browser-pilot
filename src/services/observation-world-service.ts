import { BrowserPilotError } from '../protocol/errors.js';
import type { Transport } from '../transport.js';

const OBSERVATION_WORLD_NAME = 'browser-pilot.observation.v1';

interface CachedObservationWorld {
  readonly sessionId: string;
  readonly frameId: string;
  promise: Promise<number>;
  executionContextId?: number;
}

function cacheKey(sessionId: string, frameId: string): string {
  return `${sessionId}\u0000${frameId}`;
}

export class ObservationWorldService {
  private readonly worlds = new Map<string, CachedObservationWorld>();

  constructor(private readonly transport: Transport) {}

  async contextId(sessionId: string, frameId: string): Promise<number> {
    const key = cacheKey(sessionId, frameId);
    const cached = this.worlds.get(key);
    if (cached) return cached.promise;

    const creation = this.createWorld(sessionId, frameId);
    const world: CachedObservationWorld = {
      sessionId,
      frameId,
      promise: creation,
    };
    world.promise = creation.then(executionContextId => {
      world.executionContextId = executionContextId;
      if (this.worlds.get(key) !== world) return this.contextId(sessionId, frameId);
      return executionContextId;
    }).catch(error => {
      if (this.worlds.get(key) === world) this.worlds.delete(key);
      throw error;
    });
    this.worlds.set(key, world);
    return world.promise;
  }

  invalidateFrame(sessionId: string, frameId: string): void {
    this.worlds.delete(cacheKey(sessionId, frameId));
  }

  invalidateContext(sessionId: string, executionContextId: number): void {
    for (const [key, world] of this.worlds) {
      if (world.sessionId === sessionId && world.executionContextId === executionContextId) {
        this.worlds.delete(key);
      }
    }
  }

  invalidateSession(sessionId: string): void {
    for (const [key, world] of this.worlds) {
      if (world.sessionId === sessionId) this.worlds.delete(key);
    }
  }

  private async createWorld(sessionId: string, frameId: string): Promise<number> {
    const { executionContextId } = await this.transport.send('Page.createIsolatedWorld', {
      frameId,
      worldName: OBSERVATION_WORLD_NAME,
      grantUniveralAccess: false,
    }, sessionId);
    if (!Number.isSafeInteger(executionContextId) || executionContextId < 1) {
      throw new BrowserPilotError('internal_error', 'Chrome returned an invalid observation execution context');
    }
    return executionContextId;
  }
}
