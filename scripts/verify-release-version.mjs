import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { releaseVersionMetadata } from './release-version-utils.mjs';

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
}

const packageManifest = await readJson('../package.json');
const packageLock = await readJson('../package-lock.json');
const agentPluginPackage = await readJson('../plugin/package.json');
const pluginManifest = await readJson('../plugin/.claude-plugin/plugin.json');
const skillCompatibility = await readJson('../plugin/skills/browser-pilot/compatibility.json');
const marketplace = await readJson('../.claude-plugin/marketplace.json');
const skill = await readFile(new URL('../plugin/skills/browser-pilot/SKILL.md', import.meta.url), 'utf8');
const openAiMetadata = await readFile(
  new URL('../plugin/skills/browser-pilot/agents/openai.yaml', import.meta.url),
  'utf8',
);
const marketplacePlugin = marketplace.plugins.find(plugin => plugin.name === 'browser-pilot');
const version = packageManifest.version;
const cliCompatibility = releaseVersionMetadata(version);
const repository = 'https://github.com/relixiaobo/browser-pilot';

assert.equal(packageLock.version, version, 'package-lock.json version must match package.json');
assert.equal(packageLock.packages?.['']?.version, version, 'root package-lock version must match package.json');
assert.equal(packageManifest.repository, repository, 'package repository must match release provenance');
assert.equal(agentPluginPackage.version, version, 'agent plugin package version must match package.json');
assert.equal(
  agentPluginPackage.peerDependencies?.['browser-pilot-cli'],
  cliCompatibility.supportedVersionRange,
  'agent plugin CLI peer range must match the release compatibility policy',
);
assert.equal(pluginManifest.version, version, 'plugin manifest version must match package.json');
assert.equal(skillCompatibility.schemaVersion, 2, 'skill compatibility schema must be current');
assert.equal(skillCompatibility.skillVersion, version, 'skill version must match package.json');
assert.deepEqual(skillCompatibility.browserPilotCli, {
  testedVersion: version,
  ...cliCompatibility,
  requiredNodeVersion: packageManifest.engines.node,
  installCommand: `npm install --global browser-pilot-cli@${version}`,
}, 'skill CLI compatibility must match package.json');
assert.ok(
  skill.includes('[compatibility.json](compatibility.json)') &&
    skill.includes('browserPilotCli.installCommand') &&
    skill.includes('bp --version'),
  'skill instructions must load and enforce its compatibility manifest',
);
assert.ok(
  openAiMetadata.includes('display_name: "Browser Pilot"') &&
    openAiMetadata.includes('$browser-pilot'),
  'skill UI metadata must identify Browser Pilot and its invocation token',
);
assert.ok(marketplacePlugin, 'browser-pilot marketplace entry is required');
assert.equal(marketplacePlugin.version, version, 'marketplace version must match package.json');

if (process.env.GITHUB_REF_NAME) {
  assert.equal(process.env.GITHUB_REF_NAME, `v${version}`, `release tag must equal v${version}`);
}

console.log(`Release manifests agree on ${version}.`);
