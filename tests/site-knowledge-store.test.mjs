import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SiteKnowledgeStore, matchesSiteDomain } from '../dist/services.js';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'browser-pilot-sites-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'sites');
  await mkdir(directory, { recursive: true });
  return { root, directory, store: new SiteKnowledgeStore({ directory, ...options }) };
}

function siteFile({ name, domains, summary = 'A one line summary', updated, body = '- A note' }) {
  const list = domains.map(pattern => JSON.stringify(pattern)).join(', ');
  const lines = [
    '---',
    `name: ${name}`,
    `domains: [${list}]`,
    `summary: ${summary}`,
    ...(updated ? [`updated: ${updated}`] : []),
    '---',
    body,
    '',
  ];
  return lines.join('\n');
}

async function write(directory, fileName, content) {
  await writeFile(join(directory, fileName), content, 'utf8');
}

test('a bare host pattern matches the host itself and any subdomain on a dot boundary', () => {
  assert.equal(matchesSiteDomain('https://github.com/a/b', 'github.com'), true);
  assert.equal(matchesSiteDomain('https://gist.github.com/a', 'github.com'), true);
  assert.equal(matchesSiteDomain('https://a.b.github.com/', 'github.com'), true);
  // The dot boundary is what prevents a lookalike domain from matching.
  assert.equal(matchesSiteDomain('https://notgithub.com/a', 'github.com'), false);
  assert.equal(matchesSiteDomain('https://github.com.evil.test/a', 'github.com'), false);
});

test('www is stripped from both the hostname and the pattern', () => {
  assert.equal(matchesSiteDomain('https://www.derstandard.at/x', 'derstandard.at'), true);
  assert.equal(matchesSiteDomain('https://derstandard.at/x', 'www.derstandard.at'), true);
  assert.equal(matchesSiteDomain('https://www.derstandard.at/x', 'www.derstandard.at'), true);
});

test('host matching is case-insensitive and tolerates a trailing dot', () => {
  assert.equal(matchesSiteDomain('https://GitHub.COM/a', 'github.com'), true);
  assert.equal(matchesSiteDomain('https://github.com/a', 'GITHUB.COM'), true);
  assert.equal(matchesSiteDomain('https://github.com./a', 'github.com'), true);
});

test('host wildcards match subdomains without matching the bare domain implicitly', () => {
  assert.equal(matchesSiteDomain('https://app.example.com/x', '*.example.com'), true);
  assert.equal(matchesSiteDomain('https://a.b.example.com/x', '*.example.com'), true);
  assert.equal(matchesSiteDomain('https://google.de/search?q=1', 'google.*'), true);
  assert.equal(matchesSiteDomain('https://example.org/x', '*.example.com'), false);
});

test('a path pattern is matched against the pathname, and stars span slashes', () => {
  const url = 'https://github.com/vercel/next.js/issues';
  assert.equal(matchesSiteDomain(url, 'github.com/*/*/issues*'), true);
  assert.equal(matchesSiteDomain(url, 'github.com/*/issues'), true, 'a star spans slashes by design');
  assert.equal(matchesSiteDomain(url, 'github.com/*/*/pulls*'), false);
  assert.equal(matchesSiteDomain('https://github.com/vercel', 'github.com/*/*/issues*'), false);
});

test('a host-only pattern matches any path, and a bare slash is equivalent', () => {
  assert.equal(matchesSiteDomain('https://github.com/deep/path?q=1', 'github.com'), true);
  assert.equal(matchesSiteDomain('https://github.com/deep/path', 'github.com/'), true);
});

test('the query string never participates in matching', () => {
  assert.equal(matchesSiteDomain('https://github.com/a/b/issues?q=is:open', 'github.com/*/*/issues'), true);
  assert.equal(matchesSiteDomain('https://github.com/a/b/issues?q=is:open', 'github.com/*q=is*'), false);
});

test('unusable urls and empty patterns never match', () => {
  assert.equal(matchesSiteDomain('not a url', 'github.com'), false);
  assert.equal(matchesSiteDomain('file:///tmp/page.html', 'github.com'), false);
  assert.equal(matchesSiteDomain('https://github.com/a', ''), false);
  assert.equal(matchesSiteDomain('https://github.com/a', '   '), false);
  assert.equal(matchesSiteDomain('https://github.com/a', '/issues'), false);
});

test('a missing directory yields an empty scan rather than an error', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-pilot-sites-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SiteKnowledgeStore({ directory: join(root, 'absent') });

  const scan = await store.scan();
  assert.deepEqual(scan.records, []);
  assert.deepEqual(scan.invalid, []);

  const matched = await store.match('https://github.com/a/b');
  assert.deepEqual(matched.matches, []);
});

test('a valid file is parsed into a record carrying its body and mtime', async (t) => {
  const { directory, store } = await fixture(t);
  await write(directory, 'github-issues.md', siteFile({
    name: 'github-issues',
    domains: ['github.com/*/*/issues*'],
    summary: 'Search, paginate, and extract GitHub issue lists',
    updated: '2026-08-07',
    body: '- Filter via URL query; the dropdown occludes the list\n- Anonymous sessions hide the assignee control',
  }));

  const { records, invalid } = await store.scan();
  assert.deepEqual(invalid, []);
  assert.equal(records.length, 1);

  const [record] = records;
  assert.equal(record.name, 'github-issues');
  assert.deepEqual(record.domains, ['github.com/*/*/issues*']);
  assert.equal(record.summary, 'Search, paginate, and extract GitHub issue lists');
  assert.equal(record.updated, '2026-08-07');
  assert.match(record.body, /^- Filter via URL query/);
  assert.match(record.body, /assignee control$/);
  assert.equal(record.path, join(directory, 'github-issues.md'));
  assert.ok(record.mtimeMs > 0);
});

test('domains accept a block sequence as well as a flow sequence', async (t) => {
  const { directory, store } = await fixture(t);
  await write(directory, 'blocks.md', [
    '---',
    'name: blocks',
    'domains:',
    '  - "example.com"',
    "  - other.test/path/*",
    'summary: Block sequence form',
    '---',
    '- note',
    '',
  ].join('\n'));

  const { records, invalid } = await store.scan();
  assert.deepEqual(invalid, []);
  assert.deepEqual(records[0].domains, ['example.com', 'other.test/path/*']);
});

test('frontmatter tolerates crlf, a bom, comments, and quoted scalars', async (t) => {
  const { directory, store } = await fixture(t);
  const content = [
    '---',
    '# a comment line',
    'name: "quoted"',
    "domains: ['example.com']",
    'summary: "Quoted summary"',
    '---',
    'body line',
    '',
  ].join('\r\n');
  await write(directory, 'quoted.md', `\uFEFF${content}`);

  const { records, invalid } = await store.scan();
  assert.deepEqual(invalid, []);
  assert.equal(records[0].name, 'quoted');
  assert.equal(records[0].summary, 'Quoted summary');
  assert.deepEqual(records[0].domains, ['example.com']);
  assert.equal(records[0].body, 'body line');
});

test('unusable files are excluded and reported, never dropped silently', async (t) => {
  const { directory, store } = await fixture(t);
  await write(directory, 'no-frontmatter.md', '# Just a heading\n');
  await write(directory, 'unterminated.md', '---\nname: unterminated\n');
  await write(directory, 'no-domains.md', '---\nname: no-domains\nsummary: x\n---\nbody\n');
  await write(directory, 'no-summary.md', '---\nname: no-summary\ndomains: ["a.test"]\n---\nbody\n');
  await write(directory, 'mismatched.md', '---\nname: other\ndomains: ["a.test"]\nsummary: x\n---\nbody\n');
  await write(directory, 'ignored.txt', 'not a site file');
  await write(directory, 'valid.md', siteFile({ name: 'valid', domains: ['a.test'] }));

  const { records, invalid } = await store.scan();
  assert.deepEqual(records.map(record => record.name), ['valid']);

  const reasons = new Map(invalid.map(entry => [entry.path, entry.reason]));
  assert.equal(reasons.size, 5, 'every unusable .md file is reported once');
  assert.match(reasons.get(join(directory, 'no-frontmatter.md')), /frontmatter block/);
  assert.match(reasons.get(join(directory, 'unterminated.md')), /frontmatter block/);
  assert.match(reasons.get(join(directory, 'no-domains.md')), /domains/);
  assert.match(reasons.get(join(directory, 'no-summary.md')), /summary/);
  assert.match(reasons.get(join(directory, 'mismatched.md')), /does not match the file name/);
});

test('a non-regular entry is reported instead of being read', async (t) => {
  const { directory, store } = await fixture(t);
  await write(directory, 'real.md', siteFile({ name: 'real', domains: ['a.test'] }));
  await mkdir(join(directory, 'a-directory.md'));
  await symlink(join(directory, 'real.md'), join(directory, 'link.md'));

  const { records, invalid } = await store.scan();
  assert.deepEqual(records.map(record => record.name), ['real']);
  const reported = invalid.map(entry => entry.reason);
  assert.equal(reported.length, 2);
  assert.ok(reported.every(reason => /Not a regular file/.test(reason)));
});

test('oversized files are refused with a stated limit', async (t) => {
  const { directory, store } = await fixture(t, { maxFileBytes: 128 });
  await write(directory, 'big.md', siteFile({
    name: 'big',
    domains: ['a.test'],
    body: 'x'.repeat(512),
  }));

  const { records, invalid } = await store.scan();
  assert.deepEqual(records, []);
  assert.match(invalid[0].reason, /exceeds the 128-byte site file limit/);
});

test('a truncated directory reports what it dropped', async (t) => {
  const { directory, store } = await fixture(t, { maxFiles: 2 });
  for (const name of ['a', 'b', 'c']) {
    await write(directory, `${name}.md`, siteFile({ name, domains: ['a.test'] }));
  }

  const { records, invalid } = await store.scan();
  assert.deepEqual(records.map(record => record.name), ['a', 'b']);
  assert.match(invalid[0].reason, /only the first 2 were read/);
});

test('matches are ordered by pattern specificity, then by name', async (t) => {
  const { directory, store } = await fixture(t);
  await write(directory, 'github.md', siteFile({ name: 'github', domains: ['github.com'] }));
  await write(directory, 'github-issues.md', siteFile({
    name: 'github-issues',
    domains: ['github.com/*/*/issues*'],
  }));
  await write(directory, 'elsewhere.md', siteFile({ name: 'elsewhere', domains: ['example.com'] }));

  const { matches } = await store.match('https://github.com/vercel/next.js/issues');
  assert.deepEqual(matches.map(match => match.record.name), ['github-issues', 'github']);
  assert.equal(matches[0].pattern, 'github.com/*/*/issues*');
  assert.equal(matches[1].pattern, 'github.com');
});

test('a record reports the longest of its own matching patterns', async (t) => {
  const { directory, store } = await fixture(t);
  await write(directory, 'multi.md', siteFile({
    name: 'multi',
    domains: ['example.com', 'example.com/products/*'],
  }));

  const { matches } = await store.match('https://example.com/products/42');
  assert.equal(matches.length, 1, 'a record matching twice is still delivered once');
  assert.equal(matches[0].pattern, 'example.com/products/*');
});

test('match surfaces invalid files alongside the matches', async (t) => {
  const { directory, store } = await fixture(t);
  await write(directory, 'good.md', siteFile({ name: 'good', domains: ['example.com'] }));
  await write(directory, 'broken.md', 'no frontmatter here\n');

  const { matches, invalid } = await store.match('https://example.com/');
  assert.deepEqual(matches.map(match => match.record.name), ['good']);
  assert.equal(invalid.length, 1);
});

test('the mtime changes when a file is edited so delivery can re-trigger', async (t) => {
  const { directory, store } = await fixture(t);
  await write(directory, 'edited.md', siteFile({ name: 'edited', domains: ['example.com'] }));
  const before = (await store.scan()).records[0].mtimeMs;

  await new Promise(resolve => setTimeout(resolve, 10));
  await write(directory, 'edited.md', siteFile({
    name: 'edited',
    domains: ['example.com'],
    body: '- A repaired note',
  }));

  const after = (await store.scan()).records[0];
  assert.ok(after.mtimeMs > before, 'an edit must bump the delivery de-duplication key');
  assert.match(after.body, /repaired/);
});

test('an uppercase extension is judged on its stem, not told to rename itself', async (t) => {
  const { directory, store } = await fixture(t);
  await write(directory, 'Mixed.MD', siteFile({ name: 'Mixed', domains: ['a.test'] }));

  const { records, invalid } = await store.scan();
  assert.deepEqual(invalid, [], 'a .MD file must be usable rather than permanently invalid');
  assert.deepEqual(records.map(record => record.name), ['Mixed']);
});

test('frontmatter longer than the delivered schema allows is refused', async (t) => {
  const { directory, store } = await fixture(t);
  await write(directory, 'wordy.md', siteFile({
    name: 'wordy',
    domains: ['a.test'],
    summary: 'x'.repeat(600),
  }));

  const { records, invalid } = await store.scan();
  assert.deepEqual(records, []);
  assert.match(invalid[0].reason, /summary exceeds 512 characters/);
});

test('a reported reason stays inside the bound the result schema declares', async (t) => {
  const { directory, store } = await fixture(t);
  // The name is author-controlled and gets quoted into the reason.
  await write(directory, 'long.md', siteFile({ name: 'y'.repeat(400), domains: ['a.test'] }));

  const { invalid } = await store.scan();
  assert.ok(invalid[0].reason.length <= 512, `reason ran to ${invalid[0].reason.length} characters`);
});

test('an unchanged file is not re-read, and an edited one is', async (t) => {
  const { directory, store } = await fixture(t);
  const path = join(directory, 'cached.md');
  // A whole-millisecond stamp, applied identically before and after the edit, so
  // the two stats are byte-for-byte comparable and only the cache can explain a
  // difference in what the scan returns.
  const pinned = new Date(1_770_000_000_000);
  await write(directory, 'cached.md', siteFile({ name: 'cached', domains: ['a.test'] }));
  await utimes(path, pinned, pinned);
  assert.equal((await store.scan()).records[0].body, '- A note');

  await write(directory, 'cached.md', siteFile({
    name: 'cached',
    domains: ['a.test'],
    body: '- Content the cache must still be hiding',
  }));
  await utimes(path, pinned, pinned);
  assert.equal((await store.scan()).records[0].body, '- A note', 'an unchanged mtime must not re-read');

  await new Promise(resolve => setTimeout(resolve, 10));
  await write(directory, 'cached.md', siteFile({
    name: 'cached',
    domains: ['a.test'],
    body: '- A repaired note',
  }));
  assert.equal((await store.scan()).records[0].body, '- A repaired note', 'a new mtime must re-read');
});
