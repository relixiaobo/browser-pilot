import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyCanaryResults,
  sanitizeCanaryError,
} from './real-site-canary-reporter.mjs';
import { canaryExitCode } from '../scripts/real-site-canary-policy.mjs';

test('real-site canary outcomes distinguish drift, unavailability, and runner errors', () => {
  assert.equal(classifyCanaryResults([{ outcome: 'passed' }]), 'healthy');
  assert.equal(classifyCanaryResults([
    { outcome: 'passed' },
    { outcome: 'unavailable' },
  ]), 'unavailable');
  assert.equal(classifyCanaryResults([
    { outcome: 'passed' },
    { outcome: 'drift' },
  ]), 'drift');
  assert.equal(classifyCanaryResults([
    { outcome: 'unavailable' },
    { outcome: 'unavailable' },
  ]), 'unavailable');
  assert.equal(classifyCanaryResults([], [{ message: 'runner failed' }]), 'error');
  assert.equal(classifyCanaryResults([]), 'error');
});

test('real-site canary reports keep only a bounded error summary', () => {
  assert.deepEqual(sanitizeCanaryError(new Error('first line\nprivate stack')), {
    message: 'first line',
  });
  assert.equal(sanitizeCanaryError(new Error('x'.repeat(1_000))).message.length, 500);
  assert.equal(sanitizeCanaryError(undefined), undefined);
});

test('real-site canaries are non-blocking by default and strict on demand', () => {
  const report = outcome => ({ schemaVersion: 1, outcome });
  assert.equal(canaryExitCode(report('healthy'), 0, false), 0);
  assert.equal(canaryExitCode(report('drift'), 1, false), 0);
  assert.equal(canaryExitCode(report('unavailable'), 0, false), 0);
  assert.equal(canaryExitCode(report('drift'), 1, true), 1);
  assert.equal(canaryExitCode(report('unavailable'), 0, true), 1);
  assert.equal(canaryExitCode(report('error'), 2, false), 2);
  assert.equal(canaryExitCode(undefined, 0, false), 1);
  assert.equal(canaryExitCode({ schemaVersion: 2, outcome: 'healthy' }, 0, false), 1);
});
