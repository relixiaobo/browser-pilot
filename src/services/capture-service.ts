import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import { PAGE_DIMENSIONS, elementRect } from '../page-scripts.js';
import type { Transport } from '../transport.js';

export interface BrowserMedia {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'application/pdf';
  width?: number;
  height?: number;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  selector?: string;
}

export interface PdfOptions {
  landscape?: boolean;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function parseRect(value: unknown, source: string, defaultOrigin = false): Rect {
  if (typeof value !== 'string') {
    throw new BrowserPilotError('internal_error', `Chrome returned invalid ${source} dimensions`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new BrowserPilotError('internal_error', `Chrome returned invalid ${source} dimensions`, { cause });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BrowserPilotError('internal_error', `Chrome returned invalid ${source} dimensions`);
  }
  const candidate = parsed as Record<string, unknown>;
  const required = defaultOrigin ? ['width', 'height'] : ['x', 'y', 'width', 'height'];
  if (!required.every(key => Number.isFinite(candidate[key]))) {
    throw new BrowserPilotError('internal_error', `Chrome returned invalid ${source} dimensions`);
  }
  const rect: Rect = {
    x: defaultOrigin ? 0 : candidate.x as number,
    y: defaultOrigin ? 0 : candidate.y as number,
    width: candidate.width as number,
    height: candidate.height as number,
  };
  if (rect.width <= 0 || rect.height <= 0) {
    throw invalidArgument(`${source} has no capturable area`);
  }
  return rect;
}

function decodeMedia(data: unknown, operation: string): Uint8Array {
  if (typeof data !== 'string' || data.length === 0) {
    throw new BrowserPilotError('internal_error', `Chrome returned empty ${operation} data`);
  }
  return Buffer.from(data, 'base64');
}

export class CaptureService {
  constructor(
    private readonly transport: Transport,
    private readonly sessionId: string,
  ) {}

  async screenshot(options: ScreenshotOptions = {}): Promise<BrowserMedia> {
    const params: Record<string, unknown> = { format: 'png' };
    let dimensions: Pick<Rect, 'width' | 'height'> | undefined;

    if (options.fullPage) {
      const { result } = await this.transport.send('Runtime.evaluate', {
        expression: PAGE_DIMENSIONS,
        returnByValue: true,
      }, this.sessionId);
      const fullRect = parseRect(result.value, 'full page', true);
      params.captureBeyondViewport = true;
      params.clip = { ...fullRect, scale: 1 };
      dimensions = { width: fullRect.width, height: fullRect.height };
    }

    if (options.selector) {
      const { result } = await this.transport.send('Runtime.evaluate', {
        expression: elementRect(options.selector),
        returnByValue: true,
      }, this.sessionId);
      if (!result.value || result.value === 'null') {
        throw invalidArgument(`Element not found: ${options.selector}`, 'selector');
      }
      const rect = parseRect(result.value, 'selected element');
      params.clip = { ...rect, scale: 1 };
      dimensions = { width: rect.width, height: rect.height };
    }

    const { data } = await this.transport.send('Page.captureScreenshot', params, this.sessionId);
    return {
      bytes: decodeMedia(data, 'screenshot'),
      mimeType: 'image/png',
      ...dimensions,
    };
  }

  async pdf(options: PdfOptions = {}): Promise<BrowserMedia> {
    const params: Record<string, unknown> = {};
    if (options.landscape) params.landscape = true;
    const { data } = await this.transport.send('Page.printToPDF', params, this.sessionId);
    return {
      bytes: decodeMedia(data, 'PDF'),
      mimeType: 'application/pdf',
    };
  }
}
