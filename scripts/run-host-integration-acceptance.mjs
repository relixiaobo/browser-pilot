#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  BrowserPilotAdapterError,
  BrowserPilotProcessAdapter,
  materializeToolResult,
} from '../examples/adapters/shared/browser-pilot-process.mjs';

const execFile = promisify(execFileCallback);
const REPORT_SCHEMA_VERSION = 1;
const SUITE_VERSION = '1.0.0';
const DEFAULT_TIMEOUT_MS = 65_000;
const MAX_TIMEOUT_MS = 300_000;
const DOWNLOAD_BYTES = Buffer.from('Browser Pilot host integration acceptance\n', 'utf8');
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

class AcceptanceError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'AcceptanceError';
    this.code = code;
  }
}

function bounded(value, limit = 500) {
  return String(value).replace(/[\r\n]+/gu, ' ').slice(0, limit);
}

function assertAcceptance(condition, message) {
  if (!condition) throw new AcceptanceError('acceptance_failed', message);
}

function parsePositiveInteger(raw, flag, maximum = MAX_TIMEOUT_MS) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new AcceptanceError('invalid_arguments', `${flag} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

export function parseHostAcceptanceArguments(argv) {
  let reportPath;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let profileIndex;
  let secondProfileIndex;
  let expectedVersion;
  let commandPrefix;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      commandPrefix = argv.slice(index + 1);
      break;
    }
    if (argument === '--report') {
      const value = argv[++index];
      if (!value) throw new AcceptanceError('invalid_arguments', '--report requires a path');
      reportPath = resolve(value);
      continue;
    }
    if (argument === '--timeout-ms') {
      const value = argv[++index];
      if (!value) throw new AcceptanceError('invalid_arguments', '--timeout-ms requires a value');
      timeoutMs = parsePositiveInteger(value, '--timeout-ms');
      continue;
    }
    if (argument === '--profile') {
      const value = argv[++index];
      if (!value) throw new AcceptanceError('invalid_arguments', '--profile requires a one-based index');
      profileIndex = parsePositiveInteger(value, '--profile', 128);
      continue;
    }
    if (argument === '--second-profile') {
      const value = argv[++index];
      if (!value) throw new AcceptanceError('invalid_arguments', '--second-profile requires a one-based index');
      secondProfileIndex = parsePositiveInteger(value, '--second-profile', 128);
      continue;
    }
    if (argument === '--expected-version') {
      expectedVersion = argv[++index];
      if (!expectedVersion) {
        throw new AcceptanceError('invalid_arguments', '--expected-version requires a value');
      }
      continue;
    }
    if (argument === '--help' || argument === '-h') return { help: true };
    throw new AcceptanceError('invalid_arguments', `Unknown argument: ${bounded(argument, 128)}`);
  }

  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const selected = commandPrefix ?? [process.execPath, resolve(root, 'dist/cli.js')];
  if (selected.length === 0 || !selected[0]) {
    throw new AcceptanceError('invalid_arguments', 'A Browser Pilot command prefix is required after --');
  }
  if (!isAbsolute(selected[0])) {
    throw new AcceptanceError('invalid_arguments', 'The Browser Pilot executable path must be absolute');
  }
  if (selected.length > 32 || selected.some(value => typeof value !== 'string' || value.length > 16_384)) {
    throw new AcceptanceError('invalid_arguments', 'The Browser Pilot command prefix is too large');
  }
  return {
    commandPrefix: selected,
    reportPath,
    timeoutMs,
    profileIndex,
    secondProfileIndex,
    expectedVersion,
  };
}

export function hostAcceptanceHelpText() {
  return `Usage: node scripts/run-host-integration-acceptance.mjs [options] [-- executable [prefix args...]]\n\n` +
    `Options:\n` +
    `  --report <path>           Also write the JSON report to this path\n` +
    `  --timeout-ms <value>      Timeout for each host operation (default: 65000)\n` +
    `  --profile <index>         One-based Profile for host A managed work\n` +
    `  --second-profile <index>  One-based Profile for host B managed work\n` +
    `  --expected-version <ver>  Require the exact executable/service version\n` +
    `  -h, --help                Show this help\n\n` +
    `The command prefix omits \"bridge --stdio\". The default is node dist/cli.js.\n`;
}

function clientIdentity(host) {
  return {
    id: `org.browser-pilot.host-acceptance.${host}`,
    name: `Browser Pilot Host Acceptance ${host.toUpperCase()}`,
    version: SUITE_VERSION,
    instanceId: `run:${process.pid}:${Date.now()}:${host}:${randomUUID()}`,
  };
}

async function startAcceptanceServer(marker) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/download') {
      response.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="browser-pilot-acceptance.txt"',
        'Content-Length': DOWNLOAD_BYTES.length,
        'Cache-Control': 'no-store',
      });
      response.end(DOWNLOAD_BYTES);
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(`<!doctype html>
      <meta charset="utf-8">
      <title>Browser Pilot Host Acceptance</title>
      <main>
        <label>Acceptance value <input aria-label="Acceptance value"></label>
        <a href="/download?marker=${marker}" download="browser-pilot-acceptance.txt">Download acceptance file</a>
      </main>`);
  });
  await new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(0, '127.0.0.1', resolveStart);
  });
  const address = server.address();
  assertAcceptance(address && typeof address === 'object', 'Acceptance HTTP server did not bind');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise(resolveClose => server.close(resolveClose));
    },
  };
}

function executableCommand(prefix, ...args) {
  return { executable: prefix[0], arguments: [...prefix.slice(1), ...args] };
}

async function runCli(prefix, args, env, timeoutMs) {
  const command = executableCommand(prefix, ...args);
  return await execFile(command.executable, command.arguments, {
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function selectBrowser(initializeResult) {
  const browsers = initializeResult?.browsers;
  assertAcceptance(Array.isArray(browsers) && browsers.length > 0, 'No browser candidate was discovered');
  return browsers.find(candidate => candidate.state === 'ready') ?? browsers[0];
}

function selectProfile(profiles, requestedIndex, label) {
  assertAcceptance(Array.isArray(profiles) && profiles.length > 0, `${label} did not discover a live Profile`);
  if (requestedIndex === undefined && profiles.length > 1) {
    throw new AcceptanceError(
      'profile_selection_required',
      `${label} discovered ${profiles.length} Profiles; rerun with an explicit one-based Profile index`,
    );
  }
  const index = requestedIndex ?? 1;
  const selected = profiles[index - 1];
  if (!selected) {
    throw new AcceptanceError('invalid_profile_selection', `${label} Profile index ${index} is unavailable`);
  }
  return selected;
}

function tabKey(target) {
  return JSON.stringify([target?.profileContextId ?? null, target?.url ?? '', target?.title ?? '']);
}

function tabMultiset(targets) {
  const counts = new Map();
  for (const target of targets) counts.set(tabKey(target), (counts.get(tabKey(target)) ?? 0) + 1);
  return counts;
}

function assertSameTabInventory(before, after) {
  assert.deepEqual(tabMultiset(after), tabMultiset(before), 'User-tab inventory changed during managed cleanup');
}

function commonUniqueUserTab(first, second) {
  const firstCounts = tabMultiset(first);
  const secondCounts = tabMultiset(second);
  return first.find(target => (
    firstCounts.get(tabKey(target)) === 1 && secondCounts.get(tabKey(target)) === 1
  ));
}

function findEquivalentTarget(target, targets) {
  return targets.find(candidate => tabKey(candidate) === tabKey(target));
}

function toolCall(adapter, context, name, args = {}, targetId) {
  return adapter.executeTool(context, name, args, {
    toolCallId: `acceptance:${name}:${randomUUID()}`,
    ...(targetId ? { targetId } : {}),
  });
}

async function expectAdapterError(operation, expectedCode) {
  try {
    await operation();
  } catch (error) {
    if (error instanceof BrowserPilotAdapterError && error.code === expectedCode) return error;
    throw error;
  }
  throw new AcceptanceError('acceptance_failed', `Expected Browser Pilot error ${expectedCode}`);
}

async function pollUntil(adapter, context, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const accepted = [];
  while (Date.now() < deadline) {
    const page = await adapter.pollEvents(context, 100);
    accepted.push(...page.events);
    await adapter.acknowledgeEvents(context, page.nextCursor);
    const match = accepted.find(predicate);
    if (match) return { event: match, accepted };
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new AcceptanceError('event_timeout', 'Timed out waiting for the expected Browser Pilot event');
}

async function waitFor(operation, predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw lastError ?? new AcceptanceError('acceptance_timeout', message);
}

function reportError(error, checkId) {
  return {
    checkId,
    code: bounded(error?.code ?? 'unexpected_error', 128),
    message: bounded(error instanceof Error ? error.message : error),
  };
}

export async function runHostIntegrationAcceptance(options) {
  const startedAt = Date.now();
  const checks = [];
  const marker = randomUUID();
  const workRoot = await mkdtemp(join(tmpdir(), 'browser-pilot-host-acceptance-'));
  const artifactDirectory = join(workRoot, 'artifacts');
  const environment = options.env ?? process.env;
  const isolatedDownloadPath = environment.BROWSER_PILOT_TEST_DOWNLOAD_DIR
    ? join(environment.BROWSER_PILOT_TEST_DOWNLOAD_DIR, 'browser-pilot-acceptance.txt')
    : undefined;
  const bridgeCommand = [...options.commandPrefix, 'bridge', '--stdio'];
  const notifications = { a: [], b: [], c: [] };
  const adapters = new Set();
  const contexts = new Map();
  let server;
  let failure;
  let currentCheck = 'setup';
  let hostA;
  let hostB;
  let hostC;
  let contextA;
  let contextB;
  let baselineUserTabs;
  let targetA;
  let targetB;
  let profileA;
  let profileB;

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

  const connectHost = async host => {
    const adapter = await BrowserPilotProcessAdapter.connect({
      command: bridgeCommand,
      client: clientIdentity(host),
      env: environment,
      requestTimeoutMs: options.timeoutMs,
      onBrowserEvent: event => notifications[host].push(event),
    });
    adapters.add(adapter);
    return adapter;
  };

  const closeHost = async adapter => {
    if (!adapter || !adapters.has(adapter)) return;
    try {
      await adapter.close();
    } finally {
      adapters.delete(adapter);
    }
  };

  try {
    server = await startAcceptanceServer(marker);

    await check('published_executable', async () => {
      const version = (await runCli(options.commandPrefix, ['--version'], environment, options.timeoutMs)).stdout.trim();
      assertAcceptance(version.length > 0, 'Browser Pilot executable returned no version');
      if (options.expectedVersion) {
        assertAcceptance(version === options.expectedVersion, `Expected ${options.expectedVersion}, received ${version}`);
      }
      return { version };
    });

    await check('two_host_initialize', async () => {
      [hostA, hostB] = await Promise.all([connectHost('a'), connectHost('b')]);
      const a = hostA.initializeResult;
      const b = hostB.initializeResult;
      assertAcceptance(a.protocol?.major === 1 && a.protocol?.minor >= 3, 'Host A did not negotiate protocol 1.3');
      assertAcceptance(b.protocol?.major === 1 && b.protocol?.minor >= 3, 'Host B did not negotiate protocol 1.3');
      assertAcceptance(a.brokerProcessIdentity === b.brokerProcessIdentity, 'Hosts did not reuse one Broker');
      assertAcceptance(a.connectionId !== b.connectionId, 'Hosts did not receive isolated Connections');
      assertAcceptance(a.executableVersion === b.executableVersion, 'Hosts disagree on executable version');
      if (options.expectedVersion) {
        assertAcceptance(a.serviceVersion === options.expectedVersion, 'Broker service version does not match the expected release');
        assertAcceptance(a.executableVersion === options.expectedVersion, 'Bridge executable version does not match the expected release');
      }
      return {
        protocol: `${a.protocol.major}.${a.protocol.minor}`,
        serviceVersion: bounded(a.serviceVersion, 64),
        executableVersion: bounded(a.executableVersion, 64),
        hostAToolCount: hostA.listTools().length,
        hostBToolCount: hostB.listTools().length,
      };
    });

    await check('workspace_lease_and_shared_connect', async () => {
      const browserA = selectBrowser(hostA.initializeResult);
      const browserB = selectBrowser(hostB.initializeResult);
      [contextA, contextB] = await Promise.all([
        hostA.openContext({
          workspaceKey: `host-a:${marker}`,
          leaseKey: `run-a:${marker}`,
          browserId: browserA.id,
        }),
        hostB.openContext({
          workspaceKey: `host-b:${marker}`,
          leaseKey: `run-b:${marker}`,
          browserId: browserB.id,
        }),
      ]);
      contexts.set(hostA, contextA);
      contexts.set(hostB, contextB);
      const connectCalls = [];
      if (browserA.state !== 'ready') connectCalls.push(toolCall(hostA, contextA, 'browser.connect', { browserId: browserA.id }));
      if (browserB.state !== 'ready') connectCalls.push(toolCall(hostB, contextB, 'browser.connect', { browserId: browserB.id }));
      const connected = await Promise.all(connectCalls);
      assertAcceptance(connected.every(result => result.result.state === 'connected'), 'A browser connection did not complete');
      return { explicitConnectCalls: connectCalls.length, workspaceCount: 2, leaseCount: 2 };
    });

    await check('profile_routing', async () => {
      const [listedA, listedB] = await Promise.all([
        toolCall(hostA, contextA, 'browser.profiles.list'),
        toolCall(hostB, contextB, 'browser.profiles.list'),
      ]);
      profileA = selectProfile(listedA.result.profiles, options.profileIndex, 'Host A');
      profileB = selectProfile(
        listedB.result.profiles,
        options.secondProfileIndex ?? options.profileIndex,
        'Host B',
      );
      await Promise.all([
        toolCall(hostA, contextA, 'browser.profiles.select', { profileContextId: profileA.profileContextId }),
        toolCall(hostB, contextB, 'browser.profiles.select', { profileContextId: profileB.profileContextId }),
      ]);
      return {
        discoveredProfiles: listedA.result.profiles.length,
        distinctSelectedProfiles: profileA.profileContextId === profileB.profileContextId ? 1 : 2,
      };
    });

    await check('user_tab_exclusivity_and_handoff', async () => {
      const [listedA, listedB] = await Promise.all([
        toolCall(hostA, contextA, 'browser.tabs.list', { scope: 'user_tabs' }),
        toolCall(hostB, contextB, 'browser.tabs.list', { scope: 'user_tabs' }),
      ]);
      baselineUserTabs = listedA.result.targets;
      const firstTarget = commonUniqueUserTab(listedA.result.targets, listedB.result.targets);
      assertAcceptance(firstTarget, 'No uniquely identifiable user tab is available for control handoff');
      const secondTarget = findEquivalentTarget(firstTarget, listedB.result.targets);
      assertAcceptance(secondTarget, 'Host B did not receive its own opaque ID for the shared user tab');
      assertAcceptance(firstTarget.targetId !== secondTarget.targetId, 'Hosts received the same Workspace-local target ID');
      await toolCall(hostA, contextA, 'browser.observe', { limit: 10 }, firstTarget.targetId);
      await expectAdapterError(
        () => toolCall(hostB, contextB, 'browser.observe', { limit: 10 }, secondTarget.targetId),
        'target_busy',
      );
      const releasedA = await toolCall(hostA, contextA, 'browser.tabs.release', {}, firstTarget.targetId);
      assertAcceptance(releasedA.result.released === true, 'Host A did not release target control');
      await toolCall(hostB, contextB, 'browser.observe', { limit: 10 }, secondTarget.targetId);
      const releasedB = await toolCall(hostB, contextB, 'browser.tabs.release', {}, secondTarget.targetId);
      assertAcceptance(releasedB.result.released === true, 'Host B did not release target control');
      return { userTabCount: baselineUserTabs.length, busyError: 'target_busy', handoff: 'completed' };
    });

    await check('concurrent_managed_workspaces', async () => {
      const [openedA, openedB] = await Promise.all([
        toolCall(hostA, contextA, 'browser.open', {
          url: `${server.origin}/?host=a&marker=${marker}`,
          newTarget: true,
          profileContextId: profileA.profileContextId,
          observationLimit: 20,
        }),
        toolCall(hostB, contextB, 'browser.open', {
          url: `${server.origin}/?host=b&marker=${marker}`,
          newTarget: true,
          profileContextId: profileB.profileContextId,
          observationLimit: 20,
        }),
      ]);
      targetA = openedA.result.targetId;
      targetB = openedB.result.targetId;
      const [managedA, managedB] = await Promise.all([
        toolCall(hostA, contextA, 'browser.tabs.list', { scope: 'managed_only' }),
        toolCall(hostB, contextB, 'browser.tabs.list', { scope: 'managed_only' }),
      ]);
      assertAcceptance(managedA.result.targets.length === 1, 'Host A managed inventory is not isolated');
      assertAcceptance(managedB.result.targets.length === 1, 'Host B managed inventory is not isolated');
      assertAcceptance(managedA.result.targets[0].targetId === targetA, 'Host A managed target is missing');
      assertAcceptance(managedB.result.targets[0].targetId === targetB, 'Host B managed target is missing');
      assertAcceptance(managedA.result.targets[0].profileContextId === profileA.profileContextId, 'Host A target was routed to the wrong Profile');
      assertAcceptance(managedB.result.targets[0].profileContextId === profileB.profileContextId, 'Host B target was routed to the wrong Profile');
      return { hostAManagedTargets: 1, hostBManagedTargets: 1 };
    });

    await check('concurrent_cli_client', async () => {
      const execution = await runCli(options.commandPrefix, ['tabs'], environment, options.timeoutMs);
      const result = JSON.parse(execution.stdout.trim());
      assertAcceptance(result?.ok === true && Array.isArray(result.tabs), 'One-shot CLI could not list tabs beside embedded hosts');
      return { cliUserVisibleTabCount: result.tabs.length };
    });

    await check('native_image_and_pdf_artifacts', async () => {
      const capture = await toolCall(hostA, contextA, 'browser.capture', {}, targetA);
      const imageResult = await materializeToolResult(hostA, contextA, capture);
      const image = imageResult.content.find(item => item.type === 'image');
      assertAcceptance(image?.mimeType === 'image/png', 'Screenshot was not converted to native image content');
      const imageBytes = Buffer.from(image.data, 'base64');
      assertAcceptance(imageBytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), 'Native image content is not PNG data');

      await mkdir(artifactDirectory, { recursive: true });
      const pdf = await toolCall(hostA, contextA, 'browser.pdf', { landscape: false }, targetA);
      const fileResult = await materializeToolResult(hostA, contextA, pdf, { artifactDirectory });
      const exportedPath = fileResult.details.browserPilot.exportedFiles[0];
      assertAcceptance(isAbsolute(exportedPath), 'PDF was not exported to a host-owned absolute path');
      const pdfBytes = await readFile(exportedPath);
      assertAcceptance(pdfBytes.subarray(0, 5).toString('ascii') === '%PDF-', 'Exported file is not a PDF');
      return { screenshotBytes: imageBytes.length, pdfBytes: pdfBytes.length };
    });

    await check('event_cursor_recovery', async () => {
      const first = await hostA.pollEvents(contextA, 100);
      const repeated = await hostA.pollEvents(contextA, 100);
      assert.deepEqual(repeated.events, first.events, 'Polling before acknowledgement did not replay the same events');
      assert.equal(repeated.nextCursor, first.nextCursor, 'Polling before acknowledgement changed the recovery cursor');
      await hostA.acknowledgeEvents(contextA, first.nextCursor);
      return { replayedEventCount: first.events.length };
    });

    await check('download_artifact_export', async () => {
      const observed = await toolCall(hostA, contextA, 'browser.observe', { limit: 20 }, targetA);
      const link = observed.result.elements.find(element => (
        element.role === 'link' && element.name === 'Download acceptance file'
      ));
      assertAcceptance(link, 'Download link was absent from the managed page Observation');
      await toolCall(hostA, contextA, 'browser.click', {
        target: { observationId: observed.result.observationId, ref: link.ref },
        observationLimit: 20,
      }, targetA);
      const terminal = await pollUntil(hostA, contextA, event => (
        event.type === 'download' && ['completed', 'capture_unavailable', 'failed', 'cancelled'].includes(event.payload?.state)
      ), options.timeoutMs);
      assertAcceptance(
        terminal.event.payload.state === 'completed',
        `Download ended as ${terminal.event.payload.state}: ${terminal.event.payload.reason ?? 'no reason'}`,
      );
      const descriptor = terminal.event.payload.artifact;
      assertAcceptance(descriptor?.kind === 'download', 'Completed download did not return a download Artifact');
      const outputPath = join(artifactDirectory, 'browser-pilot-acceptance-download.txt');
      const exported = await hostA.exportArtifact(contextA, descriptor.id, outputPath);
      assertAcceptance(exported.path === outputPath, 'Download was not exported to the requested host path');
      assert.deepEqual(await readFile(outputPath), DOWNLOAD_BYTES, 'Exported download bytes do not match the response');
      if (isolatedDownloadPath) {
        assert.deepEqual(
          await readFile(isolatedDownloadPath),
          DOWNLOAD_BYTES,
          'Browser Pilot moved or changed Chrome\'s original downloaded file',
        );
      }
      await hostA.releaseArtifact(contextA, descriptor.id);
      if (isolatedDownloadPath) {
        assert.deepEqual(
          await readFile(isolatedDownloadPath),
          DOWNLOAD_BYTES,
          'Artifact release removed Chrome\'s original downloaded file',
        );
      }
      return {
        byteSize: descriptor.byteSize,
        terminalState: terminal.event.payload.state,
        originalDownloadPreserved: isolatedDownloadPath !== undefined,
      };
    });

    await check('managed_only_shutdown_cleanup', async () => {
      await closeHost(hostA);
      hostA = undefined;
      const afterA = await waitFor(
        async () => (await toolCall(hostB, contextB, 'browser.tabs.list', { scope: 'all' })).result.targets,
        targets => !targets.some(target => target.url?.includes(`host=a&marker=${marker}`)),
        options.timeoutMs,
        'Host A managed target remained after its Workspace was released',
      );
      assertAcceptance(afterA.some(target => target.targetId === targetB), 'Host B managed target was removed with Host A');
      const remainingUsers = (await toolCall(hostB, contextB, 'browser.tabs.list', { scope: 'user_tabs' })).result.targets;
      assertSameTabInventory(baselineUserTabs, remainingUsers);
      if (isolatedDownloadPath) {
        assert.deepEqual(
          await readFile(isolatedDownloadPath),
          DOWNLOAD_BYTES,
          'Workspace cleanup removed Chrome\'s original downloaded file',
        );
      }
      return { hostAManagedClosed: true, hostBManagedPreserved: true, userTabsPreserved: remainingUsers.length };
    });

    await check('all_host_shutdown_cleanup', async () => {
      await closeHost(hostB);
      hostB = undefined;
      hostC = await connectHost('c');
      const browser = selectBrowser(hostC.initializeResult);
      const contextC = await hostC.openContext({
        workspaceKey: `host-c:${marker}`,
        leaseKey: `run-c:${marker}`,
        browserId: browser.id,
      });
      contexts.set(hostC, contextC);
      if (browser.state !== 'ready') {
        await toolCall(hostC, contextC, 'browser.connect', { browserId: browser.id });
      }
      const inventory = await waitFor(
        async () => (await toolCall(hostC, contextC, 'browser.tabs.list', { scope: 'all' })).result.targets,
        targets => !targets.some(target => target.url?.includes(marker)),
        options.timeoutMs,
        'Managed targets remained after both host Workspaces were released',
      );
      const userTabs = inventory.filter(target => target.origin === 'user_tab');
      assertSameTabInventory(baselineUserTabs, userTabs);
      return { allManagedClosed: true, userTabsPreserved: userTabs.length };
    });

    if (options.browserLifecycle) {
      await check('browser_disconnect_and_reconnect', async () => {
        const contextC = contexts.get(hostC);
        const browser = selectBrowser(hostC.initializeResult);
        const oldProfiles = (await toolCall(hostC, contextC, 'browser.profiles.list')).result.profiles;
        const oldTargets = (await toolCall(hostC, contextC, 'browser.tabs.list', { scope: 'user_tabs' })).result.targets;
        await options.browserLifecycle.stopBrowser();
        await pollUntil(hostC, contextC, event => event.type === 'connection.lost', options.timeoutMs);
        await expectAdapterError(
          () => toolCall(hostC, contextC, 'browser.tabs.list', { scope: 'all' }),
          'browser_disconnected',
        );
        await options.browserLifecycle.startBrowser();
        await toolCall(hostC, contextC, 'browser.connect', { browserId: browser.id });
        await pollUntil(hostC, contextC, event => event.type === 'connection.restored', options.timeoutMs);
        const currentProfiles = (await toolCall(hostC, contextC, 'browser.profiles.list')).result.profiles;
        const currentTargets = (await toolCall(hostC, contextC, 'browser.tabs.list', { scope: 'user_tabs' })).result.targets;
        assertAcceptance(currentProfiles.length > 0 && currentTargets.length > 0, 'Browser state was not rebuilt after reconnect');
        if (oldProfiles[0]) {
          await expectAdapterError(
            () => toolCall(hostC, contextC, 'browser.profiles.select', {
              profileContextId: oldProfiles[0].profileContextId,
            }),
            'profile_context_stale',
          );
        }
        if (oldTargets[0]) {
          await expectAdapterError(
            () => toolCall(hostC, contextC, 'browser.observe', { limit: 10 }, oldTargets[0].targetId),
            'target_not_owned',
          );
        }
        return {
          lostEvent: true,
          restoredEvent: true,
          profileIdsInvalidated: oldProfiles.length > 0,
          targetIdsInvalidated: oldTargets.length > 0,
        };
      });
    } else {
      checks.push({
        id: 'browser_disconnect_and_reconnect',
        status: 'skipped',
        durationMs: 0,
        detail: { reason: 'No caller-owned browser lifecycle was supplied' },
      });
    }
  } catch (error) {
    failure = reportError(error, currentCheck);
  } finally {
    for (const adapter of [...adapters]) {
      try {
        await closeHost(adapter);
      } catch (error) {
        failure ??= reportError(error, 'cleanup_hosts');
      }
    }
    if (server) await server.close().catch(error => {
      failure ??= reportError(error, 'cleanup_server');
    });
    await rm(workRoot, { recursive: true, force: true }).catch(error => {
      failure ??= reportError(error, 'cleanup_artifacts');
    });
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    suite: 'browser-pilot-host-integration-acceptance',
    suiteVersion: SUITE_VERSION,
    outcome: failure ? 'failed' : 'passed',
    command: {
      executable: bounded(basename(options.commandPrefix[0]), 128),
      prefixArgumentCount: options.commandPrefix.length - 1,
    },
    checks,
    notificationsReceived: Object.fromEntries(
      Object.entries(notifications).map(([host, events]) => [host, events.length]),
    ),
    durationMs: Date.now() - startedAt,
    ...(failure ? { failure } : {}),
  };
}

export async function writeHostAcceptanceReport(report, reportPath) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, serialized, { encoding: 'utf8', mode: 0o600 });
  }
  process.stdout.write(serialized);
}

async function main() {
  let options;
  try {
    options = parseHostAcceptanceArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(hostAcceptanceHelpText());
      return;
    }
    const report = await runHostIntegrationAcceptance(options);
    await writeHostAcceptanceReport(report, options.reportPath);
    process.exitCode = report.outcome === 'passed' ? 0 : 1;
  } catch (error) {
    const report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      suite: 'browser-pilot-host-integration-acceptance',
      suiteVersion: SUITE_VERSION,
      outcome: 'failed',
      checks: [],
      durationMs: 0,
      failure: reportError(error, options ? 'report_write' : 'runner_arguments'),
    };
    try {
      await writeHostAcceptanceReport(report, options?.reportPath);
    } catch {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
