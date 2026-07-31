import type { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { CompatibilityBrokerClient } from '../../compatibility-broker-client.js';
import { BrowserPilotError, invalidArgument } from '../../protocol/errors.js';
import type { JsonValue } from '../../protocol/model.js';
import { serializeStructuralText } from '../../structural-text.js';
import { outputPath } from '../artifacts.js';
import type { CliCommandContext } from '../context.js';
import { parseLimit, parseNonNegativeInteger } from '../parse.js';

function requireString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string') throw new BrowserPilotError('internal_error', `${label} is missing`);
  return value;
}

export function register(program: Command, ctx: CliCommandContext): void {
  const { action, requireCompatibility } = ctx;
  const { emit, useJson } = ctx.output;

function networkRequests(result: Record<string, JsonValue>): Array<Record<string, JsonValue>> {
  return Array.isArray(result.requests)
    ? result.requests as Array<Record<string, JsonValue>>
    : [];
}

function cliNetworkRequest(request: Record<string, JsonValue>): Record<string, JsonValue> {
  return {
    id: request.sequence,
    method: request.method,
    url: request.url,
    ...(request.status !== undefined ? { status: request.status } : {}),
    type: request.type,
    ...(request.size !== undefined ? { size: request.size } : {}),
    ...(request.durationMs !== undefined ? { time: request.durationMs } : {}),
    ...(request.error !== undefined ? { error: request.error } : {}),
  };
}

async function findNetworkRequest(
  client: CompatibilityBrokerClient,
  sequence: number,
): Promise<Record<string, JsonValue>> {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw invalidArgument('Request ID must be a positive integer', 'id');
  }
  const listed = await client.callTool('browser.network.requests', {
    after: sequence - 1,
    limit: 1,
  });
  const request = networkRequests(listed)[0];
  if (!request || request.sequence !== sequence) {
    throw new BrowserPilotError('invalid_argument', `Request #${sequence} not found`, {
      context: { field: 'id', sequence },
    });
  }
  return request;
}

const netCmd = program.command('net')
  .description('Network monitoring and interception')
  .option('-l, --limit <n>', 'max requests to show', '20')
  .option('--url <pattern>', 'filter by URL wildcard')
  .option('--method <method>', 'filter by HTTP method')
  .option('--status <code>', 'filter by status (200, 4xx, 5xx)')
  .option('--type <types>', 'filter by resource type (xhr,fetch,document)')
  .option('--after <id>', 'show requests after this ID')
  .addHelpText('after', '\nExamples:\n  bp net                              # list recent requests\n  bp net --url "*api*" --method POST  # filter\n  bp net show 3                       # full details + body\n  bp net block "*tracking*"           # block URLs\n  bp net mock "*api/data*" --body \'{"ok":true}\'\n  bp net rules                        # list active rules\n  bp net remove --all                 # clear rules')
  .action(action(async (opts) => {
    const client = await requireCompatibility();
    const limit = parseLimit(opts.limit ?? '20');
    const after = opts.after === undefined
      ? undefined
      : parseNonNegativeInteger(
          opts.after,
          '--after must be a non-negative integer',
          'after',
        );
    const result = await client.callTool('browser.network.requests', {
      limit,
      ...(opts.url ? { url: opts.url } : {}),
      ...(opts.method ? { method: opts.method } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.type ? { type: String(opts.type).split(',').map(value => value.trim()).filter(Boolean) } : {}),
      ...(after !== undefined ? { after } : {}),
    });
    const requests = networkRequests(result).map(cliNetworkRequest);

    if (useJson()) {
      emit({
        ok: true,
        requests,
        total: requests.length,
        truncated: result.truncated === true,
        nextCursor: result.nextCursor,
      });
    } else if (requests.length === 0) {
      console.log('No requests captured.');
    } else {
      console.log(` ${'#'.padStart(4)}  ${'METHOD'.padEnd(7)} ${'STATUS'.padEnd(7)} ${'TYPE'.padEnd(8)} ${'TIME'.padEnd(8)} URL`);
      for (const r of requests) {
        const time = r.time ? `${r.time}ms` : r.error ? 'FAIL' : '...';
        const status = r.status ? String(r.status) : r.error ? 'ERR' : '...';
        console.log(` ${String(r.id).padStart(4)}  ${serializeStructuralText(r.method).padEnd(7)} ${status.padEnd(7)} ${serializeStructuralText(r.type).padEnd(8)} ${time.padEnd(8)} ${serializeStructuralText(r.url, 2_048)}`);
      }
    }
  }));

netCmd.command('show <id>')
  .description('Show full request/response details')
  .option('--save <file>', 'save response body to file')
  .action(action(async (idStr, opts) => {
    const destination = opts.save ? outputPath(opts.save) : undefined;
    const client = await requireCompatibility();
    const id = Number(idStr);
    const summary = await findNetworkRequest(client, id);
    const result = await client.callTool('browser.network.request', {
      requestId: requireString(summary.requestId, 'requestId'),
      includeBody: true,
    });
    const request = result.request && typeof result.request === 'object' && !Array.isArray(result.request)
      ? result.request as Record<string, JsonValue>
      : {};
    const responseBody = typeof result.body === 'string' ? result.body : undefined;

    if (destination) {
      if (responseBody === undefined) {
        throw new BrowserPilotError(
          'action_not_verified',
          `Response body for request #${id} is unavailable`,
          { context: { sequence: id } },
        );
      }
      const bytes = result.bodyEncoding === 'base64'
        ? Buffer.from(responseBody, 'base64')
        : Buffer.from(responseBody, 'utf8');
      writeFileSync(destination, bytes, { mode: 0o600 });
      emit({
        ok: true,
        file: destination,
        mimeType: typeof request.mimeType === 'string' ? request.mimeType : 'application/octet-stream',
        sizeBytes: bytes.byteLength,
      }, `Saved to ${destination}`);
      return;
    }

    const detail: Record<string, any> = { id, ...request, responseBody };
    delete detail.sequence;

    if (useJson()) {
      emit({ ok: true, ...detail });
    } else {
      console.log(`#${detail.id} ${serializeStructuralText(detail.method)} ${serializeStructuralText(detail.url, 2_048)}`);
      console.log(`Status: ${detail.status ?? 'pending'} ${serializeStructuralText(detail.statusText)}`);
      if (detail.postData) console.log(`\nRequest Body:\n${detail.postData}`);
      if (responseBody) {
        console.log(`\nResponse (${serializeStructuralText(detail.mimeType)}):`);
        console.log(responseBody.length > 2000 ? responseBody.slice(0, 2000) + '\n... (truncated)' : responseBody);
      }
    }
  }));

netCmd.command('block <pattern>')
  .description('Block requests matching URL pattern')
  .action(action(async (pattern) => {
    const client = await requireCompatibility();
    const result = await client.callTool('browser.network.rules.add', { type: 'block', pattern });
    const rule = { id: result.ruleId, type: 'block', pattern };
    emit({ ok: true, rule }, `Rule #${rule.id}: blocking "${pattern}"`);
  }));

netCmd.command('mock <pattern>')
  .description('Mock responses for matching URLs')
  .option('--body <text>', 'response body text')
  .option('--file <path>', 'read body from file')
  .option('--status <code>', 'HTTP status', '200')
  .action(action(async (pattern, opts) => {
    const client = await requireCompatibility();
    let body = opts.body || '';
    if (opts.file) {
      const filePath = resolvePath(opts.file);
      if (!existsSync(filePath)) throw invalidArgument(`File not found: ${filePath}`, 'file');
      body = readFileSync(filePath, 'utf-8');
    }
    const status = Number(opts.status);
    if (!/^\d+$/.test(opts.status) || !Number.isSafeInteger(status) || status < 100 || status > 599) {
      throw invalidArgument('--status must be an HTTP status from 100 through 599', 'status');
    }
    const result = await client.callTool('browser.network.rules.add', {
      type: 'mock',
      pattern,
      status,
      body,
    });
    const rule = { id: result.ruleId, type: 'mock', pattern, status };
    emit({ ok: true, rule }, `Rule #${rule.id}: mocking "${pattern}" -> ${opts.status}`);
  }));

netCmd.command('headers <pattern> <header...>')
  .description('Add/override request headers for matching URLs')
  .action(action(async (pattern, headerStrs) => {
    const client = await requireCompatibility();
    const headers = headerStrs.map((h: string) => {
      const [name, ...rest] = h.split(':');
      return { name: name.trim(), value: rest.join(':').trim() };
    });
    const result = await client.callTool('browser.network.rules.add', {
      type: 'headers',
      pattern,
      headers,
    });
    const rule = { id: result.ruleId, type: 'headers', pattern, headers };
    emit({ ok: true, rule }, `Rule #${rule.id}: headers for "${pattern}"`);
  }));

netCmd.command('rules')
  .description('List active interception rules')
  .action(action(async () => {
    const result = await (await requireCompatibility()).callTool('browser.network.rules.list');
    const rules: Array<Record<string, JsonValue>> = (Array.isArray(result.rules) ? result.rules : []).map(value => {
      const rule = value as Record<string, JsonValue>;
      const { ruleId, ...rest } = rule;
      return { id: ruleId, ...rest };
    });
    if (useJson()) { emit({ ok: true, rules }); }
    else if (rules.length === 0) { console.log('No active rules.'); }
    else { for (const r of rules) console.log(`  #${r.id}  ${String(r.type).toUpperCase()} "${r.pattern}"`); }
  }));

netCmd.command('remove [ruleId]')
  .description('Remove interception rule(s)')
  .option('-a, --all', 'remove all rules')
  .action(action(async (ruleId, opts) => {
    const client = await requireCompatibility();
    if (opts.all) {
      await client.callTool('browser.network.rules.remove', { all: true });
      emit({ ok: true }, 'All rules removed');
    }
    else if (ruleId) {
      const normalizedRuleId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(ruleId)
        ? `rule:${ruleId}`
        : ruleId;
      await client.callTool('browser.network.rules.remove', { ruleId: normalizedRuleId });
      emit({ ok: true }, `Rule #${ruleId} removed`);
    }
    else throw invalidArgument('Specify a rule ID or use --all', 'ruleId');
  }));

netCmd.command('clear')
  .description('Clear captured request log')
  .action(action(async () => {
    await (await requireCompatibility()).callTool('browser.network.clear');
    emit({ ok: true }, 'Request log cleared');
  }));
}
