import { open } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { ProfileIdentityErrorCode } from '../protocol/model.js';
import type { VerifiedProfileIdentity } from './profile-context-registry.js';

const MAX_LOCAL_STATE_BYTES = 16 * 1024 * 1024;
const MAX_IDENTITY_TEXT_LENGTH = 4096;

export class ProfileIdentityError extends Error {
  constructor(readonly code: ProfileIdentityErrorCode, message: string) {
    super(message);
    this.name = 'ProfileIdentityError';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function identityText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().slice(0, MAX_IDENTITY_TEXT_LENGTH);
  return normalized || undefined;
}

export async function readVerifiedChromeProfileIdentity(
  userDataRoot: string,
  reportedProfilePath: string,
): Promise<VerifiedProfileIdentity> {
  const root = resolve(userDataRoot);
  const profilePath = resolve(reportedProfilePath);
  if (dirname(profilePath) !== root) {
    throw new ProfileIdentityError(
      'profile_path_unverified',
      'Chrome reported a Profile path outside the connected browser user-data root',
    );
  }
  const profileDirectory = basename(profilePath);
  if (!profileDirectory || profileDirectory === '.' || profileDirectory === '..') {
    throw new ProfileIdentityError('profile_path_unverified', 'Chrome reported an invalid Profile directory');
  }

  const localStatePath = join(root, 'Local State');
  let bytes: Buffer;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(localStatePath, 'r');
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_LOCAL_STATE_BYTES) {
      throw new ProfileIdentityError('local_state_unavailable', 'Chrome Local State is missing or too large');
    }
    bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== bytes.length) bytes = bytes.subarray(0, offset);
  } catch (error) {
    if (error instanceof ProfileIdentityError) throw error;
    throw new ProfileIdentityError('local_state_unavailable', 'Chrome Local State could not be read');
  } finally {
    await handle?.close().catch(() => {});
  }

  let rootState: Record<string, unknown> | undefined;
  try {
    rootState = record(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new ProfileIdentityError('local_state_unavailable', 'Chrome Local State contains invalid JSON');
  }
  const profileState = record(rootState?.profile);
  const infoCache = record(profileState?.info_cache);
  const entry = record(infoCache?.[profileDirectory]);
  const profileName = identityText(entry?.name);
  if (!profileName) {
    throw new ProfileIdentityError(
      'profile_metadata_missing',
      'Chrome Local State has no verified metadata for the reported Profile directory',
    );
  }

  const accountName = identityText(entry?.gaia_name) ?? identityText(entry?.gaia_given_name);
  const accountEmail = identityText(entry?.user_name);
  return {
    profileName,
    profileDirectory,
    ...(accountName ? { accountName } : {}),
    ...(accountEmail ? { accountEmail } : {}),
  };
}
