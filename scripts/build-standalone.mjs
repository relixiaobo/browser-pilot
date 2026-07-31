#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const minimumNode = [20, 12, 0];
const execFileAsync = promisify(execFile);
const seaFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const executableDefinition = {
  key: 'standalone',
  name: 'browser-pilot',
  role: 'public_cli_with_private_child_roles',
};

function assertSupportedNode(version) {
  const current = version.split('.').map(Number);
  for (let index = 0; index < minimumNode.length; index += 1) {
    if (current[index] > minimumNode[index]) return;
    if (current[index] < minimumNode[index]) {
      throw new Error('Standalone builds require Node.js 20.12.0 or newer');
    }
  }
}

function outputDirectory(runtime) {
  const index = process.argv.indexOf('--output');
  if (index === -1) {
    return join(root, 'release', `browser-pilot-${packageJson.version}-${runtime.platform}-${runtime.arch}`);
  }
  const value = process.argv[index + 1];
  if (!value) throw new Error('--output requires a directory');
  return resolve(value);
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
      ...options,
    });
    let stderr = '';
    if (options.capture) child.stderr.on('data', value => { stderr += value.toString(); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(
        `${command} exited ${signal ? `from ${signal}` : `with code ${code ?? 'unknown'}`}` +
        (stderr ? `: ${stderr.trim().slice(0, 2000)}` : ''),
      ));
    });
  });
}

async function findNodeLicense(nodeExecutable) {
  let directory = dirname(nodeExecutable);
  for (let depth = 0; depth < 5; depth += 1) {
    for (const name of ['LICENSE', 'LICENSE.md']) {
      const candidate = join(directory, name);
      try {
        await stat(candidate);
        return candidate;
      } catch { /* continue */ }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Cannot locate the Node.js license near ${nodeExecutable}`);
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function signMacBinary(path) {
  const identity = process.env.BROWSER_PILOT_MACOS_SIGN_IDENTITY;
  const args = identity
    ? [
      '--force',
      '--options', 'runtime',
      '--timestamp',
      '--entitlements', join(root, 'scripts', 'macos-entitlements.plist'),
      '--sign', identity,
      path,
    ]
    : ['--force', '--sign', '-', path];
  await run('/usr/bin/codesign', args);
  await run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', path]);
  return identity
    ? { kind: 'developer_id', identity }
    : { kind: 'adhoc' };
}

async function signWindowsBinary(path) {
  const thumbprint = process.env.BROWSER_PILOT_WINDOWS_SIGN_SHA1?.replaceAll(' ', '');
  if (!thumbprint) return { kind: 'unsigned' };
  if (!/^[a-f\d]{40}$/i.test(thumbprint)) {
    throw new Error('BROWSER_PILOT_WINDOWS_SIGN_SHA1 must be a 40-character SHA-1 certificate thumbprint');
  }
  const signtool = process.env.BROWSER_PILOT_SIGNTOOL ?? 'signtool.exe';
  const timestampUrl = process.env.BROWSER_PILOT_WINDOWS_TIMESTAMP_URL
    ?? 'http://timestamp.digicert.com';
  await run(signtool, [
    'sign',
    '/fd', 'SHA256',
    '/sha1', thumbprint,
    '/tr', timestampUrl,
    '/td', 'SHA256',
    path,
  ]);
  await run(signtool, ['verify', '/pa', path]);
  return { kind: 'authenticode', certificateThumbprint: thumbprint.toUpperCase() };
}

async function buildBinary(role, directory, temporary, seaNode) {
  const extension = process.platform === 'win32' ? '.exe' : '';
  const executable = join(directory, `${role.name}${extension}`);
  const blob = join(temporary, `${role.key}.blob`);
  const config = join(temporary, `${role.key}.json`);
  await writeFile(config, `${JSON.stringify({
    main: join(root, 'build', 'standalone-js', `${role.key}.cjs`),
    output: blob,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
  }, null, 2)}\n`);
  await run(seaNode, ['--experimental-sea-config', config]);
  await copyFile(seaNode, executable, fsConstants.COPYFILE_FICLONE);
  if (process.platform !== 'win32') await chmod(executable, 0o755);
  if (process.platform === 'darwin') {
    await run('/usr/bin/codesign', ['--remove-signature', executable], { capture: true }).catch(() => {});
  }
  const postject = join(root, 'node_modules', 'postject', 'dist', 'cli.js');
  const postjectArgs = [postject, executable, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', seaFuse];
  if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  await run(process.execPath, postjectArgs);
  return executable;
}

const seaNode = resolve(process.env.BROWSER_PILOT_SEA_NODE ?? process.execPath);
const { stdout: runtimeJson } = await execFileAsync(seaNode, [
  '-p',
  'JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch,sea:process.config.variables.single_executable_application===true})',
]);
const runtime = JSON.parse(runtimeJson);
assertSupportedNode(runtime.version);
if (!runtime.sea) {
  throw new Error(
    `${seaNode} was built without Node.js SEA support; set BROWSER_PILOT_SEA_NODE to an official SEA-capable Node executable`,
  );
}
if (runtime.platform !== process.platform || runtime.arch !== process.arch) {
  throw new Error('Standalone artifacts must be built and verified with a native Node runtime for this platform and architecture');
}
const directory = outputDirectory(runtime);
const relativeOutput = relative(root, directory);
if (relativeOutput.startsWith('..') || resolve(root, relativeOutput) !== directory) {
  throw new Error('Standalone output must remain inside the Browser Pilot repository');
}
const temporary = await mkdtemp(join(tmpdir(), 'browser-pilot-sea-'));
await rm(directory, { recursive: true, force: true });
await mkdir(join(directory, 'licenses'), { recursive: true });

try {
  const executable = {
    ...executableDefinition,
    path: await buildBinary(executableDefinition, directory, temporary, seaNode),
  };

  let signature = { kind: 'unsigned' };
  if (process.platform === 'darwin') {
    signature = await signMacBinary(executable.path);
  } else if (process.platform === 'win32') {
    signature = await signWindowsBinary(executable.path);
  }

  await copyFile(join(root, 'LICENSE'), join(directory, 'LICENSE'));
  await copyFile(await findNodeLicense(seaNode), join(directory, 'licenses', 'NODE-LICENSE'));
  await copyFile(join(root, 'node_modules', 'commander', 'LICENSE'), join(directory, 'licenses', 'commander-LICENSE'));
  await copyFile(join(root, 'node_modules', 'ws', 'LICENSE'), join(directory, 'licenses', 'ws-LICENSE'));
  await writeFile(join(directory, 'README.txt'), [
    `Browser Pilot ${packageJson.version} (${runtime.platform}-${runtime.arch})`,
    '',
    `Run: .${process.platform === 'win32' ? '\\' : '/'}browser-pilot --help`,
    `Then: .${process.platform === 'win32' ? '\\' : '/'}browser-pilot connect`,
    'The Broker and managed-target janitor run as private roles of this executable.',
    'Do not invoke --browser-pilot-internal options directly.',
    '',
  ].join('\n'));

  const distributableFiles = [
    { path: executable.path, role: executable.role },
    { path: join(directory, 'LICENSE'), role: 'license' },
    { path: join(directory, 'README.txt'), role: 'readme' },
    { path: join(directory, 'licenses', 'NODE-LICENSE'), role: 'runtime_license' },
    { path: join(directory, 'licenses', 'commander-LICENSE'), role: 'dependency_license' },
    { path: join(directory, 'licenses', 'ws-LICENSE'), role: 'dependency_license' },
  ];
  const files = [];
  for (const file of distributableFiles) {
    files.push({
      path: relative(directory, file.path).replaceAll('\\', '/'),
      role: file.role,
      bytes: (await stat(file.path)).size,
      sha256: await sha256(file.path),
    });
  }
  const manifest = {
    schemaVersion: 1,
    product: 'browser-pilot',
    version: packageJson.version,
    platform: runtime.platform,
    arch: runtime.arch,
    runtime: { kind: 'node_sea', nodeVersion: runtime.version },
    signature,
    files,
  };
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    join(directory, 'SHA256SUMS'),
    `${files.map(file => `${file.sha256}  ${file.path}`).join('\n')}\n`,
  );
  process.stdout.write(`${JSON.stringify({ ok: true, directory, manifest })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
