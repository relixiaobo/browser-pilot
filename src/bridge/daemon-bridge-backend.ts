import { DaemonClient } from '../client.js';
import { BrowserPilotError } from '../protocol/errors.js';
import type { JsonValue } from '../protocol/model.js';
import { connectDaemon } from '../session.js';
import type { StdioBridgeBackend } from './stdio-bridge.js';

export class DaemonBridgeBackend implements StdioBridgeBackend {
  private client?: DaemonClient;

  async call(bridgeSessionId: string, method: string, params?: JsonValue): Promise<JsonValue> {
    const client = await this.getClient();
    return client.brokerCall(bridgeSessionId, method, params);
  }

  async disconnect(bridgeSessionId: string): Promise<void> {
    if (!this.client) return;
    await this.client.brokerDisconnect(bridgeSessionId);
  }

  private async getClient(): Promise<DaemonClient> {
    if (!this.client) this.client = await connectDaemon();
    const health = await this.client.healthInfo();
    if (health.brokerProtocol !== 1) {
      throw new BrowserPilotError('protocol_incompatible', 'Running Browser Pilot daemon is from an older executable', {
        remediation: {
          code: 'restart_browser_pilot',
          message: 'Run bp disconnect, then start the bridge again.',
          actionRequired: true,
        },
      });
    }
    return this.client;
  }
}
