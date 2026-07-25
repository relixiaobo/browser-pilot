import { randomUUID } from 'node:crypto';
import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import type {
  BrowserWorkspaceId,
  ControlledTargetId,
  ControlLeaseId,
  JsonValue,
  NetworkRequestId,
  NetworkRuleId,
} from '../protocol/model.js';
import type { Transport } from '../transport.js';
import type { PublishBrowserEventInput } from './event-journal.js';
import { accessBlockedAgentHint } from './agent-hint-service.js';

const DEFAULT_MAX_REQUESTS = 1000;
const DEFAULT_MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_RULES_PER_WORKSPACE = 256;
const MAX_RULE_BYTES_PER_WORKSPACE = 8 * 1024 * 1024;
const MAX_RULE_BYTES_TOTAL = 64 * 1024 * 1024;
const MAX_BODY_CHARACTERS = 1_000_000;
const MAX_POST_DATA_CHARACTERS = 65_536;
const MAX_URL_CHARACTERS = 16_384;
const MAX_HEADER_COUNT = 256;
const MAX_HEADER_NAME_CHARACTERS = 256;
const MAX_HEADER_VALUE_CHARACTERS = 8192;

export interface WorkspaceNetworkSession {
  workspaceId: BrowserWorkspaceId;
  leaseId: ControlLeaseId;
  targetId: ControlledTargetId;
  browserConnectionGeneration: number;
  sessionId: string;
}

export interface WorkspaceNetworkHeader extends Record<string, string> {
  name: string;
  value: string;
}

export type WorkspaceNetworkRuleInput =
  | { type: 'block'; pattern: string }
  | {
    type: 'mock';
    pattern: string;
    status?: number;
    headers?: WorkspaceNetworkHeader[];
    body?: string;
  }
  | { type: 'headers'; pattern: string; headers: WorkspaceNetworkHeader[] };

type WorkspaceNetworkRule = WorkspaceNetworkRuleInput & {
  id: NetworkRuleId;
  createdAt: number;
};

interface NetworkRequestRecord {
  id: NetworkRequestId;
  sequence: number;
  workspaceId: BrowserWorkspaceId;
  leaseId: ControlLeaseId;
  targetId: ControlledTargetId;
  browserConnectionGeneration: number;
  sessionId: string;
  networkId: string;
  method: string;
  url: string;
  type: string;
  requestHeaders: WorkspaceNetworkHeader[];
  postData?: string;
  postDataTruncated: boolean;
  status?: number;
  statusText?: string;
  responseHeaders?: WorkspaceNetworkHeader[];
  mimeType?: string;
  size?: number;
  startedAt: number;
  endedAt?: number;
  error?: string;
  bodyAvailable: boolean;
  retainedByteSize: number;
}

interface WorkspaceNetworkState {
  credentials?: { username: string; password: string };
  rules: WorkspaceNetworkRule[];
  requests: NetworkRequestRecord[];
  requestsById: Map<NetworkRequestId, NetworkRequestRecord>;
  requestsByNetworkKey: Map<string, NetworkRequestRecord>;
  nextSequence: number;
  revision: number;
  requestBytes: number;
}

interface SessionState extends WorkspaceNetworkSession {
  fetchEnabled: boolean;
}

export interface WorkspaceNetworkRequestFilters {
  limit?: number;
  after?: number;
  url?: string;
  method?: string;
  status?: string;
  type?: string[];
}

export interface WorkspaceNetworkControllerOptions {
  maxRequestsPerWorkspace?: number;
  maxJournalBytesPerWorkspace?: number;
  now?: () => number;
  requestIdFactory?: () => NetworkRequestId;
  ruleIdFactory?: () => NetworkRuleId;
  publishEvent?: (event: PublishBrowserEventInput) => void;
}

function boundedString(value: unknown, limit: number): string {
  return (typeof value === 'string' ? value : String(value ?? '')).slice(0, limit);
}

function networkKey(sessionId: string, networkId: string): string {
  return `${sessionId}\u0000${networkId}`;
}

function wildcardMatch(value: string, pattern: string): boolean {
  try {
    const expression = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${expression}$`, 'i').test(value);
  } catch {
    return false;
  }
}

function headersFromCdp(value: unknown): WorkspaceNetworkHeader[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .slice(0, MAX_HEADER_COUNT)
    .map(([name, headerValue]) => ({
      name: boundedString(name, MAX_HEADER_NAME_CHARACTERS),
      value: boundedString(headerValue, MAX_HEADER_VALUE_CHARACTERS),
    }));
}

function validateHeaders(headers: WorkspaceNetworkHeader[] | undefined, required: boolean): WorkspaceNetworkHeader[] {
  if (!Array.isArray(headers) || (required && headers.length === 0) || headers.length > MAX_HEADER_COUNT) {
    throw invalidArgument(
      required
        ? 'At least one and no more than 256 headers are required'
        : 'No more than 256 headers are allowed',
      'headers',
    );
  }
  return headers.map(header => {
    if (
      typeof header?.name !== 'string' ||
      header.name.length === 0 ||
      header.name.length > MAX_HEADER_NAME_CHARACTERS ||
      /[\r\n:]/.test(header.name) ||
      typeof header.value !== 'string' ||
      header.value.length > MAX_HEADER_VALUE_CHARACTERS ||
      /[\r\n]/.test(header.value)
    ) {
      throw invalidArgument('Header names and values contain invalid characters or exceed their limits', 'headers');
    }
    return { name: header.name, value: header.value };
  });
}

function validatePattern(pattern: string): string {
  if (!pattern || pattern.length > MAX_URL_CHARACTERS) {
    throw invalidArgument('Network rule pattern must contain from 1 through 16384 characters', 'pattern');
  }
  return pattern;
}

function validStatus(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 100 && Number(value) <= 999
    ? Number(value)
    : undefined;
}

function sanitizedEventUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'data:' || url.protocol === 'javascript:' || url.protocol === 'file:') {
      return `${url.protocol}[redacted]`;
    }
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function ruleBytes(rule: WorkspaceNetworkRule): number {
  return Buffer.byteLength(JSON.stringify(rule), 'utf8');
}

function publicRule(rule: WorkspaceNetworkRule): Record<string, JsonValue> {
  return {
    ruleId: rule.id,
    type: rule.type,
    pattern: rule.pattern,
    ...(rule.type === 'mock' ? {
      status: rule.status ?? 200,
      headers: rule.headers ?? [],
      bodySize: Buffer.byteLength(rule.body ?? '', 'utf8'),
    } : {}),
    ...(rule.type === 'headers' ? { headers: rule.headers } : {}),
  } as Record<string, JsonValue>;
}

function publicRequest(record: NetworkRequestRecord): Record<string, JsonValue> {
  const durationMs = record.endedAt === undefined
    ? undefined
    : Math.max(0, record.endedAt - record.startedAt);
  return {
    requestId: record.id,
    method: record.method,
    url: record.url,
    type: record.type,
    requestHeaders: record.requestHeaders,
    ...(record.postData !== undefined ? { postData: record.postData } : {}),
    postDataTruncated: record.postDataTruncated,
    ...(record.status !== undefined ? { status: record.status } : {}),
    ...(record.statusText !== undefined ? { statusText: record.statusText } : {}),
    ...(record.responseHeaders !== undefined ? { responseHeaders: record.responseHeaders } : {}),
    ...(record.mimeType !== undefined ? { mimeType: record.mimeType } : {}),
    ...(record.size !== undefined ? { size: record.size } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    bodyAvailable: record.bodyAvailable,
  } as Record<string, JsonValue>;
}

function publicRequestSummary(record: NetworkRequestRecord): Record<string, JsonValue> {
  const durationMs = record.endedAt === undefined
    ? undefined
    : Math.max(0, record.endedAt - record.startedAt);
  return {
    requestId: record.id,
    method: record.method,
    url: record.url,
    type: record.type,
    ...(record.status !== undefined ? { status: record.status } : {}),
    ...(record.size !== undefined ? { size: record.size } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
  };
}

export class WorkspaceNetworkController {
  private readonly workspaces = new Map<BrowserWorkspaceId, WorkspaceNetworkState>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly maxRequestsPerWorkspace: number;
  private readonly maxJournalBytesPerWorkspace: number;
  private readonly now: () => number;
  private readonly requestIdFactory: () => NetworkRequestId;
  private readonly ruleIdFactory: () => NetworkRuleId;
  private readonly publish?: (event: PublishBrowserEventInput) => void;

  constructor(
    private readonly transport: Transport,
    options: WorkspaceNetworkControllerOptions = {},
  ) {
    this.maxRequestsPerWorkspace = options.maxRequestsPerWorkspace ?? DEFAULT_MAX_REQUESTS;
    this.maxJournalBytesPerWorkspace = options.maxJournalBytesPerWorkspace ?? DEFAULT_MAX_JOURNAL_BYTES;
    this.now = options.now ?? Date.now;
    this.requestIdFactory = options.requestIdFactory ?? (() => `request:${randomUUID()}` as NetworkRequestId);
    this.ruleIdFactory = options.ruleIdFactory ?? (() => `rule:${randomUUID()}` as NetworkRuleId);
    this.publish = options.publishEvent;
    if (
      !Number.isSafeInteger(this.maxRequestsPerWorkspace) || this.maxRequestsPerWorkspace < 1 ||
      !Number.isSafeInteger(this.maxJournalBytesPerWorkspace) || this.maxJournalBytesPerWorkspace < 1
    ) {
      throw new Error('Invalid Workspace network journal capacity');
    }
    this.installHandlers();
  }

  ownsSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async attachSession(binding: WorkspaceNetworkSession): Promise<void> {
    if (this.sessions.has(binding.sessionId)) {
      throw new BrowserPilotError('internal_error', 'Broker network session is already registered');
    }
    const session: SessionState = { ...binding, fetchEnabled: false };
    this.sessions.set(binding.sessionId, session);
    this.state(binding.workspaceId);
    try {
      await this.transport.send('Network.enable', { maxPostDataSize: MAX_POST_DATA_CHARACTERS }, binding.sessionId);
      await this.syncSession(session);
    } catch (error) {
      this.sessions.delete(binding.sessionId);
      throw error;
    }
  }

  detachSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  releaseWorkspace(workspaceId: BrowserWorkspaceId): void {
    this.workspaces.delete(workspaceId);
  }

  async setAuth(workspaceId: BrowserWorkspaceId, username: string, password: string): Promise<void> {
    if (!username) throw invalidArgument('HTTP auth username must not be empty', 'username');
    await this.mutateFetchConfiguration(workspaceId, state => {
      state.credentials = { username, password };
    });
  }

  async clearAuth(workspaceId: BrowserWorkspaceId): Promise<void> {
    await this.mutateFetchConfiguration(workspaceId, state => {
      state.credentials = undefined;
    });
  }

  async addRule(
    workspaceId: BrowserWorkspaceId,
    input: WorkspaceNetworkRuleInput,
  ): Promise<NetworkRuleId> {
    const pattern = validatePattern(input.pattern);
    let rule: WorkspaceNetworkRule;
    if (input.type === 'block') {
      rule = { id: this.ruleIdFactory(), createdAt: this.now(), type: 'block', pattern };
    } else if (input.type === 'mock') {
      const status = input.status ?? 200;
      if (!Number.isSafeInteger(status) || status < 100 || status > 999) {
        throw invalidArgument('Mock status must be an integer between 100 and 999', 'status');
      }
      const body = input.body ?? '';
      if (body.length > MAX_BODY_CHARACTERS) {
        throw invalidArgument('Mock body exceeds 1000000 characters', 'body');
      }
      rule = {
        id: this.ruleIdFactory(),
        createdAt: this.now(),
        type: 'mock',
        pattern,
        status,
        headers: validateHeaders(input.headers ?? [], false),
        body,
      };
    } else {
      rule = {
        id: this.ruleIdFactory(),
        createdAt: this.now(),
        type: 'headers',
        pattern,
        headers: validateHeaders(input.headers, true),
      };
    }
    const state = this.state(workspaceId);
    const proposedBytes = ruleBytes(rule);
    const workspaceBytes = state.rules.reduce((total, candidate) => total + ruleBytes(candidate), 0);
    const totalBytes = [...this.workspaces.values()].reduce(
      (total, workspace) => total + workspace.rules.reduce(
        (workspaceTotal, candidate) => workspaceTotal + ruleBytes(candidate),
        0,
      ),
      0,
    );
    if (
      state.rules.length >= MAX_RULES_PER_WORKSPACE ||
      workspaceBytes + proposedBytes > MAX_RULE_BYTES_PER_WORKSPACE ||
      totalBytes + proposedBytes > MAX_RULE_BYTES_TOTAL
    ) {
      throw new BrowserPilotError('result_too_large', 'Workspace network rule capacity exceeded', {
        context: {
          workspaceId,
          maxRules: MAX_RULES_PER_WORKSPACE,
          maxWorkspaceRuleBytes: MAX_RULE_BYTES_PER_WORKSPACE,
          maxTotalRuleBytes: MAX_RULE_BYTES_TOTAL,
        },
      });
    }
    await this.mutateFetchConfiguration(workspaceId, state => {
      state.rules.push(rule);
    });
    return rule.id;
  }

  listRules(workspaceId: BrowserWorkspaceId): Record<string, JsonValue>[] {
    return this.state(workspaceId).rules.map(publicRule);
  }

  async removeRules(
    workspaceId: BrowserWorkspaceId,
    options: { ruleId?: NetworkRuleId; all?: boolean },
  ): Promise<number> {
    let removed = 0;
    await this.mutateFetchConfiguration(workspaceId, state => {
      if (options.all) {
        removed = state.rules.length;
        state.rules = [];
        return;
      }
      const index = state.rules.findIndex(rule => rule.id === options.ruleId);
      if (index >= 0) {
        state.rules.splice(index, 1);
        removed = 1;
      }
    });
    return removed;
  }

  listRequests(
    workspaceId: BrowserWorkspaceId,
    filters: WorkspaceNetworkRequestFilters = {},
  ): { requests: Record<string, JsonValue>[]; nextCursor: number; truncated: boolean } {
    const state = this.state(workspaceId);
    const limit = filters.limit ?? 100;
    const after = filters.after ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw invalidArgument('Network request limit must be between 1 and 1000', 'limit');
    }
    if (!Number.isSafeInteger(after) || after < 0 || after >= state.nextSequence) {
      throw invalidArgument('Network cursor is outside this Workspace journal', 'after');
    }
    const statusFilter = this.statusFilter(filters.status);
    const method = filters.method?.toUpperCase();
    const types = filters.type ? new Set(filters.type.map(value => value.toLowerCase())) : undefined;
    const earliest = state.requests[0]?.sequence ?? state.nextSequence;
    const historyGap = after < earliest - 1;
    const matching = state.requests.filter(request => (
      request.sequence > after &&
      (!filters.url || wildcardMatch(request.url, filters.url)) &&
      (!method || request.method === method) &&
      (!statusFilter || statusFilter(request.status)) &&
      (!types || types.has(request.type.toLowerCase()))
    ));
    const selected = matching.slice(0, limit);
    const hasMoreMatches = matching.length > selected.length;
    const nextCursor = hasMoreMatches
      ? selected.at(-1)!.sequence
      : state.nextSequence - 1;
    return {
      requests: selected.map(publicRequestSummary),
      nextCursor,
      truncated: historyGap || hasMoreMatches,
    };
  }

  async request(
    workspaceId: BrowserWorkspaceId,
    requestId: NetworkRequestId,
    includeBody: boolean,
  ): Promise<{
    request: Record<string, JsonValue>;
    body?: string;
    bodyEncoding?: 'utf8' | 'base64';
    mimeType?: string;
    bodyTruncated: boolean;
  }> {
    const record = this.state(workspaceId).requestsById.get(requestId);
    if (!record) throw invalidArgument('Network request was not found in this Workspace', 'requestId');
    const base = { request: publicRequest(record), bodyTruncated: false };
    if (!includeBody || !record.bodyAvailable) return base;
    try {
      const result = await this.transport.send(
        'Network.getResponseBody',
        { requestId: record.networkId },
        record.sessionId,
      );
      if (typeof result?.body !== 'string') return base;
      const truncated = result.body.length > MAX_BODY_CHARACTERS;
      return {
        ...base,
        body: result.body.slice(0, MAX_BODY_CHARACTERS),
        bodyEncoding: result.base64Encoded === true ? 'base64' : 'utf8',
        ...(record.mimeType ? { mimeType: record.mimeType } : {}),
        bodyTruncated: truncated,
      };
    } catch {
      return base;
    }
  }

  clearRequests(workspaceId: BrowserWorkspaceId): void {
    const state = this.state(workspaceId);
    state.requests = [];
    state.requestsById.clear();
    state.requestsByNetworkKey.clear();
    state.nextSequence = 1;
    state.requestBytes = 0;
  }

  private state(workspaceId: BrowserWorkspaceId): WorkspaceNetworkState {
    let state = this.workspaces.get(workspaceId);
    if (!state) {
      state = {
        rules: [],
        requests: [],
        requestsById: new Map(),
        requestsByNetworkKey: new Map(),
        nextSequence: 1,
        revision: 0,
        requestBytes: 0,
      };
      this.workspaces.set(workspaceId, state);
    }
    return state;
  }

  private async mutateFetchConfiguration(
    workspaceId: BrowserWorkspaceId,
    mutate: (state: WorkspaceNetworkState) => void,
  ): Promise<void> {
    const state = this.state(workspaceId);
    const credentials = state.credentials ? { ...state.credentials } : undefined;
    const rules = [...state.rules];
    mutate(state);
    state.revision += 1;
    try {
      await this.syncWorkspace(workspaceId);
    } catch (error) {
      state.credentials = credentials;
      state.rules = rules;
      state.revision += 1;
      await this.syncWorkspace(workspaceId).catch(() => {});
      throw error;
    }
  }

  private async syncWorkspace(workspaceId: BrowserWorkspaceId): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.workspaceId === workspaceId) await this.syncSession(session);
    }
  }

  private async syncSession(session: SessionState): Promise<void> {
    while (this.sessions.get(session.sessionId) === session) {
      const state = this.workspaces.get(session.workspaceId);
      const revision = state?.revision ?? -1;
      const enabled = !!state && (state.credentials !== undefined || state.rules.length > 0);
      if (enabled) {
        await this.transport.send('Fetch.enable', {
          ...(state!.rules.length > 0 ? { patterns: [{ urlPattern: '*' }] } : {}),
          handleAuthRequests: state!.credentials !== undefined,
        }, session.sessionId);
      } else if (session.fetchEnabled) {
        await this.transport.send('Fetch.disable', {}, session.sessionId);
      }
      if (this.sessions.get(session.sessionId) !== session) return;
      session.fetchEnabled = enabled;
      if ((this.workspaces.get(session.workspaceId)?.revision ?? -1) === revision) return;
    }
  }

  private installHandlers(): void {
    this.transport.on?.('Fetch.authRequired', (params: any, sessionId?: string) => {
      if (!sessionId || !this.sessions.has(sessionId)) return;
      void this.handleAuthRequired(params, sessionId);
    });
    this.transport.on?.('Fetch.requestPaused', (params: any, sessionId?: string) => {
      if (!sessionId || !this.sessions.has(sessionId)) return;
      void this.handleRequestPaused(params, sessionId);
    });
    this.transport.on?.('Network.requestWillBeSent', (params: any, sessionId?: string) => {
      if (!sessionId) return;
      this.trackRequest(params, sessionId);
    });
    this.transport.on?.('Network.responseReceived', (params: any, sessionId?: string) => {
      if (!sessionId) return;
      this.trackResponse(params, sessionId);
    });
    this.transport.on?.('Network.loadingFinished', (params: any, sessionId?: string) => {
      if (!sessionId) return;
      const record = this.findNetworkRequest(sessionId, params?.requestId);
      if (!record) return;
      record.size = Math.max(0, Math.trunc(Number(params?.encodedDataLength) || 0));
      record.endedAt = this.now();
      record.bodyAvailable = true;
      this.refreshRequestSize(record);
    });
    this.transport.on?.('Network.loadingFailed', (params: any, sessionId?: string) => {
      if (!sessionId) return;
      const record = this.findNetworkRequest(sessionId, params?.requestId);
      if (!record) return;
      record.error = boundedString(params?.errorText, 4096);
      record.endedAt = this.now();
      this.refreshRequestSize(record);
    });
  }

  private async handleAuthRequired(params: any, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const credentials = this.workspaces.get(session.workspaceId)?.credentials;
    const response = credentials
      ? { response: 'ProvideCredentials', username: credentials.username, password: credentials.password }
      : { response: 'CancelAuth' };
    await this.transport.send('Fetch.continueWithAuth', {
      requestId: params?.requestId,
      authChallengeResponse: response,
    }, sessionId).catch(() => {});
  }

  private async handleRequestPaused(params: any, sessionId: string): Promise<void> {
    try {
      const session = this.sessions.get(sessionId);
      const rules = session ? this.workspaces.get(session.workspaceId)?.rules ?? [] : [];
      const url = typeof params?.request?.url === 'string' ? params.request.url : '';
      for (const rule of rules) {
        if (!wildcardMatch(url, rule.pattern)) continue;
        if (rule.type === 'block') {
          await this.transport.send('Fetch.failRequest', {
            requestId: params.requestId,
            reason: 'BlockedByClient',
          }, sessionId);
          return;
        }
        if (rule.type === 'mock') {
          await this.transport.send('Fetch.fulfillRequest', {
            requestId: params.requestId,
            responseCode: rule.status ?? 200,
            responseHeaders: rule.headers ?? [],
            body: Buffer.from(rule.body ?? '', 'utf8').toString('base64'),
          }, sessionId);
          return;
        }
        const existing = headersFromCdp(params?.request?.headers);
        const replacements = new Set(rule.headers.map(header => header.name.toLowerCase()));
        await this.transport.send('Fetch.continueRequest', {
          requestId: params.requestId,
          headers: [
            ...existing.filter(header => !replacements.has(header.name.toLowerCase())),
            ...rule.headers,
          ],
        }, sessionId);
        return;
      }
      await this.transport.send('Fetch.continueRequest', { requestId: params?.requestId }, sessionId);
    } catch {
      await this.transport.send('Fetch.continueRequest', { requestId: params?.requestId }, sessionId).catch(() => {});
    }
  }

  private trackRequest(params: any, sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || typeof params?.requestId !== 'string') return;
    const state = this.workspaces.get(session.workspaceId);
    if (!state) return;
    const key = networkKey(sessionId, params.requestId);
    const redirected = state.requestsByNetworkKey.get(key);
    if (redirected && params.redirectResponse) {
      this.applyResponse(redirected, params.redirectResponse);
      redirected.endedAt = this.now();
      this.refreshRequestSize(redirected);
      this.publishResponse(redirected);
    }
    const rawPostData = typeof params?.request?.postData === 'string' ? params.request.postData : undefined;
    const record: NetworkRequestRecord = {
      id: this.requestIdFactory(),
      sequence: state.nextSequence++,
      workspaceId: session.workspaceId,
      leaseId: session.leaseId,
      targetId: session.targetId,
      browserConnectionGeneration: session.browserConnectionGeneration,
      sessionId,
      networkId: params.requestId,
      method: boundedString(params?.request?.method, 32).toUpperCase(),
      url: boundedString(params?.request?.url, MAX_URL_CHARACTERS),
      type: boundedString(params?.type || 'Other', 128),
      requestHeaders: headersFromCdp(params?.request?.headers),
      ...(rawPostData !== undefined ? { postData: rawPostData.slice(0, MAX_POST_DATA_CHARACTERS) } : {}),
      postDataTruncated: rawPostData !== undefined && rawPostData.length > MAX_POST_DATA_CHARACTERS,
      startedAt: this.now(),
      bodyAvailable: false,
      retainedByteSize: 0,
    };
    record.retainedByteSize = Buffer.byteLength(JSON.stringify(publicRequest(record)), 'utf8');
    state.requests.push(record);
    state.requestBytes += record.retainedByteSize;
    state.requestsById.set(record.id, record);
    state.requestsByNetworkKey.set(key, record);
    this.compactRequests(state);
    this.safePublish({
      workspaceId: record.workspaceId,
      leaseId: record.leaseId,
      targetId: record.targetId,
      browserConnectionGeneration: record.browserConnectionGeneration,
      type: 'network.request',
      sensitivity: 'browser_data',
      payload: {
        requestId: record.id,
        method: record.method,
        url: sanitizedEventUrl(record.url),
        type: record.type,
      },
    });
  }

  private trackResponse(params: any, sessionId: string): void {
    const record = this.findNetworkRequest(sessionId, params?.requestId);
    if (!record) return;
    this.applyResponse(record, params?.response);
    this.refreshRequestSize(record);
    this.publishResponse(record);
  }

  private applyResponse(record: NetworkRequestRecord, response: any): void {
    record.status = validStatus(response?.status);
    record.statusText = boundedString(response?.statusText, 4096);
    record.responseHeaders = headersFromCdp(response?.headers);
    record.mimeType = boundedString(response?.mimeType, 256);
  }

  private publishResponse(record: NetworkRequestRecord): void {
    const hint = accessBlockedAgentHint(record.type, record.status);
    this.safePublish({
      workspaceId: record.workspaceId,
      leaseId: record.leaseId,
      targetId: record.targetId,
      browserConnectionGeneration: record.browserConnectionGeneration,
      type: 'network.response',
      sensitivity: 'browser_data',
      payload: {
        requestId: record.id,
        method: record.method,
        url: sanitizedEventUrl(record.url),
        type: record.type,
        ...(record.status !== undefined ? { status: record.status } : {}),
        ...(hint ? { hints: [hint] } : {}),
      },
    });
  }

  private findNetworkRequest(sessionId: string, requestId: unknown): NetworkRequestRecord | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || typeof requestId !== 'string') return undefined;
    return this.workspaces.get(session.workspaceId)?.requestsByNetworkKey.get(networkKey(sessionId, requestId));
  }

  private refreshRequestSize(record: NetworkRequestRecord): void {
    const state = this.workspaces.get(record.workspaceId);
    if (!state || state.requestsById.get(record.id) !== record) return;
    const nextSize = Buffer.byteLength(JSON.stringify(publicRequest(record)), 'utf8');
    state.requestBytes += nextSize - record.retainedByteSize;
    record.retainedByteSize = nextSize;
    this.compactRequests(state);
  }

  private compactRequests(state: WorkspaceNetworkState): void {
    while (
      state.requests.length > this.maxRequestsPerWorkspace ||
      state.requestBytes > this.maxJournalBytesPerWorkspace
    ) {
      const removed = state.requests.shift();
      if (!removed) break;
      state.requestBytes = Math.max(0, state.requestBytes - removed.retainedByteSize);
      state.requestsById.delete(removed.id);
      const removedKey = networkKey(removed.sessionId, removed.networkId);
      if (state.requestsByNetworkKey.get(removedKey) === removed) {
        state.requestsByNetworkKey.delete(removedKey);
      }
    }
  }

  private statusFilter(value: string | undefined): ((status: number | undefined) => boolean) | undefined {
    if (!value) return undefined;
    if (/^[1-9]xx$/i.test(value)) {
      const hundred = Number(value[0]);
      return status => status !== undefined && Math.floor(status / 100) === hundred;
    }
    if (/^[1-9][0-9]{2}$/.test(value)) {
      const exact = Number(value);
      return status => status === exact;
    }
    throw invalidArgument('Network status filter must be an exact status or a pattern such as 2xx', 'status');
  }

  private safePublish(event: PublishBrowserEventInput): void {
    try { this.publish?.(event); } catch { /* event delivery cannot affect browser traffic */ }
  }
}
