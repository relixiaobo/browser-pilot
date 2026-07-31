import { mkdirSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import type { ArtifactDescriptor, JsonValue } from '../protocol/model.js';

export function outputPath(filename: string): string {
  if (isAbsolute(filename)) return resolvePath(filename);
  const configured = process.env.BROWSER_PILOT_OUTPUT_DIR;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) {
      throw invalidArgument('BROWSER_PILOT_OUTPUT_DIR must be an absolute path', 'outputDir');
    }
    mkdirSync(configured, { recursive: true, mode: 0o700 });
    return resolvePath(configured, filename);
  }
  return resolvePath(filename);
}

export function artifactFileResult(
  artifact: ArtifactDescriptor,
  file: string,
): Record<string, JsonValue> {
  return {
    file,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.byteSize,
    ...(artifact.width !== undefined ? { width: artifact.width } : {}),
    ...(artifact.height !== undefined ? { height: artifact.height } : {}),
  };
}

export function artifactFrom(result: Record<string, JsonValue>): ArtifactDescriptor {
  if (!result.artifact || typeof result.artifact !== 'object' || Array.isArray(result.artifact)) {
    throw new BrowserPilotError('internal_error', 'Browser tool did not return an Artifact');
  }
  return result.artifact as unknown as ArtifactDescriptor;
}
