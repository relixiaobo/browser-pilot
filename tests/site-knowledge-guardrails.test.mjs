import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { SiteKnowledgeStore } from '../dist/services.js';
import { testTempPrefix } from './helpers/platform.mjs';

/**
 * The site knowledge corpus is user data, not cache. It is the only directory
 * Browser Pilot reads that the user and their Agents author themselves, and
 * losing it loses work that cannot be recovered from a reinstall. These tests
 * pin the two properties that keep it safe: nothing in the product writes to
 * it, and installing or upgrading never reaches the state directory at all.
 */

const root = resolve(import.meta.dirname, '..');

const READ_ONLY_FS_OPERATIONS = new Set(['readFile', 'readdir', 'stat', 'lstat', 'realpath', 'access']);

function fsImports(source) {
  const names = [];
  const pattern = /import\s*\{([^}]*)\}\s*from\s*'node:fs(?:\/promises)?'/g;
  for (const match of source.matchAll(pattern)) {
    for (const entry of match[1].split(',')) {
      const name = entry.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

test('the site knowledge store is read-only by construction', async () => {
  const source = await readFile(join(root, 'src/services/site-knowledge-store.ts'), 'utf8');
  const imported = fsImports(source);

  assert.ok(imported.length > 0, 'the store must read the corpus from disk');
  for (const name of imported) {
    assert.ok(
      READ_ONLY_FS_OPERATIONS.has(name),
      `site-knowledge-store.ts imports ${name}; the corpus must never be written by the product`,
    );
  }
});

test('site knowledge delivery never touches the file system', async () => {
  const source = await readFile(join(root, 'src/services/site-knowledge-delivery.ts'), 'utf8');
  assert.deepEqual(fsImports(source), []);
  assert.equal(/from 'node:fs/.test(source), false);
});

test('only reporting and reading consume the resolved sites directory', async () => {
  const consumers = [];
  const directories = ['src', 'src/cli', 'src/cli/commands', 'src/services', 'src/protocol'];
  for (const directory of directories) {
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const relative = `${directory}/${entry.name}`;
      if (relative === 'src/paths.ts') continue;
      const source = await readFile(join(root, relative), 'utf8');
      if (source.includes('SITES_DIR')) consumers.push(relative);
    }
  }

  // Adding a consumer is fine; adding one that writes is not. Update this list
  // deliberately, with the same read-only scrutiny applied above.
  assert.deepEqual(consumers.sort(), [
    'src/cli/commands/connection.ts',
    'src/services/site-knowledge-store.ts',
  ]);
});

test('the native installers never reach into the user state directory', async () => {
  for (const script of ['install-native.sh', 'install-native.ps1']) {
    const source = await readFile(
      join(root, 'plugin/skills/browser-pilot/scripts', script),
      'utf8',
    );
    for (const forbidden of ['.browser-pilot', 'BROWSER_PILOT_HOME', 'sites']) {
      assert.equal(
        source.includes(forbidden),
        false,
        `${script} references ${forbidden}; installing and upgrading must never reach user state`,
      );
    }
  }
});

test('scanning an absent corpus does not create it', async t => {
  const parent = await mkdtemp(testTempPrefix('browser-pilot-sites-guard-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, 'sites');

  const scan = await new SiteKnowledgeStore({ directory }).scan();
  assert.deepEqual(scan.records, []);
  // Seeding is directory-level copy-once and is driven by the Agent. If the
  // Broker created this directory, the corpus would never be seeded at all.
  await assert.rejects(stat(directory), error => error.code === 'ENOENT');
});

test('reading a corpus leaves every file byte-for-byte untouched', async t => {
  const directory = await mkdtemp(testTempPrefix('browser-pilot-sites-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const files = {
    'kept.md': [
      '---',
      'name: kept',
      'domains: ["example.test"]',
      'summary: Untouched by a scan',
      '---',
      '- a note',
      '',
    ].join('\n'),
    'broken.md': '# not a site file\n',
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(directory, name), content, 'utf8');
  }
  const before = await Promise.all(
    Object.keys(files).map(async name => [name, (await stat(join(directory, name))).mtimeMs]),
  );

  const store = new SiteKnowledgeStore({ directory });
  await store.scan();
  await store.match('https://example.test/page');

  assert.deepEqual((await readdir(directory)).sort(), ['broken.md', 'kept.md']);
  for (const [name, content] of Object.entries(files)) {
    assert.equal(await readFile(join(directory, name), 'utf8'), content);
  }
  for (const [name, mtimeMs] of before) {
    assert.equal(
      (await stat(join(directory, name))).mtimeMs,
      mtimeMs,
      `${name} was rewritten; an unusable file must be reported, never repaired in place`,
    );
  }
});
