import { DaemonClient } from '../client.js';
import { BrowserPilotError } from '../protocol/errors.js';
import type { JsonRpcNotification, JsonValue } from '../protocol/model.js';
import { connectDaemon } from '../session.js';
import type { StdioBridgeBackend } from './stdio-bridge.js';

export class DaemonBridgeBackend implements StdioBridgeBackend {
  private client?: DaemonClient;

  constructor(private readonly browserFilter?: string) {}

  async call(bridgeSessionId: string, method: string, params?: JsonValue): Promise<JsonValue> {
    const client = await this.getClient();
    return client.brokerCall(bridgeSessionId, method, params);
  }

  async disconnect(bridgeSessionId: string): Promise<void> {
    if (!this.client) return;
    await this.client.brokerDisconnect(bridgeSessionId);
  }

  async *notifications(
    bridgeSessionId: string,
    signal: AbortSignal,
  ): AsyncGenerator<JsonRpcNotification> {
    const client = await this.getClient();
    while (!signal.aborted) {
      try {
        const notification = await client.brokerNextNotification(bridgeSessionId, 25_000, signal);
        if (notification) yield notification;
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
    }
  }

  private async getClient(): Promise<DaemonClient> {
    if (!this.client) this.client = await connectDaemon(this.browserFilter);
    const health = await this.client.healthInfo();
    if (health.brokerProtocol !== 1) {
      throw new BrowserPilotError('protocol_incompatible', 'Running Browser Pilot daemon is from an older executable', {
        remediation: {
          code: 'use_compatible_executable_or_isolate',
          message: 'Use a compatible Browser Pilot executable, or set BROWSER_PILOT_HOME for a deliberately isolated Broker.',
          actionRequired: true,
        },
      });
    }
    return this.client;
  }
}
