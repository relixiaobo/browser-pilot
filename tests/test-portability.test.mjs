import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

test('test fixtures avoid non-portable temp paths, force signals, and file URL paths', async () => {
  const testFiles = (await readdir(join(root, 'tests')))
    .filter(file => file.endsWith('.test.mjs') || file.endsWith('.spec.ts'))
    .filter(file => file !== 'test-portability.test.mjs')
    .map(file => join(root, 'tests', file));
  const files = [
    ...testFiles,
    join(root, 'scripts', 'isolated-chrome-fixture.mjs'),
  ];

  for (const path of files) {
    const source = await readFile(path, 'utf8');
    assert.doesNotMatch(source, /mkdtemp\(\s*['"]\/tmp\//, `${path} creates a literal /tmp path`);
    assert.doesNotMatch(source, /\.kill\(\s*['"]SIGKILL['"]/, `${path} uses SIGKILL directly`);
    assert.doesNotMatch(
      source,
      /process\.kill\([^,\n]+,\s*['"]SIGKILL['"]/,
      `${path} uses SIGKILL directly`,
    );
    assert.doesNotMatch(
      source,
      /new URL\([^\n]+import\.meta\.url\)\.pathname/,
      `${path} uses a non-portable file URL pathname`,
    );
  }
});
