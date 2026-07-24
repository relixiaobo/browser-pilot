import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import { readContent } from '../page-scripts.js';
import type { Transport } from '../transport.js';

export interface PageReadResult {
  title: string;
  url: string;
  text: string;
  length: number;
  truncated: boolean;
}

export interface PageContextOptions {
  executionContextId?: number;
}

function evaluationError(exceptionDetails: any, fallback: string): BrowserPilotError {
  return invalidArgument(
    exceptionDetails?.exception?.description || exceptionDetails?.text || fallback,
    'expression',
  );
}

export class PageContentService {
  constructor(
    private readonly transport: Transport,
    private readonly sessionId: string,
  ) {}

  async evaluate(expression: string, options: PageContextOptions = {}): Promise<unknown> {
    if (!expression) throw invalidArgument('Expression must not be empty', 'expression');
    const params: Record<string, unknown> = {
      expression,
      returnByValue: true,
      awaitPromise: true,
    };
    if (options.executionContextId) params.contextId = options.executionContextId;
    const { result, exceptionDetails } = await this.transport.send(
      'Runtime.evaluate',
      params,
      this.sessionId,
    );
    if (exceptionDetails) throw evaluationError(exceptionDetails, 'Evaluation error');
    return result?.value ?? result?.unserializableValue;
  }

  async read(
    selector: string | undefined,
    limit: number,
    options: PageContextOptions = {},
  ): Promise<PageReadResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) {
      throw invalidArgument('Read limit must be an integer between 1 and 1000000', 'limit');
    }
    const params: Record<string, unknown> = {
      expression: readContent(selector || null, limit),
      returnByValue: true,
    };
    if (options.executionContextId) params.contextId = options.executionContextId;
    const { result, exceptionDetails } = await this.transport.send(
      'Runtime.evaluate',
      params,
      this.sessionId,
    );
    if (exceptionDetails) throw evaluationError(exceptionDetails, 'Read error');
    if (typeof result?.value !== 'string') {
      throw new BrowserPilotError('internal_error', 'Chrome returned invalid page content');
    }

    let data: unknown;
    try {
      data = JSON.parse(result.value);
    } catch (cause) {
      throw new BrowserPilotError('internal_error', 'Chrome returned invalid page content', { cause });
    }
    if (typeof data !== 'object' || data === null) {
      throw new BrowserPilotError('internal_error', 'Chrome returned invalid page content');
    }
    const record = data as Record<string, unknown>;
    if (record.ok !== true) {
      throw invalidArgument(
        typeof record.error === 'string' ? record.error : 'Failed to read page content',
        selector ? 'selector' : undefined,
      );
    }
    if (
      typeof record.title !== 'string' || typeof record.url !== 'string' ||
      typeof record.text !== 'string' || !Number.isSafeInteger(record.length) ||
      typeof record.truncated !== 'boolean'
    ) {
      throw new BrowserPilotError('internal_error', 'Chrome returned invalid page content');
    }
    return {
      title: record.title,
      url: record.url,
      text: record.text,
      length: record.length as number,
      truncated: record.truncated,
    };
  }
}
