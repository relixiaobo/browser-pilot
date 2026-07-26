import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
}

const packageManifest = await readJson('../package.json');
const packageLock = await readJson('../package-lock.json');
const pluginManifest = await readJson('../plugin/.claude-plugin/plugin.json');
const marketplace = await readJson('../.claude-plugin/marketplace.json');
const marketplacePlugin = marketplace.plugins.find(plugin => plugin.name === 'browser-pilot');
const version = packageManifest.version;

assert.equal(packageLock.version, version, 'package-lock.json version must match package.json');
assert.equal(packageLock.packages?.['']?.version, version, 'root package-lock version must match package.json');
assert.equal(pluginManifest.version, version, 'plugin manifest version must match package.json');
assert.ok(marketplacePlugin, 'browser-pilot marketplace entry is required');
assert.equal(marketplacePlugin.version, version, 'marketplace version must match package.json');

if (process.env.GITHUB_REF_NAME) {
  assert.equal(process.env.GITHUB_REF_NAME, `v${version}`, `release tag must equal v${version}`);
}

console.log(`Release manifests agree on ${version}.`);
