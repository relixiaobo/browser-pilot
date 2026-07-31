import http from 'node:http';
import { chmodSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { BROKER_TRANSPORT, SOCKET_PATH } from './paths.js';
import {
  acquireDaemonOwnerLockSync,
  createExecutableMetadataSync,
  DaemonOwnerError,
  updateBrokerVersionHistorySync,
  writeBrokerLocatorSync,
  writeBrokerStartingSync,
} from './broker-locator.js';
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
import {
  discoverBrowserCandidates,
  discoverChromeAtDataDir,
  probeBrowserEndpoint,
  type DiscoveredBrowser,
} from './chrome.js';
import { CDPError, CDP_HANDSHAKE_TIMEOUT_CODE } from './cdp.js';
import { ManagedTargetJanitorClient } from './managed-target-janitor-client.js';
import { publicExecutablePath } from './runtime-layout.js';
import { BROWSER_PILOT_VERSION as PKG_VERSION } from './version.js';
import { BROKER_RPC_VERSION } from './client.js';

const CLI_EXECUTABLE_PATH = publicExecutablePath(import.meta.url);
const PROTOCOL_RANGE = {
  min: { ...SUPPORTED_PROTOCOL_VERSIONS[0] },
  max: { ...SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1] },
};

const browserProduct = process.argv[2] || '';
const browserProfile = process.argv[3] || '';

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

// ── Main ────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  const brokerProcessIdentity = `${process.pid}:${startedAt}`;
  const daemonOwner = acquireDaemonOwnerLockSync();
  const cleanup = (): void => { daemonOwner.cleanup(brokerProcessIdentity); };
  process.once('exit', cleanup);
  daemonOwner.clearStaleBrokerState();
  const cdp = new ManagedTargetJanitorClient({
    onLog: message => process.stderr.write(`Managed browser connection: ${message}\n`),
  });
  let terminating = false;
  let terminate = async (): Promise<void> => {
    if (terminating) return;
    terminating = true;
    await cdp.close().catch(() => {});
    cleanup();
    process.exit(0);
  };
  const requestTermination = (): void => { void terminate(); };
  process.on('SIGTERM', requestTermination);
  process.on('SIGINT', requestTermination);
  daemonOwner.assertOwnership();
  writeBrokerStartingSync({ pid: process.pid, startedAt, brokerProcessIdentity });
  let currentWsUrl: string | undefined;
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
          userDataRoot: browserProfile,
          processState: 'unknown',
          remoteDebuggingState: 'disabled',
          authorizationState: 'not_applicable',
          state: 'not_running',
          remediation: {
            code: 'start_browser',
            message: 'Start this browser profile, then enable remote debugging from chrome://inspect/#remote-debugging.',
            actionRequired: true,
          },
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
      ? { ...selectedBrowser.candidate }
      : {
        id: browserId,
        product: browserProduct || 'Unavailable browser',
        userDataRoot: browserProfile,
        processState: 'unknown',
        remoteDebuggingState: 'disabled',
        authorizationState: 'not_applicable',
        state: 'not_running',
      },
    instance: {
      id: browserInstanceId,
      product: selectedProduct || 'Unavailable browser',
      userDataRoot: selectedProfile,
      processIdentity: '',
      connectionGeneration: 0,
      state: 'disconnected',
    },
  };
  const artifactStore = new ArtifactStore({
    maxArtifactBytes: DEFAULT_PROTOCOL_LIMITS.maxArtifactBytes,
  });
  await artifactStore.initialize();
  const selectedController = {
    discovered: selectedBrowser,
    binding: browserBinding,
    cdp,
    lastAttemptedWsUrl: undefined as string | undefined,
    connect: async (): Promise<void> => {
      throw new BrowserPilotError('browser_disconnected', 'Browser connection coordinator is not ready');
    },
  };
  const browserTools = new BrowserToolService(cdp, browserBinding, {
    artifactStore,
    managedTargets: cdp,
    connectBrowser: () => selectedController.connect(),
  });
  const toolRouter = new BrowserToolRouter();
  if (selectedBrowser) toolRouter.register(browserInstanceId, browserTools);
  const additionalControllers: Array<{
    discovered: DiscoveredBrowser;
    binding: BrokerBrowserBinding;
    cdp: ManagedTargetJanitorClient;
    lastAttemptedWsUrl: string | undefined;
    connect: () => Promise<void>;
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
        userDataRoot: discovered.dataDir,
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
    const controller = {
      discovered,
      binding,
      cdp: additionalCdp,
      lastAttemptedWsUrl: undefined as string | undefined,
      connect: async (): Promise<void> => {
        throw new BrowserPilotError('browser_disconnected', 'Browser connection coordinator is not ready');
      },
    };
    const service = new BrowserToolService(additionalCdp, binding, {
      artifactStore,
      managedTargets: additionalCdp,
      connectBrowser: () => controller.connect(),
    });
    toolRouter.register(instanceId, service);
    additionalControllers.push(controller);
  }
  const broker = new MemoryBrokerRuntime({
    serviceVersion: PKG_VERSION,
    executableVersion: PKG_VERSION,
    brokerProcessIdentity,
    browsers: browserBindings,
    toolExecutor: toolRouter,
    artifactStore,
  });
  const controllers = [selectedController, ...additionalControllers];
  const connectionAttempts = new Map<BrowserInstanceId, Promise<void>>();
  const explicitlyConnect = (controller: typeof selectedController): Promise<void> => {
    if (controller.binding.instance.state === 'connected') return Promise.resolve();
    const existing = connectionAttempts.get(controller.binding.instance.id);
    if (existing) return existing;

    const attempt = (async (): Promise<void> => {
      const chrome = discoverChromeAtDataDir(
        controller.binding.instance.userDataRoot,
        controller.binding.instance.product,
      );
      if (!chrome) {
        const latest = (await discoverBrowserCandidates()).find(browser => (
          browser.candidate.id === controller.binding.candidate.id
        ));
        if (latest) {
          controller.binding.candidate = { ...latest.candidate };
          broker.updateBrowserCandidate(controller.binding.instance.id, latest.candidate);
        }
        throw new BrowserPilotError('browser_disconnected', 'Browser remote debugging endpoint is unavailable', {
          retryable: true,
          remediation: latest?.candidate.remediation ?? {
            code: 'enable_remote_debugging',
            message: 'Start the selected browser and enable remote debugging, then connect explicitly.',
            actionRequired: true,
          },
        });
      }

      controller.lastAttemptedWsUrl = chrome.wsUrl;
      try {
        await controller.cdp.connect(chrome.wsUrl);
        await controller.cdp.send('Target.setDiscoverTargets', { discover: true });
        if (controller === selectedController) currentWsUrl = chrome.wsUrl;
        broker.updateBrowserConnection(controller.binding.instance.id, {
          state: 'connected',
          connectionGeneration: controller.binding.instance.connectionGeneration + 1,
          processIdentity: chrome.wsUrl,
        });
      } catch (error) {
        await controller.cdp.browserDisconnected().catch(() => {});
        const probe = error instanceof CDPError && error.code === CDP_HANDSHAKE_TIMEOUT_CODE
          ? 'authorization_required'
          : await probeBrowserEndpoint(chrome).catch(() => 'unreachable' as const);
        if (probe === 'authorization_required') {
          const candidate = {
            ...controller.binding.candidate,
            processState: 'running' as const,
            remoteDebuggingState: 'enabled' as const,
            authorizationState: 'required' as const,
            state: 'authorization_required' as const,
            remediation: {
              code: 'allow_remote_debugging',
              message: 'Approve the existing Chrome remote debugging prompt, then retry the explicit connect operation.',
              actionRequired: true,
            },
          };
          controller.binding.candidate = candidate;
          broker.updateBrowserCandidate(controller.binding.instance.id, candidate);
          throw new BrowserPilotError(
            'browser_not_authorized',
            'Chrome remote debugging authorization was not completed',
            {
              retryable: true,
              cause: error instanceof Error ? error : undefined,
              remediation: candidate.remediation,
            },
          );
        }

        const latest = (await discoverBrowserCandidates()).find(browser => (
          browser.candidate.id === controller.binding.candidate.id
        ));
        const processState = latest?.candidate.processState ?? controller.binding.candidate.processState;
        const remediation = processState === 'not_running'
          ? {
            code: 'start_browser',
            message: 'Start this browser profile and enable remote debugging, then retry the explicit connect operation.',
            actionRequired: true,
          }
          : {
            code: 'restart_remote_debugging',
            message: 'The recorded remote debugging endpoint is stale. Restart this browser profile and enable remote debugging again.',
            actionRequired: true,
          };
        const candidate = {
          ...controller.binding.candidate,
          ...(latest ? latest.candidate : {}),
          processState,
          remoteDebuggingState: 'stale' as const,
          authorizationState: 'unknown' as const,
          state: 'disconnected' as const,
          remediation,
        };
        controller.binding.candidate = candidate;
        broker.updateBrowserCandidate(controller.binding.instance.id, candidate);
        throw new BrowserPilotError(
          'browser_disconnected',
          'Chrome remote debugging endpoint is unreachable',
          {
            retryable: true,
            cause: error instanceof Error ? error : undefined,
            remediation,
          },
        );
      }
    })();
    connectionAttempts.set(controller.binding.instance.id, attempt);
    void attempt.finally(() => {
      if (connectionAttempts.get(controller.binding.instance.id) === attempt) {
        connectionAttempts.delete(controller.binding.instance.id);
      }
    }).catch(() => {});
    return attempt;
  };

  for (const controller of controllers) {
    controller.connect = () => explicitlyConnect(controller);
    controller.cdp.onConnectionState(event => {
      if (event.state !== 'disconnected' || terminating) return;
      void controller.cdp.browserDisconnected().catch(error => {
        process.stderr.write(
          `Managed browser connection reset (${controller.binding.instance.product}): ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
      if (controller === selectedController) {
        currentWsUrl = undefined;
      }
      if (controller.binding.instance.state !== 'connected') return;
      try {
        broker.updateBrowserConnection(controller.binding.instance.id, {
          state: 'disconnected',
          connectionGeneration: controller.binding.instance.connectionGeneration,
        });
      } catch (error) {
        process.stderr.write(
          `Browser disconnect state error (${controller.binding.instance.product}): ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    });
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
          const controller = controllers.find(current => current.binding.instance.id === binding.instance.id);
          if (
            binding.candidate.state === 'authorization_required' &&
            controller?.lastAttemptedWsUrl === discovered.endpoint?.wsUrl
          ) continue;
          if (controller && controller.lastAttemptedWsUrl !== discovered.endpoint?.wsUrl) {
            controller.lastAttemptedWsUrl = undefined;
          }
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
          brokerProtocol: BROKER_RPC_VERSION,
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
            userDataRoot: selectedProfile,
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
          if (typeof body.clientSessionId !== 'string') {
            throw invalidArgument('clientSessionId is required', 'clientSessionId');
          }
          if (typeof body.method !== 'string' || body.method.length === 0 || body.method.length > 256) {
            throw invalidArgument('method is required', 'method');
          }
          const result = await broker.call(
            body.clientSessionId,
            body.method,
            body.params as JsonValue | undefined,
          );
          res.writeHead(200); res.end(JSON.stringify({ result })); return;
        } catch (error) {
          res.writeHead(200); res.end(JSON.stringify({ error: asBrowserPilotError(error).toJsonRpcError() })); return;
        }
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
          if (clients.activeLeases > 0) {
            throw new BrowserPilotError('broker_in_use', 'Browser Pilot has other live clients and cannot be stopped', {
              retryable: true,
              context: clients,
              remediation: {
                code: 'close_active_clients',
                message: 'Close the other Agent clients using Browser Pilot, then retry disconnect.',
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

      res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err: any) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(SOCKET_PATH, () => {
    daemonOwner.assertOwnership();
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
    cleanup();
    process.exit(0);
  };
}

main().catch((error: unknown) => {
  const err = error instanceof Error ? error : new Error(String(error));
  const code = err instanceof DaemonOwnerError ? ` [${err.code}]` : '';
  process.stderr.write(`Daemon error${code}: ${err.message}\n`);
  process.exit(1);
});
