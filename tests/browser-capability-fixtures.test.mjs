import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { after, before } from 'node:test';
import { chromium } from 'playwright';
import { MemoryRefStore, ObservationService } from '../dist/services.js';
import {
  BROWSER_CAPABILITY_FIXTURES,
  REQUIRED_BROWSER_CAPABILITY_SCENARIOS,
  renderBrowserCapabilityFixture,
} from './fixtures/browser-capability-matrix.mjs';

let browser;
let browserCdp;
let primaryServer;
let secondaryServer;
let primaryOrigin;
let secondaryOrigin;

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

function fixtureHandler(crossOrigin) {
  return (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    const body = renderBrowserCapabilityFixture(url.pathname, { crossOrigin });
    if (body === undefined) {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html data-fixture-path="${url.pathname}"><head><meta charset="utf-8"></head><body>${body}</body></html>`);
  };
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function axValue(node, key) {
  return node[key]?.value;
}

function observeWithCdp(client, targetId) {
  const transport = {
    send(method, params) {
      return client.send(method, params);
    },
    close() {},
  };
  return new ObservationService(transport, 'isolated-session', targetId, {
    refStore: new MemoryRefStore(),
  }).observe(50);
}

async function observePage(page, targetId) {
  const client = await page.context().newCDPSession(page);
  try {
    return await observeWithCdp(client, targetId);
  } finally {
    await client.detach();
  }
}

before(async () => {
  const secondary = await listen(fixtureHandler('http://fixture.invalid'));
  secondaryServer = secondary.server;
  secondaryOrigin = secondary.origin.replace('127.0.0.1', 'localhost');
  const primary = await listen(fixtureHandler(secondaryOrigin));
  primaryServer = primary.server;
  primaryOrigin = primary.origin;
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--site-per-process', `--isolate-origins=${secondaryOrigin}`],
  });
  browserCdp = await browser.newBrowserCDPSession();
});

after(async () => {
  await browserCdp?.detach();
  await browser?.close();
  if (primaryServer) await closeServer(primaryServer);
  if (secondaryServer) await closeServer(secondaryServer);
});

test('browser capability fixture matrix is complete, unique, bounded, and local', () => {
  assert.deepEqual(
    [...BROWSER_CAPABILITY_FIXTURES.map(fixture => fixture.id)].sort(),
    [...REQUIRED_BROWSER_CAPABILITY_SCENARIOS].sort(),
  );
  assert.equal(new Set(BROWSER_CAPABILITY_FIXTURES.map(fixture => fixture.id)).size, BROWSER_CAPABILITY_FIXTURES.length);
  assert.equal(new Set(BROWSER_CAPABILITY_FIXTURES.map(fixture => fixture.path)).size, BROWSER_CAPABILITY_FIXTURES.length);
  for (const fixture of BROWSER_CAPABILITY_FIXTURES) {
    assert.match(fixture.path, /^\/capability\/[a-z0-9-]+$/);
    assert.ok(fixture.signals.length > 0 && fixture.signals.length <= 4);
    assert.equal(new Set(fixture.signals).size, fixture.signals.length);
    const html = fixture.html({ crossOrigin: 'http://127.0.0.1:9' });
    assert.ok(html.length > 0 && html.length < 10_000);
    assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1(?::9)?(?:[/'"]|$))/);
  }
});

test('AX-only and DOM-only fixtures expose deliberately different browser signals', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${primaryOrigin}/capability/ax-only`);
    let client = await page.context().newCDPSession(page);
    let tree = await client.send('Accessibility.getFullAXTree');
    assert.ok(tree.nodes.some(node => axValue(node, 'role') === 'button' && axValue(node, 'name') === 'AX Command'));
    const axObservation = await observeWithCdp(client, 'ax-only');
    assert.ok(axObservation.data.elements.some(element => (
      element.role === 'button' && element.name === 'AX Command'
    )));
    await client.detach();

    await page.goto(`${primaryOrigin}/capability/dom-only`);
    assert.equal(await page.locator('#dom-control').getAttribute('data-action'), 'command');
    client = await page.context().newCDPSession(page);
    tree = await client.send('Accessibility.getFullAXTree');
    assert.equal(tree.nodes.some(node => axValue(node, 'role') === 'button' && axValue(node, 'name') === 'DOM Command'), false);
    const domObservation = await observeWithCdp(client, 'dom-only');
    assert.ok(domObservation.data.elements.some(element => (
      element.role === 'button' && element.name === 'DOM Command'
    )));
    assert.equal(domObservation.data.elements.some(element => element.name === 'Hidden DOM Command'), false);
    assert.equal(domObservation.data.elements.some(element => element.name === 'Disabled DOM Command'), false);
    await client.detach();
  } finally {
    await page.close();
  }
});

test('shadow, overlay, contenteditable, and controlled-input fixtures preserve their edge behavior', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${primaryOrigin}/capability/shadow-dom`);
    const shadowObservation = await observePage(page, 'shadow-dom');
    assert.ok(shadowObservation.data.elements.some(element => element.name === 'Shadow Command'));
    await page.locator('#shadow-host').getByRole('button', { name: 'Shadow Command' }).click();
    assert.equal(await page.evaluate(() => window.shadowActivated), true);

    await page.goto(`${primaryOrigin}/capability/overlay`);
    const box = await page.locator('#behind').boundingBox();
    assert.ok(box);
    assert.equal(await page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit?.id || hit?.closest('[role="dialog"]')?.id;
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 }), 'fixture-overlay');

    await page.goto(`${primaryOrigin}/capability/contenteditable`);
    const editor = page.locator('#editor');
    assert.equal(await editor.getAttribute('contenteditable'), 'true');
    await editor.fill('replacement');
    assert.equal(await editor.innerText(), 'replacement');
    const editorObservation = await observePage(page, 'contenteditable');
    assert.ok(editorObservation.data.elements.some(element => (
      element.role === 'textbox' && element.name === 'Fixture editor' && element.value === 'replacement'
    )));

    await page.goto(`${primaryOrigin}/capability/react-controlled`);
    await page.getByRole('textbox', { name: 'Controlled field' }).fill('mutation');
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    assert.equal(await page.locator('#controlled').inputValue(), 'fixed');
    assert.equal(await page.evaluate(() => window.fixtureRollbackCount), 1);
    const controlledObservation = await observePage(page, 'react-controlled');
    assert.ok(controlledObservation.data.elements.some(element => (
      element.role === 'textbox' && element.name === 'Controlled field' && element.value === 'fixed'
    )));
  } finally {
    await page.close();
  }
});

test('same-origin frames and forced cross-origin OOPIFs are independently observable', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${primaryOrigin}/capability/frame-same`);
    const sameFrame = page.frames().find(frame => frame.url().endsWith('/capability/frame-same-inner'));
    assert.ok(sameFrame);
    assert.equal(new URL(sameFrame.url()).origin, primaryOrigin);
    assert.equal(await sameFrame.getByRole('button').innerText(), 'Same Frame Command');

    await page.goto(`${primaryOrigin}/capability/frame-cross`);
    await page.waitForFunction(
      expected => document.querySelector('#cross-frame')?.src.startsWith(expected),
      secondaryOrigin,
    );
    const crossFrame = page.frames().find(frame => frame.url().startsWith(secondaryOrigin));
    assert.ok(crossFrame);
    assert.notEqual(new URL(crossFrame.url()).origin, primaryOrigin);
    assert.equal(await crossFrame.getByRole('button').innerText(), 'Cross Frame Command');
    const targets = await browserCdp.send('Target.getTargets');
    assert.ok(targets.targetInfos.some(target => (
      target.type === 'iframe' && target.url.startsWith(secondaryOrigin)
    )), 'Expected the isolated cross-origin frame to have its own CDP target');
  } finally {
    await page.close();
  }
});

test('navigation and same-URL document replacement fixtures produce distinct transitions', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${primaryOrigin}/capability/navigation`);
    await Promise.all([
      page.waitForURL('**/capability/navigation-next'),
      page.locator('#navigate').click(),
    ]);
    assert.equal(await page.locator('#navigation-complete').innerText(), 'navigation complete');

    await page.goto(`${primaryOrigin}/capability/document-replacement`);
    const url = page.url();
    await page.locator('#replace-document').click();
    await page.locator('#replacement').waitFor();
    assert.equal(page.url(), url);
    assert.equal(await page.title(), 'Replaced document');
  } finally {
    await page.close();
  }
});
