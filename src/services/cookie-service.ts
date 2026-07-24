import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import type { Transport } from '../transport.js';

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly?: boolean;
  secure?: boolean;
  [key: string]: unknown;
}

export class CookieService {
  constructor(
    private readonly transport: Transport,
    private readonly sessionId: string,
  ) {}

  async list(domain?: string): Promise<BrowserCookie[]> {
    if (domain !== undefined && (!domain || domain.length > 2048 || /[\s/]/.test(domain))) {
      throw invalidArgument('Cookie domain must be a hostname without a path', 'domain');
    }
    const urls = domain
      ? [`https://${domain}`, `http://${domain}`]
      : [await this.currentUrl()];
    const { cookies } = await this.transport.send('Network.getCookies', { urls }, this.sessionId);
    if (!Array.isArray(cookies)) {
      throw new BrowserPilotError('internal_error', 'Chrome returned invalid cookie data');
    }
    return cookies as BrowserCookie[];
  }

  private async currentUrl(): Promise<string> {
    const { result } = await this.transport.send('Runtime.evaluate', {
      expression: 'location.href',
      returnByValue: true,
    }, this.sessionId);
    if (typeof result?.value !== 'string') {
      throw new BrowserPilotError('internal_error', 'Chrome returned invalid page URL');
    }
    return result.value;
  }
}
