#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { BROWSER_PILOT_REPOSITORY } from './release-version-utils.mjs';

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = packageJson.version;

function currentTarget() {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return { platform: 'darwin', architecture: 'arm64', extension: 'zip' };
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return { platform: 'linux', architecture: 'x64', extension: 'tar.gz' };
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return { platform: 'win32', architecture: 'x64', extension: 'zip' };
  }
  throw new Error(`No native installer verification target for ${process.platform}-${process.arch}`);
}

function installerInvocation(paths) {
  if (process.platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', join(root, 'plugin', 'skills', 'browser-pilot', 'scripts', 'install-native.ps1'),
        '-Version', version,
        '-Repository', BROWSER_PILOT_REPOSITORY,
        '-AssetDirectory', paths.assets,
        '-InstallRoot', paths.installRoot,
        '-BinDirectory', paths.binDirectory,
      ],
    };
  }
  return {
    command: 'sh',
    args: [
      join(root, 'plugin', 'skills', 'browser-pilot', 'scripts', 'install-native.sh'),
      '--version', version,
      '--repository', BROWSER_PILOT_REPOSITORY,
      '--asset-directory', paths.assets,
      '--install-root', paths.installRoot,
      '--bin-dir', paths.binDirectory,
    ],
  };
}

const target = currentTarget();
const archiveName = `browser-pilot-${version}-${target.platform}-${target.architecture}.${target.extension}`;
const assetsIndex = process.argv.indexOf('--assets');
if (assetsIndex !== -1 && !process.argv[assetsIndex + 1]) {
  throw new Error('--assets requires a directory');
}
const assetsDirectory = assetsIndex === -1
  ? join(root, 'release')
  : resolve(process.argv[assetsIndex + 1]);
const archivePath = join(assetsDirectory, archiveName);
await stat(archivePath);
await stat(`${archivePath}.sha256`);

const temporary = await mkdtemp(join(tmpdir(), 'browser-pilot-native-installer-'));
try {
  const paths = {
    assets: assetsDirectory,
    installRoot: join(temporary, 'install'),
    binDirectory: join(temporary, 'bin'),
  };
  await mkdir(paths.binDirectory);
  const invocation = installerInvocation(paths);
  const environment = {
    ...process.env,
    PATH: `${paths.binDirectory}${delimiter}${process.env.PATH ?? ''}`,
  };
  const installed = await execFile(invocation.command, invocation.args, {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
  assert.match(installed.stdout, /^ok=true$/m);
  assert.match(installed.stdout, /^channel=native$/m);
  assert.match(installed.stdout, /^path_ready=true$/m);

  const installedBundle = join(
    paths.installRoot,
    'versions',
    `${version}-${target.platform}-${target.architecture}`,
  );
  const commandEntry = join(paths.binDirectory, process.platform === 'win32' ? 'bp.cmd' : 'bp');
  await stat(commandEntry);
  const command = process.platform === 'win32'
    ? join(installedBundle, 'browser-pilot.exe')
    : commandEntry;
  const checked = await execFile(command, ['--version'], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  assert.equal(checked.stdout.trim(), version);

  await stat(join(installedBundle, 'LICENSE'));
  await stat(join(installedBundle, 'licenses', 'NODE-LICENSE'));

  process.stdout.write(`${JSON.stringify({
    ok: true,
    version,
    target: `${target.platform}-${target.architecture}`,
    archive: archiveName,
  })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
