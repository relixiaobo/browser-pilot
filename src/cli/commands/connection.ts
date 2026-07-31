import type { Command } from 'commander';
import { discoverBrowserCandidates } from '../../chrome.js';
import { isDaemonRunning } from '../../client.js';
import {
  connectCompatibility,
  resumeCompatibility,
  shutdownCompatibility,
  type CompatibilityProfile,
  type CompatibilityTarget,
} from '../../compatibility-broker-client.js';
import { BrowserPilotError, invalidArgument } from '../../protocol/errors.js';
import type {
  CommandDescriptor,
  CommandOutcome,
  CommandStatus,
  JsonValue,
} from '../../protocol/model.js';
import { serializeStructuralText } from '../../structural-text.js';
import type { CliCommandContext } from '../context.js';
import { parseLimit } from '../parse.js';

function cliCommand(command: CommandDescriptor): Record<string, JsonValue> {
  return {
    id: command.id,
    method: command.method,
    mutating: command.mutating,
    status: command.status,
    acceptedAt: command.acceptedAt,
    deadlineAt: command.deadlineAt,
    ...(command.targetId ? { targetId: command.targetId } : {}),
    ...(command.dispatchedAt !== undefined ? { dispatchedAt: command.dispatchedAt } : {}),
    ...(command.completedAt !== undefined ? { completedAt: command.completedAt } : {}),
    ...(command.cancellationRequested ? { cancellationRequested: true } : {}),
  };
}

function cliCommandOutcome(outcome: CommandOutcome): Record<string, JsonValue> {
  return {
    command: cliCommand(outcome.command),
    ...(outcome.result !== undefined ? { result: outcome.result } : {}),
    ...(outcome.error !== undefined ? { error: outcome.error as unknown as JsonValue } : {}),
  };
}

function matchesUrl(url: string, pattern: string): boolean {
  if (!pattern.includes('*')) return url.includes(pattern);
  const source = pattern
    .split('*')
    .map(part => part.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(url);
}

export function register(program: Command, ctx: CliCommandContext): void {
  const {
    action,
    clientKey: cliClientKey,
    invocationOptions: cliInvocationOptions,
    disconnectedBrowserSetup,
    profile: cliProfile,
    requireCompatibility,
    resolveProfile: resolveCliProfile,
  } = ctx;
  const { emit, useJson } = ctx.output;
  const delay = (ms: number): Promise<void> => {
    if (ctx.signal.aborted) {
      return Promise.reject(new BrowserPilotError('command_cancelled', 'Wait was cancelled'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        ctx.signal.removeEventListener('abort', cancelled);
        resolve();
      }
      function cancelled(): void {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', cancelled);
        reject(new BrowserPilotError('command_cancelled', 'Wait was cancelled'));
      }
      ctx.signal.addEventListener('abort', cancelled, { once: true });
    });
  };

program.command('status')
  .description('Show current Broker, browser, Agent namespace, and recovery state')
  .action(action(async () => {
    const brokerRunning = isDaemonRunning();
    const client = await resumeCompatibility(ctx.version, cliClientKey(), cliInvocationOptions());
    if (!client) {
      const setup = await disconnectedBrowserSetup();
      const browsers = setup.discovered.map(candidate => candidate.candidate);
      const remediationAction = setup.remediation.message;
      emit({
        ok: true,
        service: { state: brokerRunning ? 'unavailable' : 'stopped', version: ctx.version },
        browser: { state: 'disconnected' },
        browsers,
        session: { state: 'unavailable' },
        recovery: {
          required: true,
          code: 'browser_disconnected',
          action: remediationAction,
        },
      }, brokerRunning
        ? `Browser Pilot Broker is running, but the browser session is unavailable.\nAction: ${remediationAction}`
        : `Browser Pilot is not connected.\nAction: ${remediationAction}`);
      return;
    }

    const [activeCommands, uncertainCommands] = await Promise.all([
      client.listCommands(20, ['accepted', 'dispatched']),
      client.listCommands(20, ['unknown_outcome']),
    ]);
    let tabs: CompatibilityTarget[] = [];
    let profiles: CompatibilityProfile[] = [];
    let browserStateError: BrowserPilotError | undefined;
    try {
      [tabs, profiles] = await Promise.all([client.listTabs('all'), client.listProfiles()]);
    } catch (error) {
      browserStateError = error instanceof BrowserPilotError
        ? error
        : new BrowserPilotError('internal_error', error instanceof Error ? error.message : String(error));
    }
    const selectedTarget = tabs.find(tab => tab.selected ?? tab.active === true);
    const selectedProfile = profiles.find(profile => profile.selected);
    const browser = client.initialized.browsers.find(candidate => candidate.state === 'ready')
      ?? client.initialized.browsers[0];
    const recovery = browserStateError
      ? {
          required: true,
          code: browserStateError.code,
          action: browserStateError.remediation?.message ?? 'Inspect the browser connection before continuing.',
        }
      : uncertainCommands.length > 0
        ? {
            required: true,
            code: 'unknown_outcome',
            action: 'Inspect the current tab and the uncertain command before retrying.',
          }
        : { required: false };
    emit({
      ok: true,
      service: {
        state: 'running',
        version: client.initialized.serviceVersion,
      },
      browser: browser
        ? { id: browser.id, product: browser.product, state: browser.state }
        : { state: 'disconnected' },
      session: {
        state: client.lease.state,
        expiresAt: client.lease.expiresAt,
        profile: selectedProfile ? cliProfile(selectedProfile, profiles.indexOf(selectedProfile)) : null,
        target: selectedTarget ? {
          index: tabs.indexOf(selectedTarget) + 1,
          title: selectedTarget.title,
          url: selectedTarget.url,
          origin: selectedTarget.origin,
          profileContextId: selectedTarget.profileContextId,
        } : null,
      },
      commands: {
        active: activeCommands.map(cliCommand),
        uncertain: uncertainCommands.map(cliCommand),
      },
      recovery,
    }, `Browser Pilot: ${browser?.state ?? 'disconnected'}; ${tabs.length} tab(s); ${activeCommands.length} active command(s)`);
  }));

program.command('commands')
  .description('List recent commands for this Agent namespace')
  .option('-l, --limit <n>', 'maximum commands to return', '20')
  .option('--status <statuses>', 'comma-separated Command statuses')
  .action(action(async (opts) => {
    const limit = parseLimit(opts.limit);
    if (limit > 100) throw invalidArgument('--limit must not exceed 100', 'limit');
    const statuses = opts.status === undefined
      ? undefined
      : String(opts.status).split(',').map((status: string) => status.trim()).filter(Boolean) as CommandStatus[];
    const validStatuses = new Set<CommandStatus>([
      'accepted', 'dispatched', 'completed', 'unknown_outcome', 'cancelled', 'expired',
    ]);
    if (statuses && (statuses.length === 0 || statuses.some(status => !validStatuses.has(status)))) {
      throw invalidArgument('--status contains an invalid Command status', 'status');
    }
    const commands = await (await requireCompatibility()).listCommands(limit, statuses);
    if (useJson()) {
      emit({ ok: true, commands: commands.map(cliCommand) });
    } else if (commands.length === 0) {
      console.log('No recent commands.');
    } else {
      for (const command of commands) {
        console.log(`${command.id}  ${command.status.padEnd(15)} ${command.method}`);
      }
    }
  }));

program.command('command <commandId>')
  .description('Inspect one recent command and its outcome')
  .action(action(async (commandId) => {
    const outcome = await (await requireCompatibility()).getCommand(commandId);
    const result = cliCommandOutcome(outcome);
    if (useJson()) emit({ ok: true, ...result });
    else console.log(`${outcome.command.id}: ${outcome.command.status} (${outcome.command.method})`);
  }));

program.command('cancel <commandId>')
  .description('Request cancellation of a running command')
  .action(action(async (commandId) => {
    const outcome = await (await requireCompatibility()).cancelCommand(commandId);
    const result = cliCommandOutcome(outcome);
    if (useJson()) emit({ ok: true, ...result });
    else console.log(`${outcome.command.id}: ${outcome.command.status}`);
  }));

program.command('wait')
  .description('Wait for a browser-visible condition')
  .option('--url <pattern>', 'wait for the selected tab URL to contain a value or match a * glob')
  .option('--text <text>', 'wait for visible page text')
  .option('--selector <selector>', 'wait for a CSS selector')
  .option('--dialog', 'wait for a pending JavaScript dialog')
  .option('--download', 'wait for a completed unexported download')
  .option('--popup', 'wait for a managed popup tab')
  .option('--interval <ms>', 'poll interval in milliseconds', '250')
  .action(action(async (opts) => {
    const conditions = [
      opts.url !== undefined,
      opts.text !== undefined,
      opts.selector !== undefined,
      opts.dialog === true,
      opts.download === true,
      opts.popup === true,
    ].filter(Boolean).length;
    if (conditions !== 1) {
      throw invalidArgument(
        'Choose exactly one of --url, --text, --selector, --dialog, --download, or --popup',
        'condition',
      );
    }
    const intervalMs = Number(opts.interval);
    if (!/^\d+$/.test(String(opts.interval)) || !Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 5_000) {
      throw invalidArgument('--interval must be an integer from 100 through 5000', 'interval');
    }
    const waitTimeoutMs = cliInvocationOptions().deadlineMs ?? 60_000;
    const startedAt = Date.now();
    const deadlineAt = startedAt + waitTimeoutMs;
    const client = await requireCompatibility();
    const needsTarget = opts.url !== undefined || opts.text !== undefined || opts.selector !== undefined;
    const target = needsTarget ? await client.selectedTarget() : undefined;
    const condition = opts.url !== undefined ? 'url'
      : opts.text !== undefined ? 'text'
        : opts.selector !== undefined ? 'selector'
          : opts.dialog ? 'dialog'
            : opts.download ? 'download'
              : 'popup';

    while (Date.now() <= deadlineAt) {
      let matched: JsonValue | undefined;
      if (opts.url !== undefined) {
        const tabs = await client.listTabs('all');
        const current = tabs.find(tab => tab.targetId === target!.targetId);
        if (current && matchesUrl(current.url, String(opts.url))) {
          matched = {
            title: current.title,
            url: current.url,
            origin: current.origin,
            profileContextId: current.profileContextId,
          };
        }
      } else if (opts.text !== undefined) {
        const result = await client.callTool('browser.search', {
          query: String(opts.text),
          limit: 1,
        }, target!.targetId);
        const matches = Array.isArray(result.matches) ? result.matches : [];
        if (matches.length > 0) matched = { title: result.title, url: result.url, match: matches[0] };
      } else if (opts.selector !== undefined) {
        const result = await client.callTool('browser.elements.find', {
          selector: String(opts.selector),
          limit: 1,
        }, target!.targetId);
        const elements = Array.isArray(result.elements) ? result.elements : [];
        if (elements.length > 0) matched = { url: result.url, element: elements[0] };
      } else if (opts.dialog) {
        const result = await client.callTool('browser.dialogs.list');
        const dialogs = Array.isArray(result.dialogs) ? result.dialogs : [];
        if (dialogs.length > 0) matched = dialogs[0];
      } else if (opts.download) {
        const downloads = await client.listArtifacts(['download']);
        if (downloads.length > 0) matched = {
          index: 1,
          id: downloads[0].id,
          fileName: downloads[0].fileName ?? null,
          mimeType: downloads[0].mimeType,
          sizeBytes: downloads[0].byteSize,
          createdAt: downloads[0].createdAt,
          expiresAt: downloads[0].expiresAt,
        };
      } else {
        const tabs = await client.listTabs('all');
        const popup = tabs.find(tab => tab.origin === 'managed_popup');
        if (popup) {
          matched = {
            title: popup.title,
            url: popup.url,
            origin: popup.origin,
            profileContextId: popup.profileContextId,
          };
        }
      }
      if (matched !== undefined) {
        emit({
          ok: true,
          condition,
          elapsedMs: Date.now() - startedAt,
          matched,
        }, `Condition satisfied: ${condition}`);
        return;
      }
      await delay(Math.min(intervalMs, Math.max(0, deadlineAt - Date.now())));
    }
    throw new BrowserPilotError('wait_timeout', `Timed out waiting for ${condition}`, {
      retryable: true,
      context: { condition, timeoutMs: waitTimeoutMs },
    });
  }));

program.command('browsers')
  .description('List supported local browsers and their setup state')
  .option('-b, --browser <name>', 'filter by browser ID, product, or channel')
  .action(action(async (opts) => {
    const filter = typeof opts.browser === 'string' ? opts.browser.toLowerCase() : undefined;
    const client = await resumeCompatibility(ctx.version, cliClientKey(), cliInvocationOptions());
    const browsers = client
      ? await client.listBrowsers(filter)
      : (await discoverBrowserCandidates())
        .map(discovered => discovered.candidate)
        .filter(candidate => !filter || [candidate.id, candidate.product, candidate.channel]
          .some(value => value?.toLowerCase().includes(filter)));
    if (useJson()) {
      emit({ ok: true, browsers });
      return;
    }
    if (browsers.length === 0) {
      console.log('No installed supported browsers found.');
      return;
    }
    console.log(browsers.map(candidate => {
      const label = `${candidate.product}${candidate.channel ? ` (${candidate.channel})` : ''}`;
      const details = [
        `${label}: ${candidate.state}`,
        `  id: ${candidate.id}`,
        `  process: ${candidate.processState}; remote debugging: ${candidate.remoteDebuggingState}; authorization: ${candidate.authorizationState}`,
      ];
      if (candidate.remediation) details.push(`  action: ${candidate.remediation.message}`);
      return details.join('\n');
    }).join('\n\n'));
  }));

program.command('connect')
  .description('Connect to Chrome and prepare unambiguous managed browsing')
  .option('-b, --browser <name>', 'browser to connect to')
  .addHelpText('after', [
    '',
    'Preparation:',
    '  Run bp browsers and complete its setup remediation first.',
    '  If an Agent invokes this command, it must tell the user about the possible Allow dialog before the call.',
    '',
    'Examples:',
    '  bp connect',
    '  bp connect --browser brave',
  ].join('\n'))
  .action(action(async (opts) => {
    if (!useJson()) {
      console.log('Connecting to Chrome...');
      console.log('If prompted, click "Allow" in Chrome\'s authorization dialog.\n');
    }
    const client = await connectCompatibility(ctx.version, opts.browser, cliClientKey(), cliInvocationOptions());
    await client.connectBrowser();
    const profiles = await client.listProfiles();
    if (profiles.length <= 1) await client.ensureManagedTarget();
    const browser = client.initialized.browsers.find(candidate => candidate.state === 'ready')?.product ?? 'browser';
    if (profiles.length > 1) {
      const listed = profiles.map(cliProfile);
      emit(
        { ok: true, browser, profileSelectionRequired: true, profiles: listed },
        `\u2713 Connected to ${browser}\nMultiple Chrome Profiles are open. Run 'bp profiles --identify', then 'bp profile <index>'.`,
      );
      return;
    }
    emit(
      { ok: true, browser, profileSelectionRequired: false },
      `\u2713 Connected to ${browser}\n\u2713 Pilot window ready (daemon running in background)\n\nReady! Try: bp open https://example.com`,
    );
  }));

// ─── disconnect ─────────────────────────────────────

program.command('disconnect')
  .description('Release CLI browser state and stop an otherwise unused daemon')
  .action(action(async () => {
    await shutdownCompatibility(ctx.version, cliClientKey());
    emit({ ok: true }, '\u2713 Disconnected');
  }));

// ─── open ───────────────────────────────────────────

program.command('profiles')
  .description('List live Chrome Profile contexts')
  .option('--identify', 'explicitly identify Profiles using temporary visible Chrome pages')
  .option('--refresh', 'repeat Profile identification instead of using cached results')
  .action(action(async (opts) => {
    const client = await requireCompatibility();
    const identified = opts.identify || opts.refresh
      ? await client.identifyProfiles(undefined, opts.refresh === true)
      : await client.listProfiles();
    const profiles = identified.map(cliProfile);
    if (useJson()) {
      emit({ ok: true, profiles });
      return;
    }
    if (profiles.length === 0) {
      console.log('No live Chrome Profile contexts found.');
      return;
    }
    for (const profile of profiles) {
      const name = profile.profileName ?? profile.displayName;
      const account = profile.accountEmail ?? profile.accountName;
      const identity = name
        ? `  ${serializeStructuralText(name)}${account ? ` (${serializeStructuralText(account)})` : ''}  [${serializeStructuralText(profile.label)}]`
        : `  ${serializeStructuralText(profile.label)}${profile.identityStatus === 'unavailable' ? ' (identity unavailable)' : ''}`;
      console.log(`${profile.selected ? '*' : ' '} ${profile.index}${identity}  ${profile.tabCount} tab(s)`);
    }
  }));

program.command('profile <selector>')
  .description('Select a Chrome Profile context for new managed tabs')
  .action(action(async (selector) => {
    const client = await requireCompatibility();
    const profile = await resolveCliProfile(client, String(selector));
    const selected = await client.selectProfile(profile.profileContextId);
    emit(
      {
        ok: true,
        profileContextId: selected.profileContextId,
        label: selected.label,
        ...(selected.displayName ? { displayName: selected.displayName } : {}),
        ...(selected.identityStatus ? { identityStatus: selected.identityStatus } : {}),
        ...(selected.profileName ? { profileName: selected.profileName } : {}),
        ...(selected.accountName ? { accountName: selected.accountName } : {}),
        ...(selected.accountEmail ? { accountEmail: selected.accountEmail } : {}),
        ...(selected.profileDirectory ? { profileDirectory: selected.profileDirectory } : {}),
        ...(selected.identityErrorCode ? { identityErrorCode: selected.identityErrorCode } : {}),
      },
      `\u2713 Selected ${serializeStructuralText(selected.profileName ?? selected.displayName ?? selected.label)}`,
    );
  }));
}
