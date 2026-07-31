import {
  discoverBrowserCandidates,
  discoverChromeAtDataDir,
  probeBrowserEndpoint,
} from './chrome.js';
import { CDPError, CDP_HANDSHAKE_TIMEOUT_CODE } from './cdp.js';
import { ManagedTargetJanitorClient } from './managed-target-janitor-client.js';
import { BrowserPilotError } from './protocol/errors.js';
import type { BrowserInstanceId } from './protocol/model.js';
import type {
  BrokerBrowserBinding,
  MemoryBrokerRuntime,
} from './services/broker-runtime.js';

export interface ManagedBrowserConnection {
  binding: BrokerBrowserBinding;
  cdp: ManagedTargetJanitorClient;
  registered: boolean;
}

interface BrowserController extends ManagedBrowserConnection {
  lastAttemptedWsUrl: string | undefined;
}

export class BrowserConnectionCoordinator {
  private readonly controllers: BrowserController[];
  private readonly connectionAttempts = new Map<BrowserInstanceId, Promise<void>>();
  private discoveryRefreshRunning = false;
  private discoveryRefreshTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly broker: MemoryBrokerRuntime,
    connections: ManagedBrowserConnection[],
    private readonly isTerminating: () => boolean,
  ) {
    this.controllers = connections.map(connection => ({
      ...connection,
      lastAttemptedWsUrl: undefined,
    }));
  }

  start(): void {
    for (const controller of this.controllers) {
      controller.cdp.onConnectionState(event => {
        if (event.state !== 'disconnected' || this.isTerminating()) return;
        void controller.cdp.browserDisconnected().catch(error => {
          process.stderr.write(
            `Managed browser connection reset (${controller.binding.instance.product}): ${error instanceof Error ? error.message : String(error)}\n`,
          );
        });
        if (controller.binding.instance.state !== 'connected') return;
        try {
          this.broker.updateBrowserConnection(controller.binding.instance.id, {
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

    this.discoveryRefreshTimer = setInterval(() => { this.refreshDiscovery(); }, 2_000);
    this.discoveryRefreshTimer.unref();
  }

  connect(browserInstanceId: BrowserInstanceId): Promise<void> {
    const controller = this.controllers.find(candidate => (
      candidate.binding.instance.id === browserInstanceId
    ));
    if (!controller || !controller.registered) {
      return Promise.reject(new BrowserPilotError(
        'browser_disconnected',
        'Browser connection coordinator does not manage this browser',
      ));
    }
    return this.explicitlyConnect(controller);
  }

  async close(): Promise<void> {
    if (this.discoveryRefreshTimer) clearInterval(this.discoveryRefreshTimer);
    this.discoveryRefreshTimer = undefined;
    await Promise.all(this.controllers.map(controller => controller.cdp.close()));
  }

  private explicitlyConnect(controller: BrowserController): Promise<void> {
    if (controller.binding.instance.state === 'connected') return Promise.resolve();
    const existing = this.connectionAttempts.get(controller.binding.instance.id);
    if (existing) return existing;

    const attempt = this.connectController(controller);
    this.connectionAttempts.set(controller.binding.instance.id, attempt);
    void attempt.finally(() => {
      if (this.connectionAttempts.get(controller.binding.instance.id) === attempt) {
        this.connectionAttempts.delete(controller.binding.instance.id);
      }
    }).catch(() => {});
    return attempt;
  }

  private async connectController(controller: BrowserController): Promise<void> {
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
        this.broker.updateBrowserCandidate(controller.binding.instance.id, latest.candidate);
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
      this.broker.updateBrowserConnection(controller.binding.instance.id, {
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
        this.broker.updateBrowserCandidate(controller.binding.instance.id, candidate);
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
      this.broker.updateBrowserCandidate(controller.binding.instance.id, candidate);
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
  }

  private refreshDiscovery(): void {
    if (this.discoveryRefreshRunning || this.isTerminating()) return;
    this.discoveryRefreshRunning = true;
    void discoverBrowserCandidates()
      .then(latest => {
        for (const controller of this.controllers) {
          if (!controller.registered || controller.binding.instance.state === 'connected') continue;
          const discovered = latest.find(browser => (
            browser.candidate.id === controller.binding.candidate.id
          ));
          if (!discovered) continue;
          if (
            controller.binding.candidate.state === 'authorization_required' &&
            controller.lastAttemptedWsUrl === discovered.endpoint?.wsUrl
          ) continue;
          if (controller.lastAttemptedWsUrl !== discovered.endpoint?.wsUrl) {
            controller.lastAttemptedWsUrl = undefined;
          }
          controller.binding.candidate = { ...discovered.candidate };
          this.broker.updateBrowserCandidate(
            controller.binding.instance.id,
            discovered.candidate,
          );
        }
      })
      .catch(error => {
        process.stderr.write(
          `Browser discovery refresh error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      })
      .finally(() => { this.discoveryRefreshRunning = false; });
  }
}
