import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { testTempPrefix } from './helpers/platform.mjs';
import {
  ProfileIdentityError,
  readVerifiedChromeProfileIdentity,
} from '../dist/services.js';

test('Profile identity requires an exact Profile path and reads bounded Local State metadata', async t => {
  const root = await mkdtemp(testTempPrefix('browser-pilot-profile-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'Profile 4'));
  await writeFile(join(root, 'Local State'), JSON.stringify({
    profile: {
      info_cache: {
        'Profile 4': {
          name: 'Work',
          gaia_name: 'Alice Example',
          user_name: 'alice@example.test',
        },
      },
    },
  }));

  assert.deepEqual(
    await readVerifiedChromeProfileIdentity(root, join(root, 'Profile 4')),
    {
      profileName: 'Work',
      accountName: 'Alice Example',
      accountEmail: 'alice@example.test',
      profileDirectory: 'Profile 4',
    },
  );
});

test('Profile identity rejects paths outside the connected browser user-data root', async t => {
  const root = await mkdtemp(testTempPrefix('browser-pilot-profile-root-'));
  const other = await mkdtemp(testTempPrefix('browser-pilot-profile-other-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(other, { recursive: true, force: true }),
  ]));

  await assert.rejects(
    () => readVerifiedChromeProfileIdentity(root, join(other, 'Default')),
    error => error instanceof ProfileIdentityError && error.code === 'profile_path_unverified',
  );
});

test('Profile identity reports missing metadata without guessing from directory order', async t => {
  const root = await mkdtemp(testTempPrefix('browser-pilot-profile-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'Profile 2'));
  await writeFile(join(root, 'Local State'), JSON.stringify({ profile: { info_cache: {} } }));

  await assert.rejects(
    () => readVerifiedChromeProfileIdentity(root, join(root, 'Profile 2')),
    error => error instanceof ProfileIdentityError && error.code === 'profile_metadata_missing',
  );
});

test('Profile identity refuses an oversized Local State before reading its contents', async t => {
  const root = await mkdtemp(testTempPrefix('browser-pilot-profile-oversized-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'Default'));
  await writeFile(join(root, 'Local State'), Buffer.alloc(16 * 1024 * 1024 + 1));

  await assert.rejects(
    () => readVerifiedChromeProfileIdentity(root, join(root, 'Default')),
    error => error instanceof ProfileIdentityError && error.code === 'local_state_unavailable',
  );
});
