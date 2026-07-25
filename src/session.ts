import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DaemonClient, isDaemonRunning } from './client.js';
import {
  discoverBrowserCandidates,
  type DiscoveredBrowser,
} from './chrome.js';
import { INJECT_BORDER } from './page-scripts.js';
import type { Transport } from './transport.js';
import { BrowserPilotError } from './protocol/errors.js';

// ── Daemon lifecycle ────────────────────────────────

async function startDaemon(browser: DiscoveredBrowser | null): Promise<DaemonClient> {
  const script = fileURLToPath(new URL('daemon.js', import.meta.url));
  const child = spawn(process.execPath, [
    script,
    browser?.endpoint?.wsUrl ?? '',
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
  throw new BrowserPilotError('browser_disconnected', 'Browser Pilot Broker did not become reachable', {
    retryable: true,
    remediation: {
      code: 'restart_browser_pilot',
      message: 'Stop any stale Browser Pilot process, then start the command again.',
      actionRequired: true,
    },
  });
}

async function getDaemon(browser: DiscoveredBrowser | null): Promise<DaemonClient> {
  if (isDaemonRunning()) {
    const client = new DaemonClient();
    const info = await client.healthInfo();
    if (info.ok) {
      if (
        (browser?.endpoint && info.wsUrl === browser.endpoint.wsUrl) ||
        (
          browser &&
          info.browser?.profile === browser.dataDir &&
          info.browser.product.toLowerCase() === browser.candidate.product.toLowerCase()
        )
      ) {
        return client;
      }
      throw new BrowserPilotError('browser_not_found', 'The shared daemon is connected to a different browser profile', {
        remediation: {
          code: 'select_running_browser_pilot',
          message: 'Use the browser profile already owned by the shared daemon, or stop it explicitly before selecting another profile.',
          actionRequired: true,
        },
      });
    }
  }
  return startDaemon(browser);
}

// ── Public API ──────────────────────────────────────

/** Start or reuse the shared daemon for the selected browser. */
export async function connectDaemon(browserFilter?: string): Promise<DaemonClient> {
  if (isDaemonRunning()) {
    const existing = new DaemonClient();
    const info = await existing.healthInfo();
    if (
      info.ok &&
      (
        !browserFilter ||
        [info.browser?.id, info.browser?.product, info.browser?.channel]
          .some(value => value?.toLowerCase().includes(browserFilter.toLowerCase()))
      )
    ) {
      return existing;
    }
    if (info.ok && browserFilter) {
      throw new BrowserPilotError('browser_not_found', 'The shared daemon is connected to a different browser product', {
        remediation: {
          code: 'select_running_browser_pilot',
          message: 'Use the browser already owned by the shared daemon, or stop it explicitly before selecting another browser.',
          actionRequired: true,
        },
      });
    }
  }
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
  const selected = matches.find(browser => browser.candidate.state === 'ready') ?? matches[0] ?? null;
  return getDaemon(selected);
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
  const start = Date.now();
  const interactiveGrace = 1500; // ms after first 'interactive' before giving up on 'complete'
  let interactiveSince: number | null = null;

  while (Date.now() - start < timeout) {
    try {
      const { result } = await transport.send('Runtime.evaluate', {
        expression: 'document.readyState',
      }, sessionId);
      const state = result.value;

      if (state === 'complete') {
        await transport.send('Runtime.evaluate', { expression: INJECT_BORDER }, sessionId).catch(() => {});
        return;
      }

      if (state === 'interactive') {
        if (interactiveSince === null) interactiveSince = Date.now();
        // DOM parsed and usable; if 'complete' doesn't come quickly, accept and move on
        if (Date.now() - interactiveSince >= interactiveGrace) {
          await transport.send('Runtime.evaluate', { expression: INJECT_BORDER }, sessionId).catch(() => {});
          return;
        }
      }
    } catch { /* page navigating */ }
    await new Promise(r => setTimeout(r, 200));
  }

  // Last-chance check: if DOM is at least interactive, accept rather than throw
  try {
    const { result } = await transport.send('Runtime.evaluate', { expression: 'document.readyState' }, sessionId);
    if (result.value === 'interactive' || result.value === 'complete') {
      await transport.send('Runtime.evaluate', { expression: INJECT_BORDER }, sessionId).catch(() => {});
      return;
    }
  } catch { /* */ }

  throw new PageLoadTimeoutError(timeout);
}
