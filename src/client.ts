import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readBrokerLocatorSync, processIsAlive } from './broker-locator.js';
import { BROWSER_PILOT_PATHS } from './paths.js';
import type { Transport } from './transport.js';
import { BrowserPilotError, browserPilotErrorFromJsonRpc } from './protocol/errors.js';
import type { JsonRpcErrorObject, JsonRpcNotification, JsonValue } from './protocol/model.js';

export interface BrokerClientSummary {
  embeddedConnections: number;
  oneShotConnections: number;
  activeWorkspaces: number;
  activeLeases: number;
}

export interface DaemonShutdownExpectation {
  brokerProcessIdentity: string;
  executableVersion: string;
  executableIdentity: string;
}

const BROKER_SHUTDOWN_TIMEOUT_MS = 15_000;

export function isDaemonRunning(): boolean {
  const locator = readBrokerLocatorSync();
  if (locator) return processIsAlive(locator.pid);
  if (!existsSync(BROWSER_PILOT_PATHS.pidFile)) return false;
  try {
    const raw = readFileSync(BROWSER_PILOT_PATHS.pidFile, 'utf-8').trim();
    const parsed: unknown = raw.startsWith('{') ? JSON.parse(raw) : Number.parseInt(raw, 10);
    const pid = typeof parsed === 'number'
      ? parsed
      : parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? Number((parsed as Record<string, unknown>).pid)
        : Number.NaN;
    return processIsAlive(pid);
  } catch {
    return false;
  }
}

export class DaemonClient implements Transport {
  private readonly endpoint: string;

  constructor() {
    this.endpoint = readBrokerLocatorSync()?.endpoint ?? BROWSER_PILOT_PATHS.endpoint;
  }

  private request(path: string, body?: any, signal?: AbortSignal): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.endpoint,
          path,
          method: body !== undefined ? 'POST' : 'GET',
          headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
          timeout: 60_000,
          signal,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (typeof parsed.error === 'string') reject(new Error(parsed.error));
              else if (parsed.error && typeof parsed.error === 'object') {
                reject(browserPilotErrorFromJsonRpc(parsed.error as JsonRpcErrorObject));
              }
              else resolve(parsed.result ?? parsed);
            } catch {
              reject(new Error(`Invalid daemon response: ${data}`));
            }
          });
        },
      );
      req.on('error', (err) => {
        reject(new Error(`Cannot reach daemon: ${err.message}. Run 'bp connect' first.`));
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Daemon request timeout')); });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async send(method: string, params?: Record<string, any>, sessionId?: string): Promise<any> {
    return this.request('/cdp', { method, params, sessionId });
  }

  async health(): Promise<boolean> {
    try { await this.request('/health'); return true; } catch { return false; }
  }

  async healthInfo(): Promise<{
    ok: boolean;
    wsUrl?: string;
    brokerProtocol?: number;
    brokerProcessIdentity?: string;
    serviceVersion?: string;
    executableVersion?: string;
    executableIdentity?: string;
    shuttingDown?: boolean;
    protocol?: {
      min: { major: number; minor: number };
      max: { major: number; minor: number };
    };
    clients?: BrokerClientSummary;
    browser?: {
      id?: string;
      product: string;
      channel?: string;
      userDataRoot: string;
      state?: 'connected' | 'disconnected' | 'reconnecting';
      connectionGeneration?: number;
    };
  }> {
    try { return await this.request('/health'); } catch { return { ok: false }; }
  }

  async shutdown(expectation: DaemonShutdownExpectation): Promise<void> {
    await this.request('/shutdown', expectation);
    const deadline = Date.now() + BROKER_SHUTDOWN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const locator = readBrokerLocatorSync();
      if (
        !locator ||
        locator.brokerProcessIdentity !== expectation.brokerProcessIdentity ||
        !processIsAlive(locator.pid)
      ) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new BrowserPilotError(
      'unknown_outcome',
      `Browser Pilot Broker accepted shutdown but did not exit within ${BROKER_SHUTDOWN_TIMEOUT_MS}ms`,
      {
        retryable: true,
        context: { brokerProcessIdentity: expectation.brokerProcessIdentity },
        remediation: {
          code: 'inspect_broker_state',
          message: 'Inspect Broker health before retrying shutdown or starting a replacement.',
          actionRequired: false,
        },
      },
    );
  }

  async brokerCall(
    bridgeSessionId: string,
    method: string,
    params?: JsonValue,
  ): Promise<JsonValue> {
    return this.request('/broker/rpc', {
      bridgeSessionId,
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  async brokerDisconnect(bridgeSessionId: string): Promise<void> {
    await this.request('/broker/disconnect', { bridgeSessionId });
  }

  async brokerNextNotification(
    bridgeSessionId: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<JsonRpcNotification | undefined> {
    const result = await this.request('/broker/events/next', {
      bridgeSessionId,
      waitMs,
    }, signal);
    return result.notification as JsonRpcNotification | undefined;
  }

  async discoveredTargets(): Promise<Array<{ targetId: string; url: string; openerTargetId?: string }>> {
    const res = await this.request('/discovered');
    return res.targets ?? [];
  }

  async dialogs(): Promise<Array<{
    dialogId: string;
    type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
    message: string;
    defaultPrompt: string;
    url: string;
    openedAt: number;
  }>> {
    const result = await this.request('/dialogs');
    return result.dialogs ?? [];
  }

  async respondToDialog(
    dialogId: string,
    action: 'accept' | 'dismiss',
    prompt?: string,
  ): Promise<any> {
    const result = await this.request('/dialogs/respond', {
      dialogId,
      action,
      ...(prompt !== undefined ? { prompt } : {}),
    });
    return result.dialog;
  }

  async setAuth(username: string, password: string): Promise<void> {
    await this.request('/auth', { username, password });
  }

  async clearAuth(): Promise<void> {
    await this.request('/auth', { username: '', password: '' });
  }

  // ── Network methods ──────────────────────────────

  async enableNetwork(sessionId: string): Promise<void> {
    await this.request('/net/enable', { sessionId });
  }

  async netRequests(opts?: { limit?: number; url?: string; method?: string; status?: string; type?: string; after?: number }): Promise<{ requests: any[]; total: number }> {
    const p = new URLSearchParams();
    if (opts?.limit) p.set('limit', String(opts.limit));
    if (opts?.url) p.set('url', opts.url);
    if (opts?.method) p.set('method', opts.method);
    if (opts?.status) p.set('status', opts.status);
    if (opts?.type) p.set('type', opts.type);
    if (opts?.after) p.set('after', String(opts.after));
    const qs = p.toString();
    return this.request(`/net/requests${qs ? '?' + qs : ''}`);
  }

  async netRequestDetail(id: number): Promise<any> {
    return this.request(`/net/request/${id}`);
  }

  async netBody(id: number): Promise<{ id: number; body: string; mimeType: string }> {
    return this.request(`/net/body/${id}`);
  }

  async netClear(): Promise<void> { await this.request('/net/clear', {}); }

  async netAddRule(rule: { type: string; pattern: string; status?: number; body?: string; headers?: Array<{ name: string; value: string }> }): Promise<any> {
    return this.request('/net/rules', rule);
  }

  async netRules(): Promise<{ rules: any[] }> { return this.request('/net/rules'); }

  async netRemoveRule(id?: number): Promise<void> {
    await this.request('/net/rules/remove', id !== undefined ? { id } : { all: true });
  }

  close(): void {
    // No-op — daemon manages the connection
  }
}
