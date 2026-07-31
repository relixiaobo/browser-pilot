import { timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import { BROKER_RPC_VERSION, ENDPOINT_CREDENTIAL_CHANGED_REASON } from './client.js';
import { BrowserPilotError, asBrowserPilotError, invalidArgument } from './protocol/errors.js';
import type { JsonValue } from './protocol/model.js';
import {
  DEFAULT_PROTOCOL_LIMITS,
  type MemoryBrokerRuntime,
} from './services/broker-runtime.js';

interface RouteResponse {
  status: number;
  body: unknown;
  afterSend?: () => void;
}

interface Route {
  authenticated: boolean;
  errorStatus: number;
  handle(request: http.IncomingMessage): Promise<RouteResponse>;
}

export interface HttpApiOptions {
  daemonToken: string;
  broker: MemoryBrokerRuntime;
  health(): Record<string, unknown>;
  isShuttingDown(): boolean;
  authorizeShutdown(body: Record<string, unknown>): void;
  terminate(): void;
}

export class HttpApi {
  private readonly routes: Map<string, Route>;

  constructor(private readonly options: HttpApiOptions) {
    this.routes = new Map<string, Route>([
      ['GET /health', {
        authenticated: false,
        errorStatus: 500,
        handle: async () => ({ status: 200, body: this.options.health() }),
      }],
      ['POST /broker/rpc', {
        authenticated: true,
        errorStatus: 200,
        handle: request => this.brokerRpc(request),
      }],
      ['POST /shutdown', {
        authenticated: true,
        errorStatus: 200,
        handle: request => this.shutdown(request),
      }],
    ]);
  }

  readonly handle = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> => {
    response.setHeader('Content-Type', 'application/json');
    let url: URL;
    try {
      url = new URL(request.url || '/', 'http://localhost');
    } catch (error) {
      this.sendError(
        response,
        400,
        new BrowserPilotError('invalid_argument', 'Invalid URL', { cause: error }),
      );
      return;
    }

    const route = this.routes.get(`${request.method ?? ''} ${url.pathname}`);
    if ((route?.authenticated ?? true) && !this.endpointAuthorized(request)) {
      this.sendError(response, 401, endpointAuthenticationError());
      return;
    }
    if (!route) {
      this.sendError(
        response,
        404,
        new BrowserPilotError('invalid_argument', 'Not found', {
          context: { method: request.method ?? null, path: url.pathname },
        }),
      );
      return;
    }

    try {
      const result = await route.handle(request);
      this.sendJson(response, result.status, result.body);
      result.afterSend?.();
    } catch (error) {
      this.sendError(response, route.errorStatus, error);
    }
  };

  private async brokerRpc(request: http.IncomingMessage): Promise<RouteResponse> {
    if (this.options.isShuttingDown()) {
      throw new BrowserPilotError('browser_disconnected', 'Browser Pilot Broker is shutting down', {
        retryable: true,
      });
    }
    const body: unknown = JSON.parse(await readBody(
      request,
      DEFAULT_PROTOCOL_LIMITS.maxMessageBytes + 4096,
    ));
    if (!isRecord(body)) throw invalidArgument('Broker RPC body must be an object', 'body');
    if (typeof body.clientSessionId !== 'string') {
      throw invalidArgument('clientSessionId is required', 'clientSessionId');
    }
    if (typeof body.method !== 'string' || body.method.length === 0 || body.method.length > 256) {
      throw invalidArgument('method is required', 'method');
    }
    const result = await this.options.broker.call(
      body.clientSessionId,
      body.method,
      body.params as JsonValue | undefined,
    );
    return { status: 200, body: { result } };
  }

  private async shutdown(request: http.IncomingMessage): Promise<RouteResponse> {
    if (this.options.isShuttingDown()) {
      throw new BrowserPilotError('browser_disconnected', 'Browser Pilot Broker is already shutting down', {
        retryable: true,
      });
    }
    const body: unknown = JSON.parse(await readBody(request, 4096));
    if (!isRecord(body)) {
      throw invalidArgument(
        'brokerProcessIdentity, executableVersion, and executableIdentity are required',
      );
    }
    this.options.authorizeShutdown(body);
    return {
      status: 200,
      body: { ok: true },
      afterSend: () => { setTimeout(this.options.terminate, 50); },
    };
  }

  private endpointAuthorized(request: http.IncomingMessage): boolean {
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string') return false;
    const actual = Buffer.from(authorization);
    const expected = Buffer.from(`Bearer ${this.options.daemonToken}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private sendError(response: http.ServerResponse, status: number, error: unknown): void {
    this.sendJson(response, status, {
      error: asBrowserPilotError(error).toJsonRpcError(),
    });
  }

  private sendJson(response: http.ServerResponse, status: number, body: unknown): void {
    response.writeHead(status);
    response.end(JSON.stringify(body));
  }
}

function endpointAuthenticationError(): BrowserPilotError {
  return new BrowserPilotError(
    'protocol_incompatible',
    'Browser Pilot Broker endpoint authentication failed; upgrade the client or reload its locator',
    {
      retryable: true,
      context: {
        reason: ENDPOINT_CREDENTIAL_CHANGED_REASON,
        requiredBrokerRpcVersion: BROKER_RPC_VERSION,
      },
      remediation: {
        code: 'upgrade_or_reload_broker_client',
        message: 'Upgrade Browser Pilot, or reload the current Broker locator before initializing a new client session.',
        actionRequired: true,
      },
    },
  );
}

function readBody(request: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    request.on('data', (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      byteLength += chunk.length;
      if (byteLength > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
