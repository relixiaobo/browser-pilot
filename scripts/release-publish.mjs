#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export class ReleasePublishError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleasePublishError';
  }
}

async function defaultCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      status: typeof error.code === 'number' ? error.code : 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message ?? ''),
    };
  }
}

function checkedResult(result, label) {
  if (result.status === 0) return result;
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new ReleasePublishError(`${label} failed${detail ? `: ${detail}` : ''}`);
}

function isGitHubNotFound(result) {
  return result.status !== 0 && /(?:HTTP\s+404|not found)/i.test(result.stderr);
}

function isNpmNotFound(result) {
  return result.status !== 0 && /(?:E404|404 Not Found|is not in this registry)/i.test(result.stderr);
}

function npmArchiveName(packageName, version) {
  return `${packageName.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`;
}

function sha512Integrity(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function verifyNpmArchive(archivePath, integrityPath) {
  const expected = (await readFile(integrityPath, 'utf8')).trim();
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(expected)) {
    throw new ReleasePublishError(`Invalid npm integrity sidecar ${basename(integrityPath)}`);
  }
  const actual = sha512Integrity(await readFile(archivePath));
  if (actual !== expected) {
    throw new ReleasePublishError(`npm archive integrity mismatch for ${basename(archivePath)}`);
  }
  return actual;
}

async function verifySha256Sidecars(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const sidecars = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.sha256'))
    .map(entry => entry.name)
    .sort();
  if (sidecars.length === 0) {
    throw new ReleasePublishError('Release assets contain no SHA-256 sidecars');
  }
  for (const sidecar of sidecars) {
    const line = (await readFile(join(directory, sidecar), 'utf8')).trim();
    const match = /^([a-f0-9]{64})  ([^/\\]+)$/.exec(line);
    if (!match || `${match[2]}.sha256` !== sidecar) {
      throw new ReleasePublishError(`Invalid checksum sidecar ${sidecar}`);
    }
    const targetPath = join(directory, match[2]);
    const actual = createHash('sha256').update(await readFile(targetPath)).digest('hex');
    if (actual !== match[1]) {
      throw new ReleasePublishError(`Release asset checksum mismatch for ${match[2]}`);
    }
  }
  return sidecars.length;
}

async function releaseState(runGh, repository, tag, cwd) {
  const result = await runGh([
    'api',
    `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
  ], { cwd });
  if (isGitHubNotFound(result)) return undefined;
  checkedResult(result, `Inspect GitHub release ${tag}`);
  let release;
  try {
    release = JSON.parse(result.stdout);
  } catch {
    throw new ReleasePublishError(`GitHub returned invalid release metadata for ${tag}`);
  }
  if (typeof release.draft !== 'boolean') {
    throw new ReleasePublishError(`GitHub release metadata for ${tag} has no draft state`);
  }
  return { draft: release.draft, prerelease: release.prerelease === true };
}

async function registryIntegrity(runNpm, packageName, version, cwd) {
  const result = await runNpm([
    'view',
    `${packageName}@${version}`,
    'dist.integrity',
    '--json',
  ], { cwd });
  if (isNpmNotFound(result)) return undefined;
  checkedResult(result, `Inspect npm package ${packageName}@${version}`);
  let integrity;
  try {
    integrity = JSON.parse(result.stdout);
  } catch {
    throw new ReleasePublishError(`npm returned invalid integrity metadata for ${packageName}@${version}`);
  }
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    throw new ReleasePublishError(`npm package ${packageName}@${version} has invalid integrity metadata`);
  }
  return integrity;
}

async function packNpmArchive(runNpm, root, assetsDirectory, archiveName) {
  const result = checkedResult(await runNpm([
    'pack',
    '--json',
    '--pack-destination',
    assetsDirectory,
  ], { cwd: root }), 'Pack npm release archive');
  let entries;
  try {
    entries = JSON.parse(result.stdout);
  } catch {
    throw new ReleasePublishError('npm pack returned invalid JSON');
  }
  if (!Array.isArray(entries) || entries.length !== 1 || entries[0]?.filename !== archiveName) {
    throw new ReleasePublishError(`npm pack did not produce the expected ${archiveName}`);
  }
  const archivePath = join(assetsDirectory, archiveName);
  const integrityPath = `${archivePath}.integrity`;
  const integrity = sha512Integrity(await readFile(archivePath));
  await writeFile(integrityPath, `${integrity}\n`);
  return integrity;
}

async function downloadDraftNpmArchive(
  runGh,
  repository,
  tag,
  archiveName,
  assetsDirectory,
  cwd,
) {
  const temporary = await mkdtemp(join(tmpdir(), 'browser-pilot-release-npm-'));
  try {
    const result = await runGh([
      'release', 'download', tag,
      '--repo', repository,
      '--pattern', archiveName,
      '--pattern', `${archiveName}.integrity`,
      '--dir', temporary,
    ], { cwd });
    const archivePath = join(temporary, archiveName);
    const integrityPath = `${archivePath}.integrity`;
    const archiveExists = await pathExists(archivePath);
    const integrityExists = await pathExists(integrityPath);
    if (archiveExists !== integrityExists) {
      throw new ReleasePublishError('Draft release has a partial npm archive identity');
    }
    if (!archiveExists) {
      if (result.status !== 0 && !/(?:no assets|no files|not found|did not match)/i.test(result.stderr)) {
        checkedResult(result, `Download npm archive from draft release ${tag}`);
      }
      return undefined;
    }
    checkedResult(result, `Download npm archive from draft release ${tag}`);
    await copyFile(archivePath, join(assetsDirectory, archiveName));
    await copyFile(integrityPath, join(assetsDirectory, `${archiveName}.integrity`));
    return verifyNpmArchive(
      join(assetsDirectory, archiveName),
      join(assetsDirectory, `${archiveName}.integrity`),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifyPublicRelease(
  runGh,
  runNpm,
  repository,
  tag,
  packageName,
  version,
  archiveName,
  cwd,
) {
  const temporary = await mkdtemp(join(tmpdir(), 'browser-pilot-public-release-'));
  try {
    checkedResult(await runGh([
      'release', 'download', tag,
      '--repo', repository,
      '--dir', temporary,
    ], { cwd }), `Download public release ${tag}`);
    const checksumsVerified = await verifySha256Sidecars(temporary);
    const archivePath = join(temporary, archiveName);
    const integrityPath = `${archivePath}.integrity`;
    if (!await pathExists(archivePath) || !await pathExists(integrityPath)) {
      throw new ReleasePublishError('Public release is missing the authoritative npm archive or integrity sidecar');
    }
    const releaseIntegrity = await verifyNpmArchive(archivePath, integrityPath);
    const publishedIntegrity = await registryIntegrity(runNpm, packageName, version, cwd);
    if (!publishedIntegrity) {
      throw new ReleasePublishError(`Public release exists but ${packageName}@${version} is absent from npm`);
    }
    if (publishedIntegrity !== releaseIntegrity) {
      throw new ReleasePublishError('Public release npm archive does not match the npm registry integrity');
    }
    return { releaseIntegrity, checksumsVerified };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function regularFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(directory, entry.name);
    if ((await stat(path)).size === 0) {
      throw new ReleasePublishError(`Release asset is empty: ${entry.name}`);
    }
    paths.push(path);
  }
  return paths.sort();
}

export async function publishRelease(options, dependencies = {}) {
  const root = resolve(options.root ?? scriptRoot);
  const assetsDirectory = resolve(options.assetsDirectory);
  const tag = options.tag;
  const repository = options.repository;
  if (!tag || !repository || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new ReleasePublishError('A release tag and owner/repository are required');
  }
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const packageName = packageJson.name;
  const version = packageJson.version;
  if (tag !== `v${version}`) {
    throw new ReleasePublishError(`Release tag ${tag} does not match package version ${version}`);
  }
  await mkdir(assetsDirectory, { recursive: true });
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const runGh = dependencies.runGh ?? ((args, commandOptions) => (
    defaultCommand('gh', args, commandOptions)
  ));
  const runNpm = dependencies.runNpm ?? ((args, commandOptions) => (
    defaultCommand(npmCommand, args, commandOptions)
  ));
  const sleep = dependencies.sleep ?? (ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)));
  const archiveName = npmArchiveName(packageName, version);
  const archivePath = join(assetsDirectory, archiveName);
  const integrityPath = `${archivePath}.integrity`;
  const prerelease = version.includes('-');

  const release = await releaseState(runGh, repository, tag, root);
  const registryBefore = await registryIntegrity(runNpm, packageName, version, root);
  if (release && !release.draft) {
    const verified = await verifyPublicRelease(
      runGh,
      runNpm,
      repository,
      tag,
      packageName,
      version,
      archiveName,
      root,
    );
    return {
      ok: true,
      state: 'already_public',
      npmPublished: false,
      packed: false,
      integrity: verified.releaseIntegrity,
      checksumsVerified: verified.checksumsVerified,
    };
  }
  if (!release && registryBefore) {
    throw new ReleasePublishError(
      `npm already contains ${packageName}@${version}, but draft release ${tag} is missing`,
    );
  }

  await rm(archivePath, { force: true });
  await rm(integrityPath, { force: true });
  let integrity = release
    ? await downloadDraftNpmArchive(
        runGh,
        repository,
        tag,
        archiveName,
        assetsDirectory,
        root,
      )
    : undefined;
  let packed = false;
  if (!integrity) {
    if (registryBefore) {
      throw new ReleasePublishError('npm is published but the draft release has no authoritative npm archive');
    }
    integrity = await packNpmArchive(runNpm, root, assetsDirectory, archiveName);
    packed = true;
  }
  if (registryBefore && registryBefore !== integrity) {
    throw new ReleasePublishError('Draft npm archive does not match the npm registry integrity');
  }
  const checksumsVerified = await verifySha256Sidecars(assetsDirectory);
  await verifyNpmArchive(archivePath, integrityPath);

  if (!release) {
    const createArgs = [
      'release', 'create', tag,
      '--repo', repository,
      '--verify-tag',
      '--draft',
    ];
    if (prerelease) createArgs.push('--prerelease');
    if (options.notesFile && await pathExists(options.notesFile)) {
      createArgs.push('--notes-file', resolve(options.notesFile));
    } else {
      createArgs.push('--generate-notes');
    }
    checkedResult(await runGh(createArgs, { cwd: root }), `Create draft release ${tag}`);
  }

  const assets = await regularFiles(assetsDirectory);
  checkedResult(await runGh([
    'release', 'upload', tag,
    '--repo', repository,
    '--clobber',
    ...assets,
  ], { cwd: root }), `Upload draft release ${tag}`);

  const registryAfterUpload = await registryIntegrity(runNpm, packageName, version, root);
  let npmPublished = false;
  if (registryAfterUpload) {
    if (registryAfterUpload !== integrity) {
      throw new ReleasePublishError('Published npm package integrity differs from the draft release archive');
    }
  } else {
    const publishArgs = ['publish', archivePath, '--access', 'public', '--provenance'];
    if (prerelease) publishArgs.push('--tag', 'next');
    checkedResult(await runNpm(publishArgs, { cwd: root }), `Publish ${packageName}@${version} to npm`);
    npmPublished = true;
    let observedIntegrity;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      observedIntegrity = await registryIntegrity(runNpm, packageName, version, root);
      if (observedIntegrity) break;
      if (attempt < 29) await sleep(2_000);
    }
    if (observedIntegrity !== integrity) {
      throw new ReleasePublishError('npm publish completed without the expected registry integrity');
    }
  }

  checkedResult(await runGh([
    'release', 'edit', tag,
    '--repo', repository,
    '--draft=false',
  ], { cwd: root }), `Publish GitHub release ${tag}`);
  return {
    ok: true,
    state: 'published',
    npmPublished,
    packed,
    integrity,
    checksumsVerified,
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const assetsDirectory = argument('--assets');
  const tag = argument('--tag') ?? process.env.GITHUB_REF_NAME;
  const repository = argument('--repository') ?? process.env.GITHUB_REPOSITORY;
  if (!assetsDirectory) {
    process.stderr.write('release-publish: --assets is required\n');
    process.exitCode = 1;
  } else {
    const defaultNotes = tag ? join(scriptRoot, 'docs', 'releases', `${tag}.md`) : undefined;
    publishRelease({
      root: scriptRoot,
      assetsDirectory,
      tag,
      repository,
      notesFile: argument('--notes-file') ?? defaultNotes,
    }).then(result => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }).catch(error => {
      process.stderr.write(`release-publish: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
