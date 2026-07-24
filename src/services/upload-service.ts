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

export class UploadService {
  constructor(
    private readonly transport: Transport,
    private readonly sessionId: string,
    private readonly observations: UploadObservationService,
  ) {}

  async upload(filePath: string, options: UploadOptions = {}): Promise<SnapshotResult> {
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
      await this.setFiles(filePath, options.backendNodeId);
      return this.observations.observeAfterAction(options.observationLimit);
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
      await this.setFiles(filePath, node.backendNodeId);
    } finally {
      await this.transport.send('Runtime.releaseObject', {
        objectId: element.objectId,
      }, this.sessionId).catch(() => {});
    }

    return this.observations.observeAfterAction(options.observationLimit);
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

  private async setFiles(filePath: string, backendNodeId: number): Promise<void> {
    await this.transport.send('DOM.setFileInputFiles', {
      files: [filePath],
      backendNodeId,
    }, this.sessionId);
  }
}
