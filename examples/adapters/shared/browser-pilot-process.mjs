import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const DEFAULT_CAPABILITIES = [
  'browser.discovery',
  'browser.control',
  'workspace.manage',
  'observation.read',
  'action.input',
  'artifact.read',
  'event.read',
  'network.observe',
  'network.modify',
  'auth.manage',
  'cookies.read',
  'developer.eval',
];
const MAX_RPC_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 65_000;
const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 20_000;
const MAX_MODEL_TEXT_BYTES = 1024 * 1024;

export class BrowserPilotAdapterError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'BrowserPilotAdapterError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.remediation = options.remediation;
    this.context = options.context;
  }
}

class NdjsonRpcPeer {
  constructor(command, options = {}) {
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      typeof command[0] !== 'string' ||
      !isAbsolute(command[0])
    ) {
      throw new BrowserPilotAdapterError(
        'invalid_executable',
        'Browser Pilot must be launched from an absolute executable path.',
      );
    }
    if (command.some(argument => typeof argument !== 'string' || argument.includes('\0'))) {
      throw new BrowserPilotAdapterError(
        'invalid_command',
        'Browser Pilot launch arguments must be strings without null bytes.',
      );
    }
    this.onDiagnostic = options.onDiagnostic;
    this.onNotification = options.onNotification;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.pending = new Map();
    this.nextId = 1;
    this.stdoutBuffer = Buffer.alloc(0);
    this.writeChain = Promise.resolve();
    this.closed = false;
    this.closeError = null;
    this.child = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.exited = new Promise(resolve => {
      this.child.once('close', (code, signal) => {
        this.closed = true;
        this.rejectPending(this.closeError ?? new BrowserPilotAdapterError(
          'connection_lost',
          `Browser Pilot bridge exited ${signal ? `from ${signal}` : `with code ${code ?? 'unknown'}`}.`,
          { retryable: true, context: { code, signal } },
        ));
        resolve({ code, signal });
      });
    });
    this.child.once('error', error => {
      this.closed = true;
      this.closeError = new BrowserPilotAdapterError(
        'launch_failed',
        `Browser Pilot could not start: ${error.message}`,
        { cause: error },
      );
      this.rejectPending(this.closeError);
    });
    this.child.stdout.on('data', bytes => this.acceptStdout(bytes));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', text => {
      for (const line of text.split(/\r?\n/u)) {
        if (line) safelyInvoke(this.onDiagnostic, line.slice(0, 4096));
      }
    });
  }

  async call(method, params = {}, options = {}) {
    if (this.closed) {
      throw this.closeError ?? new BrowserPilotAdapterError('connection_lost', 'Browser Pilot bridge is not running.', {
        retryable: true,
      });
    }
    if (this.pending.size >= 256) {
      throw new BrowserPilotAdapterError('adapter_saturated', 'Too many Browser Pilot calls are pending.', {
        retryable: true,
      });
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserPilotAdapterError(
          'rpc_timeout',
          `${method} did not respond within ${timeoutMs}ms.`,
          { retryable: true, context: { method } },
        ));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
    });
    try {
      await this.write({ jsonrpc: '2.0', id, method, params });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      }
    }
    return await response;
  }

  async shutdown() {
    if (this.closed) return await this.exited;
    let shutdownError;
    try {
      await this.call('shutdown', {}, { timeoutMs: 5_000 });
    } catch (error) {
      shutdownError = error;
    }
    const graceful = await this.waitForExit(5_000);
    const result = graceful ?? await this.abort();
    if (shutdownError) throw shutdownError;
    return result;
  }

  terminate() {
    if (!this.closed) this.child.kill('SIGTERM');
  }

  async abort() {
    if (!this.closed) this.child.kill('SIGTERM');
    const terminated = await this.waitForExit(5_000);
    if (terminated) return terminated;
    this.child.kill('SIGKILL');
    const killed = await this.waitForExit(5_000);
    if (killed) return killed;
    throw new BrowserPilotAdapterError(
      'cleanup_timeout',
      'Browser Pilot bridge did not exit after forced termination.',
    );
  }

  async waitForExit(timeoutMs) {
    return await Promise.race([
      this.exited,
      new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref?.();
      }),
    ]);
  }

  async write(message) {
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
    this.writeChain = this.writeChain.then(() => new Promise((resolve, reject) => {
      if (this.closed || this.child.stdin.destroyed) {
        reject(new BrowserPilotAdapterError('connection_lost', 'Browser Pilot stdin is closed.', {
          retryable: true,
        }));
        return;
      }
      this.child.stdin.write(bytes, error => {
        if (error) reject(new BrowserPilotAdapterError(
          'connection_lost',
          `Browser Pilot write failed: ${error.message}`,
          { retryable: true, cause: error },
        ));
        else resolve();
      });
    }));
    return await this.writeChain;
  }

  acceptStdout(bytes) {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, bytes]);
    if (this.stdoutBuffer.length > MAX_RPC_LINE_BYTES && !this.stdoutBuffer.includes(0x0a)) {
      this.failProtocol('Browser Pilot emitted an oversized protocol line.');
      return;
    }
    let newline;
    while ((newline = this.stdoutBuffer.indexOf(0x0a)) >= 0) {
      const line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.length === 0) continue;
      if (line.length > MAX_RPC_LINE_BYTES) {
        this.failProtocol('Browser Pilot emitted an oversized protocol line.');
        return;
      }
      let message;
      try {
        message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
      } catch (error) {
        this.failProtocol('Browser Pilot emitted invalid NDJSON.', error);
        return;
      }
      this.acceptMessage(message);
    }
  }

  acceptMessage(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      this.failProtocol('Browser Pilot emitted an invalid JSON-RPC envelope.');
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const data = message.error.data && typeof message.error.data === 'object'
          ? message.error.data
          : {};
        pending.reject(new BrowserPilotAdapterError(
          typeof data.code === 'string' ? data.code : 'rpc_error',
          typeof message.error.message === 'string' ? message.error.message : `${pending.method} failed.`,
          {
            retryable: data.retryable === true,
            remediation: data.remediation,
            context: data.context,
          },
        ));
      } else if ('result' in message) {
        pending.resolve(message.result);
      } else {
        pending.reject(new BrowserPilotAdapterError('invalid_protocol', 'RPC response has no result.'));
      }
      return;
    }
    if (typeof message.method === 'string') {
      safelyInvoke(this.onNotification, message.method, message.params ?? {});
    }
  }

  failProtocol(message, cause) {
    const error = new BrowserPilotAdapterError('invalid_protocol', message, { cause });
    this.rejectPending(error);
    this.terminate();
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class BrowserPilotProcessAdapter {
  static async connect(options) {
    const adapter = new BrowserPilotProcessAdapter(options);
    await adapter.start();
    return adapter;
  }

  constructor(options) {
    if (!options?.client?.id || !options.client.name || !options.client.version || !options.client.instanceId) {
      throw new BrowserPilotAdapterError('invalid_client', 'A complete stable client identity is required.');
    }
    this.options = options;
    this.peer = null;
    this.initializeResult = null;
    this.manifest = null;
    this.toolDefinitions = new Map();
    this.workspaces = new Map();
    this.contexts = new Map();
    this.startPromise = null;
    this.closePromise = null;
    this.lifecycleChain = Promise.resolve();
  }

  async start() {
    if (this.closePromise) {
      throw new BrowserPilotAdapterError('connection_lost', 'Browser Pilot adapter is closing or closed.');
    }
    this.startPromise ??= this.startInternal();
    return await this.startPromise;
  }

  async startInternal() {
    const bridgeArgs = ['bridge', '--stdio'];
    if (this.options.browser) bridgeArgs.push('--browser', this.options.browser);
    const command = this.options.command ?? [this.options.executable, ...bridgeArgs];
    this.peer = new NdjsonRpcPeer(command, {
      cwd: this.options.cwd,
      env: this.options.env,
      requestTimeoutMs: this.options.requestTimeoutMs,
      onDiagnostic: this.options.onDiagnostic,
      onNotification: (method, params) => this.acceptNotification(method, params),
    });
    try {
      this.initializeResult = await this.peer.call('initialize', {
        client: this.options.client,
        protocol: { min: { major: 1, minor: 1 }, max: { major: 1, minor: 2 } },
        requestedCapabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES,
        launchMode: 'embedded',
        limits: {
          maxMessageBytes: 1024 * 1024,
          maxResultBytes: 8 * 1024 * 1024,
        },
      });
      this.manifest = await this.peer.call('tools/list', {});
      if (this.manifest?.schemaVersion !== 1 || !Array.isArray(this.manifest.tools)) {
        throw new BrowserPilotAdapterError('invalid_protocol', 'Browser Pilot returned an unsupported tool manifest.');
      }
      this.toolDefinitions = new Map(this.manifest.tools.map(definition => [definition.name, definition]));
      return this;
    } catch (error) {
      await this.peer.abort().catch(cleanupError => {
        safelyInvoke(this.options.onLifecycleError, cleanupError);
      });
      throw error;
    }
  }

  listTools() {
    if (this.closePromise) throw new BrowserPilotAdapterError('connection_lost', 'Browser Pilot adapter is closed.');
    if (!this.manifest) throw new BrowserPilotAdapterError('not_initialized', 'Browser Pilot is not initialized.');
    return this.manifest.tools.map(definition => structuredClone(definition));
  }

  async openContext(options) {
    await this.start();
    if (this.closePromise) {
      throw new BrowserPilotAdapterError('connection_lost', 'Browser Pilot adapter is closing.');
    }
    return await this.withLifecycle(() => this.openContextInternal(options));
  }

  async openContextInternal(options) {
    const contextKey = stableKey('context', `${options.workspaceKey}\0${options.leaseKey}`);
    const existing = this.contexts.get(contextKey);
    if (existing) return existing.publicContext;

    const workspaceKey = stableKey('workspace', options.workspaceKey);
    let workspace = this.workspaces.get(workspaceKey);
    let createdWorkspace = false;
    if (!workspace) {
      const created = await this.peer.call('workspaces/create', {
        clientKey: workspaceKey,
        ...(options.browserId ? { browserId: options.browserId } : {}),
      });
      workspace = {
        key: workspaceKey,
        id: created.workspace.id,
        eventCursor: created.eventCursor,
        pendingEventCursor: null,
        eventChain: Promise.resolve(),
        contextKeys: new Set(),
      };
      this.workspaces.set(workspaceKey, workspace);
      createdWorkspace = true;
    }

    const leaseKey = stableKey('lease', `${options.workspaceKey}\0${options.leaseKey}`);
    let created;
    try {
      created = await this.peer.call('leases/create', {
        workspaceId: workspace.id,
        clientKey: leaseKey,
        ttlMs: options.ttlMs ?? DEFAULT_LEASE_TTL_MS,
      });
    } catch (error) {
      if (createdWorkspace) {
        this.workspaces.delete(workspaceKey);
        await this.peer.call('workspaces/release', { workspaceId: workspace.id }).catch(cleanupError => {
          safelyInvoke(this.options.onLifecycleError, cleanupError);
        });
      }
      throw error;
    }
    const publicContext = Object.freeze({
      id: contextKey,
      workspaceId: workspace.id,
      leaseId: created.lease.id,
    });
    const record = {
      publicContext,
      workspaceKey,
      leaseId: created.lease.id,
      heartbeat: null,
      ttlMs: options.ttlMs ?? DEFAULT_LEASE_TTL_MS,
    };
    workspace.contextKeys.add(contextKey);
    this.contexts.set(contextKey, record);
    record.heartbeat = setInterval(() => {
      void this.heartbeat(record).catch(error => {
        safelyInvoke(this.options.onLifecycleError, error, publicContext);
      });
    }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    record.heartbeat.unref?.();
    return publicContext;
  }

  async heartbeat(record) {
    if (!this.contexts.has(record.publicContext.id)) return;
    await this.peer.call('leases/heartbeat', { leaseId: record.leaseId, ttlMs: record.ttlMs });
  }

  async executeTool(context, name, args, options = {}) {
    await this.start();
    const definition = this.toolDefinitions.get(name);
    if (!definition) throw new BrowserPilotAdapterError('unknown_tool', `Unsupported Browser Pilot tool: ${name}`);
    if (options.signal?.aborted) {
      throw new BrowserPilotAdapterError('cancelled', 'Tool call was cancelled before dispatch.');
    }
    if (definition.context !== 'connection' && !this.isLiveContext(context)) {
      throw new BrowserPilotAdapterError('invalid_context', `${name} requires a live host context.`);
    }
    if (definition.context === 'target' && !options.targetId) {
      throw new BrowserPilotAdapterError('invalid_argument', `${name} requires controlTargetId.`);
    }
    const callIdentity = stableKey(
      'call',
      [
        this.initializeResult.connectionId,
        context?.workspaceId ?? 'connection',
        context?.leaseId ?? 'connection',
        options.toolCallId ?? randomUUID(),
      ].join('\0'),
    );
    const params = {
      name,
      arguments: args ?? {},
      ...(definition.context !== 'connection' ? {
        workspaceId: context.workspaceId,
        leaseId: context.leaseId,
      } : {}),
      ...(definition.context === 'target' ? { targetId: options.targetId } : {}),
      commandId: `command:${callIdentity}`,
      idempotencyKey: `host:${callIdentity}`,
      deadlineMs: options.deadlineMs ?? 60_000,
    };
    const cancel = () => {
      void this.peer.call('commands/cancel', {
        commandId: params.commandId,
        ...(definition.context !== 'connection' ? { workspaceId: context.workspaceId } : {}),
      }, { timeoutMs: 5_000 }).catch(error => {
        safelyInvoke(this.options.onLifecycleError, error, context);
      });
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      const outcome = await this.peer.call('tools/call', params, {
        timeoutMs: (options.deadlineMs ?? 60_000) + 5_000,
      });
      if (outcome?.command?.status !== 'completed' || !('result' in outcome)) {
        const status = outcome?.command?.status ?? 'unknown';
        if (outcome?.error) throw adapterErrorFromJsonRpc(outcome.error, `${name} failed.`);
        throw new BrowserPilotAdapterError(
          status === 'unknown_outcome' ? 'unknown_outcome' : `command_${status}`,
          `${name} ended with command status ${status}.`,
          { retryable: false, context: { command: outcome?.command } },
        );
      }
      return { definition, command: outcome.command, result: outcome.result };
    } catch (error) {
      if (
        definition.mutating &&
        error instanceof BrowserPilotAdapterError &&
        (error.code === 'rpc_timeout' || error.code === 'connection_lost')
      ) {
        throw new BrowserPilotAdapterError(
          'unknown_outcome',
          `${name} may have been dispatched before the bridge outcome was lost. Inspect browser state before retrying.`,
          {
            cause: error,
            retryable: false,
            context: { commandId: params.commandId, method: name },
          },
        );
      }
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', cancel);
    }
  }

  async pollEvents(context, limit = 100) {
    if (!this.isLiveContext(context)) {
      throw new BrowserPilotAdapterError('invalid_context', 'Event polling requires a live host context.');
    }
    const record = this.contexts.get(context.id);
    const workspace = this.workspaces.get(record.workspaceKey);
    return await this.withWorkspaceEvents(workspace, async () => {
      const result = await this.peer.call('events/poll', {
        workspaceId: workspace.id,
        cursor: workspace.eventCursor,
        limit,
      });
      workspace.pendingEventCursor = result.nextCursor;
      return result;
    });
  }

  async acknowledgeEvents(context, nextCursor) {
    if (!this.isLiveContext(context)) {
      throw new BrowserPilotAdapterError('invalid_context', 'Event acknowledgement requires a live host context.');
    }
    const record = this.contexts.get(context.id);
    const workspace = this.workspaces.get(record.workspaceKey);
    return await this.withWorkspaceEvents(workspace, async () => {
      if (typeof nextCursor !== 'string' || nextCursor !== workspace.pendingEventCursor) {
        throw new BrowserPilotAdapterError(
          'invalid_event_cursor',
          'Only the nextCursor from the most recent event poll can be acknowledged.',
        );
      }
      workspace.eventCursor = nextCursor;
      workspace.pendingEventCursor = null;
      return { eventCursor: nextCursor };
    });
  }

  async resetEventCursor(context) {
    if (!this.isLiveContext(context)) {
      throw new BrowserPilotAdapterError('invalid_context', 'Event cursor reset requires a live host context.');
    }
    const record = this.contexts.get(context.id);
    const workspace = this.workspaces.get(record.workspaceKey);
    return await this.withWorkspaceEvents(workspace, async () => {
      const result = await this.peer.call('workspaces/get', { workspaceId: workspace.id });
      workspace.eventCursor = result.eventCursor;
      workspace.pendingEventCursor = null;
      return result;
    });
  }

  async getArtifact(context, artifactId) {
    this.assertLiveContext(context);
    return await this.peer.call('artifacts/get', {
      workspaceId: context.workspaceId,
      leaseId: context.leaseId,
      artifactId,
    });
  }

  async exportArtifact(context, artifactId, path) {
    this.assertLiveContext(context);
    if (!isAbsolute(path)) throw new BrowserPilotAdapterError('invalid_path', 'Artifact export path must be absolute.');
    const destination = resolve(path);
    const result = await this.peer.call('artifacts/export', {
      workspaceId: context.workspaceId,
      leaseId: context.leaseId,
      artifactId,
      path: destination,
      overwrite: false,
    });
    if (result?.path !== destination) {
      throw new BrowserPilotAdapterError('invalid_protocol', 'Browser Pilot returned an unexpected Artifact path.');
    }
    return result;
  }

  async releaseArtifact(context, artifactId) {
    this.assertLiveContext(context);
    return await this.peer.call('artifacts/release', {
      workspaceId: context.workspaceId,
      leaseId: context.leaseId,
      artifactId,
    });
  }

  async releaseContext(context) {
    return await this.withLifecycle(() => this.releaseContextInternal(context));
  }

  async releaseContextInternal(context) {
    const record = context && this.contexts.get(context.id);
    if (!record || record.publicContext !== context) return;
    clearInterval(record.heartbeat);
    this.contexts.delete(context.id);
    this.workspaces.get(record.workspaceKey)?.contextKeys.delete(context.id);
    await this.peer.call('leases/release', { leaseId: record.leaseId });
  }

  async releaseWorkspace(workspaceKey) {
    return await this.withLifecycle(() => this.releaseWorkspaceInternal(workspaceKey));
  }

  async releaseWorkspaceInternal(workspaceKey, normalized = false) {
    const key = normalized ? workspaceKey : stableKey('workspace', workspaceKey);
    const workspace = this.workspaces.get(key);
    if (!workspace) return;
    const failures = [];
    for (const contextKey of [...workspace.contextKeys]) {
      await this.releaseContextInternal(this.contexts.get(contextKey)?.publicContext)
        .catch(error => failures.push(error));
    }
    await this.peer.call('workspaces/release', { workspaceId: workspace.id })
      .catch(error => failures.push(error));
    this.workspaces.delete(key);
    if (failures.length > 0) throw new AggregateError(failures, 'Browser Pilot Workspace cleanup failed.');
  }

  async close() {
    this.closePromise ??= this.withLifecycle(() => this.closeInternal());
    return await this.closePromise;
  }

  async closeInternal() {
    const failures = [];
    if (this.startPromise) await this.startPromise.catch(() => {});
    for (const record of this.contexts.values()) clearInterval(record.heartbeat);
    if (this.peer) {
      for (const workspaceKey of [...this.workspaces.keys()]) {
        await this.releaseWorkspaceInternal(workspaceKey, true).catch(error => failures.push(error));
      }
      for (const context of [...this.contexts.values()]) {
        await this.releaseContextInternal(context.publicContext).catch(error => failures.push(error));
      }
      this.contexts.clear();
      this.workspaces.clear();
      await this.peer.shutdown().catch(error => failures.push(error));
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Browser Pilot adapter cleanup failed.');
  }

  isLiveContext(context) {
    return Boolean(context && this.contexts.get(context.id)?.publicContext === context);
  }

  assertLiveContext(context) {
    if (!this.isLiveContext(context)) {
      throw new BrowserPilotAdapterError('invalid_context', 'Artifact access requires a live host context.');
    }
  }

  acceptNotification(method, params) {
    if (method !== 'events/event' || !params?.event) return;
    safelyInvoke(this.options.onBrowserEvent, params.event);
  }

  async withLifecycle(operation) {
    const result = this.lifecycleChain.then(operation, operation);
    this.lifecycleChain = result.catch(() => {});
    return await result;
  }

  async withWorkspaceEvents(workspace, operation) {
    const result = workspace.eventChain.then(operation, operation);
    workspace.eventChain = result.catch(() => {});
    return await result;
  }
}

export function projectToolInputSchema(definition) {
  const schema = structuredClone(definition.inputSchema);
  if (definition.context !== 'target') return schema;
  if (schema.type !== 'object') {
    throw new BrowserPilotAdapterError('invalid_protocol', `${definition.name} has a non-object input schema.`);
  }
  schema.properties = {
    controlTargetId: {
      type: 'string',
      minLength: 3,
      maxLength: 128,
      description: 'Opaque targetId returned by browser.open or browser.tabs.list.',
    },
    ...(schema.properties ?? {}),
  };
  schema.required = [...new Set(['controlTargetId', ...(schema.required ?? [])])];
  return schema;
}

export async function materializeToolResult(adapter, context, execution, options = {}) {
  const descriptors = collectArtifactDescriptors(execution.result);
  const selected = descriptors.find(item => item.key === 'preview') ?? descriptors[0];
  const extraContent = [];
  const exportedFiles = [];
  try {
    if (selected?.descriptor?.mimeType?.startsWith('image/')) {
      const accessed = await adapter.getArtifact(context, selected.descriptor.id);
      if (!isAbsolute(accessed.path)) {
        throw new BrowserPilotAdapterError('invalid_protocol', 'Browser Pilot returned a non-absolute Artifact path.');
      }
      const bytes = await readFile(accessed.path);
      if (bytes.length !== selected.descriptor.byteSize) {
        throw new BrowserPilotAdapterError('artifact_mismatch', 'Artifact byte length does not match its descriptor.');
      }
      extraContent.push({
        type: 'image',
        data: bytes.toString('base64'),
        mimeType: selected.descriptor.mimeType,
      });
    } else if (selected) {
      if (!options.artifactDirectory || !isAbsolute(options.artifactDirectory)) {
        throw new BrowserPilotAdapterError(
          'artifact_directory_required',
          'A host-owned absolute artifactDirectory is required for non-image results.',
        );
      }
      await mkdir(options.artifactDirectory, { recursive: true });
      const path = join(
        options.artifactDirectory,
        `${safeFileName(selected.descriptor.id)}${extensionForMimeType(selected.descriptor.mimeType)}`,
      );
      const exported = await adapter.exportArtifact(context, selected.descriptor.id, path);
      exportedFiles.push(exported.path);
      extraContent.push({
        type: 'text',
        text: options.formatFileReference?.(exported.path, selected.descriptor) ?? `FILE:${exported.path}`,
      });
    }
  } finally {
    for (const descriptor of new Map(
      descriptors.map(item => [item.descriptor.id, item.descriptor]),
    ).values()) {
      await adapter.releaseArtifact(context, descriptor.id).catch(error => {
        safelyInvoke(options.onLifecycleError, error, context);
      });
    }
  }
  return {
    content: [
      { type: 'text', text: boundedModelText(execution.result) },
      ...extraContent,
    ],
    details: {
      browserPilot: {
        command: execution.command,
        result: execution.result,
        sensitivity: execution.definition.sensitivity,
        exportedFiles,
      },
    },
  };
}

function collectArtifactDescriptors(result) {
  if (!result || typeof result !== 'object') return [];
  return ['artifact', 'preview']
    .filter(key => result[key] && typeof result[key] === 'object' && typeof result[key].id === 'string')
    .map(key => ({ key, descriptor: result[key] }));
}

function stableKey(prefix, value) {
  const digest = createHash('sha256').update(String(value)).digest('hex');
  return `${prefix}:${digest}`;
}

function safeFileName(value) {
  return String(value).replaceAll(/[^A-Za-z0-9._-]/gu, '_').slice(0, 128);
}

function extensionForMimeType(mimeType) {
  if (mimeType === 'application/pdf') return '.pdf';
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/jpeg') return '.jpg';
  return '.bin';
}

function boundedModelText(value) {
  const serialized = JSON.stringify(value);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= MAX_MODEL_TEXT_BYTES) return serialized;
  const header = `[Browser Pilot result truncated: ${bytes} UTF-8 bytes]\n`;
  const prefixBytes = MAX_MODEL_TEXT_BYTES - Buffer.byteLength(header, 'utf8') - 4;
  const prefix = new TextDecoder('utf-8').decode(
    Buffer.from(serialized, 'utf8').subarray(0, prefixBytes),
  );
  return `${header}${prefix}`;
}

function adapterErrorFromJsonRpc(error, fallbackMessage) {
  const data = error?.data && typeof error.data === 'object' ? error.data : {};
  return new BrowserPilotAdapterError(
    typeof data.code === 'string' ? data.code : 'command_failed',
    typeof error?.message === 'string' ? error.message : fallbackMessage,
    {
      retryable: data.retryable === true,
      remediation: data.remediation,
      context: data.context,
    },
  );
}

function safelyInvoke(callback, ...args) {
  if (typeof callback !== 'function') return;
  try {
    const result = callback(...args);
    if (result && typeof result.catch === 'function') void result.catch(() => {});
  } catch {
    // Host callbacks cannot be allowed to corrupt bridge lifecycle or framing.
  }
}
