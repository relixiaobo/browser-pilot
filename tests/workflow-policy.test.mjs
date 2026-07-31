import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const [ci, release] = await Promise.all([
  readFile(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'),
  readFile(join(root, '.github', 'workflows', 'release.yml'), 'utf8'),
]);

function workflowJobs(source) {
  const jobsStart = source.indexOf('\njobs:\n');
  assert.notEqual(jobsStart, -1, 'workflow must define jobs');
  const jobsSource = source.slice(jobsStart + 1);
  const matches = [...jobsSource.matchAll(/^  ([a-zA-Z0-9_-]+):\s*$/gm)];
  return new Map(matches.map((match, index) => {
    const end = matches[index + 1]?.index ?? jobsSource.length;
    return [match[1], jobsSource.slice(match.index, end)];
  }));
}

test('CI runs browser gates after validation and preserves failure diagnostics', () => {
  const jobs = workflowJobs(ci);
  const browser = jobs.get('browser');
  assert.ok(browser, 'CI must define a browser job');
  assert.match(browser, /^  browser:\n    needs: validate$/m);
  assert.match(
    browser,
    /npx playwright test --project core --project compat --project network --reporter=dot,html/,
  );
  assert.match(browser, /run: npm run test:browser/);
  assert.match(browser, /if: failure\(\)[\s\S]*uses: actions\/upload-artifact@v4/);
  assert.match(browser, /path: playwright-report\//);
});

test('CI rejects release manifest drift before validation', () => {
  const jobs = workflowJobs(ci);
  const validate = jobs.get('validate');
  assert.ok(validate, 'CI must define a validation job');
  const install = validate.indexOf('run: npm ci');
  const versionCheck = validate.indexOf('run: npm run release:check-version');
  const unit = validate.indexOf('run: npm run test:unit');
  assert.ok(install >= 0, 'validation must install dependencies');
  assert.ok(versionCheck > install, 'version sync must be checked after install');
  assert.ok(unit > versionCheck, 'version sync must be checked before unit tests');
});

test('CI exercises the portable unit and distribution contracts on Windows', () => {
  const jobs = workflowJobs(ci);
  const windows = jobs.get('windows');
  assert.ok(windows, 'CI must define a Windows job');
  assert.match(windows, /^    runs-on: windows-latest$/m);
  assert.match(windows, /uses: actions\/setup-node@v4[\s\S]*node-version: 22\.17\.0/);
  assert.match(windows, /run: npm run test:unit/);
  assert.match(windows, /run: npx tsc --noEmit/);
  assert.match(windows, /run: npm run test:distribution/);
  assert.doesNotMatch(windows, /playwright|test:browser/);
});

test('every workflow job has a timeout and cancellation remains CI-only', () => {
  for (const [workflow, source] of [['CI', ci], ['Release', release]]) {
    const jobs = workflowJobs(source);
    assert.ok(jobs.size > 0, `${workflow} must define at least one job`);
    for (const [name, job] of jobs) {
      assert.match(job, /^    timeout-minutes: \d+$/m, `${workflow} job ${name} needs a timeout`);
    }
  }

  const ciHeader = ci.slice(0, ci.indexOf('\njobs:\n'));
  assert.match(ciHeader, /concurrency:\n  group: ci-\$\{\{ github\.workflow }}-\$\{\{ github\.ref }}\n  cancel-in-progress: true/);
  assert.doesNotMatch(release, /^concurrency:/m);
  assert.doesNotMatch(release, /cancel-in-progress/);
});
