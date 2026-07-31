import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    if (method === 'Browser.setDownloadBehavior') {
      if (this.unavailable) throw new Error('Method not found');
      if (this.downloadGate) await this.downloadGate;
      return {};
    }
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
  browserConnectionGeneration: 1,
  sessionId: 'session:alpha',
};
const contextB = {
  workspaceId: 'workspace:beta',
  leaseId: 'lease:beta',
  targetId: 'target:beta',
  browserConnectionGeneration: 1,
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

function behaviorCalls(transport) {
  return transport.calls.filter(call => call.method === 'Browser.setDownloadBehavior');
}

function begin(transport, context, guid, fileName = `${guid}.txt`) {
  transport.emit('Page.downloadWillBegin', {
    guid,
    url: 'https://example.test/download',
    suggestedFilename: fileName,
  }, context.sessionId);
}

function complete(transport, guid, filePath, byteSize) {
  transport.emit('Browser.downloadProgress', {
    guid,
    state: 'completed',
    receivedBytes: byteSize,
    totalBytes: byteSize,
    ...(filePath !== undefined ? { filePath } : {}),
  });
}

test('completed controlled downloads are copied into Artifacts without moving the user file', async t => {
  const { root, transport, artifacts, controller, events } = await fixture(t);
  assert.equal(await controller.attachSession(contextA), true);
  assert.deepEqual(behaviorCalls(transport), [{
    method: 'Browser.setDownloadBehavior',
    params: { behavior: 'default', eventsEnabled: true },
    sessionId: undefined,
  }]);

  const source = join(root, 'report.pdf');
  await writeFile(source, 'download bytes');
  begin(transport, contextA, 'private-guid', 'report.pdf');
  complete(transport, 'private-guid', source, 14);

  const completed = await waitFor(() => events.find(event => event.payload.state === 'completed'));
  const started = events.find(event => event.payload.state === 'started');
  assert.equal(started.payload.hints[0].recommendedAction, 'wait_for_download');
  assert.equal(completed.workspaceId, contextA.workspaceId);
  assert.equal(completed.payload.artifact.kind, 'download');
  assert.equal(completed.payload.artifact.fileName, 'report.pdf');
  assert.equal(completed.payload.artifact.sensitivity, 'user_file');
  assert.equal(completed.payload.hints[0].artifactId, completed.payload.artifact.id);
  assert.equal(JSON.stringify(events).includes('private-guid'), false);
  assert.equal(JSON.stringify(events).includes(source), false);

  const stored = await artifacts.get(contextA.workspaceId, completed.payload.artifact.id);
  assert.deepEqual(await readFile(stored.path), Buffer.from('download bytes'));
  assert.deepEqual(await readFile(source), Buffer.from('download bytes'));
  await artifacts.release(contextA.workspaceId, completed.payload.artifact.id);
  assert.deepEqual(await readFile(source), Buffer.from('download bytes'));
  await artifacts.releaseWorkspace(contextA.workspaceId);
  assert.deepEqual(await readFile(source), Buffer.from('download bytes'));
});

test('two sessions in one Profile share one browser-level default configuration and keep ownership isolated', async t => {
  const { root, transport, artifacts, controller, events } = await fixture(t);
  await Promise.all([controller.attachSession(contextA), controller.attachSession(contextB)]);
  assert.equal(behaviorCalls(transport).length, 1);

  const sourceA = join(root, 'alpha.txt');
  const sourceB = join(root, 'beta.txt');
  await Promise.all([writeFile(sourceA, 'alpha'), writeFile(sourceB, 'beta')]);
  begin(transport, contextA, 'guid-alpha', 'result.txt');
  begin(transport, contextB, 'guid-beta', 'result.txt');
  complete(transport, 'guid-alpha', sourceA, 5);
  complete(transport, 'guid-beta', sourceB, 4);

  await waitFor(() => events.filter(event => event.payload.state === 'completed').length === 2);
  for (const [workspaceId, contents] of [
    [contextA.workspaceId, 'alpha'],
    [contextB.workspaceId, 'beta'],
  ]) {
    const event = events.find(candidate => (
      candidate.workspaceId === workspaceId && candidate.payload.state === 'completed'
    ));
    const stored = await artifacts.get(workspaceId, event.payload.artifact.id);
    assert.deepEqual(await readFile(stored.path), Buffer.from(contents));
  }
});

test('different Chrome Profile contexts each enable default download events once', async t => {
  const { transport, controller } = await fixture(t);
  const profileA = { ...contextA, cdpBrowserContextId: 'browser-context-a' };
  const profileB = { ...contextB, cdpBrowserContextId: 'browser-context-b' };
  await Promise.all([
    controller.attachSession(profileA),
    controller.attachSession(profileB),
  ]);
  assert.deepEqual(behaviorCalls(transport).map(call => call.params).sort((a, b) => (
    a.browserContextId.localeCompare(b.browserContextId)
  )), [
    { behavior: 'default', eventsEnabled: true, browserContextId: 'browser-context-a' },
    { behavior: 'default', eventsEnabled: true, browserContextId: 'browser-context-b' },
  ]);
});

test('browser-wide events without a controlled Page owner are ignored', async t => {
  const { root, transport, artifacts, controller, events } = await fixture(t);
  await controller.attachSession(contextA);
  const userFile = join(root, 'uncontrolled.txt');
  await writeFile(userFile, 'user download');
  complete(transport, 'uncontrolled-guid', userFile, 13);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(events.length, 0);
  assert.equal(artifacts.size(), 0);
  assert.deepEqual(await readFile(userFile), Buffer.from('user download'));
});

test('missing and invalid Browser completion paths return stable bounded failures', async t => {
  const { transport, controller, events } = await fixture(t);
  await controller.attachSession(contextA);

  begin(transport, contextA, 'missing-path');
  complete(transport, 'missing-path', undefined, 10);
  begin(transport, contextA, 'relative-path');
  complete(transport, 'relative-path', 'relative/download.txt', 10);

  await waitFor(() => events.filter(event => event.payload.state === 'failed').length === 2);
  assert.deepEqual(
    events.filter(event => event.payload.state === 'failed').map(event => event.payload.reason),
    ['download_file_path_unavailable', 'download_file_path_invalid'],
  );
});

test('oversized downloads reject only Artifact copying and never cancel or delete the user download', async t => {
  const { root, transport, artifacts, controller, events } = await fixture(t, { maxDownloadBytes: 4 });
  await controller.attachSession(contextA);
  const source = join(root, 'large.bin');
  await writeFile(source, 'late bytes');
  begin(transport, contextA, 'oversized-guid', 'large.bin');
  transport.emit('Browser.downloadProgress', {
    guid: 'oversized-guid',
    state: 'inProgress',
    receivedBytes: 5,
    totalBytes: 100,
  });

  const failed = events.find(event => event.payload.state === 'failed');
  assert.equal(failed.payload.reason, 'size_limit_exceeded');
  assert.equal(failed.payload.maxDownloadBytes, 4);
  assert.equal(transport.calls.some(call => call.method === 'Browser.cancelDownload'), false);
  assert.equal(JSON.stringify(failed).includes('oversized-guid'), false);
  assert.equal(artifacts.size(), 0);

  complete(transport, 'oversized-guid', source, 10);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(await readFile(source), Buffer.from('late bytes'));
  assert.equal(events.filter(event => event.payload.state === 'failed').length, 1);
});

test('tracking concurrency limits do not cancel the underlying Chrome download', async t => {
  const { transport, controller, events } = await fixture(t, {
    controllerOptions: { maxActivePerSession: 1 },
  });
  await controller.attachSession(contextA);
  begin(transport, contextA, 'first-guid');
  begin(transport, contextA, 'second-guid');

  const failed = events.find(event => event.payload.reason === 'concurrency_limit_exceeded');
  assert.equal(failed.targetId, contextA.targetId);
  assert.equal(transport.calls.some(call => call.method === 'Browser.cancelDownload'), false);
});

test('a duplicate browser GUID across controlled sessions fails closed instead of crossing Workspaces', async t => {
  const { transport, controller, events } = await fixture(t);
  await Promise.all([controller.attachSession(contextA), controller.attachSession(contextB)]);
  begin(transport, contextA, 'duplicate-guid');
  begin(transport, contextB, 'duplicate-guid');

  const failures = events.filter(event => event.payload.reason === 'download_identity_collision');
  assert.equal(failures.length, 2);
  assert.deepEqual(new Set(failures.map(event => event.workspaceId)), new Set([
    contextA.workspaceId,
    contextB.workspaceId,
  ]));
});

test('unsupported browser download events are reported once per attached target without fallback redirects', async t => {
  const { transport, controller, events } = await fixture(t);
  transport.unavailable = true;
  const results = await Promise.all([
    controller.attachSession(contextA),
    controller.attachSession(contextB),
  ]);
  assert.deepEqual(results, [false, false]);
  assert.equal(behaviorCalls(transport).length, 1);
  assert.equal(events.length, 2);
  assert.equal(events.every(event => (
    event.payload.state === 'capture_unavailable' &&
    event.payload.reason === 'browser_download_events_unavailable'
  )), true);
  assert.equal(transport.calls.some(call => call.method === 'Page.setDownloadBehavior'), false);
});

test('session cleanup stops Artifact tracking but does not cancel an in-flight user download', async t => {
  const { transport, artifacts, controller, events } = await fixture(t);
  await controller.attachSession(contextA);
  begin(transport, contextA, 'partial-guid', 'partial.txt');
  controller.detachSession(contextA.sessionId, 'lease_released');

  assert.equal(events.at(-1).payload.state, 'cancelled');
  assert.equal(events.at(-1).payload.reason, 'lease_released');
  assert.equal(events.at(-1).payload.hints[0].state, 'cancelled');
  assert.equal(artifacts.size(), 0);
  assert.equal(transport.calls.some(call => call.method === 'Browser.cancelDownload'), false);
});

test('Lease release invalidates a session attachment while shared event configuration is pending', async t => {
  const { transport, controller, events } = await fixture(t);
  let releaseConfiguration;
  transport.downloadGate = new Promise(resolve => { releaseConfiguration = resolve; });
  const attaching = controller.attachSession(contextA);
  await waitFor(() => behaviorCalls(transport).length === 1);
  controller.releaseLease(contextA.leaseId);
  releaseConfiguration();

  assert.equal(await attaching, false);
  assert.equal(events.some(event => event.payload.state === 'capture_unavailable'), false);
});

test('a new browser connection generation configures download events again', async t => {
  const { transport, controller } = await fixture(t);
  await controller.attachSession(contextA);
  controller.detachSession(contextA.sessionId, 'connection_lost');
  await controller.attachSession({
    ...contextA,
    browserConnectionGeneration: 2,
    sessionId: 'session:alpha:reconnected',
  });
  assert.equal(behaviorCalls(transport).length, 2);
});
