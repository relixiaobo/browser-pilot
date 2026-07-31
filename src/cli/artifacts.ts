import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import type { ArtifactDescriptor, JsonValue } from '../protocol/model.js';

export function outputPath(filename: string): string {
  const configured = process.env.BROWSER_PILOT_OUTPUT_DIR;
  if (configured === undefined) return resolvePath(filename);
  if (!isAbsolute(configured)) {
    throw invalidArgument('BROWSER_PILOT_OUTPUT_DIR must be an absolute path', 'outputDir');
  }

  const root = resolvePath(configured);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const destination = isAbsolute(filename) ? resolvePath(filename) : resolvePath(root, filename);
  assertInsideOutputDirectory(root, destination, 'outputPath');

  const canonicalRoot = realpathSync.native(root);
  let existingAncestor = destination;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const canonicalAncestor = realpathSync.native(existingAncestor);
  assertInsideOutputDirectory(canonicalRoot, canonicalAncestor, 'outputPath');
  return destination;
}

function assertInsideOutputDirectory(root: string, candidate: string, field: string): void {
  const relativePath = relative(root, candidate);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw invalidArgument(
      'Output path must stay inside BROWSER_PILOT_OUTPUT_DIR',
      field,
    );
  }
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
