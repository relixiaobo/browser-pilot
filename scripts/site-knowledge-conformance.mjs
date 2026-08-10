#!/usr/bin/env node
/**
 * Scores whether an Agent followed the site knowledge doctrine.
 *
 * The doctrine in SKILL.md is the largest body of claims in this design that
 * no experiment has touched: that Agents read a delivered entry before acting,
 * repair a note that observation contradicts, and write one after escaping a
 * trap. Measuring that needs a real model in the loop, which lives in caliper.
 * What lives here is the definition of conformance itself, so the verdict comes
 * from the same store the product uses rather than from a grep the harness
 * invented.
 *
 * Each probe prints one JSON line and exits 0; a harness asserts on `outcome`.
 * Exit codes are reserved for the script being unusable, so that a harness can
 * tell "the Agent did not comply" apart from "the probe did not run".
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SiteKnowledgeStore } from '../dist/services.js';

const USAGE = `Usage:
  site-knowledge-conformance.mjs --probe repair --dir <sitesDir> --name <site> --claim <phrase>
  site-knowledge-conformance.mjs --probe write  --dir <sitesDir> --url <url>`;

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith('--') || value === undefined) throw new Error(USAGE);
    options[flag.slice(2)] = value;
  }
  return options;
}

/**
 * Repair probe: a fixture seeded a note that is false for the page. Did the
 * Agent correct it, work around it, or delete the file outright? All three are
 * distinguishable from the corpus alone, which is why this probe needs no
 * judge.
 */
async function repairProbe({ dir, name, claim }) {
  if (!name || !claim) throw new Error(USAGE);
  const path = join(dir, `${name}.md`);

  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if ((error).code === 'ENOENT') {
      return { outcome: 'deleted', reason: 'The seeded file is gone' };
    }
    throw error;
  }

  const { records, invalid } = await new SiteKnowledgeStore({ directory: dir }).scan();
  const rejected = invalid.find(entry => entry.path === path);
  if (rejected) {
    // An edit that breaks the frontmatter is not a repair: the file stops being
    // delivered at all, so the next Agent is worse off than before.
    return { outcome: 'invalid', reason: rejected.reason };
  }
  if (!records.some(record => record.name === name)) {
    return { outcome: 'invalid', reason: 'File no longer parses as the named site' };
  }

  return content.includes(claim)
    ? { outcome: 'untouched', reason: 'The false claim is still present verbatim' }
    : { outcome: 'corrected', reason: 'The false claim is gone' };
}

/**
 * Write probe: the corpus started empty and the task contained a trap. A file
 * only counts when the store accepts it and its patterns match the host the
 * Agent was working on — an unparseable or misaddressed note would never be
 * delivered to anyone, so it is not knowledge.
 */
async function writeProbe({ dir, url }) {
  if (!url) throw new Error(USAGE);

  let names;
  try {
    names = (await readdir(dir)).filter(entry => entry.endsWith('.md'));
  } catch (error) {
    if ((error).code !== 'ENOENT') throw error;
    names = [];
  }
  if (names.length === 0) return { outcome: 'none', reason: 'The corpus is still empty' };

  const store = new SiteKnowledgeStore({ directory: dir });
  const { matches, invalid } = await store.match(url);
  if (matches.length > 0) {
    return {
      outcome: 'written',
      matched: matches.map(match => match.record.name),
      lines: matches.map(match => match.record.body.split('\n').filter(Boolean).length),
    };
  }

  return invalid.length > 0
    ? { outcome: 'invalid', reason: invalid[0].reason }
    : { outcome: 'unmatched', reason: `Files exist but none match ${url}`, files: names };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.dir || !options.probe) throw new Error(USAGE);

  const result = options.probe === 'repair'
    ? await repairProbe(options)
    : options.probe === 'write'
      ? await writeProbe(options)
      : undefined;
  if (!result) throw new Error(`Unknown probe: ${options.probe}\n${USAGE}`);

  process.stdout.write(`${JSON.stringify({ probe: options.probe, ...result })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  });
}

export { repairProbe, writeProbe };
