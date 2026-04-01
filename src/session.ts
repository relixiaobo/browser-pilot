import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DaemonClient, isDaemonRunning } from './client.js';
import { discoverChrome } from './chrome.js';
import { loadState, saveState, clearState, type PilotState } from './state.js';
import { INJECT_BORDER } from './page-scripts.js';
import type { Transport } from './transport.js';

export { saveState, clearState, type PilotState } from './state.js';

export interface PilotContext {
  transport: Transport;
  state: PilotState;
  sessionId: string;
}

// ── Daemon lifecycle ────────────────────────────────

async function startDaemon(wsUrl: string): Promise<DaemonClient> {
  const script = fileURLToPath(new URL('daemon.js', import.meta.url));
  const child = spawn(process.execPath, [script, wsUrl], { detached: true, stdio: 'ignore' });
  child.unref();

  const client = new DaemonClient();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await client.health()) return client;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Connection timeout. Make sure to click "Allow" in Chrome\'s authorization dialog.');
}

async function getDaemon(wsUrl: string): Promise<DaemonClient> {
  if (isDaemonRunning()) {
    const client = new DaemonClient();
    if (await client.health()) {
      // Verify daemon controls the expected Chrome instance
      const state = loadState();
      if (state && state.wsEndpoint === wsUrl) return client;
      // Wrong Chrome — restart daemon
      await client.shutdown();
    }
  }
  return startDaemon(wsUrl);
}

// ── Pilot window helpers ────────────────────────────

async function verifyPilotTargets(client: DaemonClient, state: PilotState): Promise<boolean> {
  const { targetInfos } = await client.send('Target.getTargets');
  const existing = new Set(targetInfos.map((t: any) => t.targetId));
  state.pilotTargetIds = state.pilotTargetIds.filter((id: string) => existing.has(id));

  if (state.pilotTargetIds.length === 0) return false;

  if (!state.pilotTargetIds.includes(state.activeTargetId)) {
    state.activeTargetId = state.pilotTargetIds[0];
    state.activeSessionId = undefined;
  }
  saveState(state);
  return true;
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
  // Enable Page domain so daemon receives dialog events for this session
  await client.send('Page.enable', {}, sessionId).catch(() => {});
  // Inject visual border indicator
  await client.send('Runtime.evaluate', { expression: INJECT_BORDER }, sessionId).catch(() => {});
  state.activeSessionId = sessionId;
  saveState(state);
  return sessionId;
}

// ── Public API ──────────────────────────────────────

/** Connect fresh: discover Chrome, start daemon, create pilot window. */
export async function connectFresh(browserFilter?: string): Promise<{ client: DaemonClient; state: PilotState }> {
  const chrome = discoverChrome(browserFilter);
  if (!chrome) {
    throw new Error(
      'Cannot find Chrome DevTools port.\n' +
      'Open chrome://inspect/#remote-debugging in Chrome and toggle ON.',
    );
  }

  const client = await getDaemon(chrome.wsUrl);

  const { targetId } = await client.send('Target.createTarget', {
    url: 'about:blank', newWindow: true,
  });
  const { sessionId } = await client.send('Target.attachToTarget', {
    targetId, flatten: true,
  });

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

/** Wait for document.readyState === 'complete'. Throws on timeout. */
export async function waitForLoad(transport: Transport, sessionId: string, timeout = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const { result } = await transport.send('Runtime.evaluate', {
        expression: 'document.readyState',
      }, sessionId);
      if (result.value === 'complete') {
        // Re-inject border (navigation destroys the old page's DOM)
        await transport.send('Runtime.evaluate', { expression: INJECT_BORDER }, sessionId).catch(() => {});
        return;
      }
    } catch { /* page navigating */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Page load timeout');
}
