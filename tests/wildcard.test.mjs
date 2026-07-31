import assert from 'node:assert/strict';
import test from 'node:test';
import { wildcardMatch } from '../dist/services.js';

function legacyWaitMatch(value, pattern) {
  if (!pattern.includes('*')) return value.includes(pattern);
  const source = pattern
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(value);
}

test('wildcard matching is case-insensitive and covers the full value', () => {
  const cases = [
    {
      value: 'https://example.test/complete',
      pattern: 'complete',
      legacyWait: true,
      expected: false,
    },
    {
      value: 'https://example.test/api/v1',
      pattern: 'https://example.test/api',
      legacyWait: true,
      expected: false,
    },
    {
      value: 'https://example.test/Complete',
      pattern: 'HTTPS://EXAMPLE.TEST/*',
      legacyWait: false,
      expected: true,
    },
    {
      value: 'https://example.test/complete?source=agent',
      pattern: '*complete*',
      legacyWait: true,
      expected: true,
    },
    {
      value: 'https://example.test/complete?source=agent',
      pattern: '*complete?source=*',
      legacyWait: true,
      expected: true,
    },
    {
      value: 'https://example.test/completexsource=agent',
      pattern: '*complete?source=*',
      legacyWait: false,
      expected: false,
    },
    {
      value: 'https://example.test/a.c',
      pattern: 'https://example.test/a.c',
      legacyWait: true,
      expected: true,
    },
    {
      value: 'https://example.test/abc',
      pattern: 'https://example.test/a.c',
      legacyWait: false,
      expected: false,
    },
    { value: 'anything', pattern: '*', legacyWait: true, expected: true },
    { value: 'anything', pattern: '', legacyWait: true, expected: false },
    { value: '', pattern: '', legacyWait: true, expected: true },
  ];

  for (const entry of cases) {
    assert.equal(
      legacyWaitMatch(entry.value, entry.pattern),
      entry.legacyWait,
      `legacy wait: ${JSON.stringify(entry)}`,
    );
    assert.equal(
      wildcardMatch(entry.value, entry.pattern),
      entry.expected,
      `shared wildcard: ${JSON.stringify(entry)}`,
    );
  }
});

test('wildcard matching handles many stars without regular-expression backtracking', () => {
  assert.equal(wildcardMatch(`${'a'.repeat(2_000)}c`, `${'*a'.repeat(2_000)}*b`), false);
  assert.equal(wildcardMatch('prefix-suffix', '***prefix***suffix***'), true);
});
