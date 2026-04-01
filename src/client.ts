import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { SOCKET_PATH, PID_FILE } from './paths.js';
import type { Transport } from './transport.js';

export function isDaemonRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;
  const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class DaemonClient implements Transport {
  private request(path: string, body?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: SOCKET_PATH,
          path,
          method: body !== undefined ? 'POST' : 'GET',
          headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
          timeout: 60_000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) reject(new Error(parsed.error));
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

  async shutdown(): Promise<void> {
    try { await this.request('/shutdown', {}); } catch { /* may already be gone */ }
  }

  async dialogs(): Promise<any[]> {
    const res = await this.request('/dialogs');
    return res.dialogs ?? [];
  }

  async discoveredTargets(): Promise<Array<{ targetId: string; url: string; openerTargetId?: string }>> {
    const res = await this.request('/discovered');
    return res.targets ?? [];
  }

  close(): void {
    // No-op — daemon manages the connection
  }
}
