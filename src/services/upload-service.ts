import { basename } from 'node:path';
import { READ_FILE_INPUT_STATE } from '../page-scripts.js';
import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import type { SnapshotResult } from '../snapshot.js';
import type { Transport } from '../transport.js';

export interface UploadInputInfo {
  index: number;
  name: string;
  accept: string;
}

export interface UploadOptions {
  inputIndex?: number;
  observationLimit?: number;
  backendNodeId?: number;
  executionContextId?: number;
}

export interface UploadObservationService {
  observeAfterAction(limit?: number): Promise<SnapshotResult>;
}

export interface UploadVerificationEvidence {
  action: 'upload';
  status: 'verified' | 'mismatch' | 'unavailable';
  expectedFileCount: 1;
  fileCount?: number;
  nameMatched?: boolean;
  reason?: 'target_unavailable' | 'file_count_mismatch' | 'file_name_mismatch';
}

export interface UploadActionResult {
  observation: SnapshotResult;
  evidence: UploadVerificationEvidence;
}

export interface UploadServiceOptions {
  readbackDelayMs?: number;
}

type FileInputBlockReason = 'detached' | 'disabled' | 'inert' | 'wrong_type';

type FileInputState =
  | { status: 'ready'; fileCount: number; firstFileName?: string }
  | { status: 'blocked'; reason: FileInputBlockReason };

const FILE_INPUT_BLOCK_REASONS = new Set<FileInputBlockReason>([
  'detached',
  'disabled',
  'inert',
  'wrong_type',
]);

function parseInputs(value: unknown): UploadInputInfo[] {
  if (typeof value !== 'string') {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid file input metadata');
  }
  let inputs: unknown;
  try {
    inputs = JSON.parse(value);
  } catch (cause) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid file input metadata', { cause });
  }
  if (!Array.isArray(inputs) || inputs.some(input => (
    typeof input !== 'object' || input === null ||
    !Number.isSafeInteger((input as Record<string, unknown>).index) ||
    typeof (input as Record<string, unknown>).name !== 'string' ||
    typeof (input as Record<string, unknown>).accept !== 'string'
  ))) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid file input metadata');
  }
  return inputs as UploadInputInfo[];
}

function parseFileInputState(value: unknown): FileInputState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid file input state');
  }
  const record = value as Record<string, unknown>;
  if (record.status === 'blocked' && FILE_INPUT_BLOCK_REASONS.has(record.reason as FileInputBlockReason)) {
    return { status: 'blocked', reason: record.reason as FileInputBlockReason };
  }
  if (
    record.status !== 'ready' || !Number.isSafeInteger(record.fileCount) || Number(record.fileCount) < 0 ||
    (record.firstFileName !== undefined && (
      typeof record.firstFileName !== 'string' || record.firstFileName.length > 4096
    ))
  ) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid file input state');
  }
  return {
    status: 'ready',
    fileCount: Number(record.fileCount),
    ...(record.firstFileName !== undefined ? { firstFileName: record.firstFileName } : {}),
  };
}

export class UploadService {
  private readonly readbackDelayMs: number;

  constructor(
    private readonly transport: Transport,
    private readonly sessionId: string,
    private readonly observations: UploadObservationService,
    options: UploadServiceOptions = {},
  ) {
    this.readbackDelayMs = options.readbackDelayMs ?? 50;
  }

  async upload(filePath: string, options: UploadOptions = {}): Promise<UploadActionResult> {
    if (!filePath) throw invalidArgument('Upload path must not be empty', 'filePath');
    const inputIndex = options.inputIndex ?? 1;
    if (!Number.isSafeInteger(inputIndex) || inputIndex < 1) {
      throw invalidArgument('inputIndex must be a positive integer', 'inputIndex');
    }

    if (options.backendNodeId !== undefined) {
      if (!Number.isSafeInteger(options.backendNodeId) || options.backendNodeId < 1) {
        throw invalidArgument('backendNodeId must be a positive integer', 'backendNodeId');
      }
      await this.assertFileInput(options.backendNodeId);
      const evidence = await this.setFiles(filePath, options.backendNodeId);
      return {
        observation: await this.observations.observeAfterAction(options.observationLimit),
        evidence,
      };
    }

    const evaluationParams: Record<string, unknown> = {
      expression: `JSON.stringify(Array.from(document.querySelectorAll('input[type=file]')).map((el,i) => ({index:i+1, name:el.name||el.id||'unnamed', accept:el.accept||'*'})))`,
      returnByValue: true,
    };
    if (options.executionContextId) evaluationParams.contextId = options.executionContextId;
    const { result } = await this.transport.send('Runtime.evaluate', evaluationParams, this.sessionId);
    const inputs = parseInputs(result.value);
    if (inputs.length === 0) throw invalidArgument('No <input type="file"> found on this page');
    if (inputIndex > inputs.length) {
      const available = inputs.map(input => `${input.index}. ${input.name} (${input.accept})`).join('; ');
      throw invalidArgument(
        `${inputs.length} file input(s) found; inputIndex ${inputIndex} is out of range. Available: ${available}`,
        'inputIndex',
      );
    }

    const elementParams: Record<string, unknown> = {
      expression: `document.querySelectorAll('input[type=file]')[${inputIndex - 1}]`,
    };
    if (options.executionContextId) elementParams.contextId = options.executionContextId;
    const { result: element } = await this.transport.send('Runtime.evaluate', elementParams, this.sessionId);
    if (!element.objectId) {
      throw new BrowserPilotError('internal_error', 'Chrome could not resolve the selected file input');
    }
    try {
      const { node } = await this.transport.send('DOM.describeNode', {
        objectId: element.objectId,
      }, this.sessionId);
      if (!Number.isSafeInteger(node?.backendNodeId)) {
        throw new BrowserPilotError('internal_error', 'Chrome returned an invalid file input node');
      }
      const evidence = await this.setFiles(filePath, node.backendNodeId);
      return {
        observation: await this.observations.observeAfterAction(options.observationLimit),
        evidence,
      };
    } finally {
      await this.transport.send('Runtime.releaseObject', {
        objectId: element.objectId,
      }, this.sessionId).catch(() => {});
    }
  }

  private async assertFileInput(backendNodeId: number): Promise<void> {
    const { node } = await this.transport.send('DOM.describeNode', { backendNodeId }, this.sessionId);
    const attributes = Array.isArray(node?.attributes) ? node.attributes : [];
    const typeIndex = attributes.findIndex((value: unknown, index: number) => (
      index % 2 === 0 && String(value).toLowerCase() === 'type'
    ));
    const inputType = typeIndex >= 0 ? String(attributes[typeIndex + 1]).toLowerCase() : '';
    if (String(node?.nodeName).toUpperCase() !== 'INPUT' || inputType !== 'file') {
      throw invalidArgument('Observation ref does not identify a file input', 'ref');
    }
  }

  private async setFiles(filePath: string, backendNodeId: number): Promise<UploadVerificationEvidence> {
    const before = await this.readFileInputState(backendNodeId);
    this.requireFileInput(before);
    await this.transport.send('DOM.setFileInputFiles', {
      files: [filePath],
      backendNodeId,
    }, this.sessionId);
    if (this.readbackDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.readbackDelayMs));
    }
    let after: FileInputState;
    try {
      after = await this.readFileInputState(backendNodeId);
    } catch (error) {
      if (error instanceof BrowserPilotError && error.code === 'browser_disconnected') throw error;
      return {
        action: 'upload',
        status: 'unavailable',
        expectedFileCount: 1,
        reason: 'target_unavailable',
      };
    }
    if (after.status === 'blocked') {
      return {
        action: 'upload',
        status: 'unavailable',
        expectedFileCount: 1,
        reason: 'target_unavailable',
      };
    }
    const nameMatched = after.firstFileName === basename(filePath);
    const status = after.fileCount === 1 && nameMatched ? 'verified' : 'mismatch';
    const reason = after.fileCount !== 1
      ? 'file_count_mismatch' as const
      : !nameMatched ? 'file_name_mismatch' as const : undefined;
    return {
      action: 'upload',
      status,
      expectedFileCount: 1,
      fileCount: after.fileCount,
      nameMatched,
      ...(reason ? { reason } : {}),
    };
  }

  private async readFileInputState(backendNodeId: number): Promise<FileInputState> {
    const { object } = await this.transport.send('DOM.resolveNode', { backendNodeId }, this.sessionId);
    if (!object?.objectId) {
      return { status: 'blocked', reason: 'detached' };
    }
    try {
      const { result } = await this.transport.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: READ_FILE_INPUT_STATE,
        returnByValue: true,
      }, this.sessionId);
      return parseFileInputState(result.value);
    } finally {
      await this.transport.send('Runtime.releaseObject', { objectId: object.objectId }, this.sessionId).catch(() => {});
    }
  }

  private requireFileInput(state: FileInputState): void {
    if (state.status === 'ready') return;
    if (state.reason === 'detached') {
      throw new BrowserPilotError('stale_ref', 'File input is no longer connected');
    }
    if (state.reason === 'wrong_type') {
      throw invalidArgument('Selected target is not a file input', 'ref');
    }
    throw new BrowserPilotError('action_not_verified', 'File input is not currently editable', {
      retryable: true,
      context: { action: 'upload', reason: state.reason },
    });
  }
}
