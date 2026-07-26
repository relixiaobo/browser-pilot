import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  hostAcceptanceHelpText,
  parseHostAcceptanceArguments,
} from '../scripts/run-host-integration-acceptance.mjs';

test('host acceptance runner defaults to the repository CLI command prefix', () => {
  const options = parseHostAcceptanceArguments([]);
  assert.deepEqual(options.commandPrefix, [process.execPath, resolve('dist/cli.js')]);
  assert.equal(options.timeoutMs, 65_000);
});

test('host acceptance runner accepts explicit Profiles and executable prefixes', () => {
  const options = parseHostAcceptanceArguments([
    '--profile', '2',
    '--second-profile', '3',
    '--expected-version', '0.3.0-rc.3',
    '--timeout-ms', '90000',
    '--report', 'test-results/host.json',
    '--', process.execPath, '/opt/browser-pilot/dist/cli.js',
  ]);
  assert.equal(options.profileIndex, 2);
  assert.equal(options.secondProfileIndex, 3);
  assert.equal(options.expectedVersion, '0.3.0-rc.3');
  assert.equal(options.timeoutMs, 90_000);
  assert.equal(options.reportPath, resolve('test-results/host.json'));
  assert.deepEqual(options.commandPrefix, [process.execPath, '/opt/browser-pilot/dist/cli.js']);
});

test('host acceptance runner rejects ambiguous and unsafe launch arguments', () => {
  assert.throws(
    () => parseHostAcceptanceArguments(['--profile', '0']),
    error => error.code === 'invalid_arguments',
  );
  assert.throws(
    () => parseHostAcceptanceArguments(['--', 'browser-pilot']),
    error => error.code === 'invalid_arguments',
  );
  assert.throws(
    () => parseHostAcceptanceArguments(['--unknown']),
    error => error.code === 'invalid_arguments',
  );
});

test('host acceptance help defines the command-prefix and Profile contract', () => {
  const help = hostAcceptanceHelpText();
  assert.match(help, /command prefix omits "bridge --stdio"/u);
  assert.match(help, /--second-profile/u);
});
