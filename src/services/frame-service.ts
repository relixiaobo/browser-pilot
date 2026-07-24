import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import type { Transport } from '../transport.js';

export interface PageFrame {
  id: string;
  url: string;
  name: string;
}

export interface FrameSelection {
  index: number;
  frame: PageFrame;
  executionContextId?: number;
}

function collectFrames(node: any, frames: PageFrame[]): void {
  if (!node?.frame || typeof node.frame.id !== 'string') {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid frame metadata');
  }
  frames.push({
    id: node.frame.id,
    url: typeof node.frame.url === 'string' ? node.frame.url : '',
    name: typeof node.frame.name === 'string' ? node.frame.name : '',
  });
  if (node.childFrames !== undefined && !Array.isArray(node.childFrames)) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid child frame metadata');
  }
  for (const child of node.childFrames ?? []) collectFrames(child, frames);
}

export class FrameService {
  constructor(
    private readonly transport: Transport,
    private readonly sessionId: string,
  ) {}

  async list(): Promise<PageFrame[]> {
    const { frameTree } = await this.transport.send('Page.getFrameTree', {}, this.sessionId);
    const frames: PageFrame[] = [];
    collectFrames(frameTree, frames);
    return frames;
  }

  async select(index: number): Promise<FrameSelection> {
    const frames = await this.list();
    if (!Number.isSafeInteger(index) || index < 0 || index >= frames.length) {
      throw invalidArgument(`Frame index out of range (0-${frames.length - 1})`, 'index');
    }
    if (index === 0) return { index, frame: frames[index] };
    const { executionContextId } = await this.transport.send('Page.createIsolatedWorld', {
      frameId: frames[index].id,
    }, this.sessionId);
    if (!Number.isSafeInteger(executionContextId)) {
      throw new BrowserPilotError('internal_error', 'Chrome returned invalid frame execution context');
    }
    return { index, frame: frames[index], executionContextId };
  }
}
