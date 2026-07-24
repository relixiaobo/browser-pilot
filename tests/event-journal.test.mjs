import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryEventJournal } from '../dist/services.js';

function event(workspaceId, value) {
  return {
    workspaceId,
    type: 'document.changed',
    sensitivity: 'browser_data',
    payload: { value },
  };
}

test('Event Journal orders, clones, paginates, and bounds each Workspace independently', () => {
  let eventId = 0;
  const journal = new MemoryEventJournal({
    maxEventsPerWorkspace: 3,
    now: () => 1234,
    idFactory: () => `event:test-${++eventId}`,
  });
  assert.equal(journal.createWorkspace('workspace:one'), 'cursor:0');
  assert.equal(journal.createWorkspace('workspace:two'), 'cursor:0');

  const first = journal.publish(event('workspace:one', 1));
  first.payload.value = 99;
  journal.publish(event('workspace:one', 2));
  journal.publish(event('workspace:one', 3));
  journal.publish(event('workspace:one', 4));
  journal.publish(event('workspace:two', 'separate'));

  const page = journal.poll('workspace:one', 'cursor:1', 2);
  assert.deepEqual(page.events.map(item => item.payload.value), [2, 3]);
  assert.deepEqual(page.events.map(item => item.sequence), [2, 3]);
  assert.equal(page.nextCursor, 'cursor:3');
  assert.equal(page.hasMore, true);
  page.events[0].payload.value = 100;
  assert.equal(journal.poll('workspace:one', 'cursor:1').events[0].payload.value, 2);

  const other = journal.poll('workspace:two', 'cursor:0');
  assert.deepEqual(other.events.map(item => item.payload.value), ['separate']);
  assert.equal(journal.size('workspace:one'), 3);
});

test('Event Journal reports expired and future cursors explicitly', () => {
  const journal = new MemoryEventJournal({ maxEventsPerWorkspace: 2 });
  journal.createWorkspace('workspace:test');
  journal.publish(event('workspace:test', 1));
  journal.publish(event('workspace:test', 2));
  journal.publish(event('workspace:test', 3));

  assert.throws(
    () => journal.poll('workspace:test', 'cursor:0'),
    error => (
      error.code === 'cursor_expired' &&
      error.context.earliestCursor === 'cursor:1' &&
      error.context.latestCursor === 'cursor:3'
    ),
  );
  assert.throws(
    () => journal.poll('workspace:test', 'cursor:4'),
    error => error.code === 'invalid_argument' && error.context.field === 'cursor',
  );
});
