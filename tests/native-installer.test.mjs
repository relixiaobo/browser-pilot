import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { testTempPrefix } from './helpers/platform.mjs';

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, '..');
const skillRoot = join(root, 'plugin', 'skills', 'browser-pilot');
const posixInstaller = join(skillRoot, 'scripts', 'install-native.sh');
const windowsInstaller = join(skillRoot, 'scripts', 'install-native.ps1');
const fixtureVersion = '9.8.7-test.1';

function nativeTarget() {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return { platform: 'darwin', architecture: 'arm64', extension: 'zip' };
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return { platform: 'linux', architecture: 'x64', extension: 'tar.gz' };
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return { platform: 'win32', architecture: 'x64', extension: 'zip' };
  }
  return undefined;
}

async function createNativeFixture(directory, target) {
  const archiveRoot = `browser-pilot-${fixtureVersion}-${target.platform}-${target.architecture}`;
  const bundle = join(directory, archiveRoot);
  await mkdir(join(bundle, 'licenses'), { recursive: true });
  await Promise.all([
    writeFile(join(bundle, 'LICENSE'), 'fixture license\n'),
    writeFile(join(bundle, 'README.txt'), 'fixture readme\n'),
    writeFile(join(bundle, 'licenses', 'NODE-LICENSE'), 'fixture node license\n'),
  ]);

  if (process.platform === 'win32') {
    await writeFile(join(bundle, 'browser-pilot.exe'), 'fixture executable\n');
  } else {
    const executable = join(bundle, 'browser-pilot');
    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' '${fixtureVersion}'\n`);
    await chmod(executable, 0o755);
  }

  const archiveName = `${archiveRoot}.${target.extension}`;
  const archive = join(directory, archiveName);
  if (process.platform === 'darwin') {
    await execFile('/usr/bin/ditto', [
      '-c', '-k', '--norsrc', '--noextattr', '--keepParent', bundle, archive,
    ]);
  } else if (process.platform === 'win32') {
    await execFile('tar.exe', ['-a', '-c', '-f', archive, archiveRoot], { cwd: directory });
  } else {
    await execFile('tar', ['-czf', archive, archiveRoot], { cwd: directory });
  }

  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${digest}  ${archiveName}\n`);
  return { archive, archiveName };
}

function installerInvocation({ assets, installRoot, binDirectory }) {
  if (process.platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', windowsInstaller,
        '-Version', fixtureVersion,
        '-Repository', 'example/browser-pilot',
        '-AssetDirectory', assets,
        '-InstallRoot', installRoot,
        '-BinDirectory', binDirectory,
      ],
    };
  }
  return {
    command: 'sh',
    args: [
      posixInstaller,
      '--version', fixtureVersion,
      '--repository', 'example/browser-pilot',
      '--asset-directory', assets,
      '--install-root', installRoot,
      '--bin-dir', binDirectory,
    ],
  };
}

async function runInstaller(paths, options = {}) {
  const invocation = installerInvocation(paths);
  const path = options.includeBinInPath === false
    ? process.env.PATH ?? ''
    : `${paths.binDirectory}${delimiter}${process.env.PATH ?? ''}`;
  return execFile(invocation.command, invocation.args, {
    cwd: root,
    env: {
      ...process.env,
      PATH: path,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('native installers are version-parameterized and contain no package-version pin', async () => {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const [posix, windows] = await Promise.all([
    readFile(posixInstaller, 'utf8'),
    readFile(windowsInstaller, 'utf8'),
  ]);
  assert.equal(posix.includes(packageJson.version), false);
  assert.equal(windows.includes(packageJson.version), false);
  assert.equal(windows.includes('Get-FileHash'), false);
  assert.match(posix, /--version/);
  assert.match(windows, /\[string\]\$Version/);
  assert.match(windows, /\[Security\.Cryptography\.SHA256\]::Create\(\)/);
  assert.match(
    windows,
    /function Install-Shim[\s\S]*?\$shim = Join-Path \$Directory "\$Name\.cmd"/,
  );
});

test('native installer verifies and preserves a complete versioned release', {
  skip: nativeTarget() ? false : 'No native Browser Pilot release for this test platform',
}, async t => {
  const temporary = await mkdtemp(testTempPrefix('browser-pilot-native-install-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const assets = join(temporary, 'assets');
  const installRoot = join(temporary, 'install');
  const binDirectory = join(temporary, 'bin');
  await mkdir(assets);
  const target = nativeTarget();
  await createNativeFixture(assets, target);

  const first = await runInstaller({ assets, installRoot, binDirectory });
  assert.match(first.stdout, /^ok=true$/m);
  assert.match(first.stdout, /^channel=native$/m);
  assert.match(first.stdout, /^version=9\.8\.7-test\.1$/m);
  assert.match(first.stdout, /^path_ready=true$/m);

  const targetDirectory = join(
    installRoot,
    'versions',
    `${fixtureVersion}-${target.platform}-${target.architecture}`,
  );
  assert.equal(await readFile(join(targetDirectory, 'LICENSE'), 'utf8'), 'fixture license\n');
  assert.equal(
    await readFile(join(targetDirectory, 'licenses', 'NODE-LICENSE'), 'utf8'),
    'fixture node license\n',
  );

  if (process.platform === 'win32') {
    const shim = await readFile(join(binDirectory, 'bp.cmd'), 'utf8');
    assert.match(shim, /^@rem Browser Pilot managed shim/);
    assert.match(shim, /browser-pilot\.exe/);
  } else {
    assert.equal((await lstat(join(binDirectory, 'bp'))).isSymbolicLink(), true);
    assert.equal(await readlink(join(binDirectory, 'bp')), join(targetDirectory, 'browser-pilot'));
    const result = await execFile(join(binDirectory, 'bp'), ['--version'], { encoding: 'utf8' });
    assert.equal(result.stdout.trim(), fixtureVersion);
  }

  const second = await runInstaller({ assets, installRoot, binDirectory });
  assert.match(second.stdout, /^ok=true$/m);
});

test('native installer rejects a checksum mismatch before installation', {
  skip: nativeTarget() ? false : 'No native Browser Pilot release for this test platform',
}, async t => {
  const temporary = await mkdtemp(testTempPrefix('browser-pilot-native-checksum-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const assets = join(temporary, 'assets');
  const installRoot = join(temporary, 'install');
  const binDirectory = join(temporary, 'bin');
  await mkdir(assets);
  const target = nativeTarget();
  const fixture = await createNativeFixture(assets, target);
  await writeFile(`${fixture.archive}.sha256`, `${'0'.repeat(64)}  ${fixture.archiveName}\n`);

  await assert.rejects(
    runInstaller({ assets, installRoot, binDirectory }),
    error => error.code === 1 && /code=checksum_mismatch/.test(String(error.stderr)),
  );
  await assert.rejects(lstat(installRoot), error => error.code === 'ENOENT');
});

test('native installer reports a command directory that is not on PATH', {
  skip: nativeTarget() ? false : 'No native Browser Pilot release for this test platform',
}, async t => {
  const temporary = await mkdtemp(testTempPrefix('browser-pilot-native-path-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const assets = join(temporary, 'assets');
  const installRoot = join(temporary, 'install');
  const binDirectory = join(temporary, 'not-on-path');
  await mkdir(assets);
  await createNativeFixture(assets, nativeTarget());

  const result = await runInstaller(
    { assets, installRoot, binDirectory },
    { includeBinInPath: false },
  );
  assert.match(result.stdout, /^ok=true$/m);
  assert.match(result.stdout, /^path_ready=false$/m);
  const reportedBinDirectory = /^bin_directory=([^\r\n]+)$/m.exec(result.stdout)?.[1];
  assert.ok(reportedBinDirectory, 'installer must report bin_directory');
  const expectedBinDirectory = process.platform === 'win32'
    ? await realpath(binDirectory)
    : binDirectory;
  assert.equal(
    process.platform === 'win32' ? reportedBinDirectory.toLowerCase() : reportedBinDirectory,
    process.platform === 'win32' ? expectedBinDirectory.toLowerCase() : expectedBinDirectory,
  );
});

test('native installer refuses to replace an unmanaged command before installing a version', {
  skip: nativeTarget() ? false : 'No native Browser Pilot release for this test platform',
}, async t => {
  const temporary = await mkdtemp(testTempPrefix('browser-pilot-native-conflict-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const assets = join(temporary, 'assets');
  const installRoot = join(temporary, 'install');
  const binDirectory = join(temporary, 'bin');
  await Promise.all([mkdir(assets), mkdir(binDirectory)]);
  const target = nativeTarget();
  await createNativeFixture(assets, target);
  const conflict = join(binDirectory, process.platform === 'win32' ? 'bp.exe' : 'bp');
  await writeFile(conflict, 'user-owned command\n');

  await assert.rejects(
    runInstaller({ assets, installRoot, binDirectory }),
    error => error.code === 1 && /code=command_conflict/.test(String(error.stderr)),
  );
  assert.equal(await readFile(conflict, 'utf8'), 'user-owned command\n');
  const targetDirectory = join(
    installRoot,
    'versions',
    `${fixtureVersion}-${target.platform}-${target.architecture}`,
  );
  await assert.rejects(lstat(targetDirectory), error => error.code === 'ENOENT');
});
