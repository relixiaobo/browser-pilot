import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { SiteKnowledgeStore } from '../dist/services.js';
import { repairProbe, writeProbe } from '../scripts/site-knowledge-conformance.mjs';
import { testTempPrefix } from './helpers/platform.mjs';

/**
 * These tests validate the measuring instrument, not an Agent. Each one scripts
 * a behaviour an Agent could exhibit and asserts the probe classifies it
 * correctly, so S7's rates mean something before a single model token is spent
 * producing them.
 */

const root = resolve(import.meta.dirname, '..');
const REPAIR_FIXTURE = join(root, 'tests/fixtures/site-knowledge-probes/repair/the-internet.md');
const READ_FIXTURE_ROOT = join(root, 'tests/fixtures/site-knowledge-probes/read');
const READ_FIXTURE = join(READ_FIXTURE_ROOT, 'archive-lookup.md');
const READ_SITE_ROOT = join(READ_FIXTURE_ROOT, 'site');
const WRITE_SITE_ROOT = join(root, 'tests/fixtures/site-knowledge-probes/write/site');
const FALSE_CLAIM = 'the result text appears immediately once Start is';
const SITE_URL = 'https://the-internet.herokuapp.com/dynamic_loading/1';

async function seededCorpus(t) {
  const directory = await mkdtemp(testTempPrefix('bp-probe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await copyFile(REPAIR_FIXTURE, join(directory, 'the-internet.md'));
  return directory;
}

async function emptyCorpus(t) {
  const directory = await mkdtemp(testTempPrefix('bp-probe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const repair = directory => repairProbe({ dir: directory, name: 'the-internet', claim: FALSE_CLAIM });
const write = directory => writeProbe({ dir: directory, url: SITE_URL });

test('the seeded fixture really does carry the false claim the probe looks for', async t => {
  const directory = await seededCorpus(t);
  const content = await readFile(join(directory, 'the-internet.md'), 'utf8');
  assert.ok(
    content.includes(FALSE_CLAIM),
    'the probe would report every run as corrected if the claim string drifted from the fixture',
  );
});

test('the read-treatment fixture is valid and matches a loopback URL with a port', async t => {
  const directory = await emptyCorpus(t);
  await copyFile(READ_FIXTURE, join(directory, 'archive-lookup.md'));

  const result = await new SiteKnowledgeStore({ directory }).match('http://127.0.0.1:43125/');
  assert.deepEqual(result.invalid, []);
  assert.deepEqual(result.matches.map(match => match.record.name), ['archive-lookup']);
  assert.match(result.matches[0].record.body, /\/_archive\/v2\/items\/<record-id>\/release-label/);
});

test('the read-control page leaks neither the hidden route nor its answer', async () => {
  const index = await readFile(join(READ_SITE_ROOT, 'index.html'), 'utf8');
  const record = await readFile(
    join(READ_SITE_ROOT, '_archive/v2/items/7319/release-label/index.html'),
    'utf8',
  );

  assert.doesNotMatch(index, /_archive|cobalt-lantern|release-label/);
  assert.match(record, /data-codename>cobalt-lantern/);
});

test('the write fixture requires a failed standard dispatch before recovery', async () => {
  const fixture = await readFile(join(WRITE_SITE_ROOT, 'index.html'), 'utf8');

  assert.doesNotMatch(
    fixture,
    /ember-417/,
    'the exact receipt must be produced from live state rather than leaked in source',
  );
  assert.match(fixture, /if \(!legacyTransport\.checked\)/);
  assert.match(fixture, /document\.body\.dataset\.trapSeen = 'true'/);
  assert.match(fixture, /document\.body\.dataset\.recovered = String\(trapSeen\)/);
  assert.doesNotMatch(
    fixture,
    /Open Delivery options|enable Legacy transport|and retry/i,
    'the failure must not reveal the recovery steps the probe asks the Agent to discover',
  );
  assert.ok(
    fixture.indexOf("dataset.trapSeen = 'true'")
      < fixture.indexOf("dataset.recovered = String(trapSeen)"),
    'recovery evidence must be downstream of the trap',
  );
});

test('an Agent that leaves the note alone scores as worked around', async t => {
  const directory = await seededCorpus(t);
  assert.equal((await repair(directory)).outcome, 'untouched');
});

test('an Agent that corrects the false line scores as corrected', async t => {
  const directory = await seededCorpus(t);
  const path = join(directory, 'the-internet.md');
  const before = await readFile(path, 'utf8');
  await writeFile(path, before.replace(
    /- On the dynamic loading pages[\s\S]*?page at all\./,
    '- On the dynamic loading pages the result text appears only after a delay of several\n  seconds; an empty result means the load has not finished.',
  ));

  const result = await repair(directory);
  assert.equal(result.outcome, 'corrected');
});

test('an Agent that deletes the file is distinguished from one that repairs it', async t => {
  const directory = await seededCorpus(t);
  await rm(join(directory, 'the-internet.md'));
  assert.equal((await repair(directory)).outcome, 'deleted');
});

test('an edit that breaks the frontmatter is not scored as a repair', async t => {
  const directory = await seededCorpus(t);
  // Rewriting the body while dropping the header is a plausible Agent mistake,
  // and it silently removes the file from delivery — worse than leaving it.
  await writeFile(join(directory, 'the-internet.md'), '- the result text appears after a delay\n');

  const result = await repair(directory);
  assert.equal(result.outcome, 'invalid');
  assert.match(result.reason, /frontmatter/i);
});

test('renaming the site out of its own file is not scored as a repair', async t => {
  const directory = await seededCorpus(t);
  const path = join(directory, 'the-internet.md');
  const before = await readFile(path, 'utf8');
  await writeFile(path, before.replace('name: the-internet', 'name: renamed'));

  assert.equal((await repair(directory)).outcome, 'invalid');
});

test('an Agent that writes nothing scores as none', async t => {
  assert.equal((await write(await emptyCorpus(t))).outcome, 'none');
});

test('an Agent that writes a usable note scores as written', async t => {
  const directory = await emptyCorpus(t);
  await writeFile(join(directory, 'the-internet.md'), [
    '---',
    'name: the-internet',
    'domains: ["the-internet.herokuapp.com"]',
    'summary: Dynamic loading pages reveal their result only after a delay',
    'updated: 2026-08-10',
    '---',
    '- The result text on /dynamic_loading/1 appears several seconds after Start is',
    '  clicked; an empty read means the load is still running.',
    '',
  ].join('\n'), 'utf8');

  const result = await write(directory);
  assert.equal(result.outcome, 'written');
  assert.deepEqual(result.matched, ['the-internet']);
  assert.deepEqual(result.lines, [2], 'body size is reported per matched record');
});

test('a note addressed to the wrong host does not count as knowledge', async t => {
  const directory = await emptyCorpus(t);
  await writeFile(join(directory, 'elsewhere.md'), [
    '---',
    'name: elsewhere',
    'domains: ["example.invalid"]',
    'summary: Written against the wrong host',
    '---',
    '- a note',
    '',
  ].join('\n'), 'utf8');

  const result = await write(directory);
  assert.equal(result.outcome, 'unmatched');
  assert.deepEqual(result.files, ['elsewhere.md']);
});

test('a note the store rejects does not count as knowledge', async t => {
  const directory = await emptyCorpus(t);
  await writeFile(join(directory, 'the-internet.md'), '- just some prose, no header\n', 'utf8');

  const result = await write(directory);
  assert.equal(result.outcome, 'invalid');
  assert.match(result.reason, /frontmatter/i);
});

test('a missing corpus directory is reported, not crashed on', async t => {
  const parent = await mkdtemp(testTempPrefix('bp-probe-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  assert.equal((await write(join(parent, 'absent'))).outcome, 'none');
});

test('the repair probe refuses to run without the arguments it scores on', async () => {
  const directory = await mkdir(join(await mkdtemp(testTempPrefix('bp-probe-')), 'x'), { recursive: true });
  await assert.rejects(() => repairProbe({ dir: directory, name: 'the-internet' }), /Usage/);
  await assert.rejects(() => writeProbe({ dir: directory }), /Usage/);
});
