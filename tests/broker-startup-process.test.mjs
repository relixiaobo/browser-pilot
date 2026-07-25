import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const CLI = join(process.cwd(), 'dist', 'cli.js');

function bridgeInput(instanceId) {
  return [
    {
      jsonrpc: '2.0', id: 'initialize', method: 'initialize',
      params: {
        client: {
          id: 'com.example.startup-test',
          name: 'Startup Test',
          version: '1.0.0',
          instanceId,
        },
        protocol: { min: { major: 1, minor: 1 }, max: { major: 1, minor: 1 } },
        requestedCapabilities: ['browser.discovery'],
        launchMode: 'embedded',
      },
    },
    { jsonrpc: '2.0', id: 'shutdown', method: 'shutdown', params: {} },
  ].map(message => JSON.stringify(message)).join('\n') + '\n';
}

function runBridge(root, instanceId) {
  const child = spawn(process.execPath, [CLI, 'bridge', '--stdio'], {
    env: { ...process.env, HOME: root, PATH: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes.toString(); });
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  child.stdin.end(bridgeInput(instanceId));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolve({
        code,
        signal,
        stderr,
        messages: stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
      });
    });
  });
}

function daemonRequest(socketPath, path, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path,
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('simultaneous bridge processes start and reuse exactly one per-user Broker', async t => {
  const root = await mkdtemp('/tmp/bp-startup-process-');
  const stateDir = join(root, '.browser-pilot');
  const socketPath = join(stateDir, 'daemon.sock');
  t.after(async () => {
    await daemonRequest(socketPath, '/shutdown', {}).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const [first, second] = await Promise.all([
    runBridge(root, 'startup:first'),
    runBridge(root, 'startup:second'),
  ]);
  for (const result of [first, second]) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.deepEqual(result.messages.map(message => message.id), ['initialize', 'shutdown']);
    assert.equal(result.messages[0].error, undefined);
  }
  assert.equal(
    first.messages[0].result.brokerProcessIdentity,
    second.messages[0].result.brokerProcessIdentity,
  );

  const locator = JSON.parse(await readFile(join(stateDir, 'broker-locator.json'), 'utf8'));
  assert.equal(locator.brokerProcessIdentity, first.messages[0].result.brokerProcessIdentity);
  assert.equal(locator.endpoint, socketPath);
  assert.equal(locator.transport, 'unix_socket');

  process.kill(locator.pid, 'SIGKILL');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(locator.pid, 0);
      await new Promise(resolve => setTimeout(resolve, 20));
    } catch {
      break;
    }
  }
  assert.throws(() => process.kill(locator.pid, 0));

  const recovered = await runBridge(root, 'startup:recovered');
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(recovered.messages[0].error, undefined);
  assert.notEqual(
    recovered.messages[0].result.brokerProcessIdentity,
    locator.brokerProcessIdentity,
  );
});

test('a live but unresponsive Broker is reported and never silently replaced', async t => {
  const root = await mkdtemp('/tmp/bp-unresponsive-process-');
  const stateDir = join(root, '.browser-pilot');
  const socketPath = join(stateDir, 'daemon.sock');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const locator = {
    schemaVersion: 1,
    pid: process.pid,
    endpoint: socketPath,
    transport: 'unix_socket',
    startedAt: Date.now(),
    brokerProcessIdentity: 'broker:live-but-unresponsive',
  };
  await writeFile(
    join(stateDir, 'broker-locator.json'),
    `${JSON.stringify(locator)}\n`,
    { mode: 0o600 },
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await runBridge(root, 'startup:unresponsive');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.messages[0].error.data.code, 'browser_disconnected');
  assert.equal(
    result.messages[0].error.data.remediation.code,
    'restart_unresponsive_broker',
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(stateDir, 'broker-locator.json'), 'utf8')),
    locator,
  );
  await assert.rejects(access(socketPath));
});
