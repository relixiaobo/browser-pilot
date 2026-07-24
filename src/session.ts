import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { DaemonClient, isDaemonRunning } from './client.js';
import { discoverChrome, type ChromeInfo } from './chrome.js';
import { loadState, saveState, clearState, type PilotState } from './state.js';
import { SOCKET_PATH } from './paths.js';
import { INJECT_BORDER } from './page-scripts.js';
import type { Transport } from './transport.js';
import { BrowserPilotError } from './protocol/errors.js';

export { saveState, clearState, type PilotState } from './state.js';

export interface PilotContext {
  transport: Transport;
  state: PilotState;
  sessionId: string;
}

// ── Daemon lifecycle ────────────────────────────────

async function startDaemon(chrome: ChromeInfo): Promise<DaemonClient> {
  const script = fileURLToPath(new URL('daemon.js', import.meta.url));
  const child = spawn(process.execPath, [script, chrome.wsUrl, chrome.browser, chrome.dataDir], {
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
  throw new Error('Connection timeout. Make sure to click "Allow" in Chrome\'s authorization dialog.');
}

async function getDaemon(chrome: ChromeInfo): Promise<DaemonClient> {
  if (isDaemonRunning()) {
    const client = new DaemonClient();
    const info = await client.healthInfo();
    if (info.ok) {
      // Verify daemon controls the expected Chrome instance
      if (info.wsUrl === chrome.wsUrl) return client;
      // Wrong Chrome — restart daemon; wait for old socket to disappear
      await client.shutdown();
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && existsSync(SOCKET_PATH)) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
  }
  return startDaemon(chrome);
}

// ── Pilot window helpers ────────────────────────────

async function verifyPilotTargets(client: DaemonClient, state: PilotState): Promise<boolean> {
  const { targetInfos } = await client.send('Target.getTargets');
  const existing = new Set(targetInfos.map((t: any) => t.targetId));
  state.pilotTargetIds = state.pilotTargetIds.filter((id: string) => existing.has(id));

  if (!existing.has(state.activeTargetId) && state.pilotTargetIds.length > 0) {
    state.activeTargetId = state.pilotTargetIds[0];
    state.activeSessionId = undefined;
  }
  if (!existing.has(state.activeTargetId)) return false;
  saveState(state);
  return true;
}

/** Run once after attaching to any target: Page.enable + border overlay. */
export async function initSession(transport: Transport, sessionId: string): Promise<void> {
  await transport.send('Page.enable', {}, sessionId).catch(() => {});
  await transport.send('Runtime.evaluate', { expression: INJECT_BORDER }, sessionId).catch(() => {});
}

async function ensureSession(client: DaemonClient, state: PilotState): Promise<string> {
  if (state.activeSessionId) {
    try {
      await client.send('Runtime.evaluate', { expression: '1' }, state.activeSessionId);
      return state.activeSessionId;
    } catch { /* stale — re-attach */ }
  }
  const { sessionId } = await client.send('Target.attachToTarget', {
    targetId: state.activeTargetId, flatten: true,
  });
  await initSession(client, sessionId);
  state.activeSessionId = sessionId;
  saveState(state);
  return sessionId;
}

// ── Public API ──────────────────────────────────────

/** Connect fresh: discover Chrome, start daemon, create pilot window. */
export async function connectDaemon(browserFilter?: string): Promise<DaemonClient> {
  const chrome = discoverChrome(browserFilter);
  if (!chrome) {
    throw new BrowserPilotError('browser_not_found',
      'Cannot find Chrome DevTools port.\n' +
      'Open chrome://inspect/#remote-debugging in Chrome and toggle ON.',
      {
        remediation: {
          code: 'enable_remote_debugging',
          message: 'Open chrome://inspect/#remote-debugging in Chrome and toggle remote debugging on.',
          actionRequired: true,
        },
      },
    );
  }
  return getDaemon(chrome);
}

/** Connect fresh: discover Chrome, start daemon, create pilot window. */
export async function connectFresh(browserFilter?: string): Promise<{ client: DaemonClient; state: PilotState }> {
  const chrome = discoverChrome(browserFilter);
  if (!chrome) {
    throw new BrowserPilotError('browser_not_found',
      'Cannot find Chrome DevTools port.\n' +
      'Open chrome://inspect/#remote-debugging in Chrome and toggle ON.',
      {
        remediation: {
          code: 'enable_remote_debugging',
          message: 'Open chrome://inspect/#remote-debugging in Chrome and toggle remote debugging on.',
          actionRequired: true,
        },
      },
    );
  }

  const client = await getDaemon(chrome);

  const { targetId } = await client.send('Target.createTarget', {
    url: 'about:blank', newWindow: true,
  });
  const { sessionId } = await client.send('Target.attachToTarget', {
    targetId, flatten: true,
  });
  await initSession(client, sessionId);

  const state: PilotState = {
    wsEndpoint: chrome.wsUrl,
    browser: chrome.browser,
    pilotTargetIds: [targetId],
    activeTargetId: targetId,
    activeSessionId: sessionId,
  };
  saveState(state);
  return { client, state };
}

/** Resume existing session. Returns null if no valid session exists (never creates windows). */
export async function resumeExisting(): Promise<{ client: DaemonClient; state: PilotState } | null> {
  const state = loadState();
  if (!state) return null;

  if (!isDaemonRunning()) return null;
  const client = new DaemonClient();
  if (!(await client.health())) return null;

  const valid = await verifyPilotTargets(client, state);
  if (!valid) return null;

  return { client, state };
}

/** Resume existing or connect fresh. For commands that need a pilot window. */
export async function resume(browserFilter?: string): Promise<{ client: DaemonClient; state: PilotState }> {
  const existing = await resumeExisting();
  if (existing) return existing;
  return connectFresh(browserFilter);
}

/** Resume + ensure attached session. Main entry for page-interaction commands. */
export async function withPilot(fn: (ctx: PilotContext) => Promise<void>): Promise<void> {
  const { client, state } = await resume();
  const sessionId = await ensureSession(client, state);
  await fn({ transport: client, state, sessionId });
}

/** Shut down daemon and clear state. */
export async function disconnect(): Promise<void> {
  if (isDaemonRunning()) {
    const client = new DaemonClient();
    try { await client.shutdown(); } catch { /* already gone */ }
  }
  clearState();
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

  throw new Error('Page load timeout');
}
