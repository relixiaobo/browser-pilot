import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { releaseVersionMetadata } from '../scripts/release-version-utils.mjs';
import { testTempPrefix } from './helpers/platform.mjs';

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = packageJson.version;
const cliCompatibility = releaseVersionMetadata(version);

async function writeChecksummedAsset(directory, fileName, content) {
  const path = join(directory, fileName);
  await writeFile(path, content);
  const digest = createHash('sha256').update(content).digest('hex');
  await writeFile(`${path}.sha256`, `${digest}  ${fileName}\n`);
}

test('release distribution binds tested and compatible CLI versions, skill, protocol, and platforms', async t => {
  const assets = await mkdtemp(testTempPrefix('browser-pilot-release-assets-'));
  t.after(() => rm(assets, { recursive: true, force: true }));

  await execFile(process.execPath, [
    join(root, 'scripts', 'package-agent-plugin.mjs'),
    '--output',
    assets,
  ], { cwd: root, timeout: 30_000 });

  for (const fileName of [
    `browser-pilot-${version}-darwin-arm64.zip`,
    `browser-pilot-${version}-linux-x64.tar.gz`,
    `browser-pilot-${version}-win32-x64.zip`,
  ]) {
    await writeChecksummedAsset(assets, fileName, `fixture:${fileName}`);
  }

  const { stdout } = await execFile(process.execPath, [
    join(root, 'scripts', 'build-release-index.mjs'),
    '--assets',
    assets,
  ], { cwd: root, timeout: 30_000 });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.assets, 4);

  const index = JSON.parse(await readFile(result.index, 'utf8'));
  assert.equal(index.version, version);
  assert.deepEqual(index.protocol, {
    min: { major: 1, minor: 0 },
    max: { major: 1, minor: 3 },
  });
  assert.deepEqual(index.npm, {
    package: 'browser-pilot-cli',
    version,
    installSpec: `browser-pilot-cli@${version}`,
  });
  assert.equal(index.agentPlugin.version, version);
  assert.equal(index.agentPlugin.testedCliVersion, version);
  assert.equal(index.agentPlugin.compatibleCliRange, cliCompatibility.supportedVersionRange);
  assert.deepEqual(index.native.map(asset => `${asset.platform}-${asset.arch}`), [
    'darwin-arm64',
    'linux-x64',
    'win32-x64',
  ]);
  assert.equal(JSON.stringify(index).includes('darwin-x64'), false);

  const checksum = (await readFile(`${result.index}.sha256`, 'utf8')).trim();
  const digest = createHash('sha256').update(await readFile(result.index)).digest('hex');
  assert.equal(checksum, `${digest}  ${basename(result.index)}`);
});

test('CLI compatibility range advances from the release version without an exact-version lock', () => {
  assert.deepEqual(releaseVersionMetadata('0.5.0'), {
    minimumVersion: '0.5.0',
    maximumVersionExclusive: '1.0.0',
    supportedVersionRange: '>=0.5.0 <1.0.0',
  });
  assert.deepEqual(releaseVersionMetadata('1.2.3-rc.1+build.7'), {
    minimumVersion: '1.2.3-rc.1',
    maximumVersionExclusive: '2.0.0',
    supportedVersionRange: '>=1.2.3-rc.1 <2.0.0',
  });
});

test('npm version stages every manifest synchronized by the version hook', () => {
  assert.equal(
    packageJson.scripts.version,
    'node scripts/sync-release-version.mjs && git add -- package-lock.json plugin/package.json '
      + 'plugin/.claude-plugin/plugin.json .claude-plugin/marketplace.json '
      + 'plugin/skills/browser-pilot/compatibility.json',
  );
});

test('release sync advances every active manifest from the root package version', async t => {
  const fixtureRoot = await mkdtemp(testTempPrefix('browser-pilot-version-sync-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(fixtureRoot, 'plugin', '.claude-plugin'), { recursive: true }),
    mkdir(join(fixtureRoot, 'plugin', 'skills', 'browser-pilot'), { recursive: true }),
    mkdir(join(fixtureRoot, '.claude-plugin'), { recursive: true }),
  ]);

  const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  await Promise.all([
    writeJson(join(fixtureRoot, 'package.json'), { version: '0.5.0' }),
    writeJson(join(fixtureRoot, 'package-lock.json'), {
      version: '0.4.0',
      packages: { '': { version: '0.4.0' } },
    }),
    writeJson(join(fixtureRoot, 'plugin', 'package.json'), {
      version: '0.4.0',
      peerDependencies: { 'browser-pilot-cli': '0.4.0' },
    }),
    writeJson(join(fixtureRoot, 'plugin', '.claude-plugin', 'plugin.json'), {
      version: '0.4.0',
    }),
    writeJson(join(fixtureRoot, '.claude-plugin', 'marketplace.json'), {
      plugins: [{ name: 'browser-pilot', version: '0.4.0' }],
    }),
    writeJson(join(fixtureRoot, 'plugin', 'skills', 'browser-pilot', 'compatibility.json'), {
      schemaVersion: 1,
      skillVersion: '0.4.0',
      browserPilotCli: '0.4.0',
      protocol: { min: { major: 1, minor: 0 }, max: { major: 1, minor: 3 } },
    }),
  ]);

  const { stdout } = await execFile(process.execPath, [
    join(root, 'scripts', 'sync-release-version.mjs'),
    '--root',
    fixtureRoot,
  ], { cwd: root, timeout: 30_000 });
  assert.equal(JSON.parse(stdout).version, '0.5.0');

  const [lock, plugin, claudePlugin, marketplace, compatibility] = await Promise.all([
    readFile(join(fixtureRoot, 'package-lock.json'), 'utf8').then(JSON.parse),
    readFile(join(fixtureRoot, 'plugin', 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(fixtureRoot, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8').then(JSON.parse),
    readFile(join(fixtureRoot, '.claude-plugin', 'marketplace.json'), 'utf8').then(JSON.parse),
    readFile(
      join(fixtureRoot, 'plugin', 'skills', 'browser-pilot', 'compatibility.json'),
      'utf8',
    ).then(JSON.parse),
  ]);
  assert.equal(lock.version, '0.5.0');
  assert.equal(lock.packages[''].version, '0.5.0');
  assert.equal(plugin.version, '0.5.0');
  assert.equal(plugin.peerDependencies['browser-pilot-cli'], '>=0.5.0 <1.0.0');
  assert.equal(claudePlugin.version, '0.5.0');
  assert.equal(marketplace.plugins[0].version, '0.5.0');
  assert.deepEqual(compatibility.browserPilotCli, {
    testedVersion: '0.5.0',
    minimumVersion: '0.5.0',
    maximumVersionExclusive: '1.0.0',
    supportedVersionRange: '>=0.5.0 <1.0.0',
  });
});

test('release index rejects an asset whose checksum sidecar does not match', async t => {
  const assets = await mkdtemp(testTempPrefix('browser-pilot-release-checksum-'));
  t.after(() => rm(assets, { recursive: true, force: true }));

  await execFile(process.execPath, [
    join(root, 'scripts', 'package-agent-plugin.mjs'),
    '--output',
    assets,
  ], { cwd: root, timeout: 30_000 });
  for (const fileName of [
    `browser-pilot-${version}-darwin-arm64.zip`,
    `browser-pilot-${version}-linux-x64.tar.gz`,
    `browser-pilot-${version}-win32-x64.zip`,
  ]) {
    await writeChecksummedAsset(assets, fileName, `fixture:${fileName}`);
  }
  await writeFile(
    join(assets, `browser-pilot-${version}-linux-x64.tar.gz.sha256`),
    `bad  browser-pilot-${version}-linux-x64.tar.gz\n`,
  );

  await assert.rejects(
    () => execFile(process.execPath, [
      join(root, 'scripts', 'build-release-index.mjs'),
      '--assets',
      assets,
    ], { cwd: root, timeout: 30_000 }),
    error => /checksum mismatch/.test(String(error.stderr)),
  );
});
