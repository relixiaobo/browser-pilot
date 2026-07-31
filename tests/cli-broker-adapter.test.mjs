import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  isolatedBrokerEnvironment,
  testBrokerPaths,
  testTempPrefix,
} from './helpers/platform.mjs';

const execFile = promisify(execFileCallback);
const CLI = resolve(import.meta.dirname, '../dist/cli.js');
const PACKAGE_VERSION = JSON.parse(
  await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'),
).version;

function expectedClientSessionId(token, clientKey = 'browser-pilot-cli') {
  const digest = createHmac('sha256', token)
    .update(clientKey)
    .update('\0')
    .update(PACKAGE_VERSION)
    .digest('base64url')
    .slice(0, 24);
  return `client:browser-pilot-cli:${digest}`;
}

function artifact(id, kind, mimeType, fileName) {
  return {
    id,
    workspaceId: 'workspace:cli',
    kind,
    mimeType,
    byteSize: 12,
    fileName,
    sensitivity: kind === 'upload_input' || kind === 'download' ? 'user_file' : 'browser_data',
    createdAt: 1,
    expiresAt: 301_000,
    retained: false,
    ...(kind === 'screenshot' ? { width: 800, height: 600 } : {}),
  };
}

function observation(overrides = {}) {
  return {
    workspaceId: 'workspace:cli',
    leaseId: 'lease:cli',
    targetId: 'target:managed',
    profileContextId: 'profile-context:work',
    url: 'https://example.test/form',
    observationId: 'observation:current',
    title: 'Example Form',
    elements: [{ ref: 1, role: 'button', name: 'Submit' }],
    truncated: false,
    truncationReasons: [],
    hints: [],
    ...overrides,
  };
}

async function startFakeDaemon(root, options = {}) {
  const paths = testBrokerPaths(root);
  const stateDirectory = paths.stateDir;
  const socketPath = paths.endpoint;
  const calls = [];
  let selectedProfileContextId;
  let profilesIdentified = false;
  let managedClosed = false;
  let preserveSelectedManagedAfterClose = false;
  let droppedToolCall;
  let droppedToolDispatches = 0;
  let credentialErrorDispatches = 0;
  let credentialsRotated = false;
  let daemonToken = options.daemonToken ?? randomBytes(32).toString('base64url');
  const initialDaemonToken = daemonToken;
  let brokerProcessIdentity = options.brokerProcessIdentity ?? 'broker:fake';
  const executableIdentity = `executable:${'0'.repeat(64)}`;
  await Promise.all([
    mkdir(stateDirectory, { recursive: true }),
    mkdir(paths.runtimeDir, { recursive: true }),
  ]);
  await writeFile(join(stateDirectory, 'daemon.pid'), String(process.pid));

  const writeLocator = () => writeFile(paths.locatorFile, `${JSON.stringify({
    schemaVersion: 2,
    pid: process.pid,
    endpoint: socketPath,
    transport: paths.transport,
    startedAt: Date.now(),
    brokerProcessIdentity,
    serviceVersion: PACKAGE_VERSION,
    executable: {
      version: PACKAGE_VERSION,
      path: CLI,
      identity: executableIdentity,
    },
    protocol: { min: { major: 1, minor: 0 }, max: { major: 1, minor: 3 } },
    token: daemonToken,
  })}\n`, { mode: 0o600 });
  const rotateCredentials = async () => {
    daemonToken = randomBytes(32).toString('base64url');
    brokerProcessIdentity = `${brokerProcessIdentity}:rotated`;
    credentialsRotated = true;
    await writeLocator();
  };
  await writeLocator();

  const toolResult = async (name, args) => {
    if (Object.hasOwn(options.toolResults ?? {}, name)) {
      const override = options.toolResults[name];
      return typeof override === 'function' ? override(args) : structuredClone(override);
    }
    switch (name) {
      case 'browser.discover':
        return {
          browsers: [{
            id: 'browser:fake',
            product: 'Chrome',
            channel: 'stable',
            userDataRoot: '/profiles/fake',
            processState: 'running',
            remoteDebuggingState: 'enabled',
            authorizationState: 'authorized',
            state: 'ready',
          }],
        };
      case 'browser.connect':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          browserInstanceId: 'browser-instance:fake',
          connectionGeneration: 1,
          state: 'connected',
        };
      case 'browser.profiles.identify':
        profilesIdentified = true;
        // Fall through so identify and list share one daemon-memory cache.
      case 'browser.profiles.list': {
        const profiles = [
          {
            profileContextId: 'profile-context:work',
            label: 'Profile 1',
            identityStatus: profilesIdentified ? 'verified' : 'unidentified',
            ...(profilesIdentified ? {
              profileName: 'Work Account',
              accountName: 'Alice Example',
              accountEmail: 'alice@work.example.test',
              profileDirectory: 'Default',
            } : {}),
            tabCount: 2,
            eligibleTabCount: 2,
            selected: selectedProfileContextId === 'profile-context:work',
            representativeTabs: [{
              targetId: 'target:managed',
              title: 'Example Form',
              url: 'https://example.test/form',
            }],
          },
          {
            profileContextId: 'profile-context:personal',
            label: 'Profile 2',
            identityStatus: profilesIdentified ? 'verified' : 'unidentified',
            ...(profilesIdentified ? {
              profileName: 'Personal Account',
              accountName: 'Alice',
              accountEmail: 'alice@personal.example.test',
              profileDirectory: 'Profile 1',
            } : {}),
            tabCount: 1,
            eligibleTabCount: 1,
            selected: selectedProfileContextId === 'profile-context:personal',
            representativeTabs: [{
              targetId: 'target:personal',
              title: 'Personal Inbox',
              url: 'https://mail.example.test/',
            }],
          },
        ];
        return { workspaceId: 'workspace:cli', leaseId: 'lease:cli', profiles };
      }
      case 'browser.profiles.select': {
        selectedProfileContextId = args.profileContextId;
        const selected = selectedProfileContextId === 'profile-context:personal'
          ? {
              label: 'Profile 2', identityStatus: 'verified', profileName: 'Personal Account',
              accountName: 'Alice', accountEmail: 'alice@personal.example.test', profileDirectory: 'Profile 1',
            }
          : {
              label: 'Profile 1', identityStatus: 'verified', profileName: 'Work Account',
              accountName: 'Alice Example', accountEmail: 'alice@work.example.test', profileDirectory: 'Default',
            };
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          profileContextId: selectedProfileContextId,
          ...selected,
        };
      }
      case 'browser.open':
        return observation({
          profileContextId: args.profileContextId ?? selectedProfileContextId ?? 'profile-context:work',
          url: args.url,
          observationId: 'observation:after-open',
        });
      case 'browser.tabs.list': {
        if (options.noTabs === true) {
          return { workspaceId: 'workspace:cli', leaseId: 'lease:cli', targets: [] };
        }
        const managedTarget = {
          targetId: 'target:managed',
          profileContextId: 'profile-context:work',
          title: 'Example Form',
          url: 'https://example.test/form',
          selected: true,
          origin: 'managed',
          managedTabSetId: 'managed-tab-set:cli',
          controlState: 'controlled',
        };
        const selectedManagedSurvivor = {
          targetId: 'target:managed-survivor',
          profileContextId: 'profile-context:work',
          title: 'Selected Survivor',
          url: 'https://example.test/survivor',
          selected: true,
          origin: 'managed',
          managedTabSetId: 'managed-tab-set:cli',
          controlState: 'controlled',
        };
        const userTarget = {
          targetId: 'target:user',
          profileContextId: 'profile-context:work',
          title: 'User Page',
          url: 'https://example.test/user',
          selected: false,
          origin: 'user_tab',
          controlState: 'available',
        };
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          targets: args.scope === 'managed_only'
            ? (managedClosed
                ? (preserveSelectedManagedAfterClose ? [selectedManagedSurvivor] : [])
                : [managedTarget])
            : (managedClosed
                ? (preserveSelectedManagedAfterClose ? [selectedManagedSurvivor, userTarget] : [userTarget])
                : [managedTarget]),
        };
      }
      case 'browser.tabs.close':
        managedClosed = true;
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          closedTargetId: 'target:managed',
        };
      case 'browser.observe': return observation();
      case 'browser.observation.latest':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          targetId: 'target:managed',
          url: 'https://example.test/form',
          observationId: 'observation:current',
          createdAt: 1,
          expiresAt: 301_000,
          elementCount: 1,
        };
      case 'browser.click': return observation({ observationId: 'observation:after-click' });
      case 'browser.locate':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          targetId: 'target:managed',
          selector: args.selector,
          x: 50,
          y: 35,
          top: 20,
          left: 10,
          width: 80,
          height: 30,
        };
      case 'browser.type': return observation({ observationId: 'observation:after-type' });
      case 'browser.keyboard':
        return observation({
          observationId: 'observation:after-keyboard',
          page: {
            viewportWidth: 800,
            viewportHeight: 600,
            documentWidth: 800,
            documentHeight: 1200,
            scrollX: 0,
            scrollY: 0,
            pixelsAbove: 0,
            pixelsBelow: 600,
            pixelsLeft: 0,
            pixelsRight: 0,
            scrollPercentX: 0,
            scrollPercentY: 0,
          },
          hints: [{ code: 'focused', message: 'Keyboard target retained focus' }],
        });
      case 'browser.press': return observation({ observationId: 'observation:after-press' });
      case 'browser.eval':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          targetId: 'target:managed',
          value: { heading: 'Example Form', count: 1 },
          truncated: false,
        };
      case 'browser.read':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          targetId: 'target:managed',
          title: 'Example Form',
          url: 'https://example.test/form',
          text: 'Submit this form',
          length: 16,
          truncated: false,
        };
      case 'browser.search':
        return {
          workspaceId: 'workspace:cli', leaseId: 'lease:cli', targetId: 'target:managed',
          url: 'https://example.test/form', title: 'Example Form', totalMatches: 1,
          matches: [{ index: 1, text: 'Submit', context: 'Submit this form', tagName: 'button', visible: true, x: 10, y: 20, width: 80, height: 30 }],
          truncated: false,
        };
      case 'browser.elements.find':
        return {
          workspaceId: 'workspace:cli', leaseId: 'lease:cli', targetId: 'target:managed',
          url: 'https://example.test/form', title: 'Example Form', totalMatches: 1,
          elements: [{ index: 1, tagName: 'button', role: 'button', name: 'Submit', text: 'Submit', visible: true, enabled: true, x: 10, y: 20, width: 80, height: 30, attributes: [] }],
          truncated: false,
        };
      case 'browser.scroll':
        return observation({
          observationId: 'observation:after-scroll',
          page: { viewportWidth: 800, viewportHeight: 600, documentWidth: 800, documentHeight: 1800, scrollX: 0, scrollY: 480, pixelsAbove: 480, pixelsBelow: 720, pixelsLeft: 0, pixelsRight: 0, scrollPercentX: 0, scrollPercentY: 40 },
          evidence: { action: 'scroll', status: 'verified', mode: 'relative', target: 'page', moved: true, deltaX: 0, deltaY: 480, beforeX: 0, beforeY: 0, afterX: 0, afterY: 480 },
        });
      case 'browser.dropdown.options':
        return {
          workspaceId: 'workspace:cli', leaseId: 'lease:cli', targetId: 'target:managed',
          url: 'https://example.test/form', kind: 'native', expanded: true, multiple: false,
          requiresOpen: false, options: [{ index: 1, label: 'China', value: 'cn', selected: false, disabled: false }], truncated: false,
        };
      case 'browser.dropdown.select':
        return observation({
          observationId: 'observation:after-select',
          evidence: { action: 'select', status: 'verified', kind: 'native', selected: [{ index: 1, label: 'China', value: 'cn', selected: true, disabled: false }] },
        });
      case 'browser.upload': return observation({ observationId: 'observation:after-upload' });
      case 'browser.capture':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          targetId: 'target:managed',
          url: 'https://example.test/form',
          artifact: artifact('artifact:screenshot', 'screenshot', 'image/png', 'capture.png'),
          ...(args.annotations ? { annotationCount: Array.isArray(args.annotations.refs) ? args.annotations.refs.length : 1 } : {}),
        };
      case 'browser.pdf':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          targetId: 'target:managed',
          url: 'https://example.test/form',
          artifact: artifact('artifact:pdf', 'pdf', 'application/pdf', 'page.pdf'),
        };
      case 'browser.cookies.list':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          targetId: 'target:managed',
          cookies: [{
            name: 'session',
            value: 'fake-cookie-value',
            domain: '.example.test',
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          }],
        };
      case 'browser.frames.list':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          targetId: 'target:managed',
          url: 'https://example.test/form',
          frames: [
            { frameId: 'frame:top', url: 'https://example.test/form', name: '' },
            { frameId: 'frame:child', url: 'https://example.test/frame', name: 'checkout' },
          ],
        };
      case 'browser.frames.switch':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          targetId: 'target:managed',
          frameId: args.frameId ?? 'frame:top',
        };
      case 'browser.auth.set':
      case 'browser.auth.clear':
        return { workspaceId: 'workspace:cli', leaseId: 'lease:cli', ok: true };
      case 'browser.dialogs.list':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          dialogs: [{
            dialogId: 'dialog:contract',
            targetId: 'target:managed',
            type: 'prompt',
            message: 'Enter a label',
            defaultPrompt: 'draft',
            openedAt: 123,
          }],
        };
      case 'browser.dialogs.respond':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          targetId: 'target:managed',
          dialogId: args.dialogId,
          action: args.action,
        };
      case 'browser.tabs.switch':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          targetId: args.targetId,
          selected: true,
        };
      case 'browser.network.requests':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          requests: [{
            requestId: 'network-request:opaque',
            sequence: 4,
            method: 'GET',
            url: 'https://example.test/api',
            status: 200,
            type: 'Fetch',
            size: 12,
            durationMs: 8,
          }],
          nextCursor: 4,
          truncated: false,
        };
      case 'browser.network.request':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          request: {
            requestId: 'network-request:opaque',
            sequence: 4,
            method: 'GET',
            url: 'https://example.test/api',
            type: 'Fetch',
            requestHeaders: [],
            postDataTruncated: false,
            status: 200,
            statusText: 'OK',
            responseHeaders: [],
            mimeType: 'application/octet-stream',
            size: 12,
            durationMs: 8,
            bodyAvailable: true,
          },
          body: Buffer.from('network-body').toString('base64'),
          bodyEncoding: 'base64',
          mimeType: 'application/octet-stream',
          bodyTruncated: false,
        };
      case 'browser.network.rules.add':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          ruleId: `rule:${args.type}-11111111-1111-4111-8111-111111111111`,
        };
      case 'browser.network.rules.list':
        return {
          workspaceId: 'workspace:cli',
          leaseId: 'lease:cli',
          rules: [
            {
              ruleId: 'rule:block-11111111-1111-4111-8111-111111111111',
              type: 'block',
              pattern: '*analytics*',
              enabled: true,
            },
            {
              ruleId: 'rule:mock-11111111-1111-4111-8111-111111111111',
              type: 'mock',
              pattern: '*api/data*',
              status: 201,
              body: '{"created":true}',
              enabled: true,
            },
            {
              ruleId: 'rule:headers-11111111-1111-4111-8111-111111111111',
              type: 'headers',
              pattern: '*api*',
              headers: [{ name: 'X-Test', value: 'contract' }],
              enabled: true,
            },
          ],
        };
      case 'browser.network.rules.remove':
      case 'browser.network.clear':
        return { workspaceId: 'workspace:cli', leaseId: 'lease:cli', ok: true };
      default: throw new Error(`Unexpected tool: ${name} ${JSON.stringify(args)}`);
    }
  };

  const rpcResult = async body => {
    switch (body.method) {
      case 'initialize':
        return {
          serviceVersion: PACKAGE_VERSION,
          executableVersion: PACKAGE_VERSION,
          protocol: { major: 1, minor: 3 },
          supportedCapabilities: [],
          capabilities: { granted: [], unsupported: [] },
          brokerProcessIdentity,
          connectionId: 'connection:cli',
          browsers: [{ id: 'browser:fake', product: 'Chrome', state: 'ready' }],
          limits: {
            maxMessageBytes: 1_048_576,
            maxResultBytes: 4_194_304,
            maxArtifactBytes: 104_857_600,
            eventJournalSize: 1000,
          },
        };
      case 'workspaces/create':
        return {
          workspace: {
            id: 'workspace:cli',
            principalId: 'principal:cli',
            browserInstanceId: 'browser-instance:fake',
            clientKey: body.params.clientKey,
            createdAt: 1,
            updatedAt: 1,
            state: 'active',
          },
          managedTabSet: { id: 'managed-tab-set:cli' },
          eventCursor: 0,
        };
      case 'workspaces/get':
        return {
          workspace: {
            id: 'workspace:cli',
            principalId: 'principal:cli',
            browserInstanceId: 'browser-instance:fake',
            clientKey: 'browser-pilot-cli',
            createdAt: 1,
            updatedAt: 2,
            state: 'active',
          },
          managedTabSet: { id: 'managed-tab-set:cli' },
          managedTabSets: [{ id: 'managed-tab-set:cli' }],
          eventCursor: 'cursor:7',
        };
      case 'workspaces/release':
        return { workspaceId: body.params.workspaceId, released: true };
      case 'leases/create':
        return {
          lease: {
            id: 'lease:cli',
            workspaceId: 'workspace:cli',
            connectionId: 'connection:cli',
            clientKey: body.params.clientKey,
            capabilities: [],
            createdAt: 1,
            lastHeartbeatAt: 1,
            expiresAt: 301_000,
            state: 'active',
          },
        };
      case 'tools/call': {
        const result = await toolResult(body.params.name, body.params.arguments);
        return {
          command: { status: 'completed', method: body.params.name },
          result,
        };
      }
      case 'commands/list':
        return {
          commands: !body.params.statuses || body.params.statuses.includes('completed')
            ? [{
                id: 'command:recent',
                method: 'browser.click',
                mutating: true,
                status: 'completed',
                acceptedAt: 10,
                deadlineAt: 60_010,
                dispatchedAt: 11,
                completedAt: 12,
              }]
            : [],
        };
      case 'commands/get':
        return {
          command: {
            id: body.params.commandId,
            method: 'browser.click',
            mutating: true,
            status: 'completed',
            acceptedAt: 10,
            deadlineAt: 60_010,
            dispatchedAt: 11,
            completedAt: 12,
          },
          result: { url: 'https://example.test/complete' },
        };
      case 'commands/cancel':
        return {
          command: {
            id: body.params.commandId,
            method: 'browser.open',
            mutating: true,
            status: 'cancelled',
            acceptedAt: 10,
            deadlineAt: 60_010,
            completedAt: 12,
          },
        };
      case 'artifacts/import':
        return { artifact: artifact('artifact:upload', 'upload_input', 'text/plain', 'upload.txt') };
      case 'artifacts/list':
        return {
          artifacts: [artifact('artifact:download', 'download', 'text/csv', 'report.csv')],
        };
      case 'artifacts/export':
        await writeFile(body.params.path, 'screenshot-bytes');
        return { artifact: artifact('artifact:screenshot', 'screenshot', 'image/png', 'capture.png'), path: body.params.path };
      case 'artifacts/release': return { artifactId: body.params.artifactId, released: true };
      default: throw new Error(`Unexpected RPC method: ${body.method}`);
    }
  };

  const server = http.createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/health') {
        calls.push({ path: request.url });
        const health = {
          ok: true,
          brokerProtocol: options.brokerProtocol ?? 3,
          brokerProcessIdentity,
          serviceVersion: PACKAGE_VERSION,
          executableVersion: PACKAGE_VERSION,
          executableIdentity,
          clients: { connections: 1, activeWorkspaces: 1, activeLeases: 1 },
          browser: { product: 'Chrome', userDataRoot: '/profiles/fake', state: 'connected' },
        };
        if (options.rotateCredentialsAfterHealthOnce && !credentialsRotated) {
          await rotateCredentials();
        }
        response.end(JSON.stringify(health));
        return;
      }
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ path: request.url, body, authorization: request.headers.authorization });
      if (request.headers.authorization !== `Bearer ${daemonToken}`) {
        response.statusCode = 401;
        response.end(JSON.stringify({
          error: {
            code: -32000,
            message: 'Browser Pilot Broker endpoint authentication failed',
            data: {
              code: 'protocol_incompatible',
              retryable: true,
              context: { reason: 'endpoint_credential_changed' },
              remediation: {
                code: 'upgrade_or_reload_broker_client',
                message: 'Reload the Broker locator.',
                actionRequired: true,
              },
            },
          },
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/broker/rpc') {
        if (
          body?.method === 'tools/call' &&
          body.params?.name === options.credentialErrorAfterDispatchOnce &&
          credentialErrorDispatches === 0
        ) {
          credentialErrorDispatches += 1;
          await rpcResult(body);
          await rotateCredentials();
          response.end(JSON.stringify({
            error: {
              code: -32000,
              message: 'Broker credentials changed after dispatch',
              data: {
                code: 'protocol_incompatible',
                retryable: true,
                context: { reason: 'endpoint_credential_changed' },
              },
            },
          }));
          return;
        }
        if (
          body?.method === 'tools/call' &&
          body.params?.name === options.dropAfterDispatchOnce
        ) {
          const idempotencyKey = body.params.idempotencyKey;
          if (droppedToolCall?.idempotencyKey === idempotencyKey) {
            response.end(JSON.stringify({ result: droppedToolCall.result }));
            return;
          }
          droppedToolDispatches += 1;
          const result = await rpcResult(body);
          if (!droppedToolCall) {
            droppedToolCall = { idempotencyKey, result };
            response.destroy();
            return;
          }
          response.end(JSON.stringify({ result }));
          return;
        }
        const rpcError = options.rpcErrors?.[body?.method];
        const toolError = body?.method === 'tools/call'
          ? options.toolErrors?.[body.params?.name]
          : undefined;
        const responseError = rpcError ?? toolError;
        if (responseError) {
          response.end(JSON.stringify({
            error: {
              code: -32000,
              message: responseError.message,
              data: {
                code: responseError.code,
                retryable: responseError.retryable ?? false,
                ...(responseError.remediation ? { remediation: responseError.remediation } : {}),
              },
            },
          }));
          return;
        }
        response.end(JSON.stringify({ result: await rpcResult(body) }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'unexpected route' }));
    })().catch(error => {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: error.message }));
    });
  });
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(socketPath, resolveListen);
    });
  } catch (error) {
    if (paths.runtimeDir !== paths.stateDir) {
      await rm(paths.runtimeDir, { recursive: true, force: true });
    }
    throw error;
  }
  return {
    server,
    calls,
    get droppedToolDispatches() {
      return droppedToolDispatches;
    },
    get credentialErrorDispatches() {
      return credentialErrorDispatches;
    },
    get token() {
      return daemonToken;
    },
    initialToken: initialDaemonToken,
    async close() {
      await new Promise(resolveClose => server.close(resolveClose));
      if (paths.runtimeDir !== paths.stateDir) {
        await rm(paths.runtimeDir, { recursive: true, force: true });
      }
    },
    resetTabs(options = {}) {
      managedClosed = false;
      preserveSelectedManagedAfterClose = options.preserveSelectedManagedAfterClose === true;
    },
  };
}

async function runCli(home, args, extraEnv = {}) {
  const { stdout } = await execFile(process.execPath, [CLI, ...args], {
    env: isolatedBrokerEnvironment(home, extraEnv),
    timeout: 10_000,
  });
  return JSON.parse(stdout.trim());
}

async function runCliHuman(home, args, extraEnv = {}) {
  const { stdout, stderr } = await execFile(process.execPath, [CLI, '--human', ...args], {
    env: isolatedBrokerEnvironment(home, extraEnv),
    timeout: 10_000,
  });
  assert.equal(stderr, '');
  return stdout.trimEnd();
}

async function runCliFailure(home, args, extraEnv = {}) {
  try {
    await execFile(process.execPath, [CLI, ...args], {
      env: isolatedBrokerEnvironment(home, extraEnv),
      timeout: 10_000,
    });
  } catch (error) {
    return {
      exitCode: error.code,
      stdout: String(error.stdout),
      stderr: String(error.stderr),
      output: error.stdout ? JSON.parse(String(error.stdout).trim()) : undefined,
    };
  }
  assert.fail(`Expected bp ${args.join(' ')} to fail`);
}

test('CLI exposes stable machine errors for parser, input, and connection failures', async t => {
  const root = await mkdtemp(testTempPrefix('bp-cli-errors-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const cases = [
    { args: ['unknown-command'], code: 'invalid_argument', parserCode: 'commander.unknownCommand' },
    { args: ['open'], code: 'invalid_argument', parserCode: 'commander.missingArgument' },
    { args: ['--unknown-option'], code: 'invalid_argument', parserCode: 'commander.unknownOption' },
    { args: ['snapshot', '--limit', 'nope'], code: 'invalid_argument', field: 'limit' },
    { args: ['click', '--xy', '1,'], code: 'invalid_argument', field: 'xy' },
    { args: ['click', '--xy', '1,2,3'], code: 'invalid_argument', field: 'xy' },
    { args: ['click', 'nope'], code: 'invalid_argument', field: 'ref' },
    { args: ['click', '1', '--xy', '1,2'], code: 'invalid_argument', field: 'target' },
    { args: ['type', 'nope', 'text'], code: 'invalid_argument', field: 'ref' },
    { args: ['--request-id', 'bad request', 'tabs'], code: 'invalid_argument', field: 'requestId' },
    { args: ['--timeout', '0', 'tabs'], code: 'invalid_argument', field: 'timeout' },
    { args: ['tabs'], code: 'browser_disconnected', retryable: true },
    { args: ['snapshot'], code: 'browser_disconnected', retryable: true },
  ];

  for (const expected of cases) {
    const result = await runCliFailure(root, expected.args);
    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.output.ok, false);
    assert.equal(result.output.code, expected.code);
    assert.equal(typeof result.output.error, 'string');
    assert.equal(result.output.retryable, expected.retryable ?? false);
    if (expected.parserCode) assert.equal(result.output.context.parserCode, expected.parserCode);
    if (expected.field) assert.equal(result.output.context.field, expected.field);
  }

  const human = await runCliFailure(root, ['--human', 'open']);
  assert.equal(human.exitCode, 1);
  assert.equal(human.stdout, '');
  assert.match(human.stderr, /missing required argument 'url'/);
});

test('CLI preserves specific browser setup remediation without suggesting another blind connect', async t => {
  const root = await mkdtemp(testTempPrefix('bp-cli-setup-remediation-'));
  const setupError = {
    code: 'browser_disconnected',
    message: 'Browser remote debugging endpoint is unavailable',
    retryable: true,
    remediation: {
      code: 'enable_remote_debugging',
      message: 'Open chrome://inspect/#remote-debugging in this browser and turn on remote debugging.',
      actionRequired: true,
    },
  };
  const { close } = await startFakeDaemon(root, {
    toolErrors: {
      'browser.connect': setupError,
      'browser.tabs.list': setupError,
    },
  });
  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });
  const env = { BROWSER_PILOT_HOME: join(root, '.browser-pilot') };

  const machine = await runCliFailure(root, ['tabs'], env);
  assert.equal(machine.output.code, 'browser_disconnected');
  assert.equal(machine.output.remediation.code, 'enable_remote_debugging');
  assert.equal('hint' in machine.output, false);

  const connect = await runCliFailure(root, ['connect'], env);
  assert.equal(connect.output.code, 'browser_disconnected');
  assert.equal(connect.output.remediation.code, 'enable_remote_debugging');
  assert.equal('hint' in connect.output, false);

  const status = await runCli(root, ['status'], env);
  assert.equal(status.recovery.required, true);
  assert.equal(status.recovery.action, setupError.remediation.message);

  const human = await runCliFailure(root, ['--human', 'tabs'], env);
  assert.match(human.stderr, /action: Open chrome:\/\/inspect\/#remote-debugging/);
  assert.doesNotMatch(human.stderr, /Run 'bp connect' first/);
});

test('bp wait fails without creating or selecting a tab when none is selected', async t => {
  const root = await mkdtemp(testTempPrefix('bp-cli-wait-no-target-'));
  const daemon = await startFakeDaemon(root, { noTabs: true });
  t.after(async () => {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  });

  const result = await runCliFailure(root, ['--timeout', '1000', 'wait', '--text', 'Submit']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, '');
  assert.equal(result.output.code, 'no_selected_tab');
  assert.equal(result.output.remediation.code, 'select_tab');
  assert.ok(daemon.calls.some(call => call.body?.params?.name === 'browser.tabs.list'));
  assert.equal(daemon.calls.some(call => call.body?.params?.name === 'browser.open'), false);
  assert.equal(daemon.calls.some(call => call.body?.params?.name === 'browser.tabs.switch'), false);
});

test('bp status preserves structured Broker failures while resuming a session', async t => {
  const root = await mkdtemp(testTempPrefix('bp-cli-status-resume-error-'));
  const daemon = await startFakeDaemon(root, {
    rpcErrors: {
      'leases/create': {
        code: 'internal_error',
        message: 'Lease capacity reached',
      },
    },
  });
  t.after(async () => {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  });

  const result = await runCliFailure(root, ['status']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, '');
  assert.equal(result.output.code, 'internal_error');
  assert.equal(result.output.error, 'Lease capacity reached');
});

test('CLI rejects an incompatible private Broker transport before sending RPC', async t => {
  const root = await mkdtemp(testTempPrefix('bp-cli-private-transport-'));
  const { calls, close } = await startFakeDaemon(root, { brokerProtocol: 1 });
  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  const result = await runCliFailure(root, ['status'], {
    BROWSER_PILOT_HOME: join(root, '.browser-pilot'),
  });
  assert.equal(result.exitCode, 1, result.stderr);
  assert.equal(result.output.code, 'protocol_incompatible');
  assert.equal(result.output.context.brokerRpcVersion, 1);
  assert.equal(result.output.context.requiredBrokerRpcVersion, 3);
  assert.equal(result.output.remediation.code, 'stop_incompatible_broker_or_isolate');
  assert.match(result.output.remediation.message, new RegExp(`${CLI.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} disconnect`));
  assert.doesNotMatch(result.output.remediation.message, /\bbp disconnect\b/);
  assert.equal(calls.some(call => call.path === '/broker/rpc'), false);
});

test('HMAC client sessions remain stable across short-lived CLI processes', async t => {
  const root = await mkdtemp(testTempPrefix('bp-cli-hmac-session-'));
  const daemon = await startFakeDaemon(root);
  t.after(async () => {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  });

  await runCli(root, ['status']);
  await runCli(root, ['status']);
  const initializeCalls = daemon.calls.filter(call => call.body?.method === 'initialize');
  assert.equal(initializeCalls.length, 2);
  assert.deepEqual(
    [...new Set(initializeCalls.map(call => call.body.clientSessionId))],
    [expectedClientSessionId(daemon.token)],
  );
});

test('credential change during initialize rebuilds the complete client once', async t => {
  const root = await mkdtemp(testTempPrefix('bp-cli-credential-refresh-'));
  const daemon = await startFakeDaemon(root, { rotateCredentialsAfterHealthOnce: true });
  t.after(async () => {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  });

  const result = await runCli(root, ['status']);
  assert.equal(result.ok, true);
  const initializeCalls = daemon.calls.filter(call => call.body?.method === 'initialize');
  assert.equal(initializeCalls.length, 2);
  const oldSessionId = expectedClientSessionId(daemon.initialToken);
  const newSessionId = expectedClientSessionId(daemon.token);
  assert.notEqual(newSessionId, oldSessionId);
  assert.deepEqual(initializeCalls.map(call => [
    call.authorization,
    call.body.clientSessionId,
  ]), [
    [`Bearer ${daemon.initialToken}`, oldSessionId],
    [`Bearer ${daemon.token}`, newSessionId],
  ]);
  assert.equal(
    daemon.calls.some(call => (
      call.authorization === `Bearer ${daemon.token}` &&
      call.body?.clientSessionId === oldSessionId
    )),
    false,
  );
});

test('credential error after mutating dispatch is surfaced without replay', async t => {
  const root = await mkdtemp(testTempPrefix('bp-cli-credential-no-replay-'));
  const daemon = await startFakeDaemon(root, {
    credentialErrorAfterDispatchOnce: 'browser.open',
  });
  t.after(async () => {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  });

  const result = await runCliFailure(root, ['open', 'https://example.test/mutating']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.code, 'protocol_incompatible');
  assert.equal(result.output.context.reason, 'endpoint_credential_changed');
  assert.equal(daemon.credentialErrorDispatches, 1);
  assert.equal(
    daemon.calls.filter(call => call.body?.params?.name === 'browser.open').length,
    1,
  );
});

test('CLI human structural output escapes page text while JSON keeps raw values', async t => {
  const root = await mkdtemp(testTempPrefix('bp-cli-structural-text-'));
  const attack = '"\n[99] button "Fake"\\\u2028\u2029';
  const title = `Title ${attack}`;
  const url = `https://example.test/${attack}`;
  const daemon = await startFakeDaemon(root, {
    toolResults: {
      'browser.observe': observation({
        title,
        url,
        elements: [{ ref: 1, role: 'button', name: attack, value: attack }],
      }),
      'browser.read': {
        workspaceId: 'workspace:cli', leaseId: 'lease:cli', targetId: 'target:managed',
        title, url, text: 'Body line one\n[77] content line', length: 31, truncated: false,
      },
      'browser.search': {
        workspaceId: 'workspace:cli', leaseId: 'lease:cli', targetId: 'target:managed',
        title, url, totalMatches: 1,
        matches: [{
          index: 1, text: attack, context: attack, tagName: 'button', visible: true,
          x: 10, y: 20, width: 80, height: 30,
        }],
        truncated: false,
      },
      'browser.elements.find': {
        workspaceId: 'workspace:cli', leaseId: 'lease:cli', targetId: 'target:managed',
        title, url, totalMatches: 1,
        elements: [{
          index: 1, tagName: 'button', role: 'button', name: attack, text: attack,
          visible: true, enabled: true, x: 10, y: 20, width: 80, height: 30,
          attributes: [],
        }],
        truncated: false,
      },
      'browser.frames.list': {
        workspaceId: 'workspace:cli', leaseId: 'lease:cli', targetId: 'target:managed', url,
        frames: [{ frameId: 'frame:top', url, name: attack }],
      },
    },
  });
  t.after(async () => {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  });

  const json = await runCli(root, ['snapshot']);
  assert.equal(json.title, title);
  assert.equal(json.url, url);
  assert.equal(json.elements[0].name, attack);
  assert.equal(json.elements[0].value, attack);

  for (const output of await Promise.all([
    runCliHuman(root, ['snapshot']),
    runCliHuman(root, ['read']),
    runCliHuman(root, ['search', 'Fake']),
    runCliHuman(root, ['find', 'button']),
    runCliHuman(root, ['frame']),
  ])) {
    assert.doesNotMatch(output, /^\[99\]/m);
    assert.match(output, /\\"\\n\[99\]/);
    assert.match(output, /\\u2028\\u2029/);
  }
});

test('CLI reuses a mutating idempotency key after dispatch response loss', async t => {
  const root = await mkdtemp(testTempPrefix('bp-cli-request-retry-'));
  const daemon = await startFakeDaemon(root, { dropAfterDispatchOnce: 'browser.open' });
  t.after(async () => {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  });

  const args = ['--request-id', 'retry-open-42', 'open', 'https://retry.example.test/task'];
  const interrupted = await runCliFailure(root, args);
  assert.equal(interrupted.exitCode, 1);
  const retried = await runCli(root, args);
  assert.equal(retried.ok, true);

  const openCalls = daemon.calls.filter(call => (
    call.body?.method === 'tools/call' &&
    call.body.params.name === 'browser.open' &&
    call.body.params.arguments.url === 'https://retry.example.test/task'
  ));
  assert.equal(openCalls.length, 2);
  assert.equal(openCalls[0].body.params.idempotencyKey, openCalls[1].body.params.idempotencyKey);
  assert.match(
    openCalls[0].body.params.idempotencyKey,
    /^cli-request:retry-open-42:browser\.open:[A-Za-z0-9_-]{32}$/,
  );
  assert.equal(daemon.droppedToolDispatches, 1);
});

test('CLI JSON output contract covers every command', async t => {
  const root = await mkdtemp(testTempPrefix('bp-cli-json-contract-'));
  const daemon = await startFakeDaemon(root);
  t.after(async () => {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  });

  const uploadPath = join(root, 'contract-upload.txt');
  const downloadPath = join(root, 'contract-download.csv');
  const screenshotPath = join(root, 'contract-screenshot.png');
  const pdfPath = join(root, 'contract.pdf');
  await writeFile(uploadPath, 'contract upload');

  const outputs = {};
  outputs.status = await runCli(root, ['status']);
  outputs.commands = await runCli(root, ['commands']);
  outputs.command = await runCli(root, ['command', 'command:recent']);
  outputs.cancel = await runCli(root, ['cancel', 'command:running']);
  outputs.wait = await runCli(root, ['--timeout', '1000', 'wait', '--text', 'Submit']);
  outputs.wait.elapsedMs = '<elapsedMs>';
  outputs.browsers = await runCli(root, ['browsers']);
  outputs.connect = await runCli(root, ['connect']);
  outputs.profiles = await runCli(root, ['profiles', '--identify']);
  outputs.profile = await runCli(root, ['profile', 'alice@personal.example.test']);
  outputs.open = await runCli(root, [
    'open', 'https://contract.example.test/task', '--new', '--profile', '1', '--limit', '12',
  ]);
  outputs.snapshot = await runCli(root, ['snapshot', '--limit', '9']);
  outputs.click = await runCli(root, ['click', '1', '--double', '--limit', '7']);
  outputs.locate = await runCli(root, ['locate', '.editor']);
  outputs.type = await runCli(root, ['type', '1', 'contract text', '--clear', '--submit']);
  outputs.keyboard = await runCli(root, [
    'keyboard', 'keyboard text', '--clear', '--delay', '5', '--click', '.editor', '--limit', '7',
  ]);
  outputs.press = await runCli(root, ['press', 'Control+a', '--limit', '8']);
  outputs.eval = await runCli(root, ['eval', 'document.title']);
  outputs.read = await runCli(root, ['read', 'main', '--limit', '200']);
  outputs.search = await runCli(root, ['search', 'Submit', '--whole-word']);
  outputs.find = await runCli(root, ['find', 'button', '--attributes', 'id,data-testid']);
  outputs.scroll = await runCli(root, ['scroll', 'down', '--amount', '0.8']);
  outputs.dropdown = await runCli(root, ['dropdown', '1']);
  outputs.select = await runCli(root, ['select', '1', 'China']);
  outputs.upload = await runCli(root, ['upload', uploadPath]);
  outputs.downloads = await runCli(root, ['downloads']);
  outputs.download = await runCli(root, ['download', '1', downloadPath]);
  outputs.screenshot = await runCli(root, ['screenshot', screenshotPath, '--annotate', '1']);
  outputs.pdf = await runCli(root, ['pdf', pdfPath, '--landscape']);
  outputs.cookies = await runCli(root, ['cookies', 'example.test']);
  outputs.frame = await runCli(root, ['frame']);
  outputs.auth = await runCli(root, ['auth', 'contract-user', 'contract-password']);
  outputs.dialogs = await runCli(root, ['dialogs']);
  outputs.dialog = await runCli(root, ['dialog', 'dialog:contract', '--accept', '--prompt', 'final']);
  outputs.tabs = await runCli(root, ['tabs']);
  outputs.tab = await runCli(root, ['tab', '1']);
  outputs.close = await runCli(root, ['close']);
  outputs.net = await runCli(root, [
    'net', '--url', '*api*', '--method', 'GET', '--status', '2xx', '--type', 'xhr,fetch',
  ]);
  outputs['net show'] = await runCli(root, ['net', 'show', '4']);
  outputs['net block'] = await runCli(root, ['net', 'block', '*analytics*']);
  outputs['net mock'] = await runCli(root, [
    'net', 'mock', '*api/data*', '--body', '{"created":true}', '--status', '201',
  ]);
  outputs['net headers'] = await runCli(root, [
    'net', 'headers', '*api*', 'X-Test: contract',
  ]);
  outputs['net rules'] = await runCli(root, ['net', 'rules']);
  outputs['net remove'] = await runCli(root, [
    'net', 'remove', 'rule:block-11111111-1111-4111-8111-111111111111',
  ]);
  outputs['net clear'] = await runCli(root, ['net', 'clear']);
  outputs.disconnect = await runCli(root, ['disconnect']);

  const profileRepresentatives = {
    work: [{
      targetId: 'target:managed',
      title: 'Example Form',
      url: 'https://example.test/form',
    }],
    personal: [{
      targetId: 'target:personal',
      title: 'Personal Inbox',
      url: 'https://mail.example.test/',
    }],
  };
  const unidentifiedProfiles = [
    {
      index: 1,
      profileContextId: 'profile-context:work',
      label: 'Profile 1',
      identityStatus: 'unidentified',
      tabCount: 2,
      eligibleTabCount: 2,
      selected: false,
      representativeTabs: profileRepresentatives.work,
    },
    {
      index: 2,
      profileContextId: 'profile-context:personal',
      label: 'Profile 2',
      identityStatus: 'unidentified',
      tabCount: 1,
      eligibleTabCount: 1,
      selected: false,
      representativeTabs: profileRepresentatives.personal,
    },
  ];
  const identifiedProfiles = [
    {
      ...unidentifiedProfiles[0],
      identityStatus: 'verified',
      profileName: 'Work Account',
      accountName: 'Alice Example',
      accountEmail: 'alice@work.example.test',
      profileDirectory: 'Default',
    },
    {
      ...unidentifiedProfiles[1],
      identityStatus: 'verified',
      profileName: 'Personal Account',
      accountName: 'Alice',
      accountEmail: 'alice@personal.example.test',
      profileDirectory: 'Profile 1',
    },
  ];
  const observationOutput = {
    ok: true,
    title: 'Example Form',
    url: 'https://example.test/form',
    elements: [{ ref: 1, role: 'button', name: 'Submit' }],
    truncated: false,
    truncationReasons: [],
    hints: [],
    profileContextId: 'profile-context:work',
  };
  const commandDescriptor = {
    id: 'command:recent',
    method: 'browser.click',
    mutating: true,
    status: 'completed',
    acceptedAt: 10,
    deadlineAt: 60_010,
    dispatchedAt: 11,
    completedAt: 12,
  };

  assert.deepEqual(outputs, {
    status: {
      ok: true,
      service: { state: 'running', version: PACKAGE_VERSION },
      browser: { id: 'browser:fake', product: 'Chrome', state: 'ready' },
      session: {
        state: 'active',
        expiresAt: 301_000,
        profile: null,
        target: {
          index: 1,
          title: 'Example Form',
          url: 'https://example.test/form',
          origin: 'managed',
          profileContextId: 'profile-context:work',
        },
      },
      commands: { active: [], uncertain: [] },
      recovery: { required: false },
    },
    commands: { ok: true, commands: [commandDescriptor] },
    command: {
      ok: true,
      command: commandDescriptor,
      result: { url: 'https://example.test/complete' },
    },
    cancel: {
      ok: true,
      command: {
        id: 'command:running',
        method: 'browser.open',
        mutating: true,
        status: 'cancelled',
        acceptedAt: 10,
        deadlineAt: 60_010,
        completedAt: 12,
      },
    },
    wait: {
      ok: true,
      condition: 'text',
      elapsedMs: '<elapsedMs>',
      matched: {
        title: 'Example Form',
        url: 'https://example.test/form',
        match: {
          index: 1,
          text: 'Submit',
          context: 'Submit this form',
          tagName: 'button',
          visible: true,
          x: 10,
          y: 20,
          width: 80,
          height: 30,
        },
      },
    },
    browsers: {
      ok: true,
      browsers: [{
        id: 'browser:fake',
        product: 'Chrome',
        channel: 'stable',
        userDataRoot: '/profiles/fake',
        processState: 'running',
        remoteDebuggingState: 'enabled',
        authorizationState: 'authorized',
        state: 'ready',
      }],
    },
    connect: {
      ok: true,
      browser: 'Chrome',
      profileSelectionRequired: true,
      profiles: unidentifiedProfiles,
    },
    profiles: { ok: true, profiles: identifiedProfiles },
    profile: {
      ok: true,
      profileContextId: 'profile-context:personal',
      label: 'Profile 2',
      identityStatus: 'verified',
      profileName: 'Personal Account',
      accountName: 'Alice',
      accountEmail: 'alice@personal.example.test',
      profileDirectory: 'Profile 1',
    },
    open: {
      ...observationOutput,
      url: 'https://contract.example.test/task',
    },
    snapshot: observationOutput,
    click: observationOutput,
    locate: { ok: true, x: 50, y: 35, top: 20, left: 10, width: 80, height: 30 },
    type: observationOutput,
    keyboard: {
      ok: true,
      typed: 'keyboard text',
      title: 'Example Form',
      url: 'https://example.test/form',
      elements: [{ ref: 1, role: 'button', name: 'Submit' }],
      truncated: false,
      truncationReasons: [],
    },
    press: observationOutput,
    eval: {
      ok: true,
      value: { heading: 'Example Form', count: 1 },
      truncated: false,
    },
    read: {
      ok: true,
      title: 'Example Form',
      url: 'https://example.test/form',
      text: 'Submit this form',
      length: 16,
      truncated: false,
    },
    search: {
      ok: true,
      workspaceId: 'workspace:cli',
      leaseId: 'lease:cli',
      targetId: 'target:managed',
      url: 'https://example.test/form',
      title: 'Example Form',
      totalMatches: 1,
      matches: [{
        index: 1,
        text: 'Submit',
        context: 'Submit this form',
        tagName: 'button',
        visible: true,
        x: 10,
        y: 20,
        width: 80,
        height: 30,
      }],
      truncated: false,
    },
    find: {
      ok: true,
      workspaceId: 'workspace:cli',
      leaseId: 'lease:cli',
      targetId: 'target:managed',
      url: 'https://example.test/form',
      title: 'Example Form',
      totalMatches: 1,
      elements: [{
        index: 1,
        tagName: 'button',
        role: 'button',
        name: 'Submit',
        text: 'Submit',
        visible: true,
        enabled: true,
        x: 10,
        y: 20,
        width: 80,
        height: 30,
        attributes: [],
      }],
      truncated: false,
    },
    scroll: {
      ...observationOutput,
      page: {
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1800,
        scrollX: 0,
        scrollY: 480,
        pixelsAbove: 480,
        pixelsBelow: 720,
        pixelsLeft: 0,
        pixelsRight: 0,
        scrollPercentX: 0,
        scrollPercentY: 40,
      },
      evidence: {
        action: 'scroll',
        status: 'verified',
        mode: 'relative',
        target: 'page',
        moved: true,
        deltaX: 0,
        deltaY: 480,
        beforeX: 0,
        beforeY: 0,
        afterX: 0,
        afterY: 480,
      },
    },
    dropdown: {
      ok: true,
      workspaceId: 'workspace:cli',
      leaseId: 'lease:cli',
      targetId: 'target:managed',
      url: 'https://example.test/form',
      kind: 'native',
      expanded: true,
      multiple: false,
      requiresOpen: false,
      options: [{
        index: 1,
        label: 'China',
        value: 'cn',
        selected: false,
        disabled: false,
      }],
      truncated: false,
    },
    select: {
      ...observationOutput,
      evidence: {
        action: 'select',
        status: 'verified',
        kind: 'native',
        selected: [{
          index: 1,
          label: 'China',
          value: 'cn',
          selected: true,
          disabled: false,
        }],
      },
    },
    upload: observationOutput,
    downloads: {
      ok: true,
      downloads: [{
        index: 1,
        id: 'artifact:download',
        fileName: 'report.csv',
        mimeType: 'text/csv',
        sizeBytes: 12,
        createdAt: 1,
        expiresAt: 301_000,
      }],
    },
    download: { ok: true, file: downloadPath, mimeType: 'text/csv', sizeBytes: 12 },
    screenshot: {
      ok: true,
      file: screenshotPath,
      mimeType: 'image/png',
      sizeBytes: 12,
      width: 800,
      height: 600,
      annotationCount: 1,
    },
    pdf: { ok: true, file: pdfPath, mimeType: 'application/pdf', sizeBytes: 12 },
    cookies: {
      ok: true,
      cookies: [{
        name: 'session',
        value: 'fake-cookie-value',
        domain: '.example.test',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      }],
    },
    frame: {
      ok: true,
      frames: [
        { index: 0, frameId: 'frame:top', url: 'https://example.test/form', name: '' },
        { index: 1, frameId: 'frame:child', url: 'https://example.test/frame', name: 'checkout' },
      ],
    },
    auth: { ok: true },
    dialogs: {
      ok: true,
      dialogs: [{
        dialogId: 'dialog:contract',
        targetId: 'target:managed',
        type: 'prompt',
        message: 'Enter a label',
        defaultPrompt: 'draft',
        openedAt: 123,
      }],
    },
    dialog: { ok: true, dialogId: 'dialog:contract', action: 'accept' },
    tabs: {
      ok: true,
      tabs: [{
        index: 1,
        profileContextId: 'profile-context:work',
        title: 'Example Form',
        url: 'https://example.test/form',
        origin: 'managed',
        selected: true,
        controlState: 'controlled',
      }],
    },
    tab: { ok: true, index: 1 },
    close: { ok: true, remaining: 1 },
    net: {
      ok: true,
      requests: [{
        id: 4,
        method: 'GET',
        url: 'https://example.test/api',
        status: 200,
        type: 'Fetch',
        size: 12,
        time: 8,
      }],
      total: 1,
      truncated: false,
      nextCursor: 4,
    },
    'net show': {
      ok: true,
      id: 4,
      requestId: 'network-request:opaque',
      sequence: 4,
      method: 'GET',
      url: 'https://example.test/api',
      type: 'Fetch',
      requestHeaders: [],
      postDataTruncated: false,
      status: 200,
      statusText: 'OK',
      responseHeaders: [],
      mimeType: 'application/octet-stream',
      size: 12,
      durationMs: 8,
      bodyAvailable: true,
      responseBody: Buffer.from('network-body').toString('base64'),
    },
    'net block': {
      ok: true,
      rule: {
        id: 'rule:block-11111111-1111-4111-8111-111111111111',
        type: 'block',
        pattern: '*analytics*',
      },
    },
    'net mock': {
      ok: true,
      rule: {
        id: 'rule:mock-11111111-1111-4111-8111-111111111111',
        type: 'mock',
        pattern: '*api/data*',
        status: 200,
      },
    },
    'net headers': {
      ok: true,
      rule: {
        id: 'rule:headers-11111111-1111-4111-8111-111111111111',
        type: 'headers',
        pattern: '*api*',
        headers: [{ name: 'X-Test', value: 'contract' }],
      },
    },
    'net rules': {
      ok: true,
      rules: [
        {
          id: 'rule:block-11111111-1111-4111-8111-111111111111',
          type: 'block',
          pattern: '*analytics*',
          enabled: true,
        },
        {
          id: 'rule:mock-11111111-1111-4111-8111-111111111111',
          type: 'mock',
          pattern: '*api/data*',
          status: 201,
          body: '{"created":true}',
          enabled: true,
        },
        {
          id: 'rule:headers-11111111-1111-4111-8111-111111111111',
          type: 'headers',
          pattern: '*api*',
          headers: [{ name: 'X-Test', value: 'contract' }],
          enabled: true,
        },
      ],
    },
    'net remove': { ok: true },
    'net clear': { ok: true },
    disconnect: { ok: true },
  });
});

test('CLI uses only canonical Broker and file operations', async t => {
  const root = await mkdtemp(testTempPrefix('bp-cli-'));
  const { calls, close, resetTabs } = await startFakeDaemon(root);
  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  const snapshot = await runCli(root, ['snapshot', '--limit', '9']);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.elements[0].name, 'Submit');

  const status = await runCli(root, ['status']);
  assert.equal(status.service.state, 'running');
  assert.equal(status.session.target.url, 'https://example.test/form');
  assert.equal('eventCursor' in status, false);
  assert.equal(status.recovery.required, false);
  assert.deepEqual(
    calls
      .filter(call => call.body?.method === 'commands/list')
      .map(call => call.body.params.statuses),
    [['accepted', 'dispatched'], ['unknown_outcome']],
  );

  const commands = await runCli(root, ['commands']);
  assert.equal(commands.commands[0].id, 'command:recent');
  const command = await runCli(root, ['command', 'command:recent']);
  assert.equal(command.command.status, 'completed');
  const cancelled = await runCli(root, ['cancel', 'command:running']);
  assert.equal(cancelled.command.status, 'cancelled');

  await runCli(root, ['--request-id', 'host-call-42', 'snapshot']);
  const requestCall = calls.find(call => (
    call.body?.params?.name === 'browser.observe' &&
    call.body.params.arguments.limit === 50
  ));
  assert.ok(requestCall);
  assert.equal('idempotencyKey' in requestCall.body.params, false);
  assert.match(requestCall.body.params.commandId, /^command:cli-\d+-\d+-[a-f0-9-]{36}$/);

  const waitedText = await runCli(root, ['--timeout', '1000', 'wait', '--text', 'Submit']);
  assert.equal(waitedText.condition, 'text');
  const waitedDownload = await runCli(root, ['--timeout', '1000', 'wait', '--download']);
  assert.equal(waitedDownload.matched.fileName, 'report.csv');
  const downloads = await runCli(root, ['downloads']);
  assert.equal(downloads.downloads[0].mimeType, 'text/csv');

  const outputDirectory = join(root, 'agent-output');
  const downloaded = await runCli(root, ['download', '1'], {
    BROWSER_PILOT_OUTPUT_DIR: outputDirectory,
  });
  assert.equal(downloaded.file, join(outputDirectory, 'report.csv'));
  assert.equal(downloaded.mimeType, 'text/csv');
  assert.equal(await readFile(downloaded.file, 'utf8'), 'screenshot-bytes');

  const browsers = await runCli(root, ['browsers']);
  assert.equal(browsers.browsers[0].state, 'ready');
  assert.equal(browsers.browsers[0].userDataRoot, '/profiles/fake');
  assert.equal('profile' in browsers.browsers[0], false);
  assert.ok(calls.some(call => call.body?.params?.name === 'browser.discover'));

  const connected = await runCli(root, ['connect']);
  assert.equal(connected.profileSelectionRequired, true);
  assert.equal(connected.profiles.length, 2);
  assert.equal(
    calls.some(call => call.body?.params?.name === 'browser.open'),
    false,
    'multi-Profile connect must not create a managed target before selection',
  );

  const profiles = await runCli(root, ['profiles']);
  assert.deepEqual(profiles.profiles.map(profile => [profile.index, profile.identityStatus]), [
    [1, 'unidentified'],
    [2, 'unidentified'],
  ]);

  const identifiedProfiles = await runCli(root, ['profiles', '--identify']);
  assert.deepEqual(identifiedProfiles.profiles.map(profile => [
    profile.index,
    profile.profileName,
    profile.accountEmail,
  ]), [
    [1, 'Work Account', 'alice@work.example.test'],
    [2, 'Personal Account', 'alice@personal.example.test'],
  ]);
  assert.ok(calls.some(call => call.body?.params?.name === 'browser.profiles.identify'));

  const selectedProfile = await runCli(root, ['profile', 'alice@personal.example.test']);
  assert.equal(selectedProfile.profileContextId, 'profile-context:personal');
  assert.equal(selectedProfile.profileName, 'Personal Account');
  const selectedCall = calls.find(call => call.body?.params?.name === 'browser.profiles.select');
  assert.deepEqual(selectedCall.body.params.arguments, {
    profileContextId: 'profile-context:personal',
  });

  const opened = await runCli(root, [
    'open', 'https://work.example.test/task', '--new', '--profile', '1', '--limit', '12',
  ]);
  assert.equal(opened.profileContextId, 'profile-context:work');
  const openCall = calls.find(call => call.body?.params?.name === 'browser.open');
  assert.deepEqual(openCall.body.params.arguments, {
    url: 'https://work.example.test/task',
    newTarget: true,
    profileContextId: 'profile-context:work',
    observationLimit: 12,
  });

  const clicked = await runCli(root, ['click', '1', '--limit', '7']);
  assert.equal(clicked.ok, true);
  const clickCall = calls.find(call => call.body?.params?.name === 'browser.click');
  assert.deepEqual(clickCall.body.params.arguments, {
    target: { observationId: 'observation:current', ref: 1 },
    button: 'left',
    clickCount: 1,
    observationLimit: 7,
  });

  const searched = await runCli(root, ['search', 'Submit', '--whole-word']);
  assert.equal(searched.matches[0].context, 'Submit this form');
  const found = await runCli(root, ['find', 'button', '--attributes', 'id,data-testid']);
  assert.equal(found.elements[0].role, 'button');

  const scrolled = await runCli(root, ['scroll', 'down', '--amount', '0.8']);
  assert.equal(scrolled.evidence.action, 'scroll');
  assert.equal(scrolled.page.scrollY, 480);
  const scrollCall = calls.find(call => call.body?.params?.name === 'browser.scroll');
  assert.deepEqual(scrollCall.body.params.arguments, {
    direction: 'down',
    amount: 0.8,
    unit: 'viewport',
    observationLimit: 50,
  });

  const dropdown = await runCli(root, ['dropdown', '1']);
  assert.equal(dropdown.options[0].value, 'cn');
  const selected = await runCli(root, ['select', '1', 'China']);
  assert.equal(selected.evidence.status, 'verified');
  const selectCall = calls.find(call => call.body?.params?.name === 'browser.dropdown.select');
  assert.deepEqual(selectCall.body.params.arguments, {
    target: { observationId: 'observation:current', ref: 1 },
    choice: { by: 'label', label: 'China', exact: true },
    observationLimit: 50,
  });

  const screenshotPath = join(root, 'capture.png');
  const captured = await runCli(root, ['screenshot', screenshotPath]);
  assert.equal(captured.file, screenshotPath);
  assert.equal(captured.mimeType, 'image/png');
  assert.equal(captured.sizeBytes, 12);
  assert.equal(captured.width, 800);
  assert.equal(await readFile(screenshotPath, 'utf8'), 'screenshot-bytes');
  const exportCall = calls.find(call => call.body?.method === 'artifacts/export');
  assert.equal(exportCall.body.params.overwrite, true);

  const annotatedPath = join(root, 'annotated.png');
  const annotated = await runCli(root, ['screenshot', annotatedPath, '--annotate', '1']);
  assert.equal(annotated.annotationCount, 1);
  const annotationCall = calls.find(call => (
    call.body?.params?.name === 'browser.capture' && call.body.params.arguments.annotations
  ));
  assert.deepEqual(annotationCall.body.params.arguments.annotations, {
    observationId: 'observation:current',
    refs: [1],
  });

  const uploadPath = join(root, 'upload.txt');
  await writeFile(uploadPath, 'upload-source');
  assert.equal((await runCli(root, ['upload', uploadPath])).ok, true);
  assert.ok(calls.some(call => call.body?.method === 'artifacts/import'));
  assert.ok(calls.some(call => call.body?.params?.name === 'browser.upload'));

  const bodyPath = join(root, 'response.bin');
  const saved = await runCli(root, ['net', 'show', '4', '--save', bodyPath]);
  assert.equal(saved.file, bodyPath);
  assert.equal(await readFile(bodyPath, 'utf8'), 'network-body');
  const requestList = calls.find(call => (
    call.body?.params?.name === 'browser.network.requests' &&
    call.body.params.arguments.after === 3
  ));
  assert.deepEqual(requestList.body.params.arguments, { after: 3, limit: 1 });
  assert.ok(calls.some(call => (
    call.body?.params?.name === 'browser.network.request' &&
    call.body.params.arguments.requestId === 'network-request:opaque'
  )));

  assert.ok(calls.some(call => (
    call.body?.method === 'workspaces/create' &&
    call.body.params.clientKey === 'browser-pilot-cli'
  )));

  const switchCount = calls.filter(call => call.body?.params?.name === 'browser.tabs.switch').length;
  const closed = await runCli(root, ['close', '--all']);
  assert.equal(closed.closed, 1);
  assert.equal(closed.remaining, 1);
  assert.equal(
    calls.filter(call => call.body?.params?.name === 'browser.tabs.switch').length,
    switchCount,
    'managed-only cleanup must not switch control to a user tab',
  );
  resetTabs({ preserveSelectedManagedAfterClose: true });
  const closedCurrent = await runCli(root, ['close']);
  assert.equal(closedCurrent.remaining, 2);
  assert.equal(
    calls.filter(call => call.body?.params?.name === 'browser.tabs.switch').length,
    switchCount,
    'closing the current tab must preserve the Broker-selected fallback',
  );
  const remaining = await runCli(root, ['tabs']);
  const remainingUserTab = remaining.tabs.find(tab => tab.origin === 'user_tab');
  assert.equal(remaining.tabs.find(tab => tab.origin === 'managed').selected, true);
  assert.equal(remainingUserTab.controlState, 'available');
  assert.equal(remainingUserTab.selected, false);
  assert.equal('active' in remainingUserTab, false);

  const namespaceStart = calls.length;
  await runCli(root, ['tabs'], { BROWSER_PILOT_CLIENT_KEY: 'agent.alpha' });
  await runCli(root, ['--client-key', 'agent.alpha', 'tabs']);
  await runCli(root, ['--client-key', 'agent.beta', 'tabs']);
  const namespaceCalls = calls.slice(namespaceStart);
  const namespaceInitializes = namespaceCalls
    .filter(call => call.body?.method === 'initialize')
    .map(call => call.body.params.client.instanceId);
  assert.equal(namespaceInitializes[0], namespaceInitializes[1]);
  assert.notEqual(namespaceInitializes[0], namespaceInitializes[2]);
  assert.deepEqual(
    namespaceCalls
      .filter(call => call.body?.method === 'workspaces/create')
      .map(call => call.body.params.clientKey),
    ['agent.alpha', 'agent.alpha', 'agent.beta'],
  );
  await assert.rejects(
    () => runCli(root, ['--client-key', 'x', 'tabs']),
    error => {
      const output = JSON.parse(String(error.stdout).trim());
      return output.ok === false &&
        output.code === 'invalid_argument' &&
        output.context?.field === 'clientKey';
    },
  );
  assert.ok(calls.some(call => (
    call.body?.method === 'leases/create' &&
    call.body.params.clientKey === 'browser-pilot-cli' &&
    call.body.params.ttlMs === 300_000
  )));
});
