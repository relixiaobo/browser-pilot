import assert from 'node:assert/strict';
import test from 'node:test';
import { SiteKnowledgeDeliveryTracker } from '../dist/services.js';

const AGENT = 'workspace:agent-a';
const OTHER_AGENT = 'workspace:agent-b';

function record({ name, body = '- A note', mtimeMs = 1_000, updated }) {
  return {
    name,
    domains: [`${name}.test`],
    summary: `${name} summary`,
    ...(updated ? { updated } : {}),
    body,
    path: `/sites/${name}.md`,
    mtimeMs,
  };
}

function matched(records, invalid = []) {
  return {
    matches: records.map(entry => ({ record: entry, pattern: entry.domains[0] })),
    invalid,
  };
}

test('the first delivery inlines the body and later ones shrink to a pointer', () => {
  const tracker = new SiteKnowledgeDeliveryTracker();
  const site = record({ name: 'github', updated: '2026-08-07' });

  const first = tracker.deliver(AGENT, matched([site]));
  assert.deepEqual(first, [{
    status: 'full',
    name: 'github',
    summary: 'github summary',
    path: '/sites/github.md',
    updated: '2026-08-07',
    body: '- A note',
  }]);

  const second = tracker.deliver(AGENT, matched([site]));
  assert.deepEqual(second, [{
    status: 'seen',
    name: 'github',
    summary: 'github summary',
    path: '/sites/github.md',
  }]);
  assert.equal(
    second[0].path,
    '/sites/github.md',
    'the short form keeps the path so a compacted Agent can read the file again',
  );
});

test('an edit re-inlines the file because the mtime is the de-duplication key', () => {
  const tracker = new SiteKnowledgeDeliveryTracker();
  tracker.deliver(AGENT, matched([record({ name: 'github', mtimeMs: 1_000 })]));

  const repaired = record({ name: 'github', body: '- A repaired note', mtimeMs: 2_000 });
  const afterEdit = tracker.deliver(AGENT, matched([repaired]));
  assert.equal(afterEdit[0].status, 'full');
  assert.equal(afterEdit[0].body, '- A repaired note');
});

test('an unchanged frontmatter date never suppresses redelivery', () => {
  const tracker = new SiteKnowledgeDeliveryTracker();
  const before = record({ name: 'github', mtimeMs: 1_000, updated: '2026-01-01' });
  tracker.deliver(AGENT, matched([before]));

  // The Agent repaired the body but forgot to bump `updated`; mtime still moved.
  const after = record({ name: 'github', body: '- Fixed', mtimeMs: 2_000, updated: '2026-01-01' });
  assert.equal(tracker.deliver(AGENT, matched([after]))[0].status, 'full');
});

test('delivery state is per Agent, so one repair reaches every other Agent', () => {
  const tracker = new SiteKnowledgeDeliveryTracker();
  const site = record({ name: 'github', mtimeMs: 1_000 });

  assert.equal(tracker.deliver(AGENT, matched([site]))[0].status, 'full');
  assert.equal(tracker.deliver(AGENT, matched([site]))[0].status, 'seen');
  assert.equal(
    tracker.deliver(OTHER_AGENT, matched([site]))[0].status,
    'full',
    'a second Agent has its own delivery memory',
  );

  const repaired = record({ name: 'github', body: '- Repaired', mtimeMs: 2_000 });
  assert.equal(tracker.deliver(AGENT, matched([repaired]))[0].status, 'full');
  assert.equal(tracker.deliver(OTHER_AGENT, matched([repaired]))[0].status, 'full');
});

test('releasing a scope forgets its delivery memory', () => {
  const tracker = new SiteKnowledgeDeliveryTracker();
  const site = record({ name: 'github' });
  tracker.deliver(AGENT, matched([site]));
  assert.equal(tracker.deliver(AGENT, matched([site]))[0].status, 'seen');

  tracker.releaseScope(AGENT);
  assert.equal(tracker.deliver(AGENT, matched([site]))[0].status, 'full');
});

test('match order is preserved so the most specific file wins the budget', () => {
  const tracker = new SiteKnowledgeDeliveryTracker({ inlineBudgetBytes: 40 });
  const specific = record({ name: 'specific', body: 'x'.repeat(30) });
  const general = record({ name: 'general', body: 'y'.repeat(30) });

  const entries = tracker.deliver(AGENT, matched([specific, general]));
  assert.deepEqual(entries.map(entry => [entry.name, entry.status]), [
    ['specific', 'full'],
    ['general', 'seen'],
  ]);
});

test('a file skipped for budget is inlined later, once it fits', () => {
  const tracker = new SiteKnowledgeDeliveryTracker({ inlineBudgetBytes: 40 });
  const specific = record({ name: 'specific', body: 'x'.repeat(30) });
  const general = record({ name: 'general', body: 'y'.repeat(30) });

  tracker.deliver(AGENT, matched([specific, general]));
  const alone = tracker.deliver(AGENT, matched([general]));
  assert.equal(alone[0].status, 'full', 'the budget skip must not be recorded as delivered');
});

test('a file larger than the whole budget always degrades to a pointer', () => {
  const tracker = new SiteKnowledgeDeliveryTracker({ inlineBudgetBytes: 16 });
  const huge = record({ name: 'huge', body: 'z'.repeat(1_000) });

  const entries = tracker.deliver(AGENT, matched([huge]));
  assert.equal(entries[0].status, 'seen');
  assert.equal(entries[0].path, '/sites/huge.md');
});

test('the budget counts utf-8 bytes rather than characters', () => {
  const tracker = new SiteKnowledgeDeliveryTracker({ inlineBudgetBytes: 8 });
  // Nine characters, but well over eight bytes once encoded.
  const entries = tracker.deliver(AGENT, matched([record({ name: 'cjk', body: '筛选走链接' })]));
  assert.equal(entries[0].status, 'seen');
});

test('an unusable file is reported once, and again only when its reason changes', () => {
  const tracker = new SiteKnowledgeDeliveryTracker();
  const broken = [{ path: '/sites/broken.md', reason: 'Missing a frontmatter block delimited by ---' }];

  const first = tracker.deliver(AGENT, matched([], broken));
  assert.deepEqual(first, [{
    status: 'invalid',
    path: '/sites/broken.md',
    reason: 'Missing a frontmatter block delimited by ---',
  }]);

  assert.deepEqual(tracker.deliver(AGENT, matched([], broken)), [], 'the same complaint is not repeated');

  const differently = [{ path: '/sites/broken.md', reason: 'Frontmatter is missing a non-empty summary' }];
  const second = tracker.deliver(AGENT, matched([], differently));
  assert.equal(second.length, 1);
  assert.match(second[0].reason, /non-empty summary/);
});

test('a repaired file that breaks again is reported afresh', () => {
  const tracker = new SiteKnowledgeDeliveryTracker();
  const broken = [{ path: '/sites/broken.md', reason: 'Missing a frontmatter block delimited by ---' }];

  assert.equal(tracker.deliver(AGENT, matched([], broken)).length, 1);
  assert.equal(tracker.deliver(AGENT, matched([], [])).length, 0, 'a repaired file says nothing');
  assert.equal(
    tracker.deliver(AGENT, matched([], broken)).length,
    1,
    'a regression must be reported again rather than staying silent',
  );
});

test('records and diagnostics are delivered together', () => {
  const tracker = new SiteKnowledgeDeliveryTracker();
  const entries = tracker.deliver(
    AGENT,
    matched([record({ name: 'good' })], [{ path: '/sites/bad.md', reason: 'Not a regular file' }]),
  );
  assert.deepEqual(entries.map(entry => entry.status), ['full', 'invalid']);
});

test('no match and no diagnostics deliver nothing at all', () => {
  const tracker = new SiteKnowledgeDeliveryTracker();
  assert.deepEqual(tracker.deliver(AGENT, matched([])), []);
});
