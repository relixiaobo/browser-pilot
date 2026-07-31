import http from 'node:http';
import { chmodSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { BROKER_TRANSPORT, SOCKET_PATH } from './paths.js';
import {
  acquireDaemonOwnerLockSync,
  createExecutableMetadataSync,
  DaemonOwnerError,
  restrictWindowsBrokerStateSync,
  updateBrokerVersionHistorySync,
  writeBrokerLocatorSync,
  writeBrokerStartingSync,
} from './broker-locator.js';
import { BrowserPilotError, invalidArgument } from './protocol/errors.js';
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  type BrowserInstanceId,
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
  type DiscoveredBrowser,
} from './chrome.js';
import { ManagedTargetJanitorClient } from './managed-target-janitor-client.js';
import {
  BrowserConnectionCoordinator,
  type ManagedBrowserConnection,
} from './browser-connection-coordinator.js';
import { HttpApi } from './http-api.js';
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

// ── Main ────────────────────────────────────────────

async function main() {
  if (BROKER_TRANSPORT === 'unix_socket') process.umask(0o077);
  const startedAt = Date.now();
  const brokerProcessIdentity = `${process.pid}:${startedAt}`;
  const daemonToken = randomBytes(32).toString('base64url');
  const daemonOwner = acquireDaemonOwnerLockSync();
  restrictWindowsBrokerStateSync();
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

  const connections: ManagedBrowserConnection[] = [{
    binding: browserBinding,
    cdp,
    registered: selectedBrowser !== undefined,
  }];
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
    const additionalCdp = new ManagedTargetJanitorClient({
      onLog: message => process.stderr.write(
        `Managed browser connection (${discovered.candidate.product}): ${message}\n`,
      ),
    });
    browserBindings.push(binding);
    connections.push({ binding, cdp: additionalCdp, registered: true });
  }

  const toolRouter = new BrowserToolRouter();
  const broker = new MemoryBrokerRuntime({
    serviceVersion: PKG_VERSION,
    executableVersion: PKG_VERSION,
    brokerProcessIdentity,
    browsers: browserBindings,
    toolExecutor: toolRouter,
    artifactStore,
  });
  const connectionCoordinator = new BrowserConnectionCoordinator(
    broker,
    connections,
    () => terminating,
  );
  for (const connection of connections) {
    if (!connection.registered) continue;
    const service = new BrowserToolService(connection.cdp, connection.binding, {
      artifactStore,
      managedTargets: connection.cdp,
      connectBrowser: () => connectionCoordinator.connect(connection.binding.instance.id),
    });
    toolRouter.register(connection.binding.instance.id, service);
  }
  connectionCoordinator.start();

  const leaseSweepTimer = setInterval(() => {
    broker.sweepExpiredLeases();
    void artifactStore.sweep().catch(() => {});
  }, 1_000);
  leaseSweepTimer.unref();

  const api = new HttpApi({
    daemonToken,
    broker,
    health: () => ({
      ok: true,
      brokerProtocol: BROKER_RPC_VERSION,
      brokerProcessIdentity,
      serviceVersion: PKG_VERSION,
      executableVersion: executable.version,
      executableIdentity: executable.identity,
      clients: broker.lifecycleSummary(),
      ...(selectedBrowser ? { browser: {
        id: browserBinding.candidate.id,
        product: selectedProduct,
        ...(browserBinding.candidate.channel ? { channel: browserBinding.candidate.channel } : {}),
        userDataRoot: selectedProfile,
        state: browserBinding.instance.state,
        connectionGeneration: browserBinding.instance.connectionGeneration,
      } } : {}),
    }),
    isShuttingDown: () => shutdownReserved || terminating,
    authorizeShutdown: body => {
      if (
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
    },
    terminate: requestTermination,
  });
  const server = http.createServer(api.handle);

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
      token: daemonToken,
      ...(history.previous ? { previousExecutable: {
        version: history.previous.version,
        path: history.previous.path,
        identity: history.previous.identity,
      } } : {}),
    });
    restrictWindowsBrokerStateSync();
  });

  terminate = async () => {
    if (terminating) return;
    terminating = true;
    clearInterval(leaseSweepTimer);
    broker.close();
    server.close();
    await connectionCoordinator.close();
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
