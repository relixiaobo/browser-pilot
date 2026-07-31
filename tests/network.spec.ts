// Network interception tests for bp net
// Tests block, mock, headers, rules management, request monitoring, and request details.
import { test, expect } from '@playwright/test';
import { open, click, evaluate, findRef, bp } from './bp.js';
import {
  TEST_BASE_URL as BASE,
  waitForEvaluation,
  waitForValue,
} from './helpers/playwright.js';

// ── Setup / Teardown ────────────────────────────────

test.beforeEach(async () => {
  bp('net remove --all');
  bp('net clear');
});

test.afterAll(async () => {
  bp('net remove --all');
  bp('net clear');
});

/** Open net test page and return snapshot with refs */
function openNetPage() {
  const snap = open(`${BASE}/net/test`);
  expect(snap.ok).toBe(true);
  return snap;
}

async function waitForRequest(urlFragment: string, method?: string) {
  const net = await waitForValue(
    () => bp('net'),
    result => result.requests?.some((request: any) => (
      request.url.includes(urlFragment) && (!method || request.method === method)
    )),
  );
  return net.requests?.find((request: any) => (
    request.url.includes(urlFragment) && (!method || request.method === method)
  ));
}

// ── Request Monitoring ──────────────────────────────

test.describe('request monitoring', () => {
  test('should capture navigation requests', async () => {
    bp('net clear');
    openNetPage();
    const net = bp('net');
    expect(net.ok).toBe(true);
    expect(net.requests?.length).toBeGreaterThan(0);
    const navReq = net.requests?.find((r: any) => r.url.includes('/net/test'));
    expect(navReq).toBeDefined();
  });

  test('should capture fetch requests', async () => {
    const snap = openNetPage();
    bp('net clear');
    const fetchRef = findRef(snap, 'Fetch Data');
    expect(fetchRef).toBeDefined();
    click(fetchRef!);
    const apiReq = await waitForRequest('/api/data');
    expect(apiReq).toBeDefined();
    expect(apiReq?.method).toBe('GET');
  });

  test('should capture POST requests', async () => {
    const snap = openNetPage();
    bp('net clear');
    const postRef = findRef(snap, 'POST Data');
    expect(postRef).toBeDefined();
    click(postRef!);
    const postReq = await waitForRequest('/api/post', 'POST');
    expect(postReq).toBeDefined();
    expect(postReq?.method).toBe('POST');
  });

  test('should filter by URL pattern', async () => {
    const snap = openNetPage();
    const fetchRef = findRef(snap, 'Fetch Data');
    click(fetchRef!);
    const filtered = await waitForValue(
      () => bp('net --url "*api/data*"'),
      result => result.requests?.some((request: any) => request.url.includes('/api/data')),
    );
    expect(filtered.ok).toBe(true);
    for (const r of filtered.requests || []) {
      expect(r.url).toContain('api/data');
    }
  });

  test('should filter by HTTP method', async () => {
    const snap = openNetPage();
    click(findRef(snap, 'Fetch Data')!);
    click(findRef(snap, 'POST Data')!);
    const postOnly = await waitForValue(
      () => bp('net --method POST'),
      result => result.requests?.some((request: any) => request.url.includes('/api/post')),
    );
    expect(postOnly.ok).toBe(true);
    for (const r of postOnly.requests || []) {
      expect(r.method).toBe('POST');
    }
  });

  test('net clear should remove captured requests', async () => {
    openNetPage();
    bp('net clear');
    const net = bp('net');
    expect(net.requests?.length).toBe(0);
  });
});

// ── Block Rules ─────────────────────────────────────

test.describe('block', () => {
  test('should block tracking script', async () => {
    bp('net block "*tracking*"');
    const snap = openNetPage();
    bp('net clear');
    const trackRef = findRef(snap, 'Load Tracker');
    expect(trackRef).toBeDefined();
    click(trackRef!);
    await waitForEvaluation('document.getElementById("result")?.textContent === "not tracked"');
    const tracked = evaluate('window.__tracked');
    expect(tracked.value).not.toBe(true);
  });

  test('should block API requests causing fetch failure', async () => {
    bp('net block "*api/data*"');
    openNetPage();
    evaluate('window.__fetchDone=false;fetch("/api/data").then(()=>{window.__fetchOk=true;window.__fetchDone=true}).catch(()=>{window.__fetchOk=false;window.__fetchDone=true})');
    await waitForEvaluation('window.__fetchDone === true', undefined, 3_000);
    const result = evaluate('window.__fetchOk');
    expect(result.value).toBe(false);
  });
});

// ── Mock Rules ──────────────────────────────────────

test.describe('mock', () => {
  test('should mock response body', async () => {
    bp('net mock "*api/data*" --body \'{"mocked":true}\'');
    openNetPage();
    evaluate('fetch("/api/data").then(r=>r.json()).then(d=>{window.__mockResult=d})');
    await waitForEvaluation('window.__mockResult?.mocked === true');
    const result = evaluate('JSON.stringify(window.__mockResult)');
    expect(result.value).toContain('mocked');
  });

  test('should mock with custom body content', async () => {
    bp('net mock "*api/data*" --body \'{"err":"nope"}\'');
    openNetPage();
    evaluate('fetch("/api/data").then(r=>r.json()).then(d=>{window.__b=d})');
    await waitForEvaluation('window.__b?.err === "nope"');
    const body = evaluate('JSON.stringify(window.__b)');
    expect(body.value).toContain('nope');
  });

  test('should mock intercept page fetch and show in DOM', async () => {
    bp('net mock "*api/data*" --body \'{"source":"mock","value":42}\'');
    const snap = openNetPage();
    const fetchRef = findRef(snap, 'Fetch Data');
    click(fetchRef!);
    await waitForEvaluation('document.getElementById("result")?.textContent?.includes("mock")');
    const display = evaluate('document.getElementById("result").textContent');
    expect(display.value).toContain('mock');
    expect(display.value).toContain('42');
  });
});

// ── Header Rules ────────────────────────────────────

test.describe('headers', () => {
  test('should add custom request header', async () => {
    bp('net headers "*api/headers*" "X-Custom:test-value"');
    openNetPage();
    evaluate('fetch("/api/headers").then(r=>r.json()).then(d=>{window.__h=d})');
    await waitForEvaluation('window.__h?.headers?.["x-custom"] === "test-value"');
    const result = evaluate('JSON.stringify(window.__h)');
    expect(result.value).toContain('x-custom');
    expect(result.value).toContain('test-value');
  });

  test('should add multiple headers', async () => {
    bp('net headers "*api/headers*" "X-First:one" "X-Second:two"');
    openNetPage();
    evaluate('fetch("/api/headers").then(r=>r.json()).then(d=>{window.__h=d})');
    await waitForEvaluation('window.__h?.headers?.["x-first"] === "one" && window.__h?.headers?.["x-second"] === "two"');
    const result = evaluate('JSON.stringify(window.__h)');
    expect(result.value).toContain('x-first');
    expect(result.value).toContain('x-second');
  });
});

// ── Rule Management ─────────────────────────────────

test.describe('rule management', () => {
  test('should list active rules', async () => {
    bp('net block "*block1*"');
    bp('net block "*block2*"');
    bp('net mock "*mock1*" --body "{}"');
    const rules = bp('net rules');
    expect(rules.ok).toBe(true);
    expect(rules.rules?.length).toBe(3);
  });

  test('should remove specific rule by ID', async () => {
    const rule1 = bp('net block "*pattern1*"');
    bp('net block "*pattern2*"');
    const removeResult = bp(`net remove ${rule1.rule?.id}`);
    expect(removeResult.ok).toBe(true);
    const rules = bp('net rules');
    expect(rules.rules?.length).toBe(1);
  });

  test('should remove all rules', async () => {
    bp('net block "*a*"');
    bp('net block "*b*"');
    bp('net mock "*c*" --body "{}"');
    const removeAll = bp('net remove --all');
    expect(removeAll.ok).toBe(true);
    const rules = bp('net rules');
    expect(rules.rules?.length).toBe(0);
  });
});

// ── Request Details ─────────────────────────────────

test.describe('request details', () => {
  test('should show full request details', async () => {
    const snap = openNetPage();
    bp('net clear');
    const fetchRef = findRef(snap, 'Fetch Data');
    click(fetchRef!);
    const apiReq = await waitForRequest('/api/data');
    expect(apiReq).toBeDefined();
    const detail = bp(`net show ${apiReq!.id}`);
    expect(detail.ok).toBe(true);
    expect(detail.url).toContain('/api/data');
    expect(detail.status).toBe(200);
  });
});

// ── Combined scenarios ──────────────────────────────

test.describe('combined', () => {
  test('block + mock on different patterns should coexist', async () => {
    bp('net block "*tracking*"');
    bp('net mock "*api/data*" --body \'{"combined":true}\'');
    const snap = openNetPage();

    // Verify mock
    evaluate('fetch("/api/data").then(r=>r.json()).then(d=>{window.__combined=d})');
    await waitForEvaluation('window.__combined?.combined === true');
    const mockResult = evaluate('JSON.stringify(window.__combined)');
    expect(mockResult.value).toContain('combined');

    // Verify block
    const trackRef = findRef(snap, 'Load Tracker');
    click(trackRef!);
    await waitForEvaluation('document.getElementById("result")?.textContent === "not tracked"');
    const tracked = evaluate('window.__tracked');
    expect(tracked.value).not.toBe(true);
  });

  test('should work across page navigations', async () => {
    bp('net mock "*api/data*" --body \'{"persistent":true}\'');
    openNetPage();
    evaluate('fetch("/api/data").then(r=>r.json()).then(d=>{window.__persist=d})');
    await waitForEvaluation('window.__persist?.persistent === true');
    const result = evaluate('JSON.stringify(window.__persist)');
    expect(result.value).toContain('persistent');
  });
});
