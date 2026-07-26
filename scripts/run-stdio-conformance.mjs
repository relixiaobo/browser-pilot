#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPORT_SCHEMA_VERSION = 1;
const SUITE_VERSION = '1.0.0';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 300_000;
const MAX_STDOUT_LINE_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_REPORT_STRING = 500;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const REQUIRED_CAPABILITIES = [
  'browser.control',
  'workspace.manage',
  'observation.read',
  'artifact.read',
  'event.read',
];
const REQUIRED_TOOLS = [
  'browser.connect',
  'browser.open',
  'browser.observe',
  'browser.capture',
  'browser.tabs.list',
  'browser.tabs.close',
];
const REQUIRED_TOOL_CONTEXTS = new Map([
  ['browser.connect', 'workspace'],
  ['browser.open', 'workspace'],
  ['browser.observe', 'target'],
  ['browser.capture', 'target'],
  ['browser.tabs.list', 'workspace'],
  ['browser.tabs.close', 'target'],
]);

class ConformanceError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'ConformanceError';
    this.code = code;
    this.rpcCode = options.rpcCode;
  }
}

function bounded(value, limit = MAX_REPORT_STRING) {
  return String(value).replace(/[\r\n]+/g, ' ').slice(0, limit);
}

function asRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConformanceError('invalid_contract', `${label} must be an object`);
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) {
    throw new ConformanceError('invalid_contract', `${label} must be a non-empty bounded string`);
  }
  return value;
}

function assertContract(condition, message) {
  if (!condition) throw new ConformanceError('invalid_contract', message);
}

function parsePositiveInteger(raw, flag) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_REQUEST_TIMEOUT_MS) {
    throw new ConformanceError('invalid_arguments', `${flag} must be an integer from 1 through ${MAX_REQUEST_TIMEOUT_MS}`);
  }
  return value;
}

function parseArguments(argv) {
  let reportPath;
  let timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  let command;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      command = argv.slice(index + 1);
      break;
    }
    if (argument === '--report') {
      const value = argv[++index];
      if (!value) throw new ConformanceError('invalid_arguments', '--report requires a path');
      reportPath = resolve(value);
      continue;
    }
    if (argument === '--timeout-ms') {
      const value = argv[++index];
      if (!value) throw new ConformanceError('invalid_arguments', '--timeout-ms requires a value');
      timeoutMs = parsePositiveInteger(value, '--timeout-ms');
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      return { help: true };
    }
    throw new ConformanceError('invalid_arguments', `Unknown argument: ${bounded(argument, 128)}`);
  }

  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const selected = command ?? [process.execPath, resolve(root, 'dist/cli.js'), 'bridge', '--stdio'];
  if (selected.length === 0 || !selected[0]) {
    throw new ConformanceError('invalid_arguments', 'A command is required after --');
  }
  if (selected.length > 64 || selected.some(value => value.length > 16_384)) {
    throw new ConformanceError('invalid_arguments', 'The command is too large');
  }
  return { command: selected, reportPath, timeoutMs, cwd: process.cwd() };
}

function helpText() {
  return `Usage: node scripts/run-stdio-conformance.mjs [options] [-- executable arg ...]\n\n` +
    `Options:\n` +
    `  --report <path>       Also write the JSON report to this path\n` +
    `  --timeout-ms <value>  Timeout for each protocol operation (default: 30000)\n` +
    `  -h, --help            Show this help\n\n` +
    `The default command is: node dist/cli.js bridge --stdio\n`;
}

class NdjsonRpcPeer {
  constructor(command, options) {
    this.timeoutMs = options.timeoutMs;
    this.pending = new Map();
    this.retiredIds = new Set();
    this.nextId = 1;
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrBytes = 0;
    this.notifications = 0;
    this.failure = undefined;
    this.exited = false;

    this.child = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exitPromise = new Promise(resolveExit => {
      this.child.once('exit', (code, signal) => {
        this.exited = true;
        const error = this.failure ?? new ConformanceError(
          'bridge_exited',
          `Bridge exited before completing the suite (code ${code ?? 'null'}, signal ${signal ?? 'none'})`,
        );
        this.rejectPending(error);
        resolveExit({ code, signal });
      });
    });
    this.child.once('error', error => {
      this.fail(new ConformanceError('bridge_spawn_failed', `Unable to start bridge: ${bounded(error.message)}`));
    });
    this.child.stdout.on('data', chunk => this.onStdout(chunk));
    this.child.stdout.once('end', () => {
      if (this.stdoutBuffer.length > 0 && !this.failure) {
        this.fail(new ConformanceError('invalid_framing', 'Bridge stdout ended with an incomplete NDJSON line'));
      }
    });
    this.child.stderr.on('data', chunk => {
      this.stderrBytes = Math.min(MAX_STDERR_BYTES, this.stderrBytes + chunk.length);
    });
    this.child.stdin.on('error', error => {
      if (!this.exited) this.fail(new ConformanceError('transport_error', `Bridge stdin failed: ${bounded(error.message)}`));
    });
  }

  onStdout(chunk) {
    if (this.failure) return;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    if (this.stdoutBuffer.length > MAX_STDOUT_LINE_BYTES && !this.stdoutBuffer.includes(0x0a)) {
      this.fail(new ConformanceError('invalid_framing', 'Bridge emitted an oversized NDJSON line'));
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      let line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length === 0) {
        this.fail(new ConformanceError('invalid_framing', 'Bridge emitted an empty stdout line'));
        return;
      }
      if (line.length > MAX_STDOUT_LINE_BYTES) {
        this.fail(new ConformanceError('invalid_framing', 'Bridge emitted an oversized NDJSON line'));
        return;
      }
      try {
        this.onMessage(line);
      } catch (error) {
        this.fail(error instanceof ConformanceError
          ? error
          : new ConformanceError('invalid_jsonrpc', 'Bridge emitted an invalid JSON-RPC message'));
      }
      if (this.failure) return;
    }
  }

  onMessage(line) {
    let message;
    try {
      message = JSON.parse(utf8Decoder.decode(line));
    } catch {
      this.fail(new ConformanceError('invalid_json', 'Bridge stdout contained invalid UTF-8 or JSON'));
      return;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
      this.fail(new ConformanceError('invalid_jsonrpc', 'Bridge emitted an invalid JSON-RPC envelope'));
      return;
    }
    if (typeof message.method === 'string' && !Object.hasOwn(message, 'id')) {
      this.notifications += 1;
      return;
    }
    if (!Object.hasOwn(message, 'id') || (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))) {
      this.fail(new ConformanceError('invalid_jsonrpc', 'Bridge stdout must contain responses or notifications only'));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      if (this.retiredIds.delete(message.id)) return;
      this.fail(new ConformanceError('unexpected_response', 'Bridge returned an unknown JSON-RPC response id'));
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      const error = asRecord(message.error, 'JSON-RPC error');
      const code = typeof error.data?.code === 'string' ? error.data.code : 'rpc_error';
      pending.reject(new ConformanceError(code, bounded(error.message ?? 'Bridge request failed'), {
        rpcCode: Number.isSafeInteger(error.code) ? error.code : undefined,
      }));
      return;
    }
    pending.resolve(message.result);
  }

  call(method, params = {}, timeoutMs = this.timeoutMs) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.exited) return Promise.reject(new ConformanceError('bridge_exited', 'Bridge is not running'));
    const id = `conformance:${this.nextId++}`;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.retiredIds.add(id);
        rejectCall(new ConformanceError('request_timeout', `${method} did not respond within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
      this.child.stdin.write(payload, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        pending.reject(new ConformanceError('transport_error', `Unable to write ${method} request`));
      });
    });
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    this.rejectPending(error);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async waitForExit(timeoutMs) {
    if (this.exited) return this.exitPromise;
    return new Promise(resolveExit => {
      const timer = setTimeout(() => resolveExit(undefined), timeoutMs);
      void this.exitPromise.then(result => {
        clearTimeout(timer);
        resolveExit(result);
      });
    });
  }

  async stop() {
    if (this.exited) return this.exitPromise;
    this.child.stdin.end();
    const exited = await this.waitForExit(1_000);
    if (exited) return exited;
    this.child.kill('SIGTERM');
    const terminated = await this.waitForExit(1_000);
    if (terminated) return terminated;
    this.child.kill('SIGKILL');
    return this.exitPromise;
  }
}

function validateCommandOutcome(value, method) {
  const outcome = asRecord(value, `${method} response`);
  const command = asRecord(outcome.command, `${method} command`);
  assertContract(command.method === method, `${method} returned a mismatched command method`);
  assertContract(command.status === 'completed', `${method} did not complete synchronously`);
  return asRecord(outcome.result, `${method} result`);
}

function commandParams(name, args, context, serial) {
  return {
    name,
    arguments: args,
    workspaceId: context.workspaceId,
    leaseId: context.leaseId,
    ...(context.targetId ? { targetId: context.targetId } : {}),
    commandId: `command:conformance-${serial}`,
    idempotencyKey: `conformance:${serial}`,
    deadlineMs: 30_000,
  };
}

function reportError(error, checkId) {
  return {
    checkId,
    code: bounded(error?.code ?? 'unexpected_error', 128),
    message: bounded(error instanceof Error ? error.message : error),
    ...(Number.isSafeInteger(error?.rpcCode) ? { rpcCode: error.rpcCode } : {}),
  };
}

async function runSuite(options) {
  const startedAt = Date.now();
  const checks = [];
  const state = {
    initialized: false,
    browserId: undefined,
    workspaceId: undefined,
    leaseId: undefined,
    targetId: undefined,
    artifactId: undefined,
    shutdown: false,
  };
  let currentCheck = 'spawn';
  let failure;
  let peer;
  let commandSerial = 1;

  const check = async (id, operation) => {
    currentCheck = id;
    const began = Date.now();
    try {
      const detail = await operation();
      checks.push({ id, status: 'passed', durationMs: Date.now() - began, ...(detail ? { detail } : {}) });
      return detail;
    } catch (error) {
      checks.push({ id, status: 'failed', durationMs: Date.now() - began });
      throw error;
    }
  };
  const tool = async (name, args, context) => validateCommandOutcome(
    await peer.call('tools/call', commandParams(name, args, context, commandSerial++)),
    name,
  );
  const cleanup = async (id, operation) => {
    if (!peer || peer.exited) return;
    const began = Date.now();
    try {
      await operation();
      checks.push({ id, status: 'passed', durationMs: Date.now() - began });
    } catch (error) {
      checks.push({ id, status: 'failed', durationMs: Date.now() - began });
      failure ??= reportError(error, id);
    }
  };

  try {
    peer = new NdjsonRpcPeer(options.command, { timeoutMs: options.timeoutMs, cwd: options.cwd });

    await check('initialize', async () => {
      const initialized = asRecord(await peer.call('initialize', {
        client: {
          id: 'org.browser-pilot.conformance',
          name: 'Browser Pilot Stdio Conformance',
          version: SUITE_VERSION,
          instanceId: `run:${process.pid}-${startedAt}`,
        },
        protocol: { min: { major: 1, minor: 0 }, max: { major: 1, minor: 1 } },
        requestedCapabilities: REQUIRED_CAPABILITIES,
        launchMode: 'embedded',
      }), 'initialize result');
      const protocol = asRecord(initialized.protocol, 'initialize protocol');
      assertContract(protocol.major === 1 && Number.isSafeInteger(protocol.minor), 'Bridge selected an unsupported protocol');
      nonEmptyString(initialized.serviceVersion, 'serviceVersion');
      nonEmptyString(initialized.executableVersion, 'executableVersion');
      nonEmptyString(initialized.brokerProcessIdentity, 'brokerProcessIdentity');
      nonEmptyString(initialized.connectionId, 'connectionId');
      const capabilities = asRecord(initialized.capabilities, 'capability negotiation');
      const limits = asRecord(initialized.limits, 'initialize limits');
      assertContract(Array.isArray(capabilities.granted), 'initialize must return granted capabilities');
      for (const capability of REQUIRED_CAPABILITIES) {
        assertContract(capabilities.granted.includes(capability), `Required capability was not granted: ${capability}`);
      }
      assertContract(Array.isArray(initialized.browsers) && initialized.browsers.length > 0,
        'No browser candidate was advertised');
      state.browserId = nonEmptyString(initialized.browsers[0]?.id, 'browser candidate id');
      assertContract(
        Number.isSafeInteger(limits.maxMessageBytes) && limits.maxMessageBytes > 0 &&
        Number.isSafeInteger(limits.maxResultBytes) && limits.maxResultBytes > 0 &&
        Number.isSafeInteger(limits.maxArtifactBytes) && limits.maxArtifactBytes > 0 &&
        Number.isSafeInteger(limits.eventJournalSize) && limits.eventJournalSize > 0,
        'initialize returned invalid protocol limits',
      );
      state.initialized = true;
      return {
        protocol: `${protocol.major}.${protocol.minor}`,
        serviceVersion: bounded(initialized.serviceVersion, 64),
        executableVersion: bounded(initialized.executableVersion, 64),
      };
    });

    await check('tool_manifest', async () => {
      const manifest = asRecord(await peer.call('tools/list', {}), 'tool manifest');
      assertContract(manifest.schemaVersion === 1, 'Unsupported tool manifest schemaVersion');
      assertContract(Array.isArray(manifest.tools), 'Tool manifest must contain tools');
      const tools = new Map(manifest.tools.map(entry => [entry?.name, entry]));
      for (const name of REQUIRED_TOOLS) {
        const entry = asRecord(tools.get(name), `${name} manifest entry`);
        assertContract(entry.context === REQUIRED_TOOL_CONTEXTS.get(name), `${name} has an invalid context`);
        asRecord(entry.inputSchema, `${name} inputSchema`);
        asRecord(entry.outputSchema, `${name} outputSchema`);
      }
      return { toolCount: manifest.tools.length };
    });

    let eventCursor;
    await check('workspace_create', async () => {
      const created = asRecord(await peer.call('workspaces/create', {
        browserId: state.browserId,
      }), 'Workspace result');
      const workspace = asRecord(created.workspace, 'Workspace');
      state.workspaceId = nonEmptyString(workspace.id, 'Workspace id');
      assertContract(workspace.state === 'active', 'Created Workspace is not active');
      eventCursor = nonEmptyString(created.eventCursor, 'eventCursor');
      const tabSet = asRecord(created.managedTabSet, 'ManagedTabSet');
      assertContract(tabSet.workspaceId === state.workspaceId, 'ManagedTabSet belongs to another Workspace');
    });

    await check('lease_create_and_heartbeat', async () => {
      const created = asRecord(await peer.call('leases/create', {
        workspaceId: state.workspaceId,
        ttlMs: 60_000,
      }), 'Lease result');
      const lease = asRecord(created.lease, 'Lease');
      state.leaseId = nonEmptyString(lease.id, 'Lease id');
      assertContract(lease.workspaceId === state.workspaceId && lease.state === 'active', 'Lease is not active for the Workspace');
      const heartbeat = asRecord(await peer.call('leases/heartbeat', {
        leaseId: state.leaseId,
        ttlMs: 60_000,
      }), 'heartbeat result');
      const renewed = asRecord(heartbeat.lease, 'renewed Lease');
      assertContract(renewed.id === state.leaseId && renewed.state === 'active', 'Heartbeat did not renew the Lease');
    });

    await check('browser_connect', async () => {
      const connected = await tool('browser.connect', { browserId: state.browserId }, state);
      assertContract(connected.state === 'connected', 'browser.connect did not establish the browser connection');
      assertContract(Number.isSafeInteger(connected.connectionGeneration) && connected.connectionGeneration > 0,
        'browser.connect returned an invalid connection generation');
    });

    await check('managed_target_open', async () => {
      const opened = await tool('browser.open', {
        url: 'about:blank',
        newTarget: true,
        observationLimit: 10,
      }, state);
      state.targetId = nonEmptyString(opened.targetId, 'browser.open targetId');
      nonEmptyString(opened.observationId, 'browser.open observationId');
      assertContract(opened.workspaceId === state.workspaceId && opened.leaseId === state.leaseId, 'browser.open returned foreign context');
      assertContract(opened.url === 'about:blank', 'Managed target did not open about:blank');

      const listed = await tool('browser.tabs.list', { scope: 'managed_only' }, state);
      assertContract(Array.isArray(listed.targets), 'browser.tabs.list must return targets');
      assertContract(listed.targets.length === 1, 'A new Workspace must list exactly its one conformance managed target');
      assertContract(listed.targets.every(candidate => candidate?.origin === 'managed'), 'managed_only inventory returned a non-managed target');
      const target = listed.targets.find(candidate => candidate?.targetId === state.targetId);
      assertContract(target?.origin === 'managed', 'Created target is not present as a managed target');
      return { targetOrigin: 'managed' };
    });

    await check('observation', async () => {
      const observed = await tool('browser.observe', { limit: 10 }, state);
      nonEmptyString(observed.observationId, 'Observation id');
      assertContract(observed.targetId === state.targetId, 'Observation belongs to another target');
      assertContract(Array.isArray(observed.elements), 'Observation elements must be an array');
      assertContract(typeof observed.truncated === 'boolean', 'Observation must report truncation state');
      return { elementCount: observed.elements.length, truncated: observed.truncated };
    });

    let artifactPath;
    await check('screenshot_artifact', async () => {
      const captured = await tool('browser.capture', { fullPage: false }, state);
      const artifact = asRecord(captured.artifact, 'screenshot Artifact');
      state.artifactId = nonEmptyString(artifact.id, 'Artifact id');
      assertContract(artifact.kind === 'screenshot' || artifact.kind === 'screenshot_preview', 'Capture returned a non-screenshot Artifact');
      assertContract(artifact.mimeType === 'image/png', 'Screenshot Artifact must use image/png');
      assertContract(artifact.workspaceId === state.workspaceId, 'Screenshot Artifact belongs to another Workspace');
      assertContract(Number.isSafeInteger(artifact.byteSize) && artifact.byteSize > 0, 'Screenshot Artifact has an invalid byteSize');

      const accessed = asRecord(await peer.call('artifacts/get', {
        workspaceId: state.workspaceId,
        leaseId: state.leaseId,
        artifactId: state.artifactId,
      }), 'Artifact access result');
      const accessedArtifact = asRecord(accessed.artifact, 'accessed Artifact');
      assertContract(
        accessedArtifact.id === state.artifactId &&
        accessedArtifact.workspaceId === state.workspaceId &&
        accessedArtifact.mimeType === 'image/png' &&
        accessedArtifact.byteSize === artifact.byteSize,
        'Artifact access descriptor does not match the captured Artifact',
      );
      artifactPath = nonEmptyString(accessed.path, 'Artifact path');
      assertContract(isAbsolute(artifactPath), 'Artifact access path must be absolute');
      const bytes = await readFile(artifactPath);
      assertContract(bytes.length === artifact.byteSize, 'Artifact bytes do not match descriptor byteSize');
      assertContract(bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Artifact is not a PNG file');
      return { byteSize: bytes.length, mimeType: artifact.mimeType };
    });

    await check('artifact_release', async () => {
      const released = asRecord(await peer.call('artifacts/release', {
        workspaceId: state.workspaceId,
        leaseId: state.leaseId,
        artifactId: state.artifactId,
      }), 'Artifact release result');
      assertContract(released.released === true && released.artifactId === state.artifactId, 'Artifact release was not confirmed');
      try {
        await peer.call('artifacts/get', {
          workspaceId: state.workspaceId,
          leaseId: state.leaseId,
          artifactId: state.artifactId,
        });
        throw new ConformanceError('invalid_contract', 'Released Artifact remained accessible');
      } catch (error) {
        if (error?.code !== 'artifact_not_found') throw error;
      }
      try {
        await readFile(artifactPath);
        throw new ConformanceError('invalid_contract', 'Released Artifact bytes remained on disk');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      state.artifactId = undefined;
    });

    await check('event_replay', async () => {
      const polled = asRecord(await peer.call('events/poll', {
        workspaceId: state.workspaceId,
        cursor: eventCursor,
        limit: 100,
      }), 'events/poll result');
      assertContract(Array.isArray(polled.events), 'events/poll must return events');
      nonEmptyString(polled.nextCursor, 'nextCursor');
      assertContract(typeof polled.hasMore === 'boolean', 'events/poll must return hasMore');
      assertContract(polled.events.length > 0, 'No command events were replayed');
      let previousSequence = 0;
      for (const value of polled.events) {
        const event = asRecord(value, 'BrowserEvent');
        assertContract(event.workspaceId === state.workspaceId, 'Event belongs to another Workspace');
        assertContract(Number.isSafeInteger(event.sequence) && event.sequence > previousSequence, 'Events are not strictly ordered');
        previousSequence = event.sequence;
      }
      return { eventCount: polled.events.length, hasMore: polled.hasMore };
    });

    await check('managed_target_close', async () => {
      const closed = await tool('browser.tabs.close', {}, state);
      assertContract(closed.closedTargetId === state.targetId, 'The managed target was not closed');
      state.targetId = undefined;
    });

    await check('lease_and_workspace_release', async () => {
      const lease = asRecord(await peer.call('leases/release', { leaseId: state.leaseId }), 'Lease release result');
      assertContract(lease.released === true && lease.leaseId === state.leaseId, 'Lease release was not confirmed');
      state.leaseId = undefined;
      const workspace = asRecord(await peer.call('workspaces/release', { workspaceId: state.workspaceId }), 'Workspace release result');
      assertContract(workspace.released === true && workspace.workspaceId === state.workspaceId, 'Workspace release was not confirmed');
      state.workspaceId = undefined;
    });

    await check('shutdown', async () => {
      const shutdown = asRecord(await peer.call('shutdown', {}), 'shutdown result');
      assertContract(shutdown.ok === true, 'Bridge did not acknowledge shutdown');
      state.shutdown = true;
      const exited = await peer.waitForExit(Math.min(options.timeoutMs, 5_000));
      assertContract(exited !== undefined, 'Bridge did not exit after shutdown');
      assertContract(exited.code === 0 && exited.signal === null, 'Bridge exited unsuccessfully after shutdown');
    });
  } catch (error) {
    failure = reportError(error, currentCheck);
  } finally {
    if (state.artifactId && state.workspaceId && state.leaseId) {
      await cleanup('cleanup_artifact', async () => {
        await peer.call('artifacts/release', {
          workspaceId: state.workspaceId,
          leaseId: state.leaseId,
          artifactId: state.artifactId,
        });
        state.artifactId = undefined;
      });
    }
    if (state.targetId && state.workspaceId && state.leaseId) {
      await cleanup('cleanup_managed_target', async () => {
        await tool('browser.tabs.close', {}, state);
        state.targetId = undefined;
      });
    }
    if (state.leaseId) {
      await cleanup('cleanup_lease', async () => {
        await peer.call('leases/release', { leaseId: state.leaseId });
        state.leaseId = undefined;
      });
    }
    if (state.workspaceId) {
      await cleanup('cleanup_workspace', async () => {
        await peer.call('workspaces/release', { workspaceId: state.workspaceId });
        state.workspaceId = undefined;
      });
    }
    if (peer && state.initialized && !state.shutdown && !peer.exited) {
      await cleanup('cleanup_shutdown', async () => {
        await peer.call('shutdown', {});
        state.shutdown = true;
      });
    }
    if (peer) await peer.stop();
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    suite: 'browser-pilot-stdio-conformance',
    suiteVersion: SUITE_VERSION,
    outcome: failure ? 'failed' : 'passed',
    command: {
      executable: bounded(basename(options.command[0]), 128),
      argumentCount: options.command.length - 1,
    },
    checks,
    transport: {
      notificationsReceived: peer?.notifications ?? 0,
      stderrBytesObserved: peer?.stderrBytes ?? 0,
    },
    durationMs: Date.now() - startedAt,
    ...(failure ? { failure } : {}),
  };
}

async function writeReport(report, reportPath) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, serialized, { encoding: 'utf8', mode: 0o600 });
  }
  process.stdout.write(serialized);
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
  } else {
    const report = await runSuite(options);
    await writeReport(report, options.reportPath);
    process.exitCode = report.outcome === 'passed' ? 0 : 1;
  }
} catch (error) {
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    suite: 'browser-pilot-stdio-conformance',
    suiteVersion: SUITE_VERSION,
    outcome: 'failed',
    checks: [],
    durationMs: 0,
    failure: reportError(error, options ? 'report_write' : 'runner_arguments'),
  };
  try {
    await writeReport(report, options?.reportPath);
  } catch {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  process.exitCode = 2;
}
