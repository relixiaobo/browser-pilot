import { invalidArgument } from '../protocol/errors.js';

export interface NetworkFilters {
  limit?: number;
  url?: string;
  method?: string;
  status?: string;
  type?: string;
  after?: number;
}

export interface NetworkHeader {
  name: string;
  value: string;
}

export interface NetworkController {
  enableNetwork(sessionId: string): Promise<void>;
  netRequests(options?: NetworkFilters): Promise<{ requests: any[]; total: number }>;
  netRequestDetail(id: number): Promise<any>;
  netBody(id: number): Promise<{ id: number; body: string; mimeType: string }>;
  netClear(): Promise<void>;
  netAddRule(rule: {
    type: string;
    pattern: string;
    status?: number;
    body?: string;
    headers?: NetworkHeader[];
  }): Promise<any>;
  netRules(): Promise<{ rules: any[] }>;
  netRemoveRule(id?: number): Promise<void>;
}

function requestId(id: number): number {
  if (!Number.isSafeInteger(id) || id < 1) throw invalidArgument('Request ID must be a positive integer', 'id');
  return id;
}

function rulePattern(pattern: string): string {
  if (!pattern || pattern.length > 16_384) throw invalidArgument('Rule pattern must not be empty', 'pattern');
  return pattern;
}

export class NetworkService {
  constructor(
    private readonly controller: NetworkController,
    private readonly sessionId?: string,
  ) {}

  async enable(): Promise<void> {
    if (this.sessionId) await this.controller.enableNetwork(this.sessionId);
  }

  async requests(filters: NetworkFilters = {}): Promise<{ requests: any[]; total: number }> {
    if (filters.limit !== undefined && (!Number.isSafeInteger(filters.limit) || filters.limit < 1 || filters.limit > 1000)) {
      throw invalidArgument('Network request limit must be between 1 and 1000', 'limit');
    }
    if (filters.after !== undefined && (!Number.isSafeInteger(filters.after) || filters.after < 0)) {
      throw invalidArgument('Network cursor must be a non-negative integer', 'after');
    }
    return this.controller.netRequests(filters);
  }

  async request(id: number, includeBody = true): Promise<any> {
    const validId = requestId(id);
    const detail = await this.controller.netRequestDetail(validId);
    if (!includeBody) return detail;
    let responseBody: string | undefined;
    try { responseBody = (await this.controller.netBody(validId)).body; } catch { /* body is optional */ }
    return { ...detail, responseBody };
  }

  async body(id: number): Promise<{ id: number; body: string; mimeType: string }> {
    return this.controller.netBody(requestId(id));
  }

  async addBlock(pattern: string): Promise<any> {
    return this.controller.netAddRule({ type: 'block', pattern: rulePattern(pattern) });
  }

  async addMock(pattern: string, status: number, body: string): Promise<any> {
    if (!Number.isSafeInteger(status) || status < 100 || status > 999) {
      throw invalidArgument('Mock status must be an integer between 100 and 999', 'status');
    }
    if (body.length > 1_000_000) throw invalidArgument('Mock body exceeds 1000000 characters', 'body');
    return this.controller.netAddRule({ type: 'mock', pattern: rulePattern(pattern), status, body });
  }

  async addHeaders(pattern: string, headers: NetworkHeader[]): Promise<any> {
    if (!Array.isArray(headers) || headers.length === 0 || headers.length > 256) {
      throw invalidArgument('At least one and no more than 256 headers are required', 'headers');
    }
    for (const header of headers) {
      if (!header.name || /[\r\n:]/.test(header.name) || /[\r\n]/.test(header.value)) {
        throw invalidArgument('Header names and values must not contain separators or newlines', 'headers');
      }
    }
    return this.controller.netAddRule({ type: 'headers', pattern: rulePattern(pattern), headers });
  }

  async rules(): Promise<any[]> {
    return (await this.controller.netRules()).rules;
  }

  async remove(ruleId?: number): Promise<void> {
    if (ruleId !== undefined && (!Number.isSafeInteger(ruleId) || ruleId < 1)) {
      throw invalidArgument('Rule ID must be a positive integer', 'ruleId');
    }
    await this.controller.netRemoveRule(ruleId);
  }

  async clear(): Promise<void> {
    await this.controller.netClear();
  }
}
