import assert from 'node:assert/strict';
import test from 'node:test';
import { CompatibilityDialogService } from '../dist/services.js';

class DialogFixtureTransport {
  calls = [];
  handlers = new Map();

  async send(method, params = {}, sessionId) {
    this.calls.push({ method, params, sessionId });
    if (method === 'Page.handleJavaScriptDialog') {
      this.emit('Page.javascriptDialogClosed', { result: params.accept }, sessionId);
    }
    return {};
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) ?? [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }

  emit(method, params, sessionId) {
    for (const handler of this.handlers.get(method) ?? []) handler(params, sessionId);
  }

  close() {}
}

test('compatibility dialogs exclude Broker sessions and never expose CDP session IDs', async () => {
  const transport = new DialogFixtureTransport();
  const service = new CompatibilityDialogService(
    transport,
    sessionId => sessionId === 'broker-session',
  );

  transport.emit('Page.javascriptDialogOpening', {
    type: 'alert',
    message: 'Broker only',
    url: 'https://broker.example/',
  }, 'broker-session');
  assert.deepEqual(service.list(), []);

  transport.emit('Page.javascriptDialogOpening', {
    type: 'confirm',
    message: 'Continue?',
    url: 'https://user.example/form',
  }, 'compatibility-session');
  const [dialog] = service.list();
  assert.equal(dialog.type, 'confirm');
  assert.equal(dialog.message, 'Continue?');
  assert.equal('sessionId' in dialog, false);

  const result = await service.respond(dialog.dialogId, 'dismiss');
  assert.equal(result.action, 'dismiss');
  assert.deepEqual(service.list(), []);
  assert.deepEqual(transport.calls.at(-1), {
    method: 'Page.handleJavaScriptDialog',
    params: { accept: false },
    sessionId: 'compatibility-session',
  });
});

test('compatibility prompt responses validate input and detached sessions are removed', async () => {
  const transport = new DialogFixtureTransport();
  const service = new CompatibilityDialogService(transport, () => false);

  transport.emit('Page.javascriptDialogOpening', {
    type: 'confirm',
    message: 'Confirm',
  }, 'confirm-session');
  const confirm = service.list()[0];
  await assert.rejects(
    service.respond(confirm.dialogId, 'accept', 'unexpected'),
    error => error.code === 'invalid_argument' && error.context?.field === 'prompt',
  );

  transport.emit('Target.detachedFromTarget', { sessionId: 'confirm-session' });
  assert.deepEqual(service.list(), []);

  transport.emit('Page.javascriptDialogOpening', {
    type: 'prompt',
    message: 'Name?',
    defaultPrompt: 'Ada',
  }, 'prompt-session');
  const prompt = service.list()[0];
  await service.respond(prompt.dialogId, 'accept', 'Grace');
  assert.deepEqual(transport.calls.at(-1), {
    method: 'Page.handleJavaScriptDialog',
    params: { accept: true, promptText: 'Grace' },
    sessionId: 'prompt-session',
  });
});
