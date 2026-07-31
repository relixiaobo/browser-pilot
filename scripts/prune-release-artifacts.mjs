#!/usr/bin/env node

import { readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
  if (!match) return undefined;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split('.') ?? [],
  };
}

function compareIdentifiers(left, right) {
  const leftNumber = /^\d+$/u.test(left) ? Number(left) : undefined;
  const rightNumber = /^\d+$/u.test(right) ? Number(right) : undefined;
  if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber;
  if (leftNumber !== undefined) return -1;
  if (rightNumber !== undefined) return 1;
  return left.localeCompare(right);
}

function compareVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  if (!left || !right) return leftValue.localeCompare(rightValue, 'en', { numeric: true });
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (left.prerelease.length === 0 && right.prerelease.length > 0) return 1;
  if (right.prerelease.length === 0 && left.prerelease.length > 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const compared = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (compared !== 0) return compared;
  }
  return 0;
}

export function releaseArtifactVersion(name) {
  const native = /^browser-pilot-(.+)-(?:darwin|linux|win32)-[a-z0-9_]+(?:\.(?:zip|tar\.gz)(?:\.sha256)?)?$/u.exec(name);
  if (native && parseVersion(native[1])) return native[1];
  const plugin = /^browser-pilot-plugin-(.+)\.tgz(?:\.sha256)?$/u.exec(name);
  if (plugin && parseVersion(plugin[1])) return plugin[1];
  return undefined;
}

export async function pruneReleaseArtifacts({ directory, keep = 2, dryRun = false }) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be a positive integer');
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    entries = [];
  }
  const versions = new Map();
  const ignored = [];
  for (const entry of entries) {
    const version = releaseArtifactVersion(entry.name);
    if (!version) {
      ignored.push(entry.name);
      continue;
    }
    const names = versions.get(version) ?? [];
    names.push(entry.name);
    versions.set(version, names);
  }
  const retainedVersions = [...versions.keys()].sort(compareVersions).slice(-keep);
  const retainedSet = new Set(retainedVersions);
  const removed = [...versions]
    .filter(([version]) => !retainedSet.has(version))
    .flatMap(([, names]) => names)
    .sort();
  if (!dryRun) {
    for (const name of removed) {
      await rm(join(directory, name), { recursive: true, force: true });
    }
  }
  return {
    dryRun,
    keep,
    retainedVersions,
    removed,
    ignored: ignored.sort(),
  };
}

function parseArguments(argv) {
  let keep = 2;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dry-run') {
      dryRun = true;
    } else if (argv[index] === '--keep') {
      keep = Number(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return { keep, dryRun };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = await pruneReleaseArtifacts({
    directory: join(root, 'release'),
    ...parseArguments(process.argv.slice(2)),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}
