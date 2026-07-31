import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readBrokerLocatorSync, processIsAlive } from './broker-locator.js';
import { BROWSER_PILOT_PATHS } from './paths.js';
import { BrowserPilotError, browserPilotErrorFromJsonRpc } from './protocol/errors.js';
import type { JsonRpcErrorObject, JsonValue } from './protocol/model.js';
import {
  brokerRequestTimeoutError,
  brokerRequestTimeoutMs,
  MIN_BROKER_REQUEST_TIMEOUT_MS,
} from './services/broker-request-timeout.js';

export interface BrokerClientSummary {
  connections: number;
  activeWorkspaces: number;
  activeLeases: number;
}

export interface DaemonShutdownExpectation {
  brokerProcessIdentity: string;
  executableVersion: string;
  executableIdentity: string;
}

const BROKER_SHUTDOWN_TIMEOUT_MS = 15_000;
export const BROKER_RPC_VERSION = 2;

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

export class DaemonClient {
  private readonly endpoint: string;

  constructor() {
    this.endpoint = readBrokerLocatorSync()?.endpoint ?? BROWSER_PILOT_PATHS.endpoint;
  }

  private request(
    path: string,
    body?: any,
    signal?: AbortSignal,
    timeoutMs = MIN_BROKER_REQUEST_TIMEOUT_MS,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.endpoint,
          path,
          method: body !== undefined ? 'POST' : 'GET',
          headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
          timeout: timeoutMs,
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
      req.on('timeout', () => {
        req.destroy();
        reject(
          path === '/broker/rpc' && body && typeof body.method === 'string'
            ? brokerRequestTimeoutError(body.method, body.params as JsonValue | undefined)
            : new BrowserPilotError(
                'browser_disconnected',
                'Timed out waiting for the Browser Pilot Broker',
                { retryable: true },
              ),
        );
      });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
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
    clientSessionId: string,
    method: string,
    params?: JsonValue,
  ): Promise<JsonValue> {
    return this.request('/broker/rpc', {
      clientSessionId,
      method,
      ...(params !== undefined ? { params } : {}),
    }, undefined, brokerRequestTimeoutMs(method, params));
  }
}
