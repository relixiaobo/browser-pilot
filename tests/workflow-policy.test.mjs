import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const [ci, release] = await Promise.all([
  readFile(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'),
  readFile(join(root, '.github', 'workflows', 'release.yml'), 'utf8'),
]).then(sources => sources.map(source => source.replace(/\r\n?/gu, '\n')));

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
  const install = browser.indexOf('run: npm ci');
  const build = browser.indexOf('run: npm run build');
  const playwright = browser.indexOf(
    'npx playwright test --project core --project compat --project network --reporter=dot,html',
  );
  const browserTests = browser.indexOf('run: npm run test:browser');
  assert.ok(install >= 0, 'browser job must install dependencies');
  assert.ok(build > install, 'browser job must build dist after installing dependencies');
  assert.ok(playwright > build, 'Playwright gates must run after dist is built');
  assert.ok(browserTests > playwright, 'browser node tests must run after Playwright gates');
  assert.match(browser, /if: failure\(\)[\s\S]*uses: actions\/upload-artifact@v7/);
  assert.match(browser, /path: playwright-report\//);
});

test('CI rejects release manifest drift before validation', () => {
  const jobs = workflowJobs(ci);
  const validate = jobs.get('validate');
  assert.ok(validate, 'CI must define a validation job');
  const install = validate.indexOf('run: npm ci');
  const skillValidation = validate.indexOf('run: npm run validate:skill');
  const versionCheck = validate.indexOf('run: npm run release:check-version');
  const releaseManifests = validate.indexOf('run: node scripts/verify-release-version.mjs');
  const lint = validate.indexOf('run: npm run lint');
  const unit = validate.indexOf('run: npm run test:unit');
  assert.ok(install >= 0, 'validation must install dependencies');
  assert.ok(skillValidation > install, 'managed skill validation must run after install');
  assert.ok(versionCheck > skillValidation, 'version sync must be checked after skill validation');
  assert.ok(
    releaseManifests > versionCheck,
    'CI must verify release manifests so tag-only drift cannot reach a release build',
  );
  assert.ok(lint > versionCheck, 'lint must run after the version sync check');
  assert.ok(unit > lint, 'lint must run before unit tests');
});

test('CI exercises the portable unit and distribution contracts on Windows', () => {
  const jobs = workflowJobs(ci);
  const windows = jobs.get('windows');
  assert.ok(windows, 'CI must define a Windows job');
  assert.match(windows, /^    runs-on: windows-latest$/m);
  assert.match(windows, /uses: actions\/setup-node@v7[\s\S]*node-version: 22\.17\.0/);
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
  const releaseHeader = release.slice(0, release.indexOf('\njobs:\n'));
  assert.match(releaseHeader, /concurrency:\n  group: release-\$\{\{ github\.ref_name }}\n  cancel-in-progress: false/);
});

test('release publication is one tag-gated draft to npm to public state machine', () => {
  const jobs = workflowJobs(release);
  const build = jobs.get('build');
  const publish = jobs.get('publish');
  assert.ok(build, 'Release must define a build job');
  assert.ok(publish, 'Release must define a publish job');
  assert.equal(jobs.has('publish-npm'), false);
  assert.match(publish, /^    if: startsWith\(github\.ref, 'refs\/tags\/v'\)$/m);
  assert.match(publish, /^    needs: build$/m);
  assert.match(publish, /permissions:[\s\S]*contents: write[\s\S]*id-token: write/);
  assert.match(
    publish,
    /uses: actions\/checkout@v7\n        with:\n          fetch-depth: 0/,
    'release publication must fetch enough history to fast-forward skill-stable',
  );
  const skillValidation = publish.indexOf('npm run validate:skill');
  const plugin = publish.indexOf('npm run package:agent-plugin');
  const index = publish.indexOf('npm run package:release-index');
  const stateMachine = publish.indexOf('node scripts/release-publish.mjs --assets release-assets');
  const stableSkillBranch = publish.indexOf(
    'git push origin "${GITHUB_SHA}:refs/heads/skill-stable"',
  );
  assert.ok(skillValidation >= 0 && plugin > skillValidation && index > plugin && stateMachine > index);
  assert.match(
    publish,
    /if: \$\{\{ !contains\(github\.ref_name, '-'\) }}\n        run: git push origin "\$\{GITHUB_SHA}:refs\/heads\/skill-stable"/,
    'a prerelease must not advance the stable managed skill branch',
  );
  assert.ok(
    stableSkillBranch > stateMachine,
    'managed skill branch must advance only after release publication succeeds',
  );
  assert.doesNotMatch(publish.slice(stableSkillBranch), /(?:--force|-f\b)/);
  assert.doesNotMatch(publish, /npm publish/);
  assert.doesNotMatch(build, /-print -quit/);
  assert.match(build, /for ARCHIVE in "\$\{ARCHIVES\[@\]\}"/);
  const standalonePackage = build.indexOf('run: npm run package:standalone');
  const nativeInstaller = build.indexOf('run: npm run verify:native-installer');
  assert.ok(
    nativeInstaller > standalonePackage,
    'release platforms must verify the managed installer against their packaged native archive',
  );
});
