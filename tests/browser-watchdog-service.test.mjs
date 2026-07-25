import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserWatchdogService } from '../dist/services.js';

const context = {
  workspaceId: 'workspace:test',
  leaseId: 'lease:test',
  targetId: 'target:test',
  browserConnectionGeneration: 1,
};

test('action watchdog emits once per observable no-progress streak and resets on progress', () => {
  const events = [];
  const watchdogs = new BrowserWatchdogService(event => events.push(event), {
    noProgressThreshold: 3,
  });
  const stalled = {
    action: 'click',
    status: 'unavailable',
    effects: [],
    reason: 'no_observable_effect',
  };

  watchdogs.actionCompleted(context, stalled);
  watchdogs.actionCompleted(context, stalled);
  assert.equal(events.length, 0);
  const hint = watchdogs.actionCompleted(context, stalled);
  watchdogs.actionCompleted(context, stalled);
  assert.equal(hint.code, 'repeated_action');
  assert.equal(hint.streak, 3);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    ...context,
    type: 'watchdog.no_progress',
    sensitivity: 'browser_data',
    payload: {
      action: 'click',
      evidenceStatus: 'unavailable',
      reason: 'no_observable_effect',
      streak: 3,
      threshold: 3,
      hints: [hint],
    },
  });

  watchdogs.actionCompleted(context, {
    action: 'click',
    status: 'verified',
    effects: ['focus_changed'],
  });
  watchdogs.actionCompleted(context, stalled);
  watchdogs.actionCompleted(context, stalled);
  watchdogs.actionCompleted(context, stalled);
  assert.equal(events.length, 2);

  watchdogs.actionCompleted(context, {
    action: 'click',
    status: 'unavailable',
    effects: [],
    reason: 'coordinate_target',
  });
  watchdogs.actionCompleted(context, stalled);
  watchdogs.actionCompleted(context, stalled);
  assert.equal(events.length, 2);
});

test('dialog watchdog emits once without handling the dialog and cancels on cleanup', () => {
  const events = [];
  const timers = [];
  const watchdogs = new BrowserWatchdogService(event => events.push(event), {
    dialogTimeoutMs: 25,
    setTimer(callback, delayMs) {
      const timer = {
        callback,
        delayMs,
        cleared: false,
        unrefCalled: false,
        unref() { this.unrefCalled = true; },
      };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
  });

  watchdogs.dialogOpened(context, {
    dialogId: 'dialog:closed',
    dialogType: 'confirm',
    openedAt: 10,
  });
  assert.equal(timers[0].unrefCalled, true);
  watchdogs.dialogClosed('dialog:closed');
  timers[0].callback();
  assert.equal(timers[0].cleared, true);
  assert.equal(events.length, 0);

  watchdogs.dialogOpened(context, {
    dialogId: 'dialog:pending',
    dialogType: 'beforeunload',
    openedAt: 20,
  });
  timers[1].callback();
  timers[1].callback();
  assert.deepEqual(events, [{
    ...context,
    type: 'watchdog.dialog_unhandled',
    sensitivity: 'browser_data',
    payload: {
      dialogId: 'dialog:pending',
      type: 'beforeunload',
      openedAt: 20,
      timeoutMs: 25,
    },
  }]);

  watchdogs.dialogOpened(context, {
    dialogId: 'dialog:released',
    dialogType: 'alert',
    openedAt: 30,
  });
  watchdogs.releaseLease(context.leaseId);
  timers[2].callback();
  assert.equal(timers[2].cleared, true);
  assert.equal(events.length, 1);
});

test('navigation and frame watchdogs expose only stable public context', () => {
  const events = [];
  const watchdogs = new BrowserWatchdogService(event => events.push(event));
  watchdogs.navigationStalled(context, {
    url: 'https://example.test/pending',
    timeoutMs: 30_000,
  });
  watchdogs.frameDetached(context, 'frame:opaque');

  assert.deepEqual(events.map(event => event.type), [
    'watchdog.navigation_stalled',
    'watchdog.frame_detached',
  ]);
  assert.deepEqual(events[1].payload, {
    frameId: 'frame:opaque',
    selectedFrameCleared: true,
  });
  assert.equal(JSON.stringify(events).includes('sessionId'), false);
  assert.equal(JSON.stringify(events).includes('cdp'), false);
});
