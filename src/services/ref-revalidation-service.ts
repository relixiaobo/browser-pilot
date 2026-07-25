import {
  DOM_SNAPSHOT_CAPTURE_PARAMS,
  domElementName,
  domElementRole,
  parseDomSnapshot,
} from '../dom-snapshot.js';
import { BrowserPilotError } from '../protocol/errors.js';
import { OBSERVATION_V1_LIMITS } from '../protocol/model.js';
import { axElementSemantic, type RefEntry } from '../snapshot.js';
import type { Transport } from '../transport.js';

const READ_CONNECTED_STATE = `function() {
  /* browser-pilot.ref-revalidation.v1 */
  return !!(this && this.nodeType === 1 && this.isConnected);
}`;

export interface RefRevalidationContext {
  workspaceId?: string;
  leaseId?: string;
  targetId?: string;
  observationId?: string;
  ref?: number;
}

function stale(context: RefRevalidationContext, cause?: unknown): BrowserPilotError {
  return new BrowserPilotError('stale_ref', 'Ref no longer identifies the observed element', {
    context: {
      ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
      ...(context.leaseId ? { leaseId: context.leaseId } : {}),
      ...(context.targetId ? { targetId: context.targetId } : {}),
      ...(context.observationId ? { observationId: context.observationId } : {}),
      ...(context.ref !== undefined ? { ref: context.ref } : {}),
    },
    ...(cause !== undefined ? { cause } : {}),
  });
}

function matches(expected: RefEntry, role: string, name: string): boolean {
  return expected.role === role.slice(0, 128) &&
    expected.name === name.slice(0, OBSERVATION_V1_LIMITS.maxElementNameCharacters);
}

export class RefRevalidationService {
  constructor(
    private readonly transport: Transport,
    private readonly sessionId: string,
  ) {}

  async validate(expected: RefEntry, context: RefRevalidationContext = {}): Promise<void> {
    let objectId: string | undefined;
    try {
      const { object } = await this.transport.send('DOM.resolveNode', {
        backendNodeId: expected.backendNodeId,
      }, this.sessionId);
      if (typeof object?.objectId !== 'string' || !object.objectId) throw stale(context);
      const resolvedObjectId = object.objectId;
      objectId = resolvedObjectId;
      await this.validateResolved(resolvedObjectId, expected, context);
    } catch (error) {
      if (error instanceof BrowserPilotError) throw error;
      throw stale(context, error);
    } finally {
      if (objectId) {
        await this.transport.send('Runtime.releaseObject', { objectId }, this.sessionId).catch(() => {});
      }
    }
  }

  async validateResolved(
    objectId: string,
    expected: RefEntry,
    context: RefRevalidationContext = {},
  ): Promise<void> {
    try {
      await this.assertResolvedIdentity(objectId, expected, context);
    } catch (error) {
      if (error instanceof BrowserPilotError) throw error;
      throw stale(context, error);
    }
  }

  private async assertResolvedIdentity(
    objectId: string,
    expected: RefEntry,
    context: RefRevalidationContext,
  ): Promise<void> {
    const [connected, partialTree] = await Promise.all([
      this.transport.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: READ_CONNECTED_STATE,
        returnByValue: true,
      }, this.sessionId),
      this.transport.send('Accessibility.getPartialAXTree', {
        objectId,
        fetchRelatives: false,
      }, this.sessionId),
    ]);
    if (typeof connected?.result?.value !== 'boolean') {
      throw new BrowserPilotError('internal_error', 'Chrome returned invalid live ref state');
    }
    if (!connected.result.value) throw stale(context);

    const axNodes: unknown[] = Array.isArray(partialTree?.nodes) ? partialTree.nodes : [];
    const axSemantic = axNodes
      .map((node: unknown) => axElementSemantic(node))
      .find(candidate => candidate?.backendNodeId === expected.backendNodeId);
    if (axSemantic) {
      if (axSemantic.role !== expected.role) throw stale(context);
      if (axSemantic.name !== undefined) {
        if (!matches(expected, axSemantic.role, axSemantic.name)) throw stale(context);
        return;
      }
    }

    const rawSnapshot = await this.transport.send(
      'DOMSnapshot.captureSnapshot',
      DOM_SNAPSHOT_CAPTURE_PARAMS,
      this.sessionId,
    );
    const documents = parseDomSnapshot(rawSnapshot).documents;
    const document = documents.find(candidate => candidate.byBackendNodeId.has(expected.backendNodeId));
    const node = document?.byBackendNodeId.get(expected.backendNodeId);
    if (!document || !node || node.nodeType !== 1) throw stale(context);
    if (!axSemantic && !node.isClickable) throw stale(context);
    const role = axSemantic?.role ?? domElementRole(node);
    const name = domElementName(document, node);
    if (!matches(expected, role, name)) throw stale(context);
  }
}
