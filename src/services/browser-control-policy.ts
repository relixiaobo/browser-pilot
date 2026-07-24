import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import {
  BROWSER_OPERATIONS,
  type BrowserInstanceId,
  type BrowserOperation,
  type BrowserWorkspaceId,
  type ClientPrincipalId,
} from '../protocol/model.js';

export interface WorkspaceCallerContext {
  principalId: ClientPrincipalId;
  workspaceId: BrowserWorkspaceId;
}

export interface EligibleUserTarget {
  cdpTargetId: string;
  title: string;
  url: string;
  openerCdpTargetId?: string;
}

export interface BrowserTargetCatalog {
  getBrowserIdentity(browserInstanceId: BrowserInstanceId): Promise<{
    profileIdentity: string;
    connectionGeneration: number;
  } | undefined>;
  listEligibleUserTargets(browserInstanceId: BrowserInstanceId): Promise<EligibleUserTarget[]>;
}

export interface UserBrowserTarget extends EligibleUserTarget {
  browserInstanceId: BrowserInstanceId;
}

export interface BrowserControlPolicy {
  listUserTargets(browserInstanceId: BrowserInstanceId): Promise<UserBrowserTarget[]>;
  assertOperation(operation: BrowserOperation): void;
}

export interface BrowserControlPolicyOptions {
  deniedOperations?: readonly BrowserOperation[];
}

function assertKnownOperations(operations: readonly BrowserOperation[]): void {
  const known = new Set<string>(BROWSER_OPERATIONS);
  if (operations.some(operation => !known.has(operation))) {
    throw invalidArgument('Unknown browser operation', 'deniedOperations');
  }
}

/**
 * Browser Pilot exposes the whole eligible browser by default. A host may
 * remove operations when it launches the Broker, but an Agent cannot expand
 * that launch-time policy from inside the browser protocol.
 */
export function createBrowserControlPolicy(
  catalog: BrowserTargetCatalog,
  options: BrowserControlPolicyOptions = {},
): BrowserControlPolicy {
  const deniedOperations = options.deniedOperations ?? [];
  assertKnownOperations(deniedOperations);
  const denied = new Set<BrowserOperation>(deniedOperations);

  const assertOperation = (operation: BrowserOperation): void => {
    if (!(BROWSER_OPERATIONS as readonly string[]).includes(operation)) {
      throw invalidArgument('Unknown browser operation', 'operation');
    }
    if (!denied.has(operation)) return;
    throw new BrowserPilotError(
      'capability_denied',
      `Browser operation ${operation} was disabled by the Agent host`,
      { context: { operation } },
    );
  };

  return {
    async listUserTargets(browserInstanceId) {
      assertOperation('tabs.list');
      return (await catalog.listEligibleUserTargets(browserInstanceId)).map(target => ({
        ...target,
        browserInstanceId,
      }));
    },

    assertOperation,
  };
}
