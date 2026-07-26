import { spawn } from 'node:child_process';
import { DaemonClient } from './client.js';
import {
  acquireBrokerStartupLock,
  processIsAlive,
  readBrokerLocatorSync,
  readBrokerPidSync,
  readBrokerStartingSync,
  removeStaleBrokerFilesSync,
} from './broker-locator.js';
import {
  discoverBrowserCandidates,
  type DiscoveredBrowser,
} from './chrome.js';
import { INJECT_BORDER } from './page-scripts.js';
import type { Transport } from './transport.js';
import { BrowserPilotError } from './protocol/errors.js';
import { internalProcessInvocation } from './runtime-layout.js';

// ── Daemon lifecycle ────────────────────────────────

async function startDaemon(browser: DiscoveredBrowser | null): Promise<DaemonClient> {
  const invocation = internalProcessInvocation('daemon', import.meta.url);
  const child = spawn(invocation.command, [
    ...invocation.argumentsPrefix,
    '',
    browser?.candidate.product ?? '',
    browser?.dataDir ?? '',
  ], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const client = new DaemonClient();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await client.health()) return client;
    await new Promise(r => setTimeout(r, 200));
  }
  if (child.pid && processIsAlive(child.pid)) {
    throw new BrowserPilotError('browser_disconnected', 'Browser Pilot Broker did not finish starting', {
      retryable: true,
      remediation: {
        code: 'inspect_broker_startup',
        message: 'Inspect the Broker startup state; browser authorization is never requested during Broker startup.',
        actionRequired: false,
      },
    });
  }
  throw new BrowserPilotError('browser_disconnected', 'Browser Pilot Broker did not become reachable', {
    retryable: true,
    remediation: {
      code: 'restart_browser_pilot',
      message: 'Stop any stale Browser Pilot process, then start the command again.',
      actionRequired: true,
    },
  });
}

type DaemonHealth = Awaited<ReturnType<DaemonClient['healthInfo']>>;

function browserMatchesHealth(browserFilter: string | undefined, info: DaemonHealth): boolean {
  if (!browserFilter) return true;
  const filter = browserFilter.toLowerCase();
  return [info.browser?.id, info.browser?.product, info.browser?.channel]
    .some(value => value?.toLowerCase().includes(filter));
}

function assertBrowserSelection(browserFilter: string | undefined, info: DaemonHealth): void {
  if (browserMatchesHealth(browserFilter, info)) return;
  throw new BrowserPilotError('browser_not_found', 'The shared Broker is using a different browser preference', {
    remediation: {
      code: 'select_running_browser_pilot',
      message: 'Use the running Broker browser, select its browserId in workspaces/create, or stop it before changing the default preference.',
      actionRequired: true,
    },
  });
}

async function waitForStartingDaemon(
  pid: number,
  browserFilter?: string,
  timeoutMs = 60_000,
): Promise<DaemonClient | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processIsAlive(pid)) {
    const client = new DaemonClient();
    const info = await client.healthInfo();
    if (info.ok) {
      assertBrowserSelection(browserFilter, info);
      return client;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return undefined;
}

// ── Public API ──────────────────────────────────────

/** Start or reuse the shared daemon for the selected browser. */
export async function connectDaemon(browserFilter?: string): Promise<DaemonClient> {
  const existing = new DaemonClient();
  const existingInfo = await existing.healthInfo();
  if (existingInfo.ok) {
    assertBrowserSelection(browserFilter, existingInfo);
    return existing;
  }

  const startupLock = await acquireBrokerStartupLock();
  try {
    const winner = new DaemonClient();
    const winnerInfo = await winner.healthInfo();
    if (winnerInfo.ok) {
      assertBrowserSelection(browserFilter, winnerInfo);
      return winner;
    }

    const locator = readBrokerLocatorSync();
    const starting = readBrokerStartingSync();
    const brokerPid = locator?.pid ?? starting?.pid ?? readBrokerPidSync();
    if (brokerPid && processIsAlive(brokerPid)) {
      if (starting?.pid === brokerPid) {
        const started = await waitForStartingDaemon(brokerPid, browserFilter);
        if (started) return started;
        throw new BrowserPilotError('browser_disconnected', 'Browser Pilot Broker did not finish starting', {
          retryable: true,
          remediation: {
            code: 'inspect_broker_startup',
            message: 'Inspect the Broker startup state; browser authorization is never requested during Broker startup.',
            actionRequired: false,
          },
        });
      }
      throw new BrowserPilotError('browser_disconnected', 'The Browser Pilot Broker process is alive but its endpoint is unresponsive', {
        retryable: true,
        remediation: {
          code: 'restart_unresponsive_broker',
          message: 'Stop the unresponsive Browser Pilot Broker explicitly, then retry. Live processes are never replaced automatically.',
          actionRequired: true,
        },
      });
    }
    removeStaleBrokerFilesSync();

    const candidates = await discoverBrowserCandidates();
    const filter = browserFilter?.toLowerCase();
    const matches = candidates.filter(({ candidate }) => (
      !filter || [candidate.id, candidate.product, candidate.channel]
        .some(value => value?.toLowerCase().includes(filter))
    ));
    if (browserFilter && matches.length === 0) {
      throw new BrowserPilotError('browser_not_found',
        'No installed supported browser matches the requested selection.',
        {
          remediation: {
            code: 'select_supported_browser',
            message: 'Run browser discovery and select one of the returned browser IDs or product names.',
            actionRequired: true,
          },
        },
      );
    }
    const selected = matches.find(browser => browser.endpoint !== undefined) ?? matches[0] ?? null;
    return await startDaemon(selected);
  } finally {
    startupLock.release();
  }
}

export class PageLoadTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Page load did not become interactive within ${timeoutMs}ms`);
    this.name = 'PageLoadTimeoutError';
  }
}

/** Wait for the page to be usable.
 *  Returns when readyState === 'complete', OR when readyState === 'interactive'
 *  has been stable for a short grace period (handles sites with slow trackers/ads
 *  or anti-bot challenges where 'complete' never fires but the DOM is interactive).
 *  Only throws if we never even reach 'interactive'. */
export async function waitForLoad(transport: Transport, sessionId: string, timeout = 30_000): Promise<void> {
  const interactiveGrace = 1500; // ms after first 'interactive' before giving up on 'complete'
  let interactiveSince: number | null = null;
  const deadlineReached = Symbol('page-load-deadline');
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof deadlineReached>(resolve => {
    deadlineTimer = setTimeout(() => resolve(deadlineReached), timeout);
  });
  const injectBorder = async (): Promise<void> => {
    await Promise.race([
      transport.send('Runtime.evaluate', { expression: INJECT_BORDER }, sessionId).catch(() => undefined),
      deadline,
    ]);
  };

  try {
    while (true) {
      const evaluation = await Promise.race([
        transport.send('Runtime.evaluate', {
          expression: 'document.readyState',
        }, sessionId).then(
          ({ result }) => ({ state: result.value as unknown }),
          () => ({ state: undefined }),
        ),
        deadline,
      ]);
      if (evaluation === deadlineReached) throw new PageLoadTimeoutError(timeout);

      if (evaluation.state === 'complete') {
        await injectBorder();
        return;
      }

      if (evaluation.state === 'interactive') {
        if (interactiveSince === null) interactiveSince = Date.now();
        // DOM parsed and usable; if 'complete' doesn't come quickly, accept and move on.
        if (Date.now() - interactiveSince >= interactiveGrace) {
          await injectBorder();
          return;
        }
      }

      const sleep = await Promise.race([
        new Promise<'poll'>(resolve => setTimeout(() => resolve('poll'), 200)),
        deadline,
      ]);
      if (sleep === deadlineReached) throw new PageLoadTimeoutError(timeout);
    }
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}
