import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import {
  inspectSiteSeedFreshness,
  SiteSeedVerificationError,
  siteSeedFreshnessExitCode,
} from '../scripts/verify-site-seed-freshness.mjs';
import { testTempPrefix } from './helpers/platform.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');

function seedFile(name, updated, body = '- Verified note') {
  return [
    '---',
    `name: ${name}`,
    'domains: ["example.com"]',
    'summary: Verification fixture',
    `updated: ${updated}`,
    '---',
    body,
    '',
  ].join('\n');
}

function sha256(source) {
  return createHash('sha256').update(source).digest('hex');
}

async function fixture(t, entries, policy = { warningAgeDays: 75, maximumAgeDays: 90 }) {
  const root = await mkdtemp(testTempPrefix('bp-site-seed-freshness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sites = join(root, 'plugin', 'skills', 'browser-pilot', 'sites');
  const docs = join(root, 'docs');
  await mkdir(sites, { recursive: true });
  await mkdir(docs, { recursive: true });
  const seeds = [];
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const source = seedFile(entry.name, entry.verifiedOn, entry.body);
    await writeFile(join(sites, `${entry.name}.md`), source, 'utf8');
    seeds.push({
      name: entry.name,
      contentSha256: sha256(source),
      verifiedOn: entry.verifiedOn,
      evidence: `Fixture evidence for ${entry.name}`,
    });
  }
  await writeFile(
    join(docs, 'site-knowledge-seed-verification.json'),
    `${JSON.stringify({ schemaVersion: 1, policy, seeds }, null, 2)}\n`,
    'utf8',
  );
  return root;
}

test('the shipped seed ledger is complete, hash-bound, and fresh today', async () => {
  const report = await inspectSiteSeedFreshness({ today: '2026-08-13' });

  assert.equal(report.outcome, 'fresh');
  assert.deepEqual(report.summary, { total: 7, fresh: 7, warning: 0, expired: 0 });
  assert.ok(report.seeds.every(seed => seed.ageDays === 3));
  assert.equal(siteSeedFreshnessExitCode(report, { enforceFreshness: true }), 0);
});

test('freshness distinguishes warning and release-blocking ages', async t => {
  const root = await fixture(t, [
    { name: 'fresh', verifiedOn: '2026-08-13' },
    { name: 'warning', verifiedOn: '2026-05-30' },
    { name: 'expired', verifiedOn: '2026-05-15' },
  ]);

  const report = await inspectSiteSeedFreshness({ root, today: '2026-08-13' });
  assert.equal(report.outcome, 'expired');
  assert.deepEqual(
    report.seeds.map(seed => [seed.name, seed.ageDays, seed.status]),
    [
      ['expired', 90, 'expired'],
      ['fresh', 0, 'fresh'],
      ['warning', 75, 'warning'],
    ],
  );
  assert.equal(siteSeedFreshnessExitCode(report), 0);
  assert.equal(siteSeedFreshnessExitCode(report, { enforceFreshness: true }), 1);
  assert.equal(siteSeedFreshnessExitCode(report, { failOnWarning: true }), 1);
});

test('a warning remains releasable but fails the scheduled warning gate', async t => {
  const root = await fixture(t, [{ name: 'warning', verifiedOn: '2026-05-30' }]);
  const report = await inspectSiteSeedFreshness({ root, today: '2026-08-13' });

  assert.equal(report.outcome, 'warning');
  assert.equal(siteSeedFreshnessExitCode(report, { enforceFreshness: true }), 0);
  assert.equal(siteSeedFreshnessExitCode(report, { failOnWarning: true }), 1);
});

test('changing a shipped seed invalidates its verification record', async t => {
  const root = await fixture(t, [{ name: 'seed', verifiedOn: '2026-08-10' }]);
  const path = join(root, 'plugin', 'skills', 'browser-pilot', 'sites', 'seed.md');
  await writeFile(path, seedFile('seed', '2026-08-10', '- Unverified edit'), 'utf8');

  await assert.rejects(
    inspectSiteSeedFreshness({ root, today: '2026-08-13' }),
    error => error instanceof SiteSeedVerificationError && /changed after/.test(error.message),
  );
});

test('ledger coverage must exactly match the shipped seed set', async t => {
  const root = await fixture(t, [{ name: 'tracked', verifiedOn: '2026-08-10' }]);
  await writeFile(
    join(root, 'plugin', 'skills', 'browser-pilot', 'sites', 'missing.md'),
    seedFile('missing', '2026-08-10'),
    'utf8',
  );

  await assert.rejects(
    inspectSiteSeedFreshness({ root, today: '2026-08-13' }),
    error => error instanceof SiteSeedVerificationError && /coverage does not match/.test(error.message),
  );
});

test('a seed updated date must equal the verification date', async t => {
  const root = await fixture(t, [{ name: 'seed', verifiedOn: '2026-08-10' }]);
  const ledgerPath = join(root, 'docs', 'site-knowledge-seed-verification.json');
  const source = seedFile('seed', '2026-08-09');
  await writeFile(
    join(root, 'plugin', 'skills', 'browser-pilot', 'sites', 'seed.md'),
    source,
    'utf8',
  );
  await writeFile(ledgerPath, `${JSON.stringify({
    schemaVersion: 1,
    policy: { warningAgeDays: 75, maximumAgeDays: 90 },
    seeds: [{
      name: 'seed',
      contentSha256: sha256(source),
      verifiedOn: '2026-08-10',
      evidence: 'Fixture evidence',
    }],
  }, null, 2)}\n`, 'utf8');

  await assert.rejects(
    inspectSiteSeedFreshness({ root, today: '2026-08-13' }),
    error => error instanceof SiteSeedVerificationError && /does not match ledger/.test(error.message),
  );
});

test('shipped seed bytes keep LF line endings on every platform', async () => {
  const attributes = await readFile(join(repositoryRoot, '.gitattributes'), 'utf8');

  assert.ok(
    attributes
      .split(/\r?\n/u)
      .includes('plugin/skills/browser-pilot/sites/*.md text eol=lf'),
  );
});

test('repository automation applies the structural, scheduled, and release gates', async () => {
  const packageManifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
  const ci = await readFile(join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const release = await readFile(join(repositoryRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  const scheduled = parse(await readFile(
    join(repositoryRoot, '.github', 'workflows', 'site-seed-freshness.yml'),
    'utf8',
  ));

  assert.equal(
    packageManifest.scripts['verify:site-seeds'],
    'node scripts/verify-site-seed-freshness.mjs',
  );
  assert.match(ci, /npm run verify:site-seeds(?:\s|$)/);
  assert.match(release, /npm run verify:site-seeds:release/);
  assert.deepEqual(scheduled.on.schedule, [{ cron: '17 2 * * 1' }]);
  assert.equal(
    scheduled.jobs.verify.steps.at(-1).run,
    'npm run verify:site-seeds:scheduled',
  );
});

test('the public report form requires minimal evidence and explicit privacy consent', async () => {
  const form = parse(await readFile(
    join(repositoryRoot, '.github', 'ISSUE_TEMPLATE', 'stale-site-seed.yml'),
    'utf8',
  ));
  const fields = new Map(form.body.filter(item => item.id).map(item => [item.id, item]));

  for (const id of ['seed', 'claim', 'observation', 'reproduction', 'version']) {
    assert.equal(fields.get(id)?.validations?.required, true, `${id} must be required`);
  }
  const privacy = fields.get('privacy');
  assert.equal(privacy.type, 'checkboxes');
  assert.equal(privacy.attributes.options.length, 2);
  assert.ok(privacy.attributes.options.every(option => option.required === true));
  assert.match(JSON.stringify(form.body), /not uploading my local site-knowledge corpus/i);
  assert.match(JSON.stringify(form.body), /private URLs/i);
});
