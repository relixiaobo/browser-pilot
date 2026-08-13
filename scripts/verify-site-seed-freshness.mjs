#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SITE_SEED_LEDGER = 'docs/site-knowledge-seed-verification.json';
export const SITE_SEED_DIRECTORY = 'plugin/skills/browser-pilot/sites';
export const SITE_SEED_WARNING_AGE_DAYS = 75;
export const SITE_SEED_MAXIMUM_AGE_DAYS = 90;

export class SiteSeedVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SiteSeedVerificationError';
  }
}

function fail(message) {
  throw new SiteSeedVerificationError(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function dateMilliseconds(value, label) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    fail(`${label} must be a YYYY-MM-DD date`);
  }
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 10) !== value
  ) {
    fail(`${label} is not a real calendar date: ${value}`);
  }
  return milliseconds;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) fail(`${label} must be a positive integer`);
  return value;
}

function seedUpdatedDate(source, name) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source)?.[1];
  if (!frontmatter) fail(`${name}.md has no frontmatter block`);
  const matches = [...frontmatter.matchAll(/^updated:\s*(\d{4}-\d{2}-\d{2})\s*$/gmu)];
  if (matches.length !== 1) fail(`${name}.md must carry one canonical updated date`);
  return matches[0][1];
}

function contentSha256(source) {
  return createHash('sha256').update(source).digest('hex');
}

function overallOutcome(seeds) {
  if (seeds.some(seed => seed.status === 'expired')) return 'expired';
  if (seeds.some(seed => seed.status === 'warning')) return 'warning';
  return 'fresh';
}

export function siteSeedFreshnessExitCode(
  report,
  { enforceFreshness = false, failOnWarning = false } = {},
) {
  if (failOnWarning && report.outcome !== 'fresh') return 1;
  if (enforceFreshness && report.outcome === 'expired') return 1;
  return 0;
}

export async function inspectSiteSeedFreshness({
  root = scriptRoot,
  today = new Date().toISOString().slice(0, 10),
} = {}) {
  const todayMs = dateMilliseconds(today, 'today');
  const ledgerPath = resolve(root, SITE_SEED_LEDGER);
  const seedDirectory = resolve(root, SITE_SEED_DIRECTORY);

  let ledger;
  try {
    ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  } catch (error) {
    fail(`cannot read ${SITE_SEED_LEDGER}: ${error.message}`);
  }
  if (!isObject(ledger) || ledger.schemaVersion !== 1) {
    fail(`${SITE_SEED_LEDGER} must use schemaVersion 1`);
  }
  if (!isObject(ledger.policy)) fail('ledger policy must be an object');
  const warningAgeDays = positiveInteger(
    ledger.policy.warningAgeDays,
    'policy.warningAgeDays',
  );
  const maximumAgeDays = positiveInteger(
    ledger.policy.maximumAgeDays,
    'policy.maximumAgeDays',
  );
  if (warningAgeDays >= maximumAgeDays) {
    fail('policy.warningAgeDays must be lower than policy.maximumAgeDays');
  }
  if (
    warningAgeDays !== SITE_SEED_WARNING_AGE_DAYS ||
    maximumAgeDays !== SITE_SEED_MAXIMUM_AGE_DAYS
  ) {
    fail(
      `ledger policy must remain ${SITE_SEED_WARNING_AGE_DAYS}/${SITE_SEED_MAXIMUM_AGE_DAYS} ` +
      'days unless the checker contract changes with it',
    );
  }
  if (!Array.isArray(ledger.seeds) || ledger.seeds.length === 0) {
    fail('ledger seeds must be a non-empty array');
  }

  const entries = await readdir(seedDirectory, { withFileTypes: true }).catch(error => {
    fail(`cannot read ${SITE_SEED_DIRECTORY}: ${error.message}`);
  });
  const unexpected = entries.filter(entry => !entry.isFile() || !entry.name.endsWith('.md'));
  if (unexpected.length > 0) {
    fail(
      `${SITE_SEED_DIRECTORY} contains non-seed entries: ` +
      unexpected.map(entry => entry.name).sort().join(','),
    );
  }
  const seedFiles = entries
    .sort((left, right) => left.name.localeCompare(right.name));
  const fileNames = seedFiles.map(entry => entry.name.slice(0, -3));
  const ledgerNames = ledger.seeds.map(seed => seed?.name);
  if (ledgerNames.some(name => typeof name !== 'string' || !NAME_PATTERN.test(name))) {
    fail('every ledger seed name must be lowercase letters, digits, or hyphens');
  }
  if (new Set(ledgerNames).size !== ledgerNames.length) fail('ledger seed names must be unique');
  const sortedLedgerNames = [...ledgerNames].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(ledgerNames) !== JSON.stringify(sortedLedgerNames)) {
    fail('ledger seeds must be sorted by name');
  }
  if (JSON.stringify(ledgerNames) !== JSON.stringify(fileNames)) {
    fail(
      `ledger coverage does not match shipped seeds: ledger=${ledgerNames.join(',')}; ` +
      `files=${fileNames.join(',')}`,
    );
  }

  const seeds = [];
  for (const seed of ledger.seeds) {
    if (!isObject(seed)) fail('every ledger seed must be an object');
    if (typeof seed.contentSha256 !== 'string' || !SHA256_PATTERN.test(seed.contentSha256)) {
      fail(`${seed.name}.contentSha256 must be a lowercase SHA-256 digest`);
    }
    if (typeof seed.evidence !== 'string' || seed.evidence.trim() === '') {
      fail(`${seed.name}.evidence must identify the verification record`);
    }
    if (seed.evidence.length > 512) fail(`${seed.name}.evidence exceeds 512 characters`);

    const verifiedMs = dateMilliseconds(seed.verifiedOn, `${seed.name}.verifiedOn`);
    if (verifiedMs > todayMs) fail(`${seed.name}.verifiedOn is in the future`);
    const source = await readFile(join(seedDirectory, `${seed.name}.md`), 'utf8');
    const actualSha256 = contentSha256(source);
    if (actualSha256 !== seed.contentSha256) {
      fail(
        `${seed.name}.md changed after its verification record; expected ` +
        `${seed.contentSha256}, received ${actualSha256}`,
      );
    }
    const updated = seedUpdatedDate(source, seed.name);
    if (updated !== seed.verifiedOn) {
      fail(
        `${seed.name}.md updated date ${updated} does not match ledger verification ` +
        `date ${seed.verifiedOn}`,
      );
    }

    const ageDays = Math.floor((todayMs - verifiedMs) / DAY_MS);
    const status = ageDays >= maximumAgeDays
      ? 'expired'
      : ageDays >= warningAgeDays ? 'warning' : 'fresh';
    seeds.push({
      name: seed.name,
      verifiedOn: seed.verifiedOn,
      evidence: seed.evidence,
      contentSha256: seed.contentSha256,
      ageDays,
      status,
    });
  }

  const outcome = overallOutcome(seeds);
  return {
    schemaVersion: 1,
    today,
    outcome,
    policy: { warningAgeDays, maximumAgeDays },
    summary: {
      total: seeds.length,
      fresh: seeds.filter(seed => seed.status === 'fresh').length,
      warning: seeds.filter(seed => seed.status === 'warning').length,
      expired: seeds.filter(seed => seed.status === 'expired').length,
    },
    seeds,
  };
}

function parseArguments(args) {
  const options = { enforceFreshness: false, failOnWarning: false, today: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--enforce-freshness') {
      options.enforceFreshness = true;
    } else if (argument === '--fail-on-warning') {
      options.failOnWarning = true;
    } else if (argument === '--today') {
      options.today = args[index + 1];
      index += 1;
      if (!options.today) fail('--today requires a YYYY-MM-DD value');
    } else if (argument.startsWith('--today=')) {
      options.today = argument.slice('--today='.length);
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function reportLine(report) {
  const { summary, policy } = report;
  return (
    `[browser-pilot site seeds] ${report.outcome}: ${summary.fresh} fresh, ` +
    `${summary.warning} warning, ${summary.expired} expired ` +
    `(warn ${policy.warningAgeDays}d, block ${policy.maximumAgeDays}d; ` +
    `today ${report.today})`
  );
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = await inspectSiteSeedFreshness({
      ...(options.today ? { today: options.today } : {}),
    });
    process.stdout.write(`${reportLine(report)}\n`);
    for (const seed of report.seeds.filter(entry => entry.status !== 'fresh')) {
      process.stdout.write(
        `[browser-pilot site seeds] ${seed.name}: ${seed.status}, ` +
        `verified ${seed.verifiedOn} (${seed.ageDays}d old)\n`,
      );
    }
    process.exitCode = siteSeedFreshnessExitCode(report, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[browser-pilot site seeds] invalid: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
