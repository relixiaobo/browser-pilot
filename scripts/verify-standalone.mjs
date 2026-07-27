#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const suffix = process.platform === 'win32' ? '.exe' : '';
const defaultBundle = join(
  root,
  'release',
  `browser-pilot-${packageJson.version}-${process.platform}-${process.arch}`,
);
const bundleIndex = process.argv.indexOf('--bundle');
const bundle = bundleIndex === -1 ? defaultBundle : resolve(process.argv[bundleIndex + 1] ?? '');

function execute(command, args, options = {}) {
  const child = spawn(command, args, {
    env: options.env ?? process.env,
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

async function verifyJanitor(path) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolveListen, reject) => {
    server.once('listening', resolveListen);
    server.once('error', reject);
  });
  let connectionCount = 0;
  server.on('connection', socket => {
    connectionCount += 1;
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      const result = message.method === 'Target.getTargets' ? { targetInfos: [] } : {};
      if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  const port = server.address().port;
  const child = spawn(path, [
    '--browser-pilot-internal=janitor',
    `ws://127.0.0.1:${port}/devtools/browser/release-test`,
  ], {
    stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
    serialization: 'advanced',
    windowsHide: true,
  });
  let stderr = '';
  let ready = false;
  let proxied = false;
  child.on('message', message => {
    if (message?.event === 'ready') {
      ready = true;
      child.send({
        id: 1,
        method: 'cdp.send',
        params: { method: 'Target.getTargets' },
      });
    } else if (message?.id === 1) {
      assert.deepEqual(message.result, { targetInfos: [] });
      proxied = true;
      child.stdin.end();
    }
  });
  child.stderr.on('data', value => { stderr += value.toString(); });
  let result;
  try {
    result = await new Promise((resolveExit, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Private janitor role timed out'));
      }, 30_000);
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolveExit({ code, signal });
      });
    });
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolveClose => server.close(resolveClose));
  }
  assert.equal(result.code, 0, stderr);
  assert.equal(ready, true);
  assert.equal(proxied, true);
  assert.equal(connectionCount, 1);
}

const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.version, packageJson.version);
assert.equal(manifest.platform, process.platform);
assert.equal(manifest.arch, process.arch);
assert.equal(manifest.runtime.kind, 'node_sea');
assert.equal(manifest.files.length, 6);
const expectedSignatureKinds = process.platform === 'darwin'
  ? ['adhoc', 'developer_id']
  : process.platform === 'win32'
    ? ['unsigned', 'authenticode']
    : ['unsigned'];
assert.ok(expectedSignatureKinds.includes(manifest.signature.kind));
for (const file of manifest.files) {
  const path = join(bundle, file.path);
  assert.equal(relative(bundle, path).startsWith('..'), false);
  assert.equal((await stat(path)).size, file.bytes);
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), file.sha256);
}
const checksumLines = (await readFile(join(bundle, 'SHA256SUMS'), 'utf8')).trim().split('\n');
assert.deepEqual(
  checksumLines,
  manifest.files.map(file => `${file.sha256}  ${file.path}`),
);

const executable = join(bundle, `browser-pilot${suffix}`);
if (process.platform === 'darwin') {
  const signature = await execute('/usr/bin/codesign', ['--verify', '--strict', executable]);
  assert.equal(signature.code, 0, signature.stderr);
}
const version = await execute(executable, ['--version']);
assert.equal(version.code, 0, version.stderr);
assert.equal(version.stdout.trim(), packageJson.version);

const home = await mkdtemp(join(tmpdir(), 'browser-pilot-standalone-verify-'));
try {
  const env = { ...process.env, HOME: home, BROWSER_PILOT_HOME: join(home, 'state'), PATH: '' };
  const help = await execute(executable, ['--help'], { env });
  assert.equal(help.code, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /bridge --stdio/u);
  assert.match(help.stdout, /status/u);
  const status = await execute(executable, ['status'], { env });
  assert.equal(status.code, 0, status.stderr);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.service.version, packageJson.version);
  await verifyJanitor(executable);
} finally {
  await rm(home, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ ok: true, bundle })}\n`);
