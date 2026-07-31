import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  pruneReleaseArtifacts,
  releaseArtifactVersion,
} from '../scripts/prune-release-artifacts.mjs';
import { cleanDist } from '../scripts/clean-dist.mjs';
import { testTempPrefix } from './helpers/platform.mjs';

const root = resolve(import.meta.dirname, '..');

test('npm package uses a files allowlist without historical planning documents', async () => {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.files.some(path => path.startsWith('docs/plans/')), false);
  assert.deepEqual(packageJson.files.slice(0, 3), [
    'dist/cli.js',
    'dist/daemon.js',
    'dist/managed-target-janitor.js',
  ]);
  assert.equal(packageJson.scripts.prebuild, 'node scripts/clean-dist.mjs');
  assert.equal(packageJson.scripts['test:agent:download'], undefined);
});

test('dist cleanup removes only the selected output directory', async t => {
  const root = await mkdtemp(testTempPrefix('browser-pilot-clean-dist-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, 'dist');
  await mkdir(dist);
  await Promise.all([
    writeFile(join(dist, 'stale.js'), 'stale'),
    writeFile(join(root, 'keep.txt'), 'keep'),
  ]);
  await cleanDist(dist);
  assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'keep');
  await assert.rejects(readFile(join(dist, 'stale.js')));
});

test('release artifact pruning retains recent versions and ignores unknown files', async t => {
  const directory = await mkdtemp(testTempPrefix('browser-pilot-release-prune-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = [
    'browser-pilot-0.4.0-darwin-arm64',
    'browser-pilot-0.4.0-darwin-arm64.zip',
    'browser-pilot-0.5.0-darwin-arm64.zip.sha256',
    'browser-pilot-plugin-0.5.0.tgz',
    'browser-pilot-0.6.0-rc.1-linux-x64.tar.gz',
    'browser-pilot-0.6.0-linux-x64.tar.gz',
    'notes.txt',
  ];
  await Promise.all(names.map(async name => {
    const path = join(directory, name);
    if (name === 'browser-pilot-0.4.0-darwin-arm64') await mkdir(path);
    else await writeFile(path, name);
  }));

  const preview = await pruneReleaseArtifacts({ directory, keep: 2, dryRun: true });
  assert.deepEqual(preview.retainedVersions, ['0.6.0-rc.1', '0.6.0']);
  assert.deepEqual(preview.ignored, ['notes.txt']);
  assert.equal(releaseArtifactVersion('browser-pilot-0.5.0-darwin-arm64.zip'), '0.5.0');

  const result = await pruneReleaseArtifacts({ directory, keep: 2 });
  assert.deepEqual(result.removed, [
    'browser-pilot-0.4.0-darwin-arm64',
    'browser-pilot-0.4.0-darwin-arm64.zip',
    'browser-pilot-0.5.0-darwin-arm64.zip.sha256',
    'browser-pilot-plugin-0.5.0.tgz',
  ]);
  assert.equal(await readFile(join(directory, 'notes.txt'), 'utf8'), 'notes.txt');
});

test('release artifact pruning is a no-op before the release directory exists', async t => {
  const root = await mkdtemp(testTempPrefix('browser-pilot-release-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await pruneReleaseArtifacts({ directory: join(root, 'release') });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.retainedVersions, []);
});

test('plugin command metadata and architecture limitations stay explicit', async () => {
  const [browseCommand, platformSpec, commandReference] = await Promise.all([
    readFile(join(root, 'plugin', 'commands', 'browse.md'), 'utf8'),
    readFile(join(root, 'docs', 'architecture', 'browser-pilot-platform-spec.md'), 'utf8'),
    readFile(join(root, 'plugin', 'skills', 'browser-pilot', 'references', 'commands.md'), 'utf8'),
  ]);
  assert.match(browseCommand, /^argument-hint: "\[URL or task\]"$/mu);
  assert.doesNotMatch(browseCommand, /^user-invocable:/mu);
  assert.match(
    browseCommand,
    /\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/browser-pilot\/compatibility\.json/u,
  );
  assert.match(platformSpec, /not a defense against\s+same-user malware/u);
  assert.match(commandReference, /same-process iframe/u);
  assert.match(commandReference, /selected subframe/u);
});
