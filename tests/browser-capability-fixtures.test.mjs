import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test, { after, before } from 'node:test';
import { chromium } from 'playwright';
import { playwrightChromeLaunchOptions } from '../scripts/playwright-chrome.mjs';
import {
  ActionService,
  FrameService,
  MemoryRefStore,
  ObservationService,
  RefRevalidationService,
} from '../dist/services.js';
import { OBSERVATION_V1_LIMITS } from '../dist/protocol.js';
import {
  BROWSER_CAPABILITY_ACTION_FAILURE_CASES,
  BROWSER_CAPABILITY_BENCHMARK_CASES,
  BROWSER_CAPABILITY_FIXTURES,
  BROWSER_CAPABILITY_STALE_REF_CASES,
  REQUIRED_BROWSER_CAPABILITY_SCENARIOS,
  renderBrowserCapabilityFixture,
} from './fixtures/browser-capability-matrix.mjs';

let browser;
let browserCdp;
let primaryServer;
let secondaryServer;
let primaryOrigin;
let secondaryOrigin;
let nestedCdpRequestId = 1;
const benchmarkObservations = new Map();
const detectedActionFailures = new Set();
const detectedStaleRefs = new Set();

function benchmarkTargetKey(element) {
  return `${element.role}\0${element.name}`;
}

function recordBenchmarkObservation(id, observation) {
  assert.equal(benchmarkObservations.has(id), false, `Duplicate benchmark Observation: ${id}`);
  let normalizedUrl = observation.data.url;
  try {
    normalizedUrl = new URL(observation.data.url).pathname;
  } catch {}
  const normalizedData = { ...observation.data, url: normalizedUrl };
  benchmarkObservations.set(id, {
    targets: observation.data.elements.map(benchmarkTargetKey),
    normalizedBytes: Buffer.byteLength(JSON.stringify(normalizedData), 'utf8'),
  });
}

function recordExpectedDetection(id, expectedCases, detections) {
  assert.ok(expectedCases.includes(id), `Unknown benchmark case: ${id}`);
  detections.add(id);
}

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

function sendToTargetSession(client, sessionId, method, params = {}) {
  const id = nestedCdpRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('Target.receivedMessageFromTarget', onMessage);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 5_000);
    const onMessage = event => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message);
      if (message.id !== id) return;
      clearTimeout(timer);
      client.off('Target.receivedMessageFromTarget', onMessage);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result ?? {});
    };
    client.on('Target.receivedMessageFromTarget', onMessage);
    client.send('Target.sendMessageToTarget', {
      sessionId,
      message: JSON.stringify({ id, method, params }),
    }).catch(error => {
      clearTimeout(timer);
      client.off('Target.receivedMessageFromTarget', onMessage);
      reject(error);
    });
  });
}

function observeWithCdp(client, targetId, options = {}) {
  const transport = {
    send(method, params) {
      return client.send(method, params);
    },
    close() {},
  };
  return new ObservationService(transport, 'isolated-session', targetId, {
    refStore: new MemoryRefStore(),
    ...options,
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
  browser = await chromium.launch(playwrightChromeLaunchOptions({
    args: ['--site-per-process', `--isolate-origins=${secondaryOrigin}`],
  }));
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
  assert.deepEqual(
    [...BROWSER_CAPABILITY_BENCHMARK_CASES.map(benchmarkCase => benchmarkCase.id)].sort(),
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
    const axRefs = new MemoryRefStore();
    const transport = { send: (method, params) => client.send(method, params), close() {} };
    const axObservation = await new ObservationService(transport, 'isolated-session', 'ax-only', {
      refStore: axRefs,
    }).observe(50);
    recordBenchmarkObservation('ax_only', axObservation);
    assert.ok(axObservation.data.elements.some(element => (
      element.role === 'button' && element.name === 'AX Command'
    )));
    const observedRef = axRefs.load('ax-only')[0];
    const { object } = await client.send('DOM.resolveNode', { backendNodeId: observedRef.backendNodeId });
    const revalidator = new RefRevalidationService(transport, 'isolated-session');
    try {
      await revalidator.validateResolved(object.objectId, observedRef, { targetId: 'ax-only', ref: 1 });
      await page.locator('#ax-control').evaluate(element => {
        element.setAttribute('aria-label', 'Destructive Command');
      });
      await assert.rejects(
        () => revalidator.validateResolved(object.objectId, observedRef, { targetId: 'ax-only', ref: 1 }),
        error => error.code === 'stale_ref',
      );
      recordExpectedDetection(
        'semantic_mutation',
        BROWSER_CAPABILITY_STALE_REF_CASES,
        detectedStaleRefs,
      );
      await page.locator('#ax-control').evaluate(element => element.remove());
      await assert.rejects(
        () => revalidator.validateResolved(object.objectId, observedRef, { targetId: 'ax-only', ref: 1 }),
        error => error.code === 'stale_ref',
      );
      recordExpectedDetection(
        'node_detach',
        BROWSER_CAPABILITY_STALE_REF_CASES,
        detectedStaleRefs,
      );
    } finally {
      await client.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    }
    await client.detach();

    await page.goto(`${primaryOrigin}/capability/dom-only`);
    assert.equal(await page.locator('#dom-control').getAttribute('data-action'), 'command');
    client = await page.context().newCDPSession(page);
    tree = await client.send('Accessibility.getFullAXTree');
    assert.equal(tree.nodes.some(node => axValue(node, 'role') === 'button' && axValue(node, 'name') === 'DOM Command'), false);
    const domObservation = await observeWithCdp(client, 'dom-only');
    recordBenchmarkObservation('dom_only', domObservation);
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
    recordBenchmarkObservation('shadow_dom', shadowObservation);
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
    let client = await page.context().newCDPSession(page);
    let refs = new MemoryRefStore();
    let transport = { send: (method, params) => client.send(method, params), close() {} };
    let observationService = new ObservationService(transport, 'isolated-session', 'overlay', {
      refStore: refs,
      settleDelayMs: 0,
    });
    const overlayObservation = await observationService.observe(50);
    recordBenchmarkObservation('overlay', overlayObservation);
    const behindRef = overlayObservation.data.elements.find(element => element.name === 'Behind Overlay')?.ref;
    assert.ok(behindRef);
    const actionService = new ActionService(transport, 'isolated-session', 'overlay', {
      refStore: refs,
      observationService,
      refValidator: input => new RefRevalidationService(
        transport,
        'isolated-session',
      ).validateResolved(input.objectId, input.entry, { targetId: 'overlay', ref: input.ref }),
    });
    await assert.rejects(
      () => actionService.click({ kind: 'ref', ref: String(behindRef) }),
      error => error.code === 'action_not_verified' && error.context?.reason === 'obscured',
    );
    recordExpectedDetection(
      'overlay_obstruction',
      BROWSER_CAPABILITY_ACTION_FAILURE_CASES,
      detectedActionFailures,
    );
    await client.detach();

    await page.goto(`${primaryOrigin}/capability/contenteditable`);
    const editor = page.locator('#editor');
    assert.equal(await editor.getAttribute('contenteditable'), 'true');
    await editor.fill('replacement');
    assert.equal(await editor.innerText(), 'replacement');
    const editorObservation = await observePage(page, 'contenteditable');
    recordBenchmarkObservation('contenteditable', editorObservation);
    assert.ok(editorObservation.data.elements.some(element => (
      element.role === 'textbox' && element.name === 'Fixture editor' && element.value === 'replacement'
    )));

    await page.goto(`${primaryOrigin}/capability/react-controlled`);
    await page.getByRole('textbox', { name: 'Controlled field' }).fill('mutation');
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    assert.equal(await page.locator('#controlled').inputValue(), 'fixed');
    assert.equal(await page.evaluate(() => window.fixtureRollbackCount), 1);
    client = await page.context().newCDPSession(page);
    refs = new MemoryRefStore();
    transport = { send: (method, params) => client.send(method, params), close() {} };
    observationService = new ObservationService(transport, 'isolated-session', 'react-controlled', {
      refStore: refs,
      settleDelayMs: 0,
    });
    const controlledObservation = await observationService.observe(50);
    recordBenchmarkObservation('react_controlled_input', controlledObservation);
    assert.ok(controlledObservation.data.elements.some(element => (
      element.role === 'textbox' && element.name === 'Controlled field' && element.value === 'fixed'
    )));
    const controlledRef = controlledObservation.data.elements.find(
      element => element.name === 'Controlled field',
    )?.ref;
    assert.ok(controlledRef);
    const controlledActionService = new ActionService(
      transport,
      'isolated-session',
      'react-controlled',
      {
        refStore: refs,
        observationService,
        readbackDelayMs: 40,
        focusDelayMs: 0,
        refValidator: input => new RefRevalidationService(
          transport,
          'isolated-session',
        ).validateResolved(input.objectId, input.entry, {
          targetId: 'react-controlled',
          ref: input.ref,
        }),
      },
    );
    await assert.rejects(
      () => controlledActionService.type(String(controlledRef), 'mutation', {
        clear: true,
        verification: 'require_exact',
      }),
      error => error.code === 'action_not_verified' && error.context?.reason === 'value_mismatch',
    );
    recordExpectedDetection(
      'controlled_input_rollback',
      BROWSER_CAPABILITY_ACTION_FAILURE_CASES,
      detectedActionFailures,
    );
    await client.detach();
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
    let frameClient = await page.context().newCDPSession(page);
    try {
      const transport = { send: (method, params) => frameClient.send(method, params), close() {} };
      const frames = await new FrameService(transport, 'isolated-session').list();
      const frame = frames.find(candidate => candidate.url.endsWith('/capability/frame-same-inner'));
      assert.ok(frame);
      const selection = await new FrameService(transport, 'isolated-session').selectById(frame.id);
      recordBenchmarkObservation(
        'same_origin_iframe',
        await observeWithCdp(frameClient, 'same-origin-frame', {
          frameId: frame.id,
          executionContextId: selection.executionContextId,
        }),
      );
    } finally {
      await frameClient.detach();
    }

    await page.goto(`${primaryOrigin}/capability/frame-cross`);
    await page.waitForFunction(
      expected => document.querySelector('#cross-frame')?.src.startsWith(expected),
      secondaryOrigin,
    );
    const crossFrame = page.frames().find(frame => frame.url().startsWith(secondaryOrigin));
    assert.ok(crossFrame);
    assert.notEqual(new URL(crossFrame.url()).origin, primaryOrigin);
    assert.equal(await crossFrame.getByRole('button').innerText(), 'Cross Frame Command');
    frameClient = await page.context().newCDPSession(crossFrame);
    try {
      recordBenchmarkObservation(
        'cross_origin_oopif',
        await observeWithCdp(frameClient, 'cross-origin-frame'),
      );
    } finally {
      await frameClient.detach();
    }
    const targets = await browserCdp.send('Target.getTargets');
    const oopif = targets.targetInfos.find(target => (
      target.type === 'iframe' && target.url.startsWith(secondaryOrigin)
    ));
    assert.ok(oopif, 'Expected the isolated cross-origin frame to have its own CDP target');
    assert.ok(oopif.parentFrameId || oopif.parentId);

    const attached = await browserCdp.send('Target.attachToTarget', {
      targetId: oopif.targetId,
      flatten: false,
    });
    try {
      const frameTree = await sendToTargetSession(
        browserCdp,
        attached.sessionId,
        'Page.getFrameTree',
      );
      assert.equal(frameTree.frameTree.frame.id, oopif.targetId);
      const axTree = await sendToTargetSession(
        browserCdp,
        attached.sessionId,
        'Accessibility.getFullAXTree',
      );
      assert.ok(axTree.nodes.some(node => (
        axValue(node, 'role') === 'button' && axValue(node, 'name') === 'Cross Frame Command'
      )));
      const domSnapshot = await sendToTargetSession(
        browserCdp,
        attached.sessionId,
        'DOMSnapshot.captureSnapshot',
        { computedStyles: ['display', 'visibility', 'opacity', 'pointer-events'] },
      );
      assert.ok(domSnapshot.documents.some(document => (
        domSnapshot.strings[document.frameId] === oopif.targetId
      )));
    } finally {
      await browserCdp.send('Target.detachFromTarget', { sessionId: attached.sessionId });
    }
  } finally {
    await page.close();
  }
});

test('navigation and same-URL document replacement fixtures produce distinct transitions', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${primaryOrigin}/capability/navigation`);
    recordBenchmarkObservation('navigation', await observePage(page, 'navigation'));
    await Promise.all([
      page.waitForURL('**/capability/navigation-next'),
      page.locator('#navigate').click(),
    ]);
    assert.equal(await page.locator('#navigation-complete').innerText(), 'navigation complete');

    await page.goto(`${primaryOrigin}/capability/document-replacement`);
    recordBenchmarkObservation(
      'document_replacement',
      await observePage(page, 'document-replacement'),
    );
    const url = page.url();
    await page.locator('#replace-document').click();
    await page.locator('#replacement').waitFor();
    assert.equal(page.url(), url);
    assert.equal(await page.title(), 'Replaced document');
  } finally {
    await page.close();
  }
});

test('capability metrics do not regress from the versioned Chrome baseline', async t => {
  const expectedIds = BROWSER_CAPABILITY_BENCHMARK_CASES.map(candidate => candidate.id);
  assert.deepEqual([...benchmarkObservations.keys()].sort(), [...expectedIds].sort());

  let expectedTargets = 0;
  let matchedTargets = 0;
  let observedTargets = 0;
  let falseInteractableTargets = 0;
  let maxNormalizedObservationBytes = 0;
  const unclassifiedTargets = [];
  for (const benchmarkCase of BROWSER_CAPABILITY_BENCHMARK_CASES) {
    const measurement = benchmarkObservations.get(benchmarkCase.id);
    assert.ok(measurement);
    const unmatchedActionableTargets = [...benchmarkCase.actionableTargets];
    const unmatchedFalseTargets = [...benchmarkCase.falseInteractableTargets];
    expectedTargets += unmatchedActionableTargets.length;
    observedTargets += measurement.targets.length;
    maxNormalizedObservationBytes = Math.max(
      maxNormalizedObservationBytes,
      measurement.normalizedBytes,
    );
    for (const target of measurement.targets) {
      const actionableIndex = unmatchedActionableTargets.indexOf(target);
      if (actionableIndex >= 0) {
        unmatchedActionableTargets.splice(actionableIndex, 1);
        matchedTargets += 1;
        continue;
      }
      falseInteractableTargets += 1;
      const falseIndex = unmatchedFalseTargets.indexOf(target);
      if (falseIndex >= 0) unmatchedFalseTargets.splice(falseIndex, 1);
      else {
        unclassifiedTargets.push(`${benchmarkCase.id}:${target.replace('\0', ':')}`);
      }
    }
  }
  assert.deepEqual(unclassifiedTargets, []);

  const report = {
    schemaVersion: 1,
    corpus: {
      observationCases: BROWSER_CAPABILITY_BENCHMARK_CASES.length,
      actionFailureCases: BROWSER_CAPABILITY_ACTION_FAILURE_CASES.length,
      staleRefCases: BROWSER_CAPABILITY_STALE_REF_CASES.length,
    },
    observableTargetRecall: { matchedTargets, expectedTargets },
    falseInteractableRate: { falseInteractableTargets, observedTargets },
    actionFailureDetection: {
      detectedFailures: detectedActionFailures.size,
      expectedFailures: BROWSER_CAPABILITY_ACTION_FAILURE_CASES.length,
    },
    staleRefDetection: {
      detectedStaleRefs: detectedStaleRefs.size,
      expectedStaleRefs: BROWSER_CAPABILITY_STALE_REF_CASES.length,
    },
    outputSize: {
      samples: benchmarkObservations.size,
      maxNormalizedObservationBytes,
      protocolBudgetBytes: OBSERVATION_V1_LIMITS.maxSerializedBytes,
    },
  };
  t.diagnostic(`browser capability metrics: ${JSON.stringify(report)}`);
  const baseline = JSON.parse(await readFile(
    new URL('./baselines/browser-capability.v1.json', import.meta.url),
    'utf8',
  ));
  assert.equal(baseline.schemaVersion, report.schemaVersion);
  assert.deepEqual(report.corpus, baseline.corpus);
  assert.equal(baseline.outputSize.samples, benchmarkObservations.size);
  assert.equal(
    baseline.outputSize.protocolBudgetBytes,
    OBSERVATION_V1_LIMITS.maxSerializedBytes,
  );

  const rateAtLeast = (current, currentTotal, recorded, recordedTotal) => (
    current * recordedTotal >= recorded * currentTotal
  );
  const rateAtMost = (current, currentTotal, recorded, recordedTotal) => (
    current * recordedTotal <= recorded * currentTotal
  );
  assert.ok(rateAtLeast(
    matchedTargets,
    expectedTargets,
    baseline.observableTargetRecall.matchedTargets,
    baseline.observableTargetRecall.expectedTargets,
  ), 'observable target recall regressed');
  assert.ok(rateAtMost(
    falseInteractableTargets,
    observedTargets,
    baseline.falseInteractableRate.falseInteractableTargets,
    baseline.falseInteractableRate.observedTargets,
  ), 'false interactable rate increased');
  assert.ok(rateAtLeast(
    detectedActionFailures.size,
    BROWSER_CAPABILITY_ACTION_FAILURE_CASES.length,
    baseline.actionFailureDetection.detectedFailures,
    baseline.actionFailureDetection.expectedFailures,
  ), 'action failure detection regressed');
  assert.ok(rateAtLeast(
    detectedStaleRefs.size,
    BROWSER_CAPABILITY_STALE_REF_CASES.length,
    baseline.staleRefDetection.detectedStaleRefs,
    baseline.staleRefDetection.expectedStaleRefs,
  ), 'stale ref detection regressed');
  assert.ok(
    maxNormalizedObservationBytes <= baseline.outputSize.maxNormalizedObservationBytes,
    'normalized Observation output exceeded the recorded baseline',
  );
  assert.ok(
    maxNormalizedObservationBytes <= OBSERVATION_V1_LIMITS.maxSerializedBytes,
    'normalized Observation output exceeded the protocol budget',
  );
});
