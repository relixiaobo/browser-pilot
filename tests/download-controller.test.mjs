import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ArtifactStore, DownloadController } from '../dist/services.js';

class DownloadTransport {
  calls = [];
  handlers = new Map();
  unavailable = false;
  downloadGate;

  async send(method, params = {}, sessionId) {
    this.calls.push({ method, params, sessionId });
    if (method === 'Page.setDownloadBehavior') {
      if (this.unavailable) throw new Error('Method not found');
      if (this.downloadGate) await this.downloadGate;
      return {};
    }
    if (method === 'Browser.cancelDownload') return {};
    throw new Error(`Unexpected CDP call: ${method}`);
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) ?? [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }

  emit(method, params, sessionId) {
    for (const handler of this.handlers.get(method) ?? []) handler(params, sessionId);
  }

  close() {}
}

const contextA = {
  workspaceId: 'workspace:alpha',
  leaseId: 'lease:alpha',
  targetId: 'target:alpha',
  sessionId: 'session:alpha',
};
const contextB = {
  workspaceId: 'workspace:beta',
  leaseId: 'lease:beta',
  targetId: 'target:beta',
  sessionId: 'session:beta',
};

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'browser-pilot-downloads-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transport = new DownloadTransport();
  const artifacts = new ArtifactStore({
    directory: join(root, 'artifacts'),
    ...(options.artifactOptions ?? {}),
  });
  await artifacts.initialize();
  const events = [];
  const controller = new DownloadController(transport, artifacts, {
    directory: join(root, 'staging'),
    ...(options.maxDownloadBytes ? { maxDownloadBytes: options.maxDownloadBytes } : {}),
    ...(options.controllerOptions ?? {}),
    publishEvent: event => events.push(event),
  });
  return { root, transport, artifacts, controller, events };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for download state');
}

function configuredDirectory(transport, sessionId) {
  return transport.calls.find(call => (
    call.method === 'Page.setDownloadBehavior' && call.sessionId === sessionId
  ))?.params.downloadPath;
}

test('completed target-session downloads become protected Artifacts without exposing staging identity', async t => {
  const { transport, artifacts, controller, events } = await fixture(t);
  assert.equal(await controller.attachSession(contextA), true);
  const directory = configuredDirectory(transport, contextA.sessionId);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal(transport.calls.some(call => call.method === 'Browser.setDownloadBehavior'), false);

  transport.emit('Page.downloadWillBegin', {
    guid: 'private-guid',
    url: 'https://example.test/report',
    suggestedFilename: 'report.pdf',
  }, contextA.sessionId);
  await writeFile(join(directory, 'private-guid'), 'download bytes');
  transport.emit('Page.downloadProgress', {
    guid: 'private-guid',
    state: 'completed',
    receivedBytes: 14,
    totalBytes: 14,
  }, contextA.sessionId);

  const completed = await waitFor(() => events.find(event => event.payload.state === 'completed'));
  const started = events.find(event => event.payload.state === 'started');
  assert.equal(started.payload.hints[0].recommendedAction, 'wait_for_download');
  assert.equal(completed.workspaceId, contextA.workspaceId);
  assert.equal(completed.payload.artifact.kind, 'download');
  assert.equal(completed.payload.artifact.fileName, 'report.pdf');
  assert.equal(completed.payload.artifact.sensitivity, 'user_file');
  assert.equal(completed.payload.hints[0].state, 'completed');
  assert.equal(completed.payload.hints[0].artifactId, completed.payload.artifact.id);
  assert.equal(JSON.stringify(events).includes('private-guid'), false);
  assert.equal(JSON.stringify(events).includes(directory), false);
  const stored = await artifacts.get(contextA.workspaceId, completed.payload.artifact.id);
  assert.deepEqual(await readFile(stored.path), Buffer.from('download bytes'));
  await assert.rejects(() => stat(join(directory, 'private-guid')), error => error.code === 'ENOENT');
});

test('same GUID downloads remain isolated by target session and Workspace', async t => {
  const { transport, artifacts, controller, events } = await fixture(t);
  await Promise.all([controller.attachSession(contextA), controller.attachSession(contextB)]);
  const directoryA = configuredDirectory(transport, contextA.sessionId);
  const directoryB = configuredDirectory(transport, contextB.sessionId);
  assert.notEqual(directoryA, directoryB);

  for (const [context, directory, contents] of [
    [contextA, directoryA, 'alpha'],
    [contextB, directoryB, 'beta'],
  ]) {
    transport.emit('Page.downloadWillBegin', {
      guid: 'same-guid',
      suggestedFilename: 'result.txt',
      url: 'https://example.test/result',
    }, context.sessionId);
    await writeFile(join(directory, 'same-guid'), contents);
    transport.emit('Page.downloadProgress', {
      guid: 'same-guid',
      state: 'completed',
      receivedBytes: contents.length,
      totalBytes: contents.length,
    }, context.sessionId);
  }

  await waitFor(() => events.filter(event => event.payload.state === 'completed').length === 2);
  const completed = events.filter(event => event.payload.state === 'completed');
  for (const [workspaceId, contents] of [
    [contextA.workspaceId, 'alpha'],
    [contextB.workspaceId, 'beta'],
  ]) {
    const event = completed.find(candidate => candidate.workspaceId === workspaceId);
    const stored = await artifacts.get(workspaceId, event.payload.artifact.id);
    assert.deepEqual(await readFile(stored.path), Buffer.from(contents));
  }
});

test('oversized downloads are cancelled by GUID and publish only bounded metadata', async t => {
  const { transport, artifacts, controller, events } = await fixture(t, { maxDownloadBytes: 4 });
  await controller.attachSession(contextA);
  transport.emit('Page.downloadWillBegin', {
    guid: 'oversized-guid',
    suggestedFilename: 'large.bin',
    url: 'https://example.test/large',
  }, contextA.sessionId);
  transport.emit('Page.downloadProgress', {
    guid: 'oversized-guid',
    state: 'inProgress',
    receivedBytes: 5,
    totalBytes: 100,
  }, contextA.sessionId);

  const failed = events.find(event => event.payload.state === 'failed');
  assert.equal(failed.payload.reason, 'size_limit_exceeded');
  assert.equal(failed.payload.maxDownloadBytes, 4);
  assert.deepEqual(failed.payload.hints[0], {
    code: 'download',
    source: 'download',
    confidence: 'strong',
    recommendedAction: 'inspect_download_failure',
    state: 'failed',
    reason: 'size_limit_exceeded',
  });
  assert.equal(transport.calls.some(call => (
    call.method === 'Browser.cancelDownload' && call.params.guid === 'oversized-guid'
  )), true);
  assert.equal(JSON.stringify(failed).includes('oversized-guid'), false);
  assert.equal(artifacts.size(), 0);

  const directory = configuredDirectory(transport, contextA.sessionId);
  await writeFile(join(directory, 'oversized-guid'), 'late bytes');
  transport.emit('Page.downloadProgress', {
    guid: 'oversized-guid',
    state: 'completed',
    receivedBytes: 10,
    totalBytes: 100,
  }, contextA.sessionId);
  await waitFor(async () => {
    try { await stat(join(directory, 'oversized-guid')); return false; }
    catch (error) { return error.code === 'ENOENT'; }
  });
});

test('concurrent staging respects Workspace capacity before Artifact ingestion', async t => {
  const { transport, controller, events } = await fixture(t, {
    artifactOptions: {
      maxArtifactBytes: 10,
      maxWorkspaceBytes: 12,
      maxTotalBytes: 20,
    },
  });
  const secondContext = {
    ...contextA,
    targetId: 'target:alpha:second',
    sessionId: 'session:alpha:second',
  };
  await Promise.all([
    controller.attachSession(contextA),
    controller.attachSession(secondContext),
  ]);
  for (const [context, guid] of [
    [contextA, 'first-guid'],
    [secondContext, 'second-guid'],
  ]) {
    transport.emit('Page.downloadWillBegin', { guid, suggestedFilename: `${guid}.bin` }, context.sessionId);
    transport.emit('Page.downloadProgress', {
      guid,
      state: 'inProgress',
      receivedBytes: 1,
      totalBytes: 8,
    }, context.sessionId);
  }

  const failed = events.find(event => event.payload.reason === 'staging_quota_exceeded');
  assert.equal(failed.targetId, secondContext.targetId);
  assert.equal(failed.payload.maxWorkspaceBytes, 12);
  assert.equal(transport.calls.some(call => (
    call.method === 'Browser.cancelDownload' && call.params.guid === 'second-guid'
  )), true);
});

test('unsupported session download API reports unavailable and never falls back browser-wide', async t => {
  const { transport, controller, events } = await fixture(t);
  transport.unavailable = true;
  assert.equal(await controller.attachSession(contextA), false);
  assert.equal(events[0].payload.state, 'capture_unavailable');
  assert.equal(events[0].payload.reason, 'target_session_api_unavailable');
  assert.equal(transport.calls.some(call => call.method === 'Browser.setDownloadBehavior'), false);
});

test('session cleanup cancels partial downloads and removes staging bytes', async t => {
  const { transport, artifacts, controller, events } = await fixture(t);
  await controller.attachSession(contextA);
  const directory = configuredDirectory(transport, contextA.sessionId);
  transport.emit('Page.downloadWillBegin', {
    guid: 'partial-guid',
    suggestedFilename: 'partial.txt',
  }, contextA.sessionId);
  await writeFile(join(directory, 'partial-guid'), 'partial');
  controller.detachSession(contextA.sessionId, 'lease_released');

  await waitFor(async () => {
    try { await stat(directory); return false; } catch (error) { return error.code === 'ENOENT'; }
  });
  assert.equal(events.at(-1).payload.state, 'cancelled');
  assert.equal(events.at(-1).payload.reason, 'lease_released');
  assert.equal(events.at(-1).payload.hints[0].state, 'cancelled');
  assert.equal(artifacts.size(), 0);
});

test('Lease release cancels a target-session attachment still being configured', async t => {
  const { transport, controller, events } = await fixture(t);
  let releaseConfiguration;
  transport.downloadGate = new Promise(resolve => { releaseConfiguration = resolve; });
  const attaching = controller.attachSession(contextA);
  const directory = await waitFor(() => configuredDirectory(transport, contextA.sessionId));
  controller.releaseLease(contextA.leaseId);
  releaseConfiguration();

  assert.equal(await attaching, false);
  await assert.rejects(() => stat(directory), error => error.code === 'ENOENT');
  assert.equal(events.some(event => event.payload.state === 'capture_unavailable'), false);
});
