import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  validateManagedSkillDirectory,
} from '../scripts/validate-managed-skill.mjs';
import { testTempPrefix } from './helpers/platform.mjs';

const root = resolve(import.meta.dirname, '..');
const managedSkill = join(root, 'plugin', 'skills', 'browser-pilot');
const validSkill = `---
name: fixture-skill
description: A valid fixture skill.
---

# Fixture
`;

async function fixture(parent, name) {
  const directory = join(parent, name);
  await mkdir(directory);
  await writeFile(join(directory, 'SKILL.md'), validSkill, { mode: 0o644 });
  return directory;
}

test('managed Browser Pilot skill satisfies the repository distribution contract', async () => {
  const result = await validateManagedSkillDirectory(managedSkill);
  assert.equal(result.ok, true);
  assert.equal(result.name, 'browser-pilot');
  assert.equal(result.files, 9);
  assert.equal(result.totalBytes < 16 * 1024 * 1024, true);
});

test('managed skill validation rejects malformed metadata and unsafe trees', async t => {
  const parent = await mkdtemp(testTempPrefix('bp-managed-skill-'));
  t.after(() => rm(parent, { recursive: true, force: true }));

  const badYaml = await fixture(parent, 'bad-yaml');
  await writeFile(join(badYaml, 'SKILL.md'), '---\nname: [broken\n---\n');
  await assert.rejects(validateManagedSkillDirectory(badYaml), /invalid YAML/);

  const missingDescription = await fixture(parent, 'missing-description');
  await writeFile(join(missingDescription, 'SKILL.md'), '---\nname: fixture-skill\n---\n');
  await assert.rejects(validateManagedSkillDirectory(missingDescription), /requires a non-empty description/);

  const longDescription = await fixture(parent, 'long-description');
  await writeFile(
    join(longDescription, 'SKILL.md'),
    `---\ndescription: ${'x'.repeat(2_001)}\n---\n`,
  );
  await assert.rejects(validateManagedSkillDirectory(longDescription), /exceeds 2000 characters/);

  const badName = await fixture(parent, 'bad-name');
  await writeFile(join(badName, 'SKILL.md'), '---\nname: Bad_Name\ndescription: valid\n---\n');
  await assert.rejects(validateManagedSkillDirectory(badName), /name must be at most 64/);

  const hidden = await fixture(parent, 'hidden');
  await writeFile(join(hidden, '.secret'), 'hidden');
  await assert.rejects(validateManagedSkillDirectory(hidden), /hidden path/);

  const nested = await fixture(parent, 'nested');
  await mkdir(join(nested, 'references'));
  await writeFile(join(nested, 'references', 'SKILL.md'), validSkill);
  await assert.rejects(validateManagedSkillDirectory(nested), /exactly one SKILL\.md/);

  const badMagic = await fixture(parent, 'bad-magic');
  await writeFile(join(badMagic, 'image.png'), 'not a png');
  await assert.rejects(validateManagedSkillDirectory(badMagic), /file magic/);

  const unsupported = await fixture(parent, 'unsupported');
  await writeFile(join(unsupported, 'archive.zip'), 'not allowed');
  await assert.rejects(validateManagedSkillDirectory(unsupported), /unsupported file extension/);

  const oversized = await fixture(parent, 'oversized');
  await writeFile(join(oversized, 'large.txt'), Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(validateManagedSkillDirectory(oversized), /exceeds 1MB/);
});

test('managed skill validation enforces Git modes and tracked files', async t => {
  const parent = await mkdtemp(testTempPrefix('bp-managed-skill-git-'));
  t.after(() => rm(parent, { recursive: true, force: true }));

  const executableMode = await fixture(parent, 'executable-mode');
  await assert.rejects(
    validateManagedSkillDirectory(executableMode, {
      gitModes: new Map([['SKILL.md', '100755']]),
    }),
    /Git mode must be 100644/,
  );

  const submoduleMode = await fixture(parent, 'submodule-mode');
  await assert.rejects(
    validateManagedSkillDirectory(submoduleMode, {
      gitModes: new Map([['SKILL.md', '160000']]),
    }),
    /Git mode must be 100644/,
  );

  const untracked = await fixture(parent, 'untracked');
  await writeFile(join(untracked, 'reference.md'), 'untracked');
  await assert.rejects(
    validateManagedSkillDirectory(untracked, {
      gitModes: new Map([['SKILL.md', '100644']]),
    }),
    /every skill file must be tracked/,
  );
});

test('managed skill validation enforces tree count and total size limits', async t => {
  const parent = await mkdtemp(testTempPrefix('bp-managed-skill-limits-'));
  t.after(() => rm(parent, { recursive: true, force: true }));

  const tooMany = await fixture(parent, 'too-many');
  await Promise.all(Array.from({ length: 512 }, (_, index) => (
    writeFile(join(tooMany, `file-${index}.txt`), '')
  )));
  await assert.rejects(validateManagedSkillDirectory(tooMany), /more than 512 files/);

  const tooLarge = await fixture(parent, 'too-large');
  const oneMegabyte = Buffer.alloc(1024 * 1024);
  await Promise.all(Array.from({ length: 17 }, (_, index) => (
    writeFile(join(tooLarge, `file-${index}.txt`), oneMegabyte)
  )));
  await assert.rejects(validateManagedSkillDirectory(tooLarge), /16MB total size limit/);
});

test('managed skill validation rejects executable files and symbolic links', {
  skip: process.platform === 'win32' ? 'Windows does not preserve POSIX modes and symlinks need privileges' : false,
}, async t => {
  const parent = await mkdtemp(testTempPrefix('bp-managed-skill-links-'));
  t.after(() => rm(parent, { recursive: true, force: true }));

  const executable = await fixture(parent, 'executable');
  await writeFile(join(executable, 'run.sh'), '#!/bin/sh\n', { mode: 0o644 });
  await chmod(join(executable, 'run.sh'), 0o755);
  await assert.rejects(validateManagedSkillDirectory(executable), /executable file/);

  const linked = await fixture(parent, 'linked');
  await symlink(join(linked, 'SKILL.md'), join(linked, 'linked.md'));
  await assert.rejects(validateManagedSkillDirectory(linked), /symbolic link/);
});
