import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  BrowserPilotAdapterError,
  BrowserPilotProcessAdapter,
  materializeToolResult,
} from '../examples/adapters/shared/browser-pilot-process.mjs';
import { TenonBrowserPilotAdapter } from '../examples/adapters/tenon/browser-pilot-adapter.mjs';
import { OpenClawBrowserPilotAdapter } from '../examples/adapters/openclaw/browser-pilot-adapter.mjs';

const fixture = join(process.cwd(), 'tests', 'fixtures', 'fake-stdio-bridge.mjs');

function clientIdentity() {
  return {
    id: 'org.browser-pilot.reference-adapter-test',
    name: 'Reference Adapter Test',
    version: '1.0.0',
    instanceId: `test:${Date.now()}:${Math.random()}`,
  };
}

async function fixtureConnection(events = [], fixtureArgs = [], options = {}) {
  return await BrowserPilotProcessAdapter.connect({
    command: [process.execPath, fixture, ...fixtureArgs],
    client: clientIdentity(),
    onBrowserEvent: event => events.push(event),
    ...options,
  });
}

test('Tenon adapter maps Thread/Turn lifecycle, target context, and native image content', async t => {
  const events = [];
  const output = await mkdtemp(join(tmpdir(), 'browser-pilot-tenon-adapter-'));
  const adapter = await fixtureConnection(events);
  const tenon = new TenonBrowserPilotAdapter(adapter, { artifactDirectory: output });
  t.after(async () => {
    await tenon.close().catch(() => {});
    await rm(output, { recursive: true, force: true });
  });

  const [turn, sameTurn] = await Promise.all([
    tenon.beginTurn({ threadId: 'thread-1', turnId: 'turn-1' }),
    tenon.beginTurn({ threadId: 'thread-1', turnId: 'turn-1' }),
  ]);
  assert.equal(sameTurn, turn);
  const tools = tenon.createTools(turn);
  const open = tools.find(tool => tool.name === 'browser_pilot_browser_open');
  const profiles = tools.find(tool => tool.name === 'browser_pilot_browser_profiles_list');
  const observe = tools.find(tool => tool.name === 'browser_pilot_browser_observe');
  const capture = tools.find(tool => tool.name === 'browser_pilot_browser_capture');
  assert.ok(open && profiles && observe && capture);
  assert.deepEqual(adapter.initializeResult.protocol, { major: 1, minor: 2 });
  assert.equal(observe.parameters.required.includes('controlTargetId'), true);

  const opened = await open.execute('call-open', { url: 'about:blank', newTarget: true });
  assert.equal(opened.details.browserPilot.result.targetId, 'target:fake');
  const listedProfiles = await profiles.execute('call-profiles', {});
  assert.equal(
    listedProfiles.details.browserPilot.result.profiles[0].profileContextId,
    'profile-context:fake',
  );
  await observe.execute('call-observe', { controlTargetId: 'target:fake', limit: 10 });
  const captured = await capture.execute('call-capture', { controlTargetId: 'target:fake' });
  assert.equal(captured.content.some(item => item.type === 'image' && item.mimeType === 'image/png'), true);
  assert.equal(events.some(event => event.type === 'command.status'), true);

  await tenon.endTurn('turn-1');
  await tenon.releaseThread('thread-1');
});

test('OpenClaw adapter maps session/run lifecycle through a runtime-manifest dispatcher', async t => {
  const output = await mkdtemp(join(tmpdir(), 'browser-pilot-openclaw-adapter-'));
  const adapter = await fixtureConnection();
  const openclaw = new OpenClawBrowserPilotAdapter(adapter, { artifactDirectory: output });
  t.after(async () => {
    await openclaw.close().catch(() => {});
    await rm(output, { recursive: true, force: true });
  });

  const [run, sameRun] = await Promise.all([
    openclaw.beginRun({ agentId: 'agent-1', sessionKey: 'session-1', runId: 'run-1' }),
    openclaw.beginRun({ agentId: 'agent-1', sessionKey: 'session-1', runId: 'run-1' }),
  ]);
  assert.equal(sameRun, run);
  const tool = openclaw.createTool(run);
  assert.equal(tool.name, 'browser_pilot');
  const listSchema = tool.parameters.oneOf.find(
    schema => schema.properties.operation.const === 'browser.tabs.list',
  );
  const observeSchema = tool.parameters.oneOf.find(
    schema => schema.properties.operation.const === 'browser.observe',
  );
  assert.ok(listSchema);
  assert.equal(listSchema.required.includes('controlTargetId'), false);
  assert.equal(observeSchema.required.includes('controlTargetId'), true);

  const opened = await tool.execute('call-open', {
    operation: 'browser.open',
    arguments: { url: 'about:blank', newTarget: true },
  });
  assert.equal(opened.details.browserPilot.result.targetId, 'target:fake');
  const observed = await tool.execute('call-observe', {
    operation: 'browser.observe',
    arguments: { limit: 10 },
    controlTargetId: 'target:fake',
  });
  assert.equal(observed.details.browserPilot.result.observationId, 'observation:fake');

  await openclaw.endRun('run-1');
  await openclaw.releaseSession('agent-1', 'session-1');
});

test('reference adapter exports non-image Artifacts into host scratch and then releases them', async () => {
  const output = await mkdtemp(join(tmpdir(), 'browser-pilot-file-adapter-'));
  const released = [];
  try {
    const result = await materializeToolResult({
      exportArtifact: async (_context, artifactId, path) => ({ artifactId, path }),
      releaseArtifact: async (_context, artifactId) => { released.push(artifactId); },
    }, { id: 'context:test' }, {
      definition: { sensitivity: { input: [], output: ['browser_data'] } },
      command: { id: 'command:test', status: 'completed' },
      result: {
        artifact: {
          id: 'artifact:pdf-test',
          mimeType: 'application/pdf',
          byteSize: 100,
        },
      },
    }, { artifactDirectory: output });

    assert.match(result.content[1].text, /^FILE:.*artifact_pdf-test\.pdf$/u);
    assert.deepEqual(released, ['artifact:pdf-test']);
    assert.equal(result.details.browserPilot.exportedFiles.length, 1);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test('reference adapter bounds model-visible text while retaining structured host details', async () => {
  const payload = { text: 'x'.repeat(1024 * 1024 + 4096) };
  const result = await materializeToolResult({}, null, {
    definition: { sensitivity: { input: [], output: ['browser_data'] } },
    command: { id: 'command:large', status: 'completed' },
    result: payload,
  });
  assert.match(result.content[0].text, /^\[Browser Pilot result truncated:/u);
  assert.ok(Buffer.byteLength(result.content[0].text, 'utf8') <= 1024 * 1024);
  assert.equal(result.details.browserPilot.result, payload);
});

test('mutating transport uncertainty is surfaced as unknown_outcome and never retryable', async t => {
  const adapter = await fixtureConnection();
  t.after(() => adapter.close().catch(() => {}));
  const context = await adapter.openContext({ workspaceKey: 'uncertain', leaseKey: 'uncertain' });
  const call = adapter.peer.call.bind(adapter.peer);
  adapter.peer.call = async (method, params, options) => {
    if (method === 'tools/call') {
      throw new BrowserPilotAdapterError('connection_lost', 'simulated transport loss', {
        retryable: true,
      });
    }
    return await call(method, params, options);
  };

  await assert.rejects(
    adapter.executeTool(context, 'browser.open', { url: 'about:blank' }, { toolCallId: 'uncertain' }),
    error => error.code === 'unknown_outcome' && error.retryable === false,
  );
  adapter.peer.call = call;
});

test('event polling advances its recovery cursor only after explicit host acknowledgement', async t => {
  const adapter = await fixtureConnection();
  t.after(() => adapter.close().catch(() => {}));
  const context = await adapter.openContext({ workspaceKey: 'events', leaseKey: 'events' });
  await adapter.executeTool(context, 'browser.open', { url: 'about:blank' }, { toolCallId: 'event-open' });

  const cursors = [];
  const call = adapter.peer.call.bind(adapter.peer);
  adapter.peer.call = async (method, params, options) => {
    if (method === 'events/poll') cursors.push(params.cursor);
    return await call(method, params, options);
  };
  const first = await adapter.pollEvents(context);
  const repeated = await adapter.pollEvents(context);
  assert.equal(first.nextCursor, 'cursor:1');
  assert.equal(repeated.nextCursor, first.nextCursor);
  assert.deepEqual(cursors, ['cursor:0', 'cursor:0']);
  await assert.rejects(
    adapter.acknowledgeEvents(context, 'cursor:999'),
    error => error.code === 'invalid_event_cursor',
  );
  await adapter.acknowledgeEvents(context, first.nextCursor);
  await adapter.pollEvents(context);
  assert.equal(cursors.at(-1), 'cursor:1');

  const baseline = await adapter.resetEventCursor(context);
  assert.equal(baseline.eventCursor, 'cursor:1');
  adapter.peer.call = call;
});

test('failed context creation and release leave no reusable local lifecycle state', async t => {
  const creationFailures = [];
  const failedCreate = await fixtureConnection([], ['--fail-method', 'leases/create'], {
    onLifecycleError: error => creationFailures.push(error),
  });
  t.after(() => failedCreate.close().catch(() => {}));
  await assert.rejects(
    failedCreate.openContext({ workspaceKey: 'failed-create', leaseKey: 'failed-create' }),
    error => error.code === 'fixture_failure',
  );
  assert.equal(failedCreate.workspaces.size, 0);
  assert.equal(failedCreate.contexts.size, 0);
  assert.equal(creationFailures.length, 0);

  const failedRelease = await fixtureConnection([], ['--fail-method', 'leases/release']);
  t.after(() => failedRelease.close().catch(() => {}));
  const context = await failedRelease.openContext({
    workspaceKey: 'failed-release',
    leaseKey: 'failed-release',
  });
  await assert.rejects(
    failedRelease.releaseContext(context),
    error => error.code === 'fixture_failure',
  );
  assert.equal(failedRelease.isLiveContext(context), false);
  assert.equal(failedRelease.contexts.size, 0);
  await failedRelease.releaseWorkspace('failed-release');
});

test('failed initialization and invalid process or Artifact paths fail deterministically', async () => {
  await assert.rejects(
    BrowserPilotProcessAdapter.connect({
      command: [process.execPath, fixture, '--fail-method', 'tools/list'],
      client: clientIdentity(),
    }),
    error => error.code === 'fixture_failure',
  );

  const relative = new BrowserPilotProcessAdapter({
    command: ['browser-pilot', 'bridge', '--stdio'],
    client: clientIdentity(),
  });
  await assert.rejects(relative.start(), error => error.code === 'invalid_executable');

  const invalidArguments = new BrowserPilotProcessAdapter({
    command: [process.execPath, 42],
    client: clientIdentity(),
  });
  await assert.rejects(invalidArguments.start(), error => error.code === 'invalid_command');

  const missing = join(tmpdir(), `missing-browser-pilot-${Date.now()}`);
  await assert.rejects(
    BrowserPilotProcessAdapter.connect({ command: [missing], client: clientIdentity() }),
    error => error.code === 'launch_failed',
  );

  const adapter = await fixtureConnection();
  try {
    const context = await adapter.openContext({ workspaceKey: 'paths', leaseKey: 'paths' });
    await assert.rejects(
      adapter.exportArtifact(context, 'artifact:fake', 'relative-output.pdf'),
      error => error.code === 'invalid_path',
    );
  } finally {
    await adapter.close();
  }
});

test('concurrent OpenClaw beginRun performs one context creation and rejects identity collisions', async () => {
  let opens = 0;
  const connection = {
    openContext: async () => {
      opens += 1;
      await new Promise(resolve => setImmediate(resolve));
      return { id: `context:${opens}` };
    },
  };
  const openclaw = new OpenClawBrowserPilotAdapter(connection);
  const runs = await Promise.all(Array.from({ length: 16 }, () => openclaw.beginRun({
    agentId: 'agent-concurrent',
    sessionKey: 'session-concurrent',
    runId: 'run-concurrent',
  })));
  assert.equal(opens, 1);
  assert.equal(runs.every(run => run === runs[0]), true);
  await assert.rejects(
    openclaw.beginRun({
      agentId: 'different-agent',
      sessionKey: 'session-concurrent',
      runId: 'run-concurrent',
    }),
    /already bound to another Agent session/u,
  );
});

test('ending a host invocation while context creation is pending still releases the Lease', async () => {
  const released = [];
  const connection = {
    openContext: async ({ leaseKey }) => {
      await new Promise(resolve => setImmediate(resolve));
      return Object.freeze({ id: `context:${leaseKey}` });
    },
    releaseContext: async context => { released.push(context.id); },
  };
  const tenon = new TenonBrowserPilotAdapter(connection);
  const openclaw = new OpenClawBrowserPilotAdapter(connection);

  const openingTurn = tenon.beginTurn({ threadId: 'thread-pending', turnId: 'turn-pending' });
  const endingTurn = tenon.endTurn('turn-pending');
  await Promise.all([openingTurn, endingTurn]);
  assert.equal(tenon.turns.size, 0);

  const openingRun = openclaw.beginRun({
    agentId: 'agent-pending',
    sessionKey: 'session-pending',
    runId: 'run-pending',
  });
  const endingRun = openclaw.endRun('run-pending');
  await Promise.all([openingRun, endingRun]);
  assert.equal(openclaw.runs.size, 0);
  assert.deepEqual(released, [
    'context:tenon-turn:turn-pending',
    'context:openclaw-run:run-pending',
  ]);
});

test('throwing host callbacks cannot interrupt bridge responses or Artifact cleanup', async t => {
  const adapter = await fixtureConnection([], [], {
    onBrowserEvent: () => { throw new Error('host event failure'); },
  });
  t.after(() => adapter.close().catch(() => {}));
  const context = await adapter.openContext({ workspaceKey: 'callbacks', leaseKey: 'callbacks' });
  const opened = await adapter.executeTool(
    context,
    'browser.open',
    { url: 'about:blank' },
    { toolCallId: 'callback-open' },
  );
  assert.equal(opened.result.targetId, 'target:fake');

  const materialized = await materializeToolResult({
    exportArtifact: async (_context, artifactId, path) => ({ artifactId, path }),
    releaseArtifact: async () => { throw new Error('release failed'); },
  }, context, {
    definition: { sensitivity: { input: [], output: ['browser_data'] } },
    command: { id: 'command:callback', status: 'completed' },
    result: {
      artifact: { id: 'artifact:callback', mimeType: 'application/pdf', byteSize: 1 },
    },
  }, {
    artifactDirectory: tmpdir(),
    onLifecycleError: () => { throw new Error('host lifecycle callback failure'); },
  });
  assert.equal(materialized.details.browserPilot.exportedFiles.length, 1);
});

test('structured command failures preserve Browser Pilot error semantics', async t => {
  const adapter = await fixtureConnection();
  t.after(() => adapter.close().catch(() => {}));
  const context = await adapter.openContext({ workspaceKey: 'tool-error', leaseKey: 'tool-error' });
  const call = adapter.peer.call.bind(adapter.peer);
  adapter.peer.call = async (method, params, options) => {
    if (method === 'tools/call') {
      return {
        command: { id: 'command:failed', status: 'failed' },
        error: {
          code: -32000,
          message: 'The action could not be verified.',
          data: {
            code: 'action_not_verified',
            retryable: false,
            context: { targetId: 'target:fake' },
          },
        },
      };
    }
    return await call(method, params, options);
  };
  await assert.rejects(
    adapter.executeTool(
      context,
      'browser.observe',
      {},
      { toolCallId: 'failed-command', targetId: 'target:fake' },
    ),
    error => error.code === 'action_not_verified' && error.context.targetId === 'target:fake',
  );
  adapter.peer.call = call;
});
