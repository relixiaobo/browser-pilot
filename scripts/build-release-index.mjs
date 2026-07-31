#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_PROTOCOL_VERSIONS } from '../dist/protocol.js';
import { releaseVersionMetadata } from './release-version-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assetsIndex = process.argv.indexOf('--assets');
const assetsDirectory = assetsIndex === -1
  ? join(root, 'release')
  : resolve(process.argv[assetsIndex + 1] ?? '');
if (assetsIndex !== -1 && !process.argv[assetsIndex + 1]) {
  throw new Error('--assets requires a directory');
}

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const pluginPackage = JSON.parse(await readFile(join(root, 'plugin', 'package.json'), 'utf8'));
const skillCompatibility = JSON.parse(await readFile(
  join(root, 'plugin', 'skills', 'browser-pilot', 'compatibility.json'),
  'utf8',
));
const version = packageJson.version;
const cliCompatibility = releaseVersionMetadata(version);
assert.equal(pluginPackage.version, version);
assert.equal(
  pluginPackage.peerDependencies?.['browser-pilot-cli'],
  cliCompatibility.supportedVersionRange,
);
assert.equal(skillCompatibility.skillVersion, version);
assert.deepEqual(skillCompatibility.browserPilotCli, {
  testedVersion: version,
  ...cliCompatibility,
  requiredNodeVersion: packageJson.engines.node,
  installCommand: `npm install --global browser-pilot-cli@${version}`,
});

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function verifiedAsset(fileName) {
  const path = join(assetsDirectory, fileName);
  const checksumPath = `${path}.sha256`;
  const digest = await sha256(path);
  const checksumLine = (await readFile(checksumPath, 'utf8')).trim();
  assert.equal(checksumLine, `${digest}  ${fileName}`, `checksum mismatch for ${fileName}`);
  return {
    file: fileName,
    bytes: (await stat(path)).size,
    sha256: digest,
    checksumFile: basename(checksumPath),
  };
}

const targetDefinitions = [
  { platform: 'darwin', arch: 'arm64', archive: 'zip', requirement: 'Apple Silicon' },
  { platform: 'linux', arch: 'x64', archive: 'tar.gz' },
  { platform: 'win32', arch: 'x64', archive: 'zip' },
];
const native = [];
for (const target of targetDefinitions) {
  const fileName = `browser-pilot-${version}-${target.platform}-${target.arch}.${target.archive}`;
  native.push({
    platform: target.platform,
    arch: target.arch,
    ...(target.requirement ? { requirement: target.requirement } : {}),
    ...await verifiedAsset(fileName),
  });
}

const pluginAsset = await verifiedAsset(`browser-pilot-plugin-${version}.tgz`);
const protocolMin = SUPPORTED_PROTOCOL_VERSIONS[0];
const protocolMax = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];
assert.deepEqual(skillCompatibility.protocol, { min: protocolMin, max: protocolMax });

const index = {
  schemaVersion: 1,
  product: 'browser-pilot',
  version,
  protocol: { min: protocolMin, max: protocolMax },
  npm: {
    package: packageJson.name,
    version,
    installSpec: `${packageJson.name}@${version}`,
  },
  agentPlugin: {
    package: pluginPackage.name,
    version,
    testedCliVersion: version,
    compatibleCliRange: cliCompatibility.supportedVersionRange,
    skillPath: 'skills/browser-pilot',
    ...pluginAsset,
  },
  native,
  supportedPlatforms: targetDefinitions.map(({ platform, arch, requirement }) => ({
    platform,
    arch,
    ...(requirement ? { requirement } : {}),
  })),
};
const fileName = `browser-pilot-${version}-release-index.json`;
const path = join(assetsDirectory, fileName);
await writeFile(path, `${JSON.stringify(index, null, 2)}\n`);
const digest = await sha256(path);
const checksumPath = `${path}.sha256`;
await writeFile(checksumPath, `${digest}  ${fileName}\n`);

process.stdout.write(`${JSON.stringify({
  ok: true,
  index: path,
  sha256: digest,
  checksum: checksumPath,
  assets: native.length + 1,
})}\n`);
