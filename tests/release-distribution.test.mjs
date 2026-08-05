import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { publishRelease } from '../scripts/release-publish.mjs';
import {
  browserPilotCliMetadata,
  releaseVersionMetadata,
} from '../scripts/release-version-utils.mjs';
import { testTempPrefix } from './helpers/platform.mjs';

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const version = packageJson.version;
const cliCompatibility = releaseVersionMetadata(version);
const npmArchiveName = `browser-pilot-cli-${version}.tgz`;

function npmIntegrity(content) {
  return `sha512-${createHash('sha512').update(content).digest('base64')}`;
}

async function preparePublishAssets(directory) {
  await mkdir(directory, { recursive: true });
  await writeChecksummedAsset(directory, `browser-pilot-${version}-fixture.zip`, 'release-fixture');
}

function releaseHarness(options = {}) {
  const calls = [];
  const assets = new Map(options.assets ?? []);
  let release = options.release ? { ...options.release } : undefined;
  let registry = options.registryIntegrity;
  let packCount = 0;
  let publishCount = 0;

  const result = (status = 0, stdout = '', stderr = '') => ({ status, stdout, stderr });
  const optionValues = (args, name) => args.flatMap((value, index) => (
    value === name ? [args[index + 1]] : []
  ));
  return {
    calls,
    assets,
    get release() { return release; },
    get registryIntegrity() { return registry; },
    get packCount() { return packCount; },
    get publishCount() { return publishCount; },
    async runGh(args) {
      calls.push(['gh', ...args]);
      if (args[0] === 'api') {
        return release
          ? result(0, JSON.stringify(release))
          : result(1, '', 'gh: Not Found (HTTP 404)');
      }
      if (args[0] === 'release' && args[1] === 'download') {
        const directory = args[args.indexOf('--dir') + 1];
        const patterns = optionValues(args, '--pattern');
        const selected = [...assets].filter(([name]) => patterns.length === 0 || patterns.includes(name));
        if (selected.length === 0) return result(1, '', 'no assets matched');
        await mkdir(directory, { recursive: true });
        await Promise.all(selected.map(([name, bytes]) => writeFile(join(directory, name), bytes)));
        return result();
      }
      if (args[0] === 'release' && args[1] === 'create') {
        release = { draft: true, prerelease: args.includes('--prerelease') };
        return result();
      }
      if (args[0] === 'release' && args[1] === 'upload') {
        const firstAsset = args.indexOf('--clobber') + 1;
        for (const path of args.slice(firstAsset)) {
          assets.set(basename(path), await readFile(path));
        }
        return result();
      }
      if (args[0] === 'release' && args[1] === 'edit') {
        release = { ...release, draft: false };
        return result();
      }
      return result(1, '', `unexpected gh call: ${args.join(' ')}`);
    },
    async runNpm(args) {
      calls.push(['npm', ...args]);
      if (args[0] === 'view') {
        return registry
          ? result(0, JSON.stringify(registry))
          : result(1, '', 'npm error code E404');
      }
      if (args[0] === 'pack') {
        packCount += 1;
        const directory = args[args.indexOf('--pack-destination') + 1];
        await writeFile(join(directory, npmArchiveName), `npm-pack-${packCount}`);
        return result(0, JSON.stringify([{ filename: npmArchiveName }]));
      }
      if (args[0] === 'publish') {
        publishCount += 1;
        registry = npmIntegrity(await readFile(args[1]));
        return result();
      }
      return result(1, '', `unexpected npm call: ${args.join(' ')}`);
    },
  };
}

function authoritativeNpmAssets(content) {
  const bytes = Buffer.from(content);
  const integrity = npmIntegrity(bytes);
  return {
    integrity,
    assets: [
      [npmArchiveName, bytes],
      [`${npmArchiveName}.integrity`, Buffer.from(`${integrity}\n`)],
    ],
  };
}

async function runPublish(assetsDirectory, harness) {
  return publishRelease({
    root,
    assetsDirectory,
    tag: `v${version}`,
    repository: 'example/browser-pilot',
  }, {
    runGh: harness.runGh,
    runNpm: harness.runNpm,
    sleep: async () => {},
  });
}

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
  assert.equal(
    browserPilotCliMetadata({ version: '0.7.2', engines: { node: '>=22' } })
      .installation.native.version,
    '0.7.2',
  );
  assert.equal(
    browserPilotCliMetadata({ version: '0.7.2', engines: { node: '>=22' } })
      .installation.npmFallback.installCommand,
    'npm install --global browser-pilot-cli@0.7.2',
  );
});

test('npm version stages every manifest synchronized by the version hook', () => {
  assert.equal(
    packageJson.scripts.version,
    'node scripts/sync-release-version.mjs && git add -- package-lock.json plugin/package.json '
      + 'plugin/.claude-plugin/plugin.json .claude-plugin/marketplace.json '
      + 'plugin/skills/browser-pilot/compatibility.json',
  );
});

test('npm distribution and lockfile require Node.js 22 or newer', () => {
  assert.equal(packageJson.engines.node, '>=22');
  assert.equal(packageLock.packages[''].engines.node, packageJson.engines.node);
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
    writeJson(join(fixtureRoot, 'package.json'), {
      version: '0.5.0',
      engines: { node: '>=22' },
    }),
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
  assert.equal(plugin.peerDependenciesMeta['browser-pilot-cli'].optional, true);
  assert.equal(claudePlugin.version, '0.5.0');
  assert.equal(marketplace.plugins[0].version, '0.5.0');
  assert.equal(compatibility.schemaVersion, 3);
  assert.equal(compatibility.skillVersion, '0.5.0');
  assert.deepEqual(compatibility.browserPilotCli, {
    testedVersion: '0.5.0',
    minimumVersion: '0.5.0',
    maximumVersionExclusive: '1.0.0',
    supportedVersionRange: '>=0.5.0 <1.0.0',
    installation: {
      strategy: 'native-first',
      native: {
        repository: 'relixiaobo/browser-pilot',
        version: '0.5.0',
        installers: {
          posix: 'scripts/install-native.sh',
          windows: 'scripts/install-native.ps1',
        },
        unsupportedPlatformExitCode: 10,
      },
      npmFallback: {
        requiredNodeVersion: '>=22',
        installCommand: 'npm install --global browser-pilot-cli@0.5.0',
      },
    },
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

test('release publisher creates a draft before npm and finalizes it afterward', async t => {
  const assets = await mkdtemp(testTempPrefix('browser-pilot-publish-fresh-'));
  t.after(() => rm(assets, { recursive: true, force: true }));
  await preparePublishAssets(assets);
  const harness = releaseHarness();

  const published = await runPublish(assets, harness);
  assert.equal(published.state, 'published');
  assert.equal(published.packed, true);
  assert.equal(published.npmPublished, true);
  assert.equal(harness.release.draft, false);
  assert.equal(harness.packCount, 1);
  assert.equal(harness.publishCount, 1);
  assert.equal(harness.assets.has(npmArchiveName), true);
  assert.equal(harness.assets.has(`${npmArchiveName}.integrity`), true);
  const operations = harness.calls.map(call => `${call[0]} ${call[1]} ${call[2] ?? ''}`);
  assert.ok(operations.indexOf('npm pack --json') < operations.indexOf('gh release create'));
  assert.ok(operations.indexOf('gh release create') < operations.indexOf('npm publish ' + join(assets, npmArchiveName)));
  assert.ok(operations.indexOf('npm publish ' + join(assets, npmArchiveName)) < operations.indexOf('gh release edit'));
});

test('release publisher reuses the draft npm archive when npm already succeeded', async t => {
  const assets = await mkdtemp(testTempPrefix('browser-pilot-publish-rerun-'));
  t.after(() => rm(assets, { recursive: true, force: true }));
  await preparePublishAssets(assets);
  const npm = authoritativeNpmAssets('authoritative-rerun-package');
  const harness = releaseHarness({
    release: { draft: true, prerelease: false },
    assets: npm.assets,
    registryIntegrity: npm.integrity,
  });

  const published = await runPublish(assets, harness);
  assert.equal(published.state, 'published');
  assert.equal(published.packed, false);
  assert.equal(published.npmPublished, false);
  assert.equal(harness.packCount, 0);
  assert.equal(harness.publishCount, 0);
  assert.equal(harness.release.draft, false);
});

test('release publisher rejects a registry integrity mismatch', async t => {
  const assets = await mkdtemp(testTempPrefix('browser-pilot-publish-mismatch-'));
  t.after(() => rm(assets, { recursive: true, force: true }));
  await preparePublishAssets(assets);
  const npm = authoritativeNpmAssets('draft-package');
  const harness = releaseHarness({
    release: { draft: true, prerelease: false },
    assets: npm.assets,
    registryIntegrity: npmIntegrity('different-registry-package'),
  });

  await assert.rejects(
    () => runPublish(assets, harness),
    /Draft npm archive does not match the npm registry integrity/,
  );
  assert.equal(harness.packCount, 0);
  assert.equal(harness.publishCount, 0);
  assert.equal(harness.release.draft, true);
});

test('release publisher fails when npm exists but its authoritative draft is missing', async t => {
  const assets = await mkdtemp(testTempPrefix('browser-pilot-publish-missing-draft-'));
  t.after(() => rm(assets, { recursive: true, force: true }));
  await preparePublishAssets(assets);
  const harness = releaseHarness({ registryIntegrity: npmIntegrity('already-published') });

  await assert.rejects(
    () => runPublish(assets, harness),
    /npm already contains .* but draft release .* is missing/,
  );
  assert.equal(harness.packCount, 0);
  assert.equal(harness.publishCount, 0);
  assert.equal(harness.release, undefined);
});

test('release publisher verifies an already-public release and performs no writes', async t => {
  const localAssets = await mkdtemp(testTempPrefix('browser-pilot-publish-public-'));
  t.after(() => rm(localAssets, { recursive: true, force: true }));
  const npm = authoritativeNpmAssets('public-package');
  const releaseFileName = `browser-pilot-${version}-public.zip`;
  const releaseBytes = Buffer.from('public-release-asset');
  const releaseDigest = createHash('sha256').update(releaseBytes).digest('hex');
  const harness = releaseHarness({
    release: { draft: false, prerelease: false },
    registryIntegrity: npm.integrity,
    assets: [
      ...npm.assets,
      [releaseFileName, releaseBytes],
      [`${releaseFileName}.sha256`, Buffer.from(`${releaseDigest}  ${releaseFileName}\n`)],
    ],
  });

  const published = await runPublish(localAssets, harness);
  assert.equal(published.state, 'already_public');
  assert.equal(published.integrity, npm.integrity);
  assert.equal(published.checksumsVerified, 1);
  assert.equal(harness.packCount, 0);
  assert.equal(harness.publishCount, 0);
  assert.equal(
    harness.calls.some(call => call[0] === 'gh' && ['upload', 'edit', 'create'].includes(call[2])),
    false,
  );
});
