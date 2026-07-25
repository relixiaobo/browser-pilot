import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import type { Transport } from '../transport.js';

export interface PageFrame {
  id: string;
  parentId?: string;
  loaderId?: string;
  url: string;
  name: string;
}

export interface SessionPageFrame extends PageFrame {
  sessionId: string;
  cdpTargetId: string;
}

export interface FrameTargetInfo {
  targetId: string;
  type: 'iframe';
  url: string;
  title: string;
  parentFrameId: string;
}

export interface FrameTargetAttachment {
  targetId: string;
  sessionId: string;
}

export interface FrameTraversalOptions {
  rootTargetId: string;
  attachment(targetId: string): FrameTargetAttachment | undefined;
  attach(target: FrameTargetInfo): Promise<FrameTargetAttachment>;
}

export interface FrameTraversalResult {
  frames: SessionPageFrame[];
  attachedTargetIds: string[];
}

export interface FrameSelection {
  index: number;
  frame: PageFrame;
  executionContextId?: number;
}

function collectFrames(node: any, frames: PageFrame[], parentId?: string): void {
  if (!node?.frame || typeof node.frame.id !== 'string') {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid frame metadata');
  }
  frames.push({
    id: node.frame.id,
    ...(parentId ? { parentId } : {}),
    ...(typeof node.frame.loaderId === 'string' ? { loaderId: node.frame.loaderId } : {}),
    url: typeof node.frame.url === 'string' ? node.frame.url : '',
    name: typeof node.frame.name === 'string' ? node.frame.name : '',
  });
  if (node.childFrames !== undefined && !Array.isArray(node.childFrames)) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid child frame metadata');
  }
  for (const child of node.childFrames ?? []) collectFrames(child, frames, node.frame.id);
}

function frameTargetInfo(value: unknown): FrameTargetInfo | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const target = value as Record<string, unknown>;
  if (
    target.type !== 'iframe' ||
    typeof target.targetId !== 'string' || !target.targetId ||
    typeof target.url !== 'string'
  ) return undefined;
  const parentFrameId = typeof target.parentFrameId === 'string' && target.parentFrameId
    ? target.parentFrameId
    : typeof target.parentId === 'string' && target.parentId
      ? target.parentId
      : undefined;
  if (!parentFrameId) return undefined;
  return {
    targetId: target.targetId,
    type: 'iframe',
    url: target.url,
    title: typeof target.title === 'string' ? target.title : '',
    parentFrameId,
  };
}

function compareTargets(left: FrameTargetInfo, right: FrameTargetInfo): number {
  return left.parentFrameId.localeCompare(right.parentFrameId) ||
    left.url.localeCompare(right.url) ||
    left.targetId.localeCompare(right.targetId);
}

function orderFrames(frames: SessionPageFrame[], topFrameId: string): SessionPageFrame[] {
  const byId = new Map(frames.map(frame => [frame.id, frame]));
  const children = new Map<string, SessionPageFrame[]>();
  for (const frame of frames) {
    if (!frame.parentId) continue;
    const siblings = children.get(frame.parentId) ?? [];
    siblings.push(frame);
    children.set(frame.parentId, siblings);
  }
  const ordered: SessionPageFrame[] = [];
  const visited = new Set<string>();
  const visit = (frame: SessionPageFrame): void => {
    if (visited.has(frame.id)) return;
    visited.add(frame.id);
    ordered.push(frame);
    for (const child of children.get(frame.id) ?? []) visit(child);
  };
  const top = byId.get(topFrameId);
  if (top) visit(top);
  return ordered;
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

  async listAcrossTargets(options: FrameTraversalOptions): Promise<FrameTraversalResult> {
    const rootFrames = await this.list();
    if (rootFrames.length === 0) {
      throw new BrowserPilotError('internal_error', 'Chrome returned an empty frame tree');
    }
    const frames: SessionPageFrame[] = rootFrames.map(frame => ({
      ...frame,
      sessionId: this.sessionId,
      cdpTargetId: options.rootTargetId,
    }));
    const knownFrameIds = new Set(frames.map(frame => frame.id));
    const seenFrameIds = new Set(knownFrameIds);
    const attachedTargetIds: string[] = [];
    const targetsResponse = await this.transport.send('Target.getTargets');
    const targetInfos: unknown[] = Array.isArray(targetsResponse?.targetInfos)
      ? targetsResponse.targetInfos
      : [];
    const remaining = targetInfos
      .map(frameTargetInfo)
      .filter((target): target is FrameTargetInfo => target !== undefined)
      .sort(compareTargets);

    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let index = 0; index < remaining.length;) {
        const target = remaining[index];
        if (!knownFrameIds.has(target.parentFrameId)) {
          index += 1;
          continue;
        }
        remaining.splice(index, 1);
        const attachment = options.attachment(target.targetId) ?? await options.attach(target);
        const childFrames = await new FrameService(this.transport, attachment.sessionId).list();
        if (childFrames.length === 0 || childFrames[0].id !== target.targetId) {
          throw new BrowserPilotError('internal_error', 'Chrome returned an inconsistent iframe target tree');
        }
        attachedTargetIds.push(target.targetId);
        for (let childIndex = 0; childIndex < childFrames.length; childIndex += 1) {
          const child = childFrames[childIndex];
          knownFrameIds.add(child.id);
          if (seenFrameIds.has(child.id)) continue;
          seenFrameIds.add(child.id);
          frames.push({
            ...child,
            ...(childIndex === 0 && !child.parentId ? { parentId: target.parentFrameId } : {}),
            sessionId: attachment.sessionId,
            cdpTargetId: target.targetId,
          });
        }
        progressed = true;
      }
    }

    return {
      frames: orderFrames(frames, rootFrames[0].id),
      attachedTargetIds,
    };
  }

  async select(index: number): Promise<FrameSelection> {
    const frames = await this.list();
    if (!Number.isSafeInteger(index) || index < 0 || index >= frames.length) {
      throw invalidArgument(`Frame index out of range (0-${frames.length - 1})`, 'index');
    }
    return this.selectFrame(frames[index], index, frames[0].id);
  }

  async selectById(frameId: string): Promise<FrameSelection> {
    const frames = await this.list();
    const index = frames.findIndex(frame => frame.id === frameId);
    if (index < 0) throw invalidArgument('Frame is no longer attached to this target', 'frameId');
    return this.selectFrame(frames[index], index, frames[0].id);
  }

  private async selectFrame(frame: PageFrame, index: number, topFrameId: string): Promise<FrameSelection> {
    if (frame.id === topFrameId) return { index, frame };
    const { executionContextId } = await this.transport.send('Page.createIsolatedWorld', {
      frameId: frame.id,
    }, this.sessionId);
    if (!Number.isSafeInteger(executionContextId)) {
      throw new BrowserPilotError('internal_error', 'Chrome returned invalid frame execution context');
    }
    return { index, frame, executionContextId };
  }
}
