import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const failMethodIndex = process.argv.indexOf('--fail-method');
const failMethod = failMethodIndex >= 0 ? process.argv[failMethodIndex + 1] : undefined;
const ids = {
  workspaceId: 'workspace:fake',
  leaseId: 'lease:fake',
  targetId: 'target:fake',
  observationId: 'observation:fake',
  artifactId: 'artifact:fake',
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/69dG1QAAAABJRU5ErkJggg==', 'base64');
let artifactRoot;
let artifactPath;
let sequence = 0;
let eventSequence = 0;

const now = () => Date.now();
const descriptor = () => ({
  id: ids.artifactId,
  workspaceId: ids.workspaceId,
  kind: 'screenshot',
  mimeType: 'image/png',
  byteSize: png.length,
  sensitivity: 'browser_data',
  createdAt: now(),
  expiresAt: now() + 60_000,
  retained: false,
});
const observation = () => ({
  workspaceId: ids.workspaceId,
  leaseId: ids.leaseId,
  targetId: ids.targetId,
  url: 'about:blank',
  observationId: ids.observationId,
  title: '',
  elements: [],
  truncated: false,
  truncationReasons: [],
});
const lease = () => ({
  id: ids.leaseId,
  workspaceId: ids.workspaceId,
  connectionId: 'connection:fake',
  capabilities: ['browser.control', 'workspace.manage', 'observation.read', 'artifact.read', 'event.read'],
  createdAt: now(),
  lastHeartbeatAt: now(),
  expiresAt: now() + 60_000,
  state: 'active',
});

function response(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function notification() {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    method: 'events/event',
    params: {
      event: {
        id: 'event:notification',
        sequence: 1,
        timestamp: now(),
        workspaceId: ids.workspaceId,
        browserConnectionGeneration: 1,
        leaseId: ids.leaseId,
        targetId: ids.targetId,
        type: 'command.status',
        payloadVersion: 1,
        sensitivity: 'none',
        payload: { status: 'completed' },
      },
    },
  })}\n`);
}

function error(id, code, message) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message, data: { code, retryable: false } },
  })}\n`);
}

function toolOutcome(name, result) {
  sequence += 1;
  eventSequence += 1;
  return {
    command: {
      id: `command:fake-${sequence}`,
      status: 'completed',
      method: name,
      browserConnectionGeneration: 1,
      acceptedAt: now(),
      deadlineAt: now() + 30_000,
      dispatchedAt: now(),
      completedAt: now(),
      mutating: ['browser.connect', 'browser.open', 'browser.tabs.close'].includes(name),
    },
    result,
  };
}

async function handle(message) {
  const { id, method, params = {} } = message;
  const effectiveMethod = method === 'tools/call' ? params.name : method;
  if (effectiveMethod === failMethod) {
    error(id, 'fixture_failure', 'Requested fixture failure');
    return;
  }
  if (method === 'initialize') {
    response(id, {
      serviceVersion: '1.0.0-fixture',
      executableVersion: '1.0.0-fixture',
      protocol: { major: 1, minor: 1 },
      supportedCapabilities: params.requestedCapabilities,
      capabilities: { granted: params.requestedCapabilities, denied: [], unsupported: [] },
      brokerProcessIdentity: 'broker:fake',
      connectionId: 'connection:fake',
      browsers: [{ id: 'browser:fake', product: 'Fixture Chrome', state: 'disconnected' }],
      limits: {
        maxMessageBytes: 1024 * 1024,
        maxResultBytes: 4 * 1024 * 1024,
        maxArtifactBytes: 100 * 1024 * 1024,
        eventJournalSize: 1000,
      },
    });
    return;
  }
  if (method === 'tools/list') {
    response(id, {
      schemaVersion: 1,
      tools: ['browser.connect', 'browser.open', 'browser.observe', 'browser.capture', 'browser.tabs.list', 'browser.tabs.close'].map(name => ({
        name,
        title: name,
        description: name,
        context: name.includes('observe') || name.includes('capture') || name.includes('close') ? 'target' : 'workspace',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        requiredCapabilities: [],
        mutating: name.includes('connect') || name.includes('open') || name.includes('close'),
        idempotency: 'idempotent',
        cancellation: 'before_dispatch',
        sensitivity: { input: [], output: [] },
        artifactKinds: [],
      })),
    });
    return;
  }
  if (method === 'workspaces/create') {
    response(id, {
      workspace: {
        id: ids.workspaceId,
        principalId: 'principal:fake',
        browserInstanceId: 'browser:fake',
        createdAt: now(),
        updatedAt: now(),
        state: 'active',
      },
      managedTabSet: {
        id: 'tabset:fake',
        workspaceId: ids.workspaceId,
        browserInstanceId: 'browser:fake',
        createdAt: now(),
        state: 'active',
      },
      eventCursor: 'cursor:0',
    });
    return;
  }
  if (method === 'workspaces/get') {
    response(id, {
      workspace: {
        id: ids.workspaceId,
        principalId: 'principal:fake',
        browserInstanceId: 'browser:fake',
        createdAt: now(),
        updatedAt: now(),
        state: 'active',
      },
      managedTabSet: {
        id: 'tabset:fake',
        workspaceId: ids.workspaceId,
        browserInstanceId: 'browser:fake',
        createdAt: now(),
        state: 'active',
      },
      eventCursor: `cursor:${eventSequence}`,
    });
    return;
  }
  if (method === 'leases/create' || method === 'leases/heartbeat') {
    response(id, { lease: lease() });
    return;
  }
  if (method === 'tools/call') {
    if (params.name === 'browser.connect') {
      response(id, toolOutcome(params.name, {
        workspaceId: ids.workspaceId,
        leaseId: ids.leaseId,
        browserInstanceId: 'browser-instance:fake',
        connectionGeneration: 1,
        state: 'connected',
      }));
      return;
    }
    if (params.name === 'browser.open' || params.name === 'browser.observe') {
      if (params.name === 'browser.open') notification();
      response(id, toolOutcome(params.name, observation()));
      return;
    }
    if (params.name === 'browser.tabs.list') {
      response(id, toolOutcome(params.name, {
        workspaceId: ids.workspaceId,
        leaseId: ids.leaseId,
        targets: [{
          targetId: ids.targetId,
          title: '',
          url: 'about:blank',
          active: true,
          origin: 'managed',
          managedTabSetId: 'tabset:fake',
          controlState: 'controlled',
        }],
      }));
      return;
    }
    if (params.name === 'browser.capture') {
      artifactRoot = await mkdtemp(join(tmpdir(), 'browser-pilot-fake-bridge-'));
      artifactPath = join(artifactRoot, 'capture.png');
      await writeFile(artifactPath, png);
      response(id, toolOutcome(params.name, {
        workspaceId: ids.workspaceId,
        leaseId: ids.leaseId,
        targetId: ids.targetId,
        url: 'about:blank',
        artifact: descriptor(),
      }));
      return;
    }
    if (params.name === 'browser.tabs.close') {
      response(id, toolOutcome(params.name, {
        workspaceId: ids.workspaceId,
        leaseId: ids.leaseId,
        closedTargetId: ids.targetId,
      }));
      return;
    }
  }
  if (method === 'artifacts/get') {
    if (!artifactPath) {
      error(id, 'artifact_not_found', 'Artifact not found');
      return;
    }
    response(id, { artifact: descriptor(), path: artifactPath });
    return;
  }
  if (method === 'artifacts/release') {
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
    artifactRoot = undefined;
    artifactPath = undefined;
    response(id, { artifactId: ids.artifactId, released: true });
    return;
  }
  if (method === 'events/poll') {
    response(id, {
      events: [{
        id: 'event:fake',
        sequence: 1,
        timestamp: now(),
        workspaceId: ids.workspaceId,
        browserConnectionGeneration: 1,
        leaseId: ids.leaseId,
        targetId: ids.targetId,
        type: 'command.status',
        payloadVersion: 1,
        sensitivity: 'none',
        payload: { status: 'completed' },
      }],
      nextCursor: `cursor:${eventSequence}`,
      hasMore: false,
    });
    return;
  }
  if (method === 'leases/release') {
    response(id, { leaseId: ids.leaseId, released: true });
    return;
  }
  if (method === 'workspaces/release') {
    response(id, { workspaceId: ids.workspaceId, released: true });
    return;
  }
  if (method === 'shutdown') {
    response(id, { ok: true });
    setImmediate(async () => {
      if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
      process.exit(0);
    });
    return;
  }
  error(id, 'invalid_argument', `Unexpected method: ${effectiveMethod}`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  void (async () => {
    const message = JSON.parse(line);
    await handle(message);
  })().catch(cause => {
    error(null, 'fixture_error', cause instanceof Error ? cause.message : String(cause));
  });
});
