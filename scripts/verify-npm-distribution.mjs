#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const npmInvocation = process.env.npm_execpath
  ? { command: process.execPath, prefix: [process.env.npm_execpath] }
  : { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [] };

function execute(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    shell: options.shell ?? false,
    stdio: options.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', value => { stdout += value.toString(); });
  child.stderr.on('data', value => { stderr += value.toString(); });
  if (options.input !== undefined) child.stdin.end(options.input);
  return new Promise((resolveExecution, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out`));
    }, options.timeoutMs ?? 30_000);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExecution({ code, signal, stdout, stderr });
    });
  });
}

function npm(args, options = {}) {
  return execute(npmInvocation.command, [...npmInvocation.prefix, ...args], options);
}

function executableInvocation(path) {
  if (process.platform === 'win32') {
    return { command: path, prefix: [], shell: true };
  }
  return { command: path, prefix: [], shell: false };
}

async function verifyMode(name, invocation, env, cwd) {
  const version = await execute(
    invocation.command,
    [...invocation.prefix, '--version'],
    { cwd, env, shell: invocation.shell },
  );
  assert.equal(version.code, 0, `${name} version failed: ${version.stderr}`);
  assert.equal(version.stdout.trim(), packageJson.version);

  const help = await execute(
    invocation.command,
    [...invocation.prefix, '--help'],
    { cwd, env, shell: invocation.shell },
  );
  assert.equal(help.code, 0, `${name} help failed: ${help.stderr}`);
  assert.doesNotMatch(help.stdout, /bridge --stdio/u);
  assert.match(help.stdout, /status/u);
  assert.match(help.stdout, /--client-key/u);

  const status = await execute(
    invocation.command,
    [...invocation.prefix, 'status'],
    { cwd, env, shell: invocation.shell },
  );
  assert.equal(status.code, 0, `${name} status failed: ${status.stderr}`);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.service.version, packageJson.version);
}

const temporary = await mkdtemp(join(tmpdir(), 'browser-pilot-npm-distribution-'));
try {
  const packDirectory = join(temporary, 'pack');
  const globalPrefix = join(temporary, 'global');
  const localProject = join(temporary, 'local-project');
  const npmCache = join(temporary, 'npm-cache');
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(localProject, { recursive: true }),
  ]);
  await writeFile(join(localProject, 'package.json'), JSON.stringify({
    name: 'browser-pilot-distribution-fixture',
    private: true,
    version: '1.0.0',
  }));
  const npmEnv = { ...process.env, npm_config_cache: npmCache };
  const packed = await npm(
    ['pack', '--json', '--pack-destination', packDirectory],
    { cwd: root, env: npmEnv },
  );
  assert.equal(packed.code, 0, packed.stderr);
  const packResult = JSON.parse(packed.stdout);
  assert.equal(packResult.length, 1);
  const tarball = join(packDirectory, packResult[0].filename);

  const installGlobal = await npm([
    'install', '--global', '--prefix', globalPrefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball,
  ], { env: npmEnv, timeoutMs: 120_000 });
  assert.equal(installGlobal.code, 0, installGlobal.stderr);
  const installLocal = await npm([
    'install', '--prefix', localProject, '--ignore-scripts', '--no-audit', '--no-fund', tarball,
  ], { env: npmEnv, timeoutMs: 120_000 });
  assert.equal(installLocal.code, 0, installLocal.stderr);

  const basePath = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`;
  const globalBin = process.platform === 'win32'
    ? join(globalPrefix, 'browser-pilot.cmd')
    : join(globalPrefix, 'bin', 'browser-pilot');
  const globalHome = join(temporary, 'global-home');
  await verifyMode('global-npm', executableInvocation(globalBin), {
    ...process.env,
    HOME: globalHome,
    USERPROFILE: globalHome,
    BROWSER_PILOT_HOME: join(globalHome, 'state'),
    PATH: basePath,
  }, temporary);

  const npxHome = join(temporary, 'npx-home');
  await verifyMode('local-npx', {
    command: npmInvocation.command,
    prefix: [...npmInvocation.prefix, '--prefix', localProject, 'exec', '--offline', '--', 'browser-pilot'],
    shell: false,
  }, {
    ...process.env,
    HOME: npxHome,
    USERPROFILE: npxHome,
    BROWSER_PILOT_HOME: join(npxHome, 'state'),
    npm_config_cache: npmCache,
    PATH: basePath,
  }, localProject);

  const bundledHome = join(temporary, 'bundled-home');
  const bundledCli = join(localProject, 'node_modules', packageJson.name, 'dist', 'cli.js');
  await verifyMode('product-bundled-absolute-path', {
    command: process.execPath,
    prefix: [bundledCli],
    shell: false,
  }, {
    ...process.env,
    BROWSER_PILOT_INTERNAL_LAYOUT: 'sea-v1',
    HOME: bundledHome,
    USERPROFILE: bundledHome,
    BROWSER_PILOT_HOME: join(bundledHome, 'state'),
    PATH: basePath,
  }, localProject);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    version: packageJson.version,
    modes: ['global-npm', 'local-npx', 'product-bundled-absolute-path'],
  })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
