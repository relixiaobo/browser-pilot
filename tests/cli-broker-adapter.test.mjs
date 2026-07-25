import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFile = promisify(execFileCallback);
const CLI = resolve(import.meta.dirname, '../dist/cli.js');
const PACKAGE_VERSION = JSON.parse(
  await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'),
).version;

function artifact(id, kind, mimeType, fileName) {
  return {
    id,
    workspaceId: 'workspace:cli',
    kind,
    mimeType,
    byteSize: 12,
    fileName,
    sensitivity: kind === 'upload_input' ? 'user_file' : 'browser_data',
    createdAt: 1,
    expiresAt: 301_000,
    retained: false,
  };
}

function observation(overrides = {}) {
  return {
    workspaceId: 'workspace:cli',
    leaseId: 'lease:cli',
    targetId: 'target:managed',
    url: 'https://example.test/form',
    observationId: 'observation:current',
    title: 'Example Form',
    elements: [{ ref: 1, role: 'button', name: 'Submit' }],
    truncated: false,
    truncationReasons: [],
    hints: [],
    ...overrides,
  };
}

async function startFakeDaemon(root) {
  const stateDirectory = join(root, '.browser-pilot');
  const socketPath = join(stateDirectory, 'daemon.sock');
  const calls = [];
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(join(stateDirectory, 'daemon.pid'), String(process.pid));

  const toolResult = async (name, args) => {
    switch (name) {
      case 'browser.tabs.list':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          targets: [{
            targetId: 'target:managed',
            title: 'Example Form',
            url: 'https://example.test/form',
            active: true,
            origin: 'managed',
            managedTabSetId: 'managed-tab-set:cli',
            controlState: 'controlled',
          }],
        };
      case 'browser.observe': return observation();
      case 'browser.observation.latest':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          targetId: 'target:managed',
          url: 'https://example.test/form',
          observationId: 'observation:current',
          createdAt: 1,
          expiresAt: 301_000,
          elementCount: 1,
        };
      case 'browser.click': return observation({ observationId: 'observation:after-click' });
      case 'browser.upload': return observation({ observationId: 'observation:after-upload' });
      case 'browser.capture':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          targetId: 'target:managed',
          url: 'https://example.test/form',
          artifact: artifact('artifact:screenshot', 'screenshot', 'image/png', 'capture.png'),
        };
      case 'browser.network.requests':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          requests: [{
            requestId: 'network-request:opaque',
            sequence: 4,
            method: 'GET',
            url: 'https://example.test/api',
            status: 200,
            type: 'Fetch',
            size: 12,
            durationMs: 8,
          }],
          nextCursor: 4,
          truncated: false,
        };
      case 'browser.network.request':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          request: {
            requestId: 'network-request:opaque',
            sequence: 4,
            method: 'GET',
            url: 'https://example.test/api',
            type: 'Fetch',
            requestHeaders: [],
            postDataTruncated: false,
            status: 200,
            statusText: 'OK',
            responseHeaders: [],
            mimeType: 'application/octet-stream',
            size: 12,
            durationMs: 8,
            bodyAvailable: true,
          },
          body: Buffer.from('network-body').toString('base64'),
          bodyEncoding: 'base64',
          mimeType: 'application/octet-stream',
          bodyTruncated: false,
        };
      default: throw new Error(`Unexpected tool: ${name} ${JSON.stringify(args)}`);
    }
  };

  const rpcResult = async body => {
    switch (body.method) {
      case 'initialize':
        return {
          serviceVersion: PACKAGE_VERSION,
          executableVersion: PACKAGE_VERSION,
          protocol: { major: 1, minor: 1 },
          supportedCapabilities: [],
          capabilities: { granted: [], unsupported: [] },
          brokerProcessIdentity: 'broker:fake',
          connectionId: 'connection:cli',
          browsers: [{ id: 'browser:fake', product: 'Chrome', state: 'ready' }],
          limits: {
            maxMessageBytes: 1_048_576,
            maxResultBytes: 4_194_304,
            maxArtifactBytes: 104_857_600,
            eventJournalSize: 1000,
          },
        };
      case 'workspaces/create':
        return {
          workspace: {
            id: 'workspace:cli',
            principalId: 'principal:cli',
            browserInstanceId: 'browser-instance:fake',
            clientKey: 'browser-pilot-cli',
            createdAt: 1,
            updatedAt: 1,
            state: 'active',
          },
          managedTabSet: { id: 'managed-tab-set:cli' },
          eventCursor: 0,
        };
      case 'leases/create':
        return {
          lease: {
            id: 'lease:cli',
            workspaceId: 'workspace:cli',
            connectionId: 'connection:cli',
            clientKey: 'browser-pilot-cli',
            capabilities: [],
            createdAt: 1,
            lastHeartbeatAt: 1,
            expiresAt: 301_000,
            state: 'active',
          },
        };
      case 'tools/call': {
        const result = await toolResult(body.params.name, body.params.arguments);
        return {
          command: { status: 'completed', method: body.params.name },
          result,
        };
      }
      case 'artifacts/import':
        return { artifact: artifact('artifact:upload', 'upload_input', 'text/plain', 'upload.txt') };
      case 'artifacts/export':
        await writeFile(body.params.path, 'screenshot-bytes');
        return { artifact: artifact('artifact:screenshot', 'screenshot', 'image/png', 'capture.png'), path: body.params.path };
      case 'artifacts/release': return { artifactId: body.params.artifactId, released: true };
      default: throw new Error(`Unexpected RPC method: ${body.method}`);
    }
  };

  const server = http.createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/health') {
        calls.push({ path: request.url });
        response.end(JSON.stringify({
          ok: true,
          brokerProtocol: 1,
          browser: { product: 'Chrome', profile: '/profiles/fake', state: 'connected' },
        }));
        return;
      }
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ path: request.url, body });
      if (request.method === 'POST' && request.url === '/broker/rpc') {
        response.end(JSON.stringify({ result: await rpcResult(body) }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'unexpected route' }));
    })().catch(error => {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: error.message }));
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(socketPath, resolveListen);
  });
  return { server, calls };
}

async function runCli(home, args) {
  const { stdout } = await execFile(process.execPath, [CLI, ...args], {
    env: { ...process.env, HOME: home },
    timeout: 10_000,
  });
  return JSON.parse(stdout.trim());
}

test('one-shot CLI uses only canonical Broker and Artifact operations', async t => {
  const root = await mkdtemp('/tmp/bp-cli-');
  const { server, calls } = await startFakeDaemon(root);
  t.after(async () => {
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  });

  const snapshot = await runCli(root, ['snapshot', '--limit', '9']);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.elements[0].name, 'Submit');

  const clicked = await runCli(root, ['click', '1', '--limit', '7']);
  assert.equal(clicked.ok, true);
  const clickCall = calls.find(call => call.body?.params?.name === 'browser.click');
  assert.deepEqual(clickCall.body.params.arguments, {
    target: { observationId: 'observation:current', ref: 1 },
    button: 'left',
    clickCount: 1,
    observationLimit: 7,
  });

  const screenshotPath = join(root, 'capture.png');
  const captured = await runCli(root, ['screenshot', screenshotPath]);
  assert.equal(captured.file, screenshotPath);
  assert.equal(await readFile(screenshotPath, 'utf8'), 'screenshot-bytes');
  const exportCall = calls.find(call => call.body?.method === 'artifacts/export');
  assert.equal(exportCall.body.params.overwrite, true);

  const uploadPath = join(root, 'upload.txt');
  await writeFile(uploadPath, 'upload-source');
  assert.equal((await runCli(root, ['upload', uploadPath])).ok, true);
  assert.ok(calls.some(call => call.body?.method === 'artifacts/import'));
  assert.ok(calls.some(call => call.body?.params?.name === 'browser.upload'));

  const bodyPath = join(root, 'response.bin');
  const saved = await runCli(root, ['net', 'show', '4', '--save', bodyPath]);
  assert.equal(saved.file, bodyPath);
  assert.equal(await readFile(bodyPath, 'utf8'), 'network-body');
  const requestList = calls.find(call => (
    call.body?.params?.name === 'browser.network.requests' &&
    call.body.params.arguments.after === 3
  ));
  assert.deepEqual(requestList.body.params.arguments, { after: 3, limit: 1 });
  assert.ok(calls.some(call => (
    call.body?.params?.name === 'browser.network.request' &&
    call.body.params.arguments.requestId === 'network-request:opaque'
  )));

  assert.ok(calls.some(call => (
    call.body?.method === 'workspaces/create' &&
    call.body.params.clientKey === 'browser-pilot-cli'
  )));
  assert.ok(calls.some(call => (
    call.body?.method === 'leases/create' &&
    call.body.params.clientKey === 'browser-pilot-cli' &&
    call.body.params.ttlMs === 300_000
  )));
  assert.equal(calls.some(call => call.path === '/cdp'), false);
});
