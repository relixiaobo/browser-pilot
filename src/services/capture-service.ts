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
  scale?: number;
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

function pngDimensions(bytes: Uint8Array): Pick<Rect, 'width' | 'height'> | undefined {
  if (bytes.byteLength < 24) return undefined;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47 ||
    buffer.toString('ascii', 12, 16) !== 'IHDR'
  ) return undefined;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function parseViewport(value: unknown): Rect {
  if (typeof value !== 'object' || value === null) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid viewport metrics');
  }
  const metrics = value as Record<string, unknown>;
  const viewport = (metrics.cssVisualViewport ?? metrics.cssLayoutViewport) as Record<string, unknown> | undefined;
  if (!viewport) throw new BrowserPilotError('internal_error', 'Chrome returned invalid viewport metrics');
  const x = viewport.pageX ?? 0;
  const y = viewport.pageY ?? 0;
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  if (![x, y, width, height].every(Number.isFinite) || Number(width) <= 0 || Number(height) <= 0) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid viewport metrics');
  }
  return { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
}

export class CaptureService {
  constructor(
    private readonly transport: Transport,
    private readonly sessionId: string,
  ) {}

  async screenshot(options: ScreenshotOptions = {}): Promise<BrowserMedia> {
    const params: Record<string, unknown> = { format: 'png' };
    const scale = options.scale ?? 1;
    if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
      throw invalidArgument('Screenshot scale must be greater than 0 and no more than 1', 'scale');
    }
    let captureRect: Rect | undefined;

    if (options.fullPage) {
      const { result } = await this.transport.send('Runtime.evaluate', {
        expression: PAGE_DIMENSIONS,
        returnByValue: true,
      }, this.sessionId);
      const fullRect = parseRect(result.value, 'full page', true);
      params.captureBeyondViewport = true;
      captureRect = fullRect;
      params.clip = { ...fullRect, scale };
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
      captureRect = rect;
      params.clip = { ...rect, scale };
    }

    if (scale < 1 && !captureRect) {
      captureRect = parseViewport(await this.transport.send('Page.getLayoutMetrics', {}, this.sessionId));
      params.clip = { ...captureRect, scale };
    }

    const { data } = await this.transport.send('Page.captureScreenshot', params, this.sessionId);
    const bytes = decodeMedia(data, 'screenshot');
    const dimensions = pngDimensions(bytes) ?? (captureRect ? {
      width: Math.max(1, Math.round(captureRect.width * scale)),
      height: Math.max(1, Math.round(captureRect.height * scale)),
    } : undefined);
    return {
      bytes,
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
