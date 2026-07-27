#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseVersionMetadata } from './release-version-utils.mjs';

const rootIndex = process.argv.indexOf('--root');
if (rootIndex !== -1 && !process.argv[rootIndex + 1]) {
  throw new Error('--root requires a directory');
}
const root = rootIndex === -1
  ? resolve(dirname(fileURLToPath(import.meta.url)), '..')
  : resolve(process.argv[rootIndex + 1]);
const checkOnly = process.argv.includes('--check');

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function syncJson(path, update) {
  const current = await readJson(path);
  const next = update(structuredClone(current));
  if (checkOnly) {
    assert.deepEqual(current, next, `${path} is not synchronized with package.json`);
    return false;
  }
  if (JSON.stringify(current) === JSON.stringify(next)) return false;
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}

const packagePath = join(root, 'package.json');
const version = (await readJson(packagePath)).version;
const cliCompatibility = releaseVersionMetadata(version);
const changed = [];

if (await syncJson(join(root, 'package-lock.json'), manifest => {
  manifest.version = version;
  manifest.packages[''].version = version;
  return manifest;
})) changed.push('package-lock.json');

if (await syncJson(join(root, 'plugin', 'package.json'), manifest => {
  manifest.version = version;
  manifest.peerDependencies['browser-pilot-cli'] = cliCompatibility.supportedVersionRange;
  return manifest;
})) changed.push('plugin/package.json');

if (await syncJson(join(root, 'plugin', '.claude-plugin', 'plugin.json'), manifest => {
  manifest.version = version;
  return manifest;
})) changed.push('plugin/.claude-plugin/plugin.json');

if (await syncJson(join(root, '.claude-plugin', 'marketplace.json'), manifest => {
  const plugin = manifest.plugins.find(entry => entry.name === 'browser-pilot');
  assert.ok(plugin, 'browser-pilot marketplace entry is required');
  plugin.version = version;
  return manifest;
})) changed.push('.claude-plugin/marketplace.json');

if (await syncJson(join(root, 'plugin', 'skills', 'browser-pilot', 'compatibility.json'), manifest => {
  manifest.skillVersion = version;
  manifest.browserPilotCli = {
    testedVersion: version,
    ...cliCompatibility,
  };
  return manifest;
})) changed.push('plugin/skills/browser-pilot/compatibility.json');

process.stdout.write(`${JSON.stringify({
  ok: true,
  mode: checkOnly ? 'check' : 'write',
  version,
  changed,
})}\n`);
