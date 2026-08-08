#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { releaseVersionMetadata } from './release-version-utils.mjs';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputIndex = process.argv.indexOf('--output');
const outputDirectory = outputIndex === -1
  ? join(root, 'release')
  : resolve(process.argv[outputIndex + 1] ?? '');

if (outputIndex !== -1 && !process.argv[outputIndex + 1]) {
  throw new Error('--output requires a directory');
}

const rootPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const pluginPackage = JSON.parse(await readFile(join(root, 'plugin', 'package.json'), 'utf8'));
const cliCompatibility = releaseVersionMetadata(rootPackage.version);
assert.equal(pluginPackage.version, rootPackage.version, 'plugin version must match CLI version');
assert.equal(
  pluginPackage.peerDependencies?.['browser-pilot-cli'],
  cliCompatibility.supportedVersionRange,
  'plugin CLI peer range must match the release compatibility policy',
);
assert.equal(
  pluginPackage.peerDependenciesMeta?.['browser-pilot-cli']?.optional,
  true,
  'plugin npm CLI peer must be optional when the native CLI is used',
);

await mkdir(outputDirectory, { recursive: true });
const npmArguments = [
  'pack',
  join(root, 'plugin'),
  '--json',
  '--pack-destination',
  outputDirectory,
];
const npmCli = process.env.npm_execpath;
const { stdout } = await execFileAsync(
  npmCli ? process.execPath : 'npm',
  npmCli ? [npmCli, ...npmArguments] : npmArguments,
  { cwd: root, maxBuffer: 10 * 1024 * 1024 },
);
const packed = JSON.parse(stdout);
assert.equal(packed.length, 1, 'npm pack must produce one plugin archive');

const entry = packed[0];
const expectedFileName = `browser-pilot-plugin-${rootPackage.version}.tgz`;
assert.equal(entry.filename, expectedFileName, 'plugin archive name must be versioned');
const paths = new Set(entry.files.map(file => file.path));
for (const required of [
  '.claude-plugin/plugin.json',
  'commands/browse.md',
  'package.json',
  'skills/browser-pilot/SKILL.md',
  'skills/browser-pilot/compatibility.json',
  'skills/browser-pilot/agents/openai.yaml',
  'skills/browser-pilot/references/commands.md',
  'skills/browser-pilot/references/async.md',
  'skills/browser-pilot/references/embedding.md',
  'skills/browser-pilot/references/recovery.md',
  'skills/browser-pilot/scripts/install-native.ps1',
  'skills/browser-pilot/scripts/install-native.sh',
  // Seeds must reach the archive: an Agent copies them once, and a seed missing
  // from the package is never noticed afterwards.
  'skills/browser-pilot/sites/google-docs-editors.md',
  'skills/browser-pilot/sites/google-search.md',
]) {
  assert.ok(paths.has(required), `plugin archive is missing ${required}`);
}

const archive = join(outputDirectory, entry.filename);
const bytes = await readFile(archive);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const checksum = `${archive}.sha256`;
await writeFile(checksum, `${sha256}  ${entry.filename}\n`);

process.stdout.write(`${JSON.stringify({
  ok: true,
  version: rootPackage.version,
  archive,
  bytes: (await stat(archive)).size,
  sha256,
  checksum,
  files: entry.files.length,
})}\n`);
