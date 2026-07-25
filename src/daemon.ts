import http from 'node:http';
import { unlinkSync, chmodSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { BROKER_TRANSPORT, STATE_DIR, SOCKET_PATH } from './paths.js';
import {
  ensureBrokerDirectoriesSync,
  createExecutableMetadataSync,
  removeBrokerLocatorSync,
  updateBrokerVersionHistorySync,
  writeBrokerLocatorSync,
  writeBrokerStartingSync,
} from './broker-locator.js';
import type { Transport } from './transport.js';
import { BrowserPilotError, asBrowserPilotError, invalidArgument } from './protocol/errors.js';
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  type BrowserInstanceId,
  type JsonValue,
} from './protocol/model.js';
import {
  DEFAULT_PROTOCOL_LIMITS,
  MemoryBrokerRuntime,
  type BrokerBrowserBinding,
} from './services/broker-runtime.js';
import { BrowserToolService } from './services/browser-tool-service.js';
import { BrowserToolRouter } from './services/browser-tool-router.js';
import { ArtifactStore } from './services/artifact-store.js';
import { CompatibilityDialogService } from './services/compatibility-dialog-service.js';
import {
  discoverBrowserCandidates,
  discoverChromeAtDataDir,
  type DiscoveredBrowser,
} from './chrome.js';
import { ManagedTargetJanitorClient } from './managed-target-janitor-client.js';
import { publicExecutablePath } from './runtime-layout.js';
import { BROWSER_PILOT_VERSION as PKG_VERSION } from './version.js';

const CLI_EXECUTABLE_PATH = publicExecutablePath(import.meta.url);
const PROTOCOL_RANGE = {
  min: { ...SUPPORTED_PROTOCOL_VERSIONS[0] },
  max: { ...SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1] },
};

const initialWsUrl = process.argv[2] || undefined;
const browserProduct = process.argv[3] || '';
const browserProfile = process.argv[4] || '';
ensureBrokerDirectoriesSync();
for (const legacyFile of ['state.json', 'refs.json']) {
  try { unlinkSync(join(STATE_DIR, legacyFile)); } catch { /* absent or already removed */ }
}
if (BROKER_TRANSPORT === 'unix_socket') {
  try { unlinkSync(SOCKET_PATH); } catch { /* absent */ }
}

function cleanup(brokerProcessIdentity: string) {
  if (BROKER_TRANSPORT === 'unix_socket') {
    try { unlinkSync(SOCKET_PATH); } catch { /* absent */ }
  }
  removeBrokerLocatorSync(brokerProcessIdentity);
}

function readBody(req: http.IncomingMessage, maxBytes = 5 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    req.on('data', (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      byteLength += chunk.length;
      if (byteLength > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── Stateful event tracking ─────────────────────────

let authCredentials: { username: string; password: string } | null = null;

const discoveredTargets: Array<{ targetId: string; url: string; openerTargetId?: string; timestamp: number }> = [];

// ── Network monitoring state ────────────────────────

interface TrackedRequest {
  id: number; networkId: string; sessionId?: string;
  method: string; url: string; type: string;
  requestHeaders: Record<string, string>; postData?: string;
  status?: number; statusText?: string; responseHeaders?: Record<string, string>;
  mimeType?: string; size?: number; startTime: number; endTime?: number;
  error?: string; bodyAvailable: boolean;
}

let nextReqId = 1;
const MAX_TRACKED = 1000;
const trackedRequests: TrackedRequest[] = [];
const requestsByNetworkId = new Map<string, TrackedRequest>();
const networkEnabledSessions = new Set<string>();

function legacyNetworkKey(sessionId: string | undefined, networkId: string): string {
  return `${sessionId ?? ''}\u0000${networkId}`;
}

// ── Interception rules ──────────────────────────────

interface BlockRule { id: number; type: 'block'; pattern: string; }
interface MockRule { id: number; type: 'mock'; pattern: string; status: number; headers: Array<{ name: string; value: string }>; body: string; }
interface HeaderRule { id: number; type: 'headers'; pattern: string; headers: Array<{ name: string; value: string }>; }
type InterceptRule = BlockRule | MockRule | HeaderRule;

let nextRuleId = 1;
const interceptRules: InterceptRule[] = [];
const fetchEnabledSessions = new Set<string>(); // Fix 2: per-session tracking

function wildcardMatch(url: string, pattern: string): boolean {
  try {
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
    return re.test(url);
  } catch { return false; }
}

async function syncFetch(cdp: Transport, sessionId?: string) {
  if (!sessionId) return;
  const need = interceptRules.length > 0;
  if (need) {
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }], handleAuthRequests: !!authCredentials }, sessionId).catch(() => {});
    fetchEnabledSessions.add(sessionId);
  } else if (fetchEnabledSessions.has(sessionId)) {
    if (authCredentials) {
      await cdp.send('Fetch.enable', { handleAuthRequests: true }, sessionId).catch(() => {});
    } else {
      await cdp.send('Fetch.disable', {}, sessionId).catch(() => {});
    }
    fetchEnabledSessions.delete(sessionId);
  }
}

// Fix 4: only add to Set after success
async function enableNetworkTracking(cdp: Transport, sessionId: string) {
  if (!sessionId || networkEnabledSessions.has(sessionId)) return;
  await cdp.send('Network.enable', { maxPostDataSize: 65536 }, sessionId);
  networkEnabledSessions.add(sessionId);
}

// Ensure both Network + Fetch are enabled for a session
async function ensureNetSession(cdp: Transport, sessionId: string) {
  await enableNetworkTracking(cdp, sessionId);
  if ((interceptRules.length > 0 || authCredentials) && !fetchEnabledSessions.has(sessionId)) {
    await syncFetch(cdp, sessionId);
  }
}

// Sync Fetch state across ALL known sessions (after rule/auth changes)
async function syncFetchAll(cdp: Transport, currentSessionId?: string) {
  const allSessions = new Set([...fetchEnabledSessions, ...networkEnabledSessions]);
  if (currentSessionId) allSessions.add(currentSessionId);
  for (const sid of allSessions) {
    await syncFetch(cdp, sid);
  }
}

// ── Main ────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  const brokerProcessIdentity = `${process.pid}:${startedAt}`;
  writeBrokerStartingSync({ pid: process.pid, startedAt, brokerProcessIdentity });
  process.once('exit', () => cleanup(brokerProcessIdentity));
  const cdp = new ManagedTargetJanitorClient({
    onLog: message => process.stderr.write(`Managed browser connection: ${message}\n`),
  });
  let terminating = false;
  let terminate = async (): Promise<void> => {
    if (terminating) return;
    terminating = true;
    await cdp.close().catch(() => {});
    cleanup(brokerProcessIdentity);
    process.exit(0);
  };
  const requestTermination = (): void => { void terminate(); };
  process.on('SIGTERM', requestTermination);
  process.on('SIGINT', requestTermination);
  if (initialWsUrl) await cdp.connect(initialWsUrl);
  let activeSessionId: string | undefined;
  let currentWsUrl = initialWsUrl;
  let shutdownReserved = false;
  const executable = createExecutableMetadataSync(PKG_VERSION, CLI_EXECUTABLE_PATH);
  const discoveredBrowsers = await discoverBrowserCandidates();
  const knownSelection = discoveredBrowsers.find(browser => (
    browser.dataDir === browserProfile &&
    browser.candidate.product.toLowerCase() === browserProduct.toLowerCase()
  ));
  const customBrowserId = browserProfile
    ? `browser:custom:${createHash('sha256').update(`${browserProduct}\0${browserProfile}`).digest('base64url').slice(0, 20)}`
    : undefined;
  const selectedBrowser: DiscoveredBrowser | undefined = knownSelection ?? (
    browserProfile && customBrowserId
      ? {
        candidate: {
          id: customBrowserId,
          product: browserProduct || 'Chromium',
          profile: browserProfile,
          processState: initialWsUrl ? 'running' : 'unknown',
          remoteDebuggingState: initialWsUrl ? 'enabled' : 'disabled',
          authorizationState: initialWsUrl ? 'authorized' : 'not_applicable',
          state: initialWsUrl ? 'ready' : 'not_running',
          ...(!initialWsUrl ? {
            remediation: {
              code: 'start_browser',
              message: 'Start this browser profile, then enable remote debugging from chrome://inspect/#remote-debugging.',
              actionRequired: true,
            },
          } : {}),
        },
        dataDir: browserProfile,
      }
      : discoveredBrowsers[0]
  );
  const selectedProduct = selectedBrowser?.candidate.product ?? browserProduct;
  const selectedProfile = selectedBrowser?.dataDir ?? browserProfile;
  const browserId = selectedBrowser?.candidate.id ?? `browser:custom:${randomUUID()}`;
  const browserInstanceId = `browser-instance:${browserId.slice('browser:'.length)}` as BrowserInstanceId;
  const browserBinding: BrokerBrowserBinding = {
    candidate: selectedBrowser
      ? {
        ...selectedBrowser.candidate,
        ...(initialWsUrl ? {
          processState: 'running' as const,
          remoteDebuggingState: 'enabled' as const,
          authorizationState: 'authorized' as const,
          state: 'ready' as const,
          remediation: undefined,
        } : {}),
      }
      : {
        id: browserId,
        product: browserProduct || 'Unavailable browser',
        profile: browserProfile,
        processState: initialWsUrl ? 'running' : 'unknown',
        remoteDebuggingState: initialWsUrl ? 'enabled' : 'disabled',
        authorizationState: initialWsUrl ? 'authorized' : 'not_applicable',
        state: initialWsUrl ? 'ready' : 'not_running',
      },
    instance: {
      id: browserInstanceId,
      product: selectedProduct || 'Unavailable browser',
      profilePath: selectedProfile,
      processIdentity: initialWsUrl ?? '',
      connectionGeneration: initialWsUrl ? 1 : 0,
      state: initialWsUrl ? 'connected' : 'disconnected',
    },
  };
  const artifactStore = new ArtifactStore({
    maxArtifactBytes: DEFAULT_PROTOCOL_LIMITS.maxArtifactBytes,
  });
  await artifactStore.initialize();
  const browserTools = new BrowserToolService(cdp, browserBinding, {
    artifactStore,
    managedTargets: cdp,
  });
  const compatibilityDialogs = new CompatibilityDialogService(
    cdp,
    sessionId => browserTools.ownsSession(sessionId),
  );
  const toolRouter = new BrowserToolRouter();
  if (selectedBrowser) toolRouter.register(browserInstanceId, browserTools);
  const additionalControllers: Array<{
    discovered: DiscoveredBrowser;
    binding: BrokerBrowserBinding;
    cdp: ManagedTargetJanitorClient;
  }> = [];
  const browserBindings: BrokerBrowserBinding[] = selectedBrowser ? [browserBinding] : [];
  for (const discovered of discoveredBrowsers) {
    if (discovered.candidate.id === browserId) continue;
    const instanceId = `browser-instance:${discovered.candidate.id.slice('browser:'.length)}` as BrowserInstanceId;
    const binding: BrokerBrowserBinding = {
      candidate: { ...discovered.candidate },
      instance: {
        id: instanceId,
        product: discovered.candidate.product,
        profilePath: discovered.dataDir,
        processIdentity: '',
        connectionGeneration: 0,
        state: 'disconnected',
      },
    };
    browserBindings.push(binding);
    const additionalCdp = new ManagedTargetJanitorClient({
      onLog: message => process.stderr.write(
        `Managed browser connection (${discovered.candidate.product}): ${message}\n`,
      ),
    });
    const service = new BrowserToolService(additionalCdp, binding, {
      artifactStore,
      managedTargets: additionalCdp,
    });
    toolRouter.register(instanceId, service);
    additionalControllers.push({
      discovered,
      binding,
      cdp: additionalCdp,
    });
    if (discovered.candidate.state === 'ready' && discovered.endpoint) {
      try {
        await additionalCdp.connect(discovered.endpoint.wsUrl);
        await additionalCdp.send('Target.setDiscoverTargets', { discover: true });
        binding.instance = {
          ...binding.instance,
          processIdentity: discovered.endpoint.wsUrl,
          connectionGeneration: 1,
          state: 'connected',
        };
      } catch {
        await additionalCdp.browserDisconnected().catch(() => {});
        binding.candidate = {
          ...binding.candidate,
          state: 'disconnected',
          remoteDebuggingState: 'stale',
          authorizationState: 'unknown',
          remediation: {
            code: 'reconnect_browser',
            message: 'The browser endpoint changed while Browser Pilot was connecting. Retry discovery.',
            actionRequired: false,
          },
        };
      }
    }
  }
  const broker = new MemoryBrokerRuntime({
    serviceVersion: PKG_VERSION,
    executableVersion: PKG_VERSION,
    brokerProcessIdentity,
    browsers: browserBindings,
    toolExecutor: toolRouter,
    artifactStore,
  });
  let reconnectTask: Promise<void> | undefined;
  const resetDisconnectedState = (): void => {
    activeSessionId = undefined;
    networkEnabledSessions.clear();
    fetchEnabledSessions.clear();
    trackedRequests.length = 0;
    requestsByNetworkId.clear();
    nextReqId = 1;
    discoveredTargets.length = 0;
    compatibilityDialogs.clear();
  };
  const wait = (ms: number): Promise<void> => new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
  const reconnectBrowser = async (): Promise<void> => {
    let retryDelayMs = 250;
    while (!terminating) {
      const chrome = discoverChromeAtDataDir(selectedProfile, selectedProduct);
      if (!chrome) {
        await wait(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
        continue;
      }
      try {
        await cdp.connect(chrome.wsUrl);
        await cdp.send('Target.setDiscoverTargets', { discover: true });
        currentWsUrl = chrome.wsUrl;
        broker.updateBrowserConnection(browserInstanceId, {
          state: 'connected',
          connectionGeneration: browserBinding.instance.connectionGeneration + 1,
          processIdentity: chrome.wsUrl,
        });
        return;
      } catch {
        await cdp.browserDisconnected().catch(() => {});
        await wait(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
      }
    }
  };
  cdp.onConnectionState(event => {
    if (event.state !== 'disconnected' || terminating) return;
    void cdp.browserDisconnected().catch(error => {
      process.stderr.write(`Managed browser connection reset error: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    resetDisconnectedState();
    if (browserBinding.instance.state === 'connected') {
      try {
        broker.updateBrowserConnection(browserInstanceId, {
          state: 'disconnected',
          connectionGeneration: browserBinding.instance.connectionGeneration,
        });
      } catch (error) {
        process.stderr.write(`Browser disconnect state error: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (!reconnectTask) {
      reconnectTask = reconnectBrowser()
        .catch(error => {
          process.stderr.write(`Browser reconnect error: ${error instanceof Error ? error.message : String(error)}\n`);
        })
        .finally(() => { reconnectTask = undefined; });
      void reconnectTask;
    }
  });
  if (selectedBrowser && browserBinding.instance.state !== 'connected') {
    reconnectTask = reconnectBrowser()
      .catch(error => {
        process.stderr.write(`Browser reconnect error: ${error instanceof Error ? error.message : String(error)}\n`);
      })
      .finally(() => { reconnectTask = undefined; });
    void reconnectTask;
  }
  for (const controller of additionalControllers) {
    let additionalReconnectTask: Promise<void> | undefined;
    const reconnectAdditional = async (): Promise<void> => {
      let retryDelayMs = 250;
      while (!terminating) {
        const chrome = discoverChromeAtDataDir(
          controller.discovered.dataDir,
          controller.discovered.candidate.product,
        );
        if (!chrome) {
          await wait(retryDelayMs);
          retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
          continue;
        }
        try {
          await controller.cdp.connect(chrome.wsUrl);
          await controller.cdp.send('Target.setDiscoverTargets', { discover: true });
          broker.updateBrowserConnection(controller.binding.instance.id, {
            state: 'connected',
            connectionGeneration: controller.binding.instance.connectionGeneration + 1,
            processIdentity: chrome.wsUrl,
          });
          return;
        } catch {
          await controller.cdp.browserDisconnected().catch(() => {});
          await wait(retryDelayMs);
          retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
        }
      }
    };
    controller.cdp.onConnectionState(event => {
      if (event.state !== 'disconnected' || terminating) return;
      void controller.cdp.browserDisconnected().catch(error => {
        process.stderr.write(
          `Managed browser connection reset (${controller.discovered.candidate.product}): ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
      if (controller.binding.instance.state === 'connected') {
        try {
          broker.updateBrowserConnection(controller.binding.instance.id, {
            state: 'disconnected',
            connectionGeneration: controller.binding.instance.connectionGeneration,
          });
        } catch (error) {
          process.stderr.write(
            `Browser disconnect state error (${controller.discovered.candidate.product}): ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
      if (!additionalReconnectTask) {
        additionalReconnectTask = reconnectAdditional()
          .catch(error => {
            process.stderr.write(
              `Browser reconnect error (${controller.discovered.candidate.product}): ${error instanceof Error ? error.message : String(error)}\n`,
            );
          })
          .finally(() => { additionalReconnectTask = undefined; });
        void additionalReconnectTask;
      }
    });
    if (controller.binding.instance.state !== 'connected') {
      additionalReconnectTask = reconnectAdditional()
        .catch(error => {
          process.stderr.write(
            `Browser reconnect error (${controller.discovered.candidate.product}): ${error instanceof Error ? error.message : String(error)}\n`,
          );
        })
        .finally(() => { additionalReconnectTask = undefined; });
      void additionalReconnectTask;
    }
  }
  const leaseSweepTimer = setInterval(() => {
    broker.sweepExpiredLeases();
    void artifactStore.sweep().catch(() => {});
  }, 1_000);
  leaseSweepTimer.unref();
  let discoveryRefreshRunning = false;
  const discoveryRefreshTimer = setInterval(() => {
    if (discoveryRefreshRunning || terminating) return;
    discoveryRefreshRunning = true;
    void discoverBrowserCandidates()
      .then(latest => {
        for (const binding of browserBindings) {
          if (binding.instance.state === 'connected') continue;
          const discovered = latest.find(browser => browser.candidate.id === binding.candidate.id);
          if (!discovered) continue;
          binding.candidate = { ...discovered.candidate };
          broker.updateBrowserCandidate(binding.instance.id, discovered.candidate);
        }
      })
      .catch(error => {
        process.stderr.write(`Browser discovery refresh error: ${error instanceof Error ? error.message : String(error)}\n`);
      })
      .finally(() => { discoveryRefreshRunning = false; });
  }, 2_000);
  discoveryRefreshTimer.unref();

  // ── Popup tracking ────────────────────────────────
  if (cdp.connectionState === 'connected') {
    await cdp.send('Target.setDiscoverTargets', { discover: true });
  }
  cdp.on('Target.targetCreated', (params: any) => {
    const { targetInfo } = params;
    if (targetInfo.type === 'page' && targetInfo.openerId) {
      discoveredTargets.push({ targetId: targetInfo.targetId, url: targetInfo.url || 'about:blank', openerTargetId: targetInfo.openerId, timestamp: Date.now() });
      if (discoveredTargets.length > 50) discoveredTargets.shift();
    }
  });
  cdp.on('Target.targetInfoChanged', (params: any) => {
    const e = discoveredTargets.find(d => d.targetId === params.targetInfo.targetId);
    if (e) e.url = params.targetInfo.url;
  });

  // ── Auth handling ─────────────────────────────────
  cdp.on('Fetch.authRequired', (params: any, sessionId?: string) => {
    if (sessionId && browserTools.ownsSession(sessionId)) return;
    const resp = authCredentials
      ? { response: 'ProvideCredentials' as const, username: authCredentials.username, password: authCredentials.password }
      : { response: 'CancelAuth' as const };
    cdp.send('Fetch.continueWithAuth', { requestId: params.requestId, authChallengeResponse: resp }, sessionId).catch(() => {});
  });

  // ── Fetch interception — Fix 1: try/catch with fallback ──
  cdp.on('Fetch.requestPaused', (params: any, sessionId?: string) => {
    if (sessionId && browserTools.ownsSession(sessionId)) return;
    try {
      const url = params.request?.url || '';
      for (const rule of interceptRules) {
        if (!wildcardMatch(url, rule.pattern)) continue;
        if (rule.type === 'block') {
          cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {});
          return;
        }
        if (rule.type === 'mock') {
          cdp.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: rule.status, responseHeaders: rule.headers, body: rule.body }, sessionId).catch(() => {});
          return;
        }
        if (rule.type === 'headers' && Array.isArray(rule.headers)) {
          const existing = Object.entries(params.request?.headers || {}).map(([name, value]) => ({ name, value: value as string }));
          const overrides = new Set(rule.headers.map(h => h.name.toLowerCase()));
          const merged = existing.filter(h => !overrides.has(h.name.toLowerCase()));
          merged.push(...rule.headers);
          cdp.send('Fetch.continueRequest', { requestId: params.requestId, headers: merged }, sessionId).catch(() => {});
          return;
        }
      }
      // No rule matched — pass through
      cdp.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId).catch(() => {});
    } catch {
      // Last resort: always resolve the paused request to prevent Chrome hang
      cdp.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId).catch(() => {});
    }
  });

  // ── Network monitoring events ─────────────────────
  cdp.on('Network.requestWillBeSent', (params: any, sessionId?: string) => {
    if (sessionId && browserTools.ownsSession(sessionId)) return;
    const entry: TrackedRequest = {
      id: nextReqId++, networkId: params.requestId, sessionId,
      method: params.request.method, url: params.request.url, type: params.type || 'Other',
      requestHeaders: params.request.headers || {}, postData: params.request.postData,
      startTime: Date.now(), bodyAvailable: false,
    };
    trackedRequests.push(entry);
    requestsByNetworkId.set(legacyNetworkKey(sessionId, params.requestId), entry);
    if (trackedRequests.length > MAX_TRACKED) {
      const old = trackedRequests.shift()!;
      const key = legacyNetworkKey(old.sessionId, old.networkId);
      if (requestsByNetworkId.get(key) === old) requestsByNetworkId.delete(key);
    }
  });
  cdp.on('Network.responseReceived', (params: any, sessionId?: string) => {
    if (sessionId && browserTools.ownsSession(sessionId)) return;
    const e = requestsByNetworkId.get(legacyNetworkKey(sessionId, params.requestId));
    if (e) { e.status = params.response.status; e.statusText = params.response.statusText; e.responseHeaders = params.response.headers; e.mimeType = params.response.mimeType; }
  });
  cdp.on('Network.loadingFinished', (params: any, sessionId?: string) => {
    if (sessionId && browserTools.ownsSession(sessionId)) return;
    const e = requestsByNetworkId.get(legacyNetworkKey(sessionId, params.requestId));
    if (e) { e.size = params.encodedDataLength; e.endTime = Date.now(); e.bodyAvailable = true; }
  });
  cdp.on('Network.loadingFailed', (params: any, sessionId?: string) => {
    if (sessionId && browserTools.ownsSession(sessionId)) return;
    const e = requestsByNetworkId.get(legacyNetworkKey(sessionId, params.requestId));
    if (e) { e.error = params.errorText; e.endTime = Date.now(); }
  });

  // ── HTTP server ───────────────────────────────────

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    let url: URL;
    try { url = new URL(req.url || '/', 'http://localhost'); } catch {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid URL' })); return;
    }
    try {
      // ── Core endpoints ────────────────────────────
      if (req.method === 'GET' && url.pathname === '/health') {
        const clients = broker.lifecycleSummary();
        res.writeHead(200); res.end(JSON.stringify({
          ok: true,
          wsUrl: currentWsUrl,
          brokerProtocol: 1,
          brokerProcessIdentity,
          serviceVersion: PKG_VERSION,
          executableVersion: executable.version,
          executableIdentity: executable.identity,
          protocol: PROTOCOL_RANGE,
          clients,
          shuttingDown: shutdownReserved || terminating,
          ...(selectedBrowser ? { browser: {
            id: browserBinding.candidate.id,
            product: selectedProduct,
            ...(browserBinding.candidate.channel ? { channel: browserBinding.candidate.channel } : {}),
            profile: selectedProfile,
            state: browserBinding.instance.state,
            connectionGeneration: browserBinding.instance.connectionGeneration,
          } } : {}),
        })); return;
      }
      if (req.method === 'POST' && url.pathname === '/broker/rpc') {
        try {
          if (shutdownReserved || terminating) {
            throw new BrowserPilotError('browser_disconnected', 'Browser Pilot Broker is shutting down', {
              retryable: true,
            });
          }
          const body: unknown = JSON.parse(await readBody(req, DEFAULT_PROTOCOL_LIMITS.maxMessageBytes + 4096));
          if (!isRecord(body)) throw invalidArgument('Broker RPC body must be an object', 'body');
          if (typeof body.bridgeSessionId !== 'string') {
            throw invalidArgument('bridgeSessionId is required', 'bridgeSessionId');
          }
          if (typeof body.method !== 'string' || body.method.length === 0 || body.method.length > 256) {
            throw invalidArgument('method is required', 'method');
          }
          const result = await broker.call(
            body.bridgeSessionId,
            body.method,
            body.params as JsonValue | undefined,
          );
          res.writeHead(200); res.end(JSON.stringify({ result })); return;
        } catch (error) {
          res.writeHead(200); res.end(JSON.stringify({ error: asBrowserPilotError(error).toJsonRpcError() })); return;
        }
      }
      if (req.method === 'POST' && url.pathname === '/broker/disconnect') {
        try {
          const body: unknown = JSON.parse(await readBody(req, 4096));
          if (!isRecord(body) || typeof body.bridgeSessionId !== 'string') {
            throw invalidArgument('bridgeSessionId is required', 'bridgeSessionId');
          }
          broker.disconnect(body.bridgeSessionId);
          res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
        } catch (error) {
          res.writeHead(200); res.end(JSON.stringify({ error: asBrowserPilotError(error).toJsonRpcError() })); return;
        }
      }
      if (req.method === 'POST' && url.pathname === '/broker/events/next') {
        const abort = new AbortController();
        res.once('close', () => abort.abort());
        try {
          const body: unknown = JSON.parse(await readBody(req, 4096));
          if (
            !isRecord(body) ||
            typeof body.bridgeSessionId !== 'string' ||
            !Number.isSafeInteger(body.waitMs)
          ) {
            throw invalidArgument('bridgeSessionId and integer waitMs are required');
          }
          const notification = await broker.nextNotification(body.bridgeSessionId, {
            waitMs: Number(body.waitMs),
            signal: abort.signal,
          });
          if (!res.destroyed) {
            res.writeHead(200);
            res.end(JSON.stringify({ notification }));
          }
          return;
        } catch (error) {
          if (!res.destroyed) {
            res.writeHead(200);
            res.end(JSON.stringify({ error: asBrowserPilotError(error).toJsonRpcError() }));
          }
          return;
        }
      }
      if (req.method === 'POST' && url.pathname === '/cdp') {
        const body = await readBody(req);
        const { method, params, sessionId } = JSON.parse(body);
        if (sessionId) activeSessionId = sessionId;
        const result = await cdp.send(method, params, sessionId);
        res.writeHead(200); res.end(JSON.stringify({ result })); return;
      }
      if (req.method === 'GET' && url.pathname === '/dialogs') {
        res.writeHead(200); res.end(JSON.stringify({ dialogs: compatibilityDialogs.list() })); return;
      }
      if (req.method === 'POST' && url.pathname === '/dialogs/respond') {
        const body: unknown = JSON.parse(await readBody(req, 4096));
        if (
          !isRecord(body) ||
          typeof body.dialogId !== 'string' ||
          (body.action !== 'accept' && body.action !== 'dismiss') ||
          (body.prompt !== undefined && typeof body.prompt !== 'string')
        ) {
          throw invalidArgument('dialogId and an accept or dismiss action are required');
        }
        const dialog = await compatibilityDialogs.respond(
          body.dialogId,
          body.action,
          body.prompt,
        );
        res.writeHead(200); res.end(JSON.stringify({ dialog })); return;
      }
      if (req.method === 'POST' && url.pathname === '/auth') {
        const body = await readBody(req);
        const { username, password } = JSON.parse(body);
        authCredentials = username ? { username, password } : null;
        await syncFetchAll(cdp, activeSessionId);
        res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
      }
      if (req.method === 'GET' && url.pathname === '/discovered') {
        res.writeHead(200); res.end(JSON.stringify({ targets: discoveredTargets })); return;
      }
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        try {
          if (shutdownReserved || terminating) {
            throw new BrowserPilotError('browser_disconnected', 'Browser Pilot Broker is already shutting down', {
              retryable: true,
            });
          }
          const body: unknown = JSON.parse(await readBody(req, 4096));
          if (
            !isRecord(body) ||
            typeof body.brokerProcessIdentity !== 'string' ||
            typeof body.executableVersion !== 'string' ||
            typeof body.executableIdentity !== 'string'
          ) {
            throw invalidArgument(
              'brokerProcessIdentity, executableVersion, and executableIdentity are required',
            );
          }
          if (body.brokerProcessIdentity !== brokerProcessIdentity) {
            throw new BrowserPilotError('protocol_incompatible', 'The Broker changed before shutdown could be authorized', {
              retryable: true,
              context: { brokerProcessIdentity },
              remediation: {
                code: 'refresh_broker_identity',
                message: 'Reconnect with the same executable and retry against the current Broker.',
                actionRequired: true,
              },
            });
          }
          if (
            body.executableVersion !== executable.version ||
            body.executableIdentity !== executable.identity
          ) {
            throw new BrowserPilotError('protocol_incompatible', 'Only the executable installation that started this Broker may stop it', {
              context: {
                brokerExecutableVersion: executable.version,
                requesterExecutableVersion: body.executableVersion,
              },
              remediation: {
                code: 'use_matching_executable_or_isolate',
                message: 'Use the matching Browser Pilot installation, or set BROWSER_PILOT_HOME for a deliberately isolated Broker.',
                actionRequired: true,
              },
            });
          }
          const clients = broker.lifecycleSummary();
          if (clients.embeddedConnections > 0) {
            throw new BrowserPilotError('broker_in_use', 'Browser Pilot has live embedded clients and cannot be stopped', {
              retryable: true,
              context: clients,
              remediation: {
                code: 'close_embedded_clients',
                message: 'Close the Agent products using Browser Pilot, then retry disconnect.',
                actionRequired: true,
              },
            });
          }
          shutdownReserved = true;
          res.writeHead(200); res.end(JSON.stringify({ ok: true }));
          setTimeout(() => { void terminate(); }, 50);
        } catch (error) {
          res.writeHead(200); res.end(JSON.stringify({ error: asBrowserPilotError(error).toJsonRpcError() }));
        }
        return;
      }

      // ── Network: enable ───────────────────────────
      if (req.method === 'POST' && url.pathname === '/net/enable') {
        const body = await readBody(req);
        const { sessionId } = JSON.parse(body);
        if (!sessionId) { res.writeHead(400); res.end(JSON.stringify({ error: 'sessionId required' })); return; }
        activeSessionId = sessionId;
        await ensureNetSession(cdp, sessionId);
        res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
      }

      // ── Network: list requests ────────────────────
      if (req.method === 'GET' && url.pathname === '/net/requests') {
        const limit = Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10) || 20);
        const urlF = url.searchParams.get('url');
        const methodF = url.searchParams.get('method')?.toUpperCase();
        const statusF = url.searchParams.get('status');
        const typeF = url.searchParams.get('type')?.split(',').map(t => t.trim().toLowerCase());
        const afterId = Math.max(0, parseInt(url.searchParams.get('after') || '0', 10) || 0);

        let results = trackedRequests.slice();
        if (afterId > 0) results = results.filter(r => r.id > afterId);
        if (urlF) results = results.filter(r => wildcardMatch(r.url, urlF));
        if (methodF) results = results.filter(r => r.method === methodF);
        if (statusF) {
          if (statusF.endsWith('xx')) { const p = parseInt(statusF[0], 10); results = results.filter(r => r.status && Math.floor(r.status / 100) === p); }
          else { const c = parseInt(statusF, 10); if (!isNaN(c)) results = results.filter(r => r.status === c); }
        }
        if (typeF) results = results.filter(r => typeF.includes(r.type.toLowerCase()));

        const sliced = results.slice(-limit);
        res.writeHead(200); res.end(JSON.stringify({ requests: sliced.map(r => ({ id: r.id, method: r.method, url: r.url, status: r.status, type: r.type, size: r.size, time: r.endTime && r.startTime ? r.endTime - r.startTime : null, error: r.error })), total: trackedRequests.length })); return;
      }

      // ── Network: request detail ────────────────────
      if (req.method === 'GET' && url.pathname.startsWith('/net/request/')) {
        const id = parseInt(url.pathname.split('/').pop()!, 10);
        if (isNaN(id)) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid request ID' })); return; }
        const entry = trackedRequests.find(r => r.id === id);
        if (!entry) { res.writeHead(404); res.end(JSON.stringify({ error: 'Request not found' })); return; }
        res.writeHead(200); res.end(JSON.stringify(entry)); return;
      }

      // ── Network: response body ────────────────────
      if (req.method === 'GET' && url.pathname.startsWith('/net/body/')) {
        const id = parseInt(url.pathname.split('/').pop()!, 10);
        if (isNaN(id)) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid request ID' })); return; }
        const entry = trackedRequests.find(r => r.id === id);
        if (!entry) { res.writeHead(404); res.end(JSON.stringify({ error: 'Request not found' })); return; }
        if (!entry.bodyAvailable) { res.writeHead(400); res.end(JSON.stringify({ error: 'Body not available' })); return; }
        const sid = entry.sessionId || activeSessionId;
        const result = await cdp.send('Network.getResponseBody', { requestId: entry.networkId }, sid);
        const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf-8') : result.body;
        res.writeHead(200); res.end(JSON.stringify({ id: entry.id, body, mimeType: entry.mimeType })); return;
      }

      // ── Network: clear ────────────────────────────
      if (req.method === 'POST' && url.pathname === '/net/clear') {
        trackedRequests.length = 0; requestsByNetworkId.clear(); nextReqId = 1;
        res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
      }

      // ── Network: add rule (Fix 3: no file read in daemon) ──
      if (req.method === 'POST' && url.pathname === '/net/rules') {
        const b = JSON.parse(await readBody(req));
        if (!b.pattern || typeof b.pattern !== 'string') { res.writeHead(400); res.end(JSON.stringify({ error: 'pattern is required' })); return; }
        let rule: InterceptRule;
        if (b.type === 'block') {
          rule = { id: nextRuleId++, type: 'block', pattern: b.pattern };
        } else if (b.type === 'mock') {
          const content = b.body || '';
          rule = { id: nextRuleId++, type: 'mock', pattern: b.pattern, status: b.status || 200, headers: Array.isArray(b.headers) ? b.headers : [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(content).toString('base64') };
        } else if (b.type === 'headers') {
          if (!Array.isArray(b.headers)) { res.writeHead(400); res.end(JSON.stringify({ error: 'headers array required' })); return; }
          rule = { id: nextRuleId++, type: 'headers', pattern: b.pattern, headers: b.headers };
        } else { res.writeHead(400); res.end(JSON.stringify({ error: `Unknown rule type: ${b.type}` })); return; }
        interceptRules.push(rule);
        await syncFetchAll(cdp, activeSessionId);
        res.writeHead(200); res.end(JSON.stringify({ ok: true, rule })); return;
      }

      // ── Network: list rules ───────────────────────
      if (req.method === 'GET' && url.pathname === '/net/rules') {
        res.writeHead(200); res.end(JSON.stringify({ rules: interceptRules })); return;
      }

      // ── Network: remove rule(s) ───────────────────
      if (req.method === 'POST' && url.pathname === '/net/rules/remove') {
        const b = JSON.parse(await readBody(req));
        if (b.all) { interceptRules.length = 0; }
        else if (typeof b.id === 'number') {
          const idx = interceptRules.findIndex(r => r.id === b.id);
          if (idx >= 0) interceptRules.splice(idx, 1);
        }
        await syncFetchAll(cdp, activeSessionId);
        res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
      }

      res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err: any) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(SOCKET_PATH, () => {
    if (BROKER_TRANSPORT === 'unix_socket') {
      try { chmodSync(SOCKET_PATH, 0o600); } catch { /* ignore */ }
    }
    const history = updateBrokerVersionHistorySync(executable, startedAt);
    writeBrokerLocatorSync({
      schemaVersion: 2,
      pid: process.pid,
      endpoint: SOCKET_PATH,
      transport: BROKER_TRANSPORT,
      startedAt,
      brokerProcessIdentity,
      serviceVersion: PKG_VERSION,
      executable,
      protocol: PROTOCOL_RANGE,
      ...(history.previous ? { previousExecutable: {
        version: history.previous.version,
        path: history.previous.path,
        identity: history.previous.identity,
      } } : {}),
    });
  });
  terminate = async () => {
    if (terminating) return;
    terminating = true;
    clearInterval(leaseSweepTimer);
    clearInterval(discoveryRefreshTimer);
    broker.close();
    server.close();
    await Promise.all(additionalControllers.map(controller => controller.cdp.close()));
    await cdp.close();
    await artifactStore.clear().catch(() => {});
    cleanup(brokerProcessIdentity);
    process.exit(0);
  };
}

main().catch((err) => { process.stderr.write(`Daemon error: ${err.message}\n`); process.exit(1); });
