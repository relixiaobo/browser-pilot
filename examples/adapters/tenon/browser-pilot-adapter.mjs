import {
  materializeToolResult,
  projectToolInputSchema,
} from '../shared/browser-pilot-process.mjs';

export class TenonBrowserPilotAdapter {
  constructor(connection, options = {}) {
    this.connection = connection;
    this.options = options;
    this.turns = new Map();
    this.pendingTurns = new Map();
  }

  async beginTurn({ threadId, turnId, browserId }) {
    const existing = this.turns.get(turnId);
    if (existing) return assertTurnIdentity(existing, threadId, turnId);
    const pending = this.pendingTurns.get(turnId);
    if (pending) return await assertPendingTurnIdentity(pending, threadId, turnId);
    const promise = (async () => {
      const context = await this.connection.openContext({
        workspaceKey: `tenon-thread:${threadId}`,
        leaseKey: `tenon-turn:${turnId}`,
        browserId,
      });
      const turn = { threadId, turnId, context };
      this.turns.set(turnId, turn);
      return turn;
    })();
    this.pendingTurns.set(turnId, { threadId, promise });
    try {
      return await promise;
    } finally {
      if (this.pendingTurns.get(turnId)?.promise === promise) this.pendingTurns.delete(turnId);
    }
  }

  createTools(turn) {
    if (!turn?.context || ![...this.turns.values()].includes(turn)) {
      throw new Error('Tenon Browser Pilot tools require an active Turn.');
    }
    return this.connection.listTools().map(definition => ({
      name: projectName(definition.name),
      label: definition.title,
      description: `${definition.description} Browser Pilot operation: ${definition.name}.`,
      parameters: projectToolInputSchema(definition),
      executionMode: 'parallel',
      execute: async (toolCallId, rawParams, signal) => {
        const { controlTargetId, ...args } = rawParams ?? {};
        const execution = await this.connection.executeTool(
          turn.context,
          definition.name,
          args,
          { toolCallId, targetId: controlTargetId, signal },
        );
        return await materializeToolResult(this.connection, turn.context, execution, {
          artifactDirectory: this.options.artifactDirectory,
          formatFileReference: this.options.formatFileReference,
          onLifecycleError: this.options.onLifecycleError,
        });
      },
    }));
  }

  async endTurn(turnId) {
    const pending = this.pendingTurns.get(turnId);
    if (pending) await pending.promise.catch(() => {});
    const turn = this.turns.get(turnId);
    if (!turn) return;
    try {
      await this.connection.releaseContext(turn.context);
    } finally {
      this.turns.delete(turnId);
    }
  }

  async releaseThread(threadId) {
    const failures = [];
    for (const [turnId, pending] of [...this.pendingTurns]) {
      if (pending.threadId === threadId) await this.endTurn(turnId).catch(error => failures.push(error));
    }
    for (const [turnId, turn] of [...this.turns]) {
      if (turn.threadId === threadId) await this.endTurn(turnId).catch(error => failures.push(error));
    }
    await this.connection.releaseWorkspace(`tenon-thread:${threadId}`)
      .catch(error => failures.push(error));
    if (failures.length > 0) throw new AggregateError(failures, 'Tenon Browser Pilot Thread cleanup failed.');
  }

  async close() {
    try {
      await this.connection.close();
    } finally {
      this.turns.clear();
      this.pendingTurns.clear();
    }
  }
}

function projectName(name) {
  return `browser_pilot_${name.replaceAll('.', '_')}`;
}

function assertTurnIdentity(turn, threadId, turnId) {
  if (turn.threadId !== threadId) {
    throw new Error(`Tenon Turn ${turnId} is already bound to another Thread.`);
  }
  return turn;
}

async function assertPendingTurnIdentity(pending, threadId, turnId) {
  if (pending.threadId !== threadId) {
    throw new Error(`Tenon Turn ${turnId} is already being opened for another Thread.`);
  }
  return await pending.promise;
}
