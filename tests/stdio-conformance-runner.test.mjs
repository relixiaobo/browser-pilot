import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runner = join(root, 'scripts/run-stdio-conformance.mjs');
const fixture = join(root, 'tests/fixtures/fake-stdio-bridge.mjs');

function execute(args) {
  return new Promise((resolveExecution, reject) => {
    const child = spawn(process.execPath, [runner, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => resolveExecution({ code, stdout, stderr }));
  });
}

test('stdio conformance runner validates a black-box executable and writes a bounded report', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-pilot-conformance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reportPath = join(directory, 'report.json');
  const execution = await execute([
    '--report', reportPath,
    '--timeout-ms', '5000',
    '--', process.execPath, fixture,
  ]);

  assert.equal(execution.code, 0, execution.stderr);
  const stdoutReport = JSON.parse(execution.stdout);
  const fileReport = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.deepEqual(fileReport, stdoutReport);
  assert.equal(stdoutReport.schemaVersion, 1);
  assert.equal(stdoutReport.suite, 'browser-pilot-stdio-conformance');
  assert.equal(stdoutReport.outcome, 'passed');
  assert.equal(stdoutReport.checks.every(check => check.status === 'passed'), true);
  assert.equal(stdoutReport.transport.notificationsReceived, 1);
  assert.deepEqual(stdoutReport.checks.map(check => check.id), [
    'initialize',
    'tool_manifest',
    'workspace_create',
    'lease_create_and_heartbeat',
    'managed_target_open',
    'observation',
    'screenshot_artifact',
    'artifact_release',
    'event_replay',
    'managed_target_close',
    'lease_and_workspace_release',
    'shutdown',
  ]);
  assert.equal(JSON.stringify(stdoutReport).includes('workspace:fake'), false);
  assert.ok(Buffer.byteLength(execution.stdout) < 16 * 1024);
});

test('stdio conformance runner reports protocol failures and still cleans up owned resources', async () => {
  const execution = await execute([
    '--timeout-ms', '5000',
    '--', process.execPath, fixture, '--fail-method', 'browser.observe',
  ]);

  assert.equal(execution.code, 1);
  const report = JSON.parse(execution.stdout);
  assert.equal(report.outcome, 'failed');
  assert.deepEqual(report.failure, {
    checkId: 'observation',
    code: 'fixture_failure',
    message: 'Requested fixture failure',
    rpcCode: -32000,
  });
  assert.equal(report.checks.some(check => check.id === 'cleanup_managed_target' && check.status === 'passed'), true);
  assert.equal(report.checks.some(check => check.id === 'cleanup_lease' && check.status === 'passed'), true);
  assert.equal(report.checks.some(check => check.id === 'cleanup_workspace' && check.status === 'passed'), true);
  assert.equal(report.checks.some(check => check.id === 'cleanup_shutdown' && check.status === 'passed'), true);
  assert.ok(Buffer.byteLength(execution.stdout) < 16 * 1024);
});
