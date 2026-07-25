import {
  materializeToolResult,
} from '../shared/browser-pilot-process.mjs';

export class OpenClawBrowserPilotAdapter {
  constructor(connection, options = {}) {
    this.connection = connection;
    this.options = options;
    this.runs = new Map();
    this.pendingRuns = new Map();
  }

  async beginRun({ agentId, sessionKey, runId, browserId }) {
    const existing = this.runs.get(runId);
    if (existing) return assertRunIdentity(existing, agentId, sessionKey, runId);
    const pending = this.pendingRuns.get(runId);
    if (pending) return await assertPendingRunIdentity(pending, agentId, sessionKey, runId);
    const promise = (async () => {
      const context = await this.connection.openContext({
        workspaceKey: `openclaw-session:${agentId}:${sessionKey}`,
        leaseKey: `openclaw-run:${runId}`,
        browserId,
      });
      const run = { agentId, sessionKey, runId, context };
      this.runs.set(runId, run);
      return run;
    })();
    this.pendingRuns.set(runId, { agentId, sessionKey, promise });
    try {
      return await promise;
    } finally {
      if (this.pendingRuns.get(runId)?.promise === promise) this.pendingRuns.delete(runId);
    }
  }

  createTool(run) {
    if (!run?.context || ![...this.runs.values()].includes(run)) {
      throw new Error('OpenClaw Browser Pilot tool requires an active Agent run.');
    }
    const definitions = this.connection.listTools();
    const definitionByName = new Map(definitions.map(definition => [definition.name, definition]));
    return {
      name: 'browser_pilot',
      label: 'Browser Pilot',
      description: [
        'Control the user\'s eligible Chromium tabs through Browser Pilot without an extension.',
        'Use browser.tabs.list to obtain an opaque controlTargetId before target-scoped operations.',
        `Available operations: ${definitions.map(definition => definition.name).join(', ')}.`,
      ].join(' '),
      parameters: {
        oneOf: definitions.map(definition => operationSchema(definition)),
      },
      executionMode: 'parallel',
      execute: async (toolCallId, params, signal) => {
        const definition = definitionByName.get(params.operation);
        if (!definition) throw new Error(`Unsupported Browser Pilot operation: ${params.operation}`);
        const execution = await this.connection.executeTool(
          run.context,
          definition.name,
          params.arguments,
          { toolCallId, targetId: params.controlTargetId, signal },
        );
        return await materializeToolResult(this.connection, run.context, execution, {
          artifactDirectory: this.options.artifactDirectory,
          formatFileReference: this.options.formatFileReference,
          onLifecycleError: this.options.onLifecycleError,
        });
      },
    };
  }

  async endRun(runId) {
    const pending = this.pendingRuns.get(runId);
    if (pending) await pending.promise.catch(() => {});
    const run = this.runs.get(runId);
    if (!run) return;
    try {
      await this.connection.releaseContext(run.context);
    } finally {
      this.runs.delete(runId);
    }
  }

  async releaseSession(agentId, sessionKey) {
    const failures = [];
    for (const [runId, pending] of [...this.pendingRuns]) {
      if (pending.agentId === agentId && pending.sessionKey === sessionKey) {
        await this.endRun(runId).catch(error => failures.push(error));
      }
    }
    for (const [runId, run] of [...this.runs]) {
      if (run.agentId === agentId && run.sessionKey === sessionKey) {
        await this.endRun(runId).catch(error => failures.push(error));
      }
    }
    await this.connection.releaseWorkspace(`openclaw-session:${agentId}:${sessionKey}`)
      .catch(error => failures.push(error));
    if (failures.length > 0) throw new AggregateError(failures, 'OpenClaw Browser Pilot session cleanup failed.');
  }

  async close() {
    try {
      await this.connection.close();
    } finally {
      this.runs.clear();
      this.pendingRuns.clear();
    }
  }
}

function operationSchema(definition) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'operation',
      'arguments',
      ...(definition.context === 'target' ? ['controlTargetId'] : []),
    ],
    properties: {
      operation: { type: 'string', const: definition.name },
      arguments: structuredClone(definition.inputSchema),
      ...(definition.context === 'target' ? {
        controlTargetId: {
          type: 'string',
          minLength: 3,
          maxLength: 128,
          description: 'Opaque targetId returned by browser.open or browser.tabs.list.',
        },
      } : {}),
    },
  };
}

function assertRunIdentity(run, agentId, sessionKey, runId) {
  if (run.agentId !== agentId || run.sessionKey !== sessionKey) {
    throw new Error(`OpenClaw run ${runId} is already bound to another Agent session.`);
  }
  return run;
}

async function assertPendingRunIdentity(pending, agentId, sessionKey, runId) {
  if (pending.agentId !== agentId || pending.sessionKey !== sessionKey) {
    throw new Error(`OpenClaw run ${runId} is already being opened for another Agent session.`);
  }
  return await pending.promise;
}
