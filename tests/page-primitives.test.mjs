import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { chromium } from 'playwright';
import {
  CaptureService,
  DropdownService,
  PageInspectionService,
  ScreenshotAnnotationService,
  ScrollService,
} from '../dist/services.js';

let browser;
let page;
let client;
let transport;

before(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  client = await page.context().newCDPSession(page);
  transport = {
    send: (method, params) => client.send(method, params),
    close() {},
  };
});

after(async () => {
  await client?.detach();
  await browser?.close();
});

test('page search and bounded element queries include open Shadow DOM', async () => {
  await page.setContent(`
    <main>
      <p>Invoice total is $42.00 and ready for review.</p>
      <a class="result" href="/first" data-testid="first-result">First result</a>
      <div id="host"></div>
    </main>
    <script>
      const root = document.querySelector('#host').attachShadow({ mode: 'open' });
      root.innerHTML = '<a class="result" href="/shadow" data-testid="shadow-result">Shadow needle result</a>';
    </script>
  `);

  const inspection = new PageInspectionService(transport, 'root-session');
  const search = await inspection.search('invoice total', { limit: 10 });
  assert.equal(search.totalMatches, 1);
  assert.match(search.matches[0].context, /Invoice total/);
  assert.equal(search.matches[0].visible, true);

  const shadowSearch = await inspection.search('Shadow needle', { limit: 10 });
  assert.equal(shadowSearch.totalMatches, 1);
  assert.equal(shadowSearch.matches[0].tagName, 'a');

  const found = await inspection.find('.result', {
    limit: 1,
    attributeNames: ['href', 'data-testid'],
  });
  assert.equal(found.totalMatches, 2);
  assert.equal(found.elements.length, 1);
  assert.equal(found.truncated, true);
  assert.deepEqual(found.elements[0].attributes, [
    { name: 'href', value: '/first' },
    { name: 'data-testid', value: 'first-result' },
  ]);
});

test('scroll operates on the page, containers, boundaries, and visible text', async () => {
  await page.setContent(`
    <style>
      body { margin: 0; }
      #spacer { height: 1500px; }
      #target { height: 40px; }
      #container { width: 300px; height: 120px; overflow: auto; }
      #container-content { height: 900px; }
    </style>
    <div id="container"><div id="container-content">Container start<div style="margin-top:800px">Container end</div></div></div>
    <div id="spacer"></div><div id="target">Payment details</div>
  `);
  const scroll = new ScrollService(transport, 'root-session');

  const down = await scroll.page({ mode: 'relative', direction: 'down', amount: 0.5, unit: 'viewport' });
  assert.equal(down.status, 'verified');
  assert.ok(down.deltaY >= 200);

  const container = await scroll.selector('#container', {
    mode: 'relative', direction: 'down', amount: 300, unit: 'pixels',
  });
  assert.equal(container.target, 'element');
  assert.equal(container.deltaY, 300);

  const end = await scroll.selector('#container', { mode: 'position', position: 'end' });
  assert.equal(end.status, 'verified');
  const boundary = await scroll.selector('#container', { mode: 'position', position: 'end' });
  assert.equal(boundary.status, 'mismatch');
  assert.equal(boundary.reason, 'at_boundary');

  await scroll.page({ mode: 'position', position: 'start' });
  const text = await scroll.text('Payment details');
  assert.equal(text.status, 'verified');
  assert.equal(text.target, 'text');
  assert.equal(text.matchedText, 'Payment details');
  assert.ok(text.afterY > 500);

  await scroll.page({ mode: 'position', position: 'start' });
  await page.evaluate(() => {
    document.querySelector('#target').scrollIntoView = () => {};
  });
  const fallback = await scroll.text('Payment details');
  assert.equal(fallback.status, 'verified');
  assert.equal(fallback.moved, true);
  assert.ok(fallback.afterY > 500);

  await scroll.page({ mode: 'position', position: 'start' });
  await page.setContent(`
    <main id="long" style="white-space:pre-line">${'prefix '.repeat(2000)}\n${'spacer\n'.repeat(200)}Rule   of\nthumb${' suffix'.repeat(2000)}</main>
  `);
  await page.evaluate(() => {
    document.querySelector('#long').scrollIntoView = () => {};
  });
  const precise = await scroll.text('Rule of thumb');
  assert.equal(precise.status, 'verified');
  assert.equal(precise.moved, true);
  const matchedViewport = await page.evaluate(() => {
    const node = document.querySelector('#long').firstChild;
    const start = node.nodeValue.indexOf('Rule');
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + 'Rule   of\nthumb'.length);
    return { rect: range.getBoundingClientRect().toJSON(), viewportHeight: window.innerHeight };
  });
  assert.ok(matchedViewport.rect.bottom > 0);
  assert.ok(matchedViewport.rect.top < matchedViewport.viewportHeight);
});

test('dropdown service enumerates native and ARIA options and verifies native selection', async () => {
  await page.setContent(`
    <select id="country">
      <option value="">Choose one</option>
      <option value="cn">China</option>
      <option value="us">United States</option>
    </select>
    <div id="unrelated" role="listbox"><div role="option">Shanghai</div></div>
    <button id="city" role="combobox" aria-expanded="true" aria-controls="cities">City</button>
    <div id="cities" role="listbox">
      <div role="option" data-value="sha">Shanghai</div>
      <div role="option" data-value="nyc" aria-selected="true">New York</div>
    </div>
    <script>
      window.selectionEvents = [];
      const select = document.querySelector('#country');
      select.addEventListener('input', () => window.selectionEvents.push('input'));
      select.addEventListener('change', () => window.selectionEvents.push('change'));
    </script>
  `);
  const dropdown = new DropdownService(transport, 'root-session');
  const { result: nativeObject } = await client.send('Runtime.evaluate', {
    expression: "document.querySelector('#country')",
  });
  const { result: ariaObject } = await client.send('Runtime.evaluate', {
    expression: "document.querySelector('#city')",
  });
  const { result: ownedOptionObject } = await client.send('Runtime.evaluate', {
    expression: "document.querySelector('#cities [role=option]')",
  });
  const { result: unrelatedOptionObject } = await client.send('Runtime.evaluate', {
    expression: "document.querySelector('#unrelated [role=option]')",
  });
  try {
    const native = await dropdown.inspectObject(nativeObject.objectId);
    assert.equal(native.kind, 'native');
    assert.deepEqual(native.options.map(option => option.label), ['Choose one', 'China', 'United States']);

    const selected = await dropdown.selectNativeObject(nativeObject.objectId, {
      by: 'value', value: 'us', exact: true,
    });
    assert.equal(selected.status, 'verified');
    assert.equal(selected.selected[0].label, 'United States');
    assert.deepEqual(await page.evaluate(() => window.selectionEvents), ['input', 'change']);

    const aria = await dropdown.inspectObject(ariaObject.objectId);
    assert.equal(aria.kind, 'aria');
    assert.equal(aria.requiresOpen, false);
    assert.deepEqual(aria.options.map(option => [option.label, option.selected]), [
      ['Shanghai', false],
      ['New York', true],
    ]);
    assert.equal(
      (await dropdown.inspectOwnedAriaOption(ariaObject.objectId, ownedOptionObject.objectId)).value,
      'sha',
    );
    assert.equal(
      await dropdown.inspectOwnedAriaOption(ariaObject.objectId, unrelatedOptionObject.objectId),
      undefined,
    );
  } finally {
    await client.send('Runtime.releaseObject', { objectId: nativeObject.objectId });
    await client.send('Runtime.releaseObject', { objectId: ariaObject.objectId });
    await client.send('Runtime.releaseObject', { objectId: ownedOptionObject.objectId });
    await client.send('Runtime.releaseObject', { objectId: unrelatedOptionObject.objectId });
  }
});

test('screenshot annotations render numbered boxes without mutating the page DOM', async () => {
  await page.setContent(`
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; img-src 'none'; style-src 'unsafe-inline'">
    <button id="save" style="margin:80px;width:120px;height:50px">Save</button>
  `);
  const beforeHtml = await page.content();
  const capture = await new CaptureService(transport, 'root-session').screenshot();
  const annotated = await new ScreenshotAnnotationService(transport, 'root-session').annotate(
    capture,
    [{ ref: 7, x: 80, y: 80, width: 120, height: 50 }],
    { width: 800, height: 500 },
  );

  assert.equal(annotated.mimeType, 'image/png');
  assert.equal(annotated.width, capture.width);
  assert.equal(annotated.height, capture.height);
  assert.notDeepEqual(Buffer.from(annotated.bytes), Buffer.from(capture.bytes));
  assert.equal(await page.content(), beforeHtml);
});
