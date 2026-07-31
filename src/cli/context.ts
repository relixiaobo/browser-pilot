import type { Command } from 'commander';
import { discoverBrowserCandidates } from '../chrome.js';
import {
  resumeCompatibility,
  type CompatibilityBrokerClient,
  type CompatibilityInvocationOptions,
  type CompatibilityProfile,
  type CompatibilityTarget,
} from '../compatibility-broker-client.js';
import { BrowserPilotError } from '../protocol/errors.js';
import type { JsonValue } from '../protocol/model.js';
import { cliClientKey, cliInvocationOptions } from './parse.js';
import type { CliOutput } from './output.js';

export type CliAction = (
  fn: (...args: any[]) => Promise<void>,
) => (...args: any[]) => Promise<void>;

export interface CliCommandContext {
  program: Command;
  version: string;
  signal: AbortSignal;
  output: CliOutput;
  action: CliAction;
  clientKey(): string;
  invocationOptions(): CompatibilityInvocationOptions;
  disconnectedBrowserSetup(): ReturnType<typeof disconnectedBrowserSetup>;
  requireCompatibility(): Promise<CompatibilityBrokerClient>;
  resolveProfile(client: CompatibilityBrokerClient, selector: string): Promise<CompatibilityProfile>;
  profile(profile: CompatibilityProfile, index: number): Record<string, JsonValue>;
  withTarget<T>(operation: (
    client: CompatibilityBrokerClient,
    target: CompatibilityTarget,
  ) => Promise<T>): Promise<T>;
  readStdin(): Promise<string>;
}

export function createCliCommandContext(options: {
  program: Command;
  version: string;
  signal: AbortSignal;
  output: CliOutput;
}): CliCommandContext {
  const { program, version, signal, output } = options;
  const clientKey = (): string => cliClientKey(program);
  const invocationOptions = (): CompatibilityInvocationOptions => cliInvocationOptions(program, signal);

  const requireCompatibility = async (): Promise<CompatibilityBrokerClient> => {
    const client = await resumeCompatibility(version, clientKey(), invocationOptions());
    if (!client) {
      const setup = await disconnectedBrowserSetup();
      throw new BrowserPilotError('browser_disconnected', 'Browser Pilot is not connected', {
        retryable: true,
        context: setup.selected ? {
          browserId: setup.selected.candidate.id,
          product: setup.selected.candidate.product,
          browserState: setup.selected.candidate.state,
        } : undefined,
        remediation: setup.remediation,
      });
    }
    return client;
  };

  const resolveProfile = async (
    client: CompatibilityBrokerClient,
    selector: string,
  ): Promise<CompatibilityProfile> => {
    const profiles = await client.listProfiles();
    const exactId = profiles.find(profile => profile.profileContextId === selector);
    if (exactId) return exactId;
    if (/^\d+$/.test(selector)) {
      const index = Number(selector);
      if (Number.isSafeInteger(index) && index >= 1 && profiles[index - 1]) return profiles[index - 1];
      throw invalidProfile(`Profile index out of range (1-${profiles.length})`, selector);
    }
    const normalized = selector.trim().toLocaleLowerCase();
    const matches = profiles.filter(profile => (
      profile.label.toLocaleLowerCase() === normalized ||
      profile.displayName?.toLocaleLowerCase() === normalized ||
      profile.profileName?.toLocaleLowerCase() === normalized ||
      profile.accountName?.toLocaleLowerCase() === normalized ||
      profile.accountEmail?.toLocaleLowerCase() === normalized
    ));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw invalidProfile('Profile selector is ambiguous; use its index or Profile context ID', selector);
    }
    throw invalidProfile('Profile selector does not match a live Chrome Profile', selector);
  };

  const profile = (value: CompatibilityProfile, index: number): Record<string, JsonValue> => ({
    index: index + 1,
    profileContextId: value.profileContextId,
    label: value.label,
    ...(value.displayName ? { displayName: value.displayName } : {}),
    ...(value.identityStatus ? { identityStatus: value.identityStatus } : {}),
    ...(value.profileName ? { profileName: value.profileName } : {}),
    ...(value.accountName ? { accountName: value.accountName } : {}),
    ...(value.accountEmail ? { accountEmail: value.accountEmail } : {}),
    ...(value.profileDirectory ? { profileDirectory: value.profileDirectory } : {}),
    ...(value.identityErrorCode ? { identityErrorCode: value.identityErrorCode } : {}),
    tabCount: value.tabCount,
    eligibleTabCount: value.eligibleTabCount,
    selected: value.selected,
    representativeTabs: value.representativeTabs,
  });

  const withTarget = async <T>(operation: (
    client: CompatibilityBrokerClient,
    target: CompatibilityTarget,
  ) => Promise<T>): Promise<T> => {
    const client = await requireCompatibility();
    const target = await client.ensureTarget();
    return operation(client, target);
  };

  const readStdin = (): Promise<string> => {
    if (process.stdin.isTTY) return Promise.resolve('');
    return new Promise(resolve => {
      let data = '';
      process.stdin.on('data', chunk => { data += chunk; });
      process.stdin.on('end', () => resolve(data.trim()));
    });
  };

  const action: CliAction = fn => (...args) => fn(...args).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const stable = error instanceof BrowserPilotError
      ? error
      : new BrowserPilotError('internal_error', message, { cause: error });
    if (stable.code === 'stale_ref') {
      output.fail(message, "Run 'bp snapshot' to refresh element refs.", stable);
    }
    if (stable.code === 'browser_disconnected') {
      output.fail(
        message,
        stable.remediation
          ? undefined
          : "Run 'bp browsers', follow its setup remediation, then connect once.",
        stable,
      );
    }
    if (stable.code === 'unknown_outcome') {
      output.fail(message, 'Inspect the current tab state before deciding whether to retry.', stable);
    }
    output.fail(message, undefined, stable);
  });

  return {
    program,
    version,
    signal,
    output,
    action,
    clientKey,
    invocationOptions,
    disconnectedBrowserSetup,
    requireCompatibility,
    resolveProfile,
    profile,
    withTarget,
    readStdin,
  };
}

function invalidProfile(message: string, selector: string): BrowserPilotError {
  return new BrowserPilotError('invalid_argument', message, {
    context: { field: 'profile', selector },
  });
}

async function disconnectedBrowserSetup() {
  const discovered = await discoverBrowserCandidates();
  const selected = discovered.find(candidate => candidate.endpoint !== undefined) ?? discovered[0];
  return {
    discovered,
    selected,
    remediation: selected?.candidate.remediation ?? {
      code: 'connect_browser',
      message: "Run 'bp browsers', follow its setup remediation, then run one explicit 'bp connect'.",
      actionRequired: true,
    },
  };
}
