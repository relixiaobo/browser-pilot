import assert from 'node:assert/strict';
import test from 'node:test';
import { CaptureService } from '../dist/services.js';

class FakeTransport {
  calls = [];
  responses = [];

  enqueue(response) {
    this.responses.push(response);
  }

  async send(method, params, sessionId) {
    this.calls.push({ method, params, sessionId });
    if (this.responses.length === 0) throw new Error(`Unexpected CDP call: ${method}`);
    return this.responses.shift();
  }

  close() {}
}

test('capture service returns screenshot bytes without writing a file', async () => {
  const transport = new FakeTransport();
  transport.enqueue({ data: Buffer.from('png-data').toString('base64') });

  const media = await new CaptureService(transport, 'session-1').screenshot();

  assert.equal(media.mimeType, 'image/png');
  assert.equal(Buffer.from(media.bytes).toString(), 'png-data');
  assert.deepEqual(transport.calls, [{
    method: 'Page.captureScreenshot',
    params: { format: 'png' },
    sessionId: 'session-1',
  }]);
});

test('capture service computes full-page clipping and dimensions', async () => {
  const transport = new FakeTransport();
  transport.enqueue({ result: { value: JSON.stringify({ width: 1200, height: 3000 }) } });
  transport.enqueue({ data: Buffer.from('full-page').toString('base64') });

  const media = await new CaptureService(transport, 'session-2').screenshot({ fullPage: true });

  assert.equal(media.width, 1200);
  assert.equal(media.height, 3000);
  assert.deepEqual(transport.calls[1], {
    method: 'Page.captureScreenshot',
    params: {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1200, height: 3000, scale: 1 },
    },
    sessionId: 'session-2',
  });
});

test('selector capture returns selected element dimensions', async () => {
  const transport = new FakeTransport();
  transport.enqueue({ result: { value: JSON.stringify({ x: 10, y: 20, width: 320, height: 180 }) } });
  transport.enqueue({ data: Buffer.from('element').toString('base64') });

  const media = await new CaptureService(transport, 'session-3').screenshot({ selector: '.chart' });

  assert.equal(media.width, 320);
  assert.equal(media.height, 180);
  assert.deepEqual(transport.calls[1].params.clip, { x: 10, y: 20, width: 320, height: 180, scale: 1 });
});

test('selector capture fails before CDP capture when the element is missing', async () => {
  const transport = new FakeTransport();
  transport.enqueue({ result: { value: 'null' } });

  await assert.rejects(
    () => new CaptureService(transport, 'session-4').screenshot({ selector: '#missing' }),
    error => error.code === 'invalid_argument' && error.context?.field === 'selector',
  );
  assert.equal(transport.calls.length, 1);
});

test('capture service returns PDF bytes and forwards landscape mode', async () => {
  const transport = new FakeTransport();
  transport.enqueue({ data: Buffer.from('pdf-data').toString('base64') });

  const media = await new CaptureService(transport, 'session-5').pdf({ landscape: true });

  assert.equal(media.mimeType, 'application/pdf');
  assert.equal(Buffer.from(media.bytes).toString(), 'pdf-data');
  assert.deepEqual(transport.calls[0], {
    method: 'Page.printToPDF',
    params: { landscape: true },
    sessionId: 'session-5',
  });
});
