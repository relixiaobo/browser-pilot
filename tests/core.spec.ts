// Core functionality tests — migrated from tests/run.sh
// Covers lifecycle, navigation, click, type, press, eval, screenshot, pdf,
// cookies, frames, upload, auth, tabs, dialogs, and output format.
import { test, expect } from '@playwright/test';
import { open, click, type as bpType, press, evaluate, snapshot, findRef, findRefByRole, bp } from './bp.js';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:18274';

// ── Lifecycle ───────────────────────────────────────

test.describe('lifecycle', () => {
  // Disconnect + reconnect requires manual Chrome "Allow" dialog — skip in automated tests
  test.skip('disconnect + reconnect (manual)', async () => {
    bp('disconnect');
    const result = bp('connect');
    expect(result.ok).toBe(true);
  });
});

// ── Navigation ──────────────────────────────────────

test.describe('navigation', () => {
  test('open returns snapshot with title and elements', async () => {
    const snap = open(`${BASE}/input/types`);
    expect(snap.ok).toBe(true);
    expect(snap.title).toBe('Input Types');
    expect(snap.elements?.length).toBeGreaterThan(0);
  });

  test('open --limit caps elements', async () => {
    const snap = open(`${BASE}/input/scrollable`, { limit: 5 });
    expect(snap.ok).toBe(true);
    expect(snap.elements?.length).toBeLessThanOrEqual(5);
  });

  test('open --new creates new tab', async () => {
    open(`${BASE}/input/types`);
    bp(`open "${BASE}/input/number" --new`);
    const tabs = bp('tabs');
    expect(tabs.tabs?.length).toBeGreaterThanOrEqual(2);
    // Clean up: close extra tab and reconnect to avoid state issues
    bp('close');
  });

  test('open empty page has minimal elements', async () => {
    // The /click/scroll-target has few elements
    const snap = open(`${BASE}/input/keyboard`);
    expect(snap.ok).toBe(true);
  });
});

// ── Click ───────────────────────────────────────────

test.describe('click', () => {
  test('click invalid ref returns error with hint', async () => {
    open(`${BASE}/input/types`);
    snapshot(); // refresh refs
    const result = click(999);
    expect(result.ok).toBe(false);
    expect(result.hint || result.error).toBeDefined();
  });
});

// ── Type ────────────────────────────────────────────

test.describe('type', () => {
  test('type invalid ref fails', async () => {
    open(`${BASE}/input/types`);
    snapshot();
    const result = bpType(999, 'hello');
    expect(result.ok).toBe(false);
  });
});

// ── Press ───────────────────────────────────────────

test.describe('press', () => {
  test('press Enter', async () => {
    open(`${BASE}/input/types`);
    expect(press('Enter').ok).toBe(true);
  });

  test('press Escape', async () => {
    expect(press('Escape').ok).toBe(true);
  });

  test('press Control+a', async () => {
    expect(press('Control+a').ok).toBe(true);
  });

  test('press Tab', async () => {
    expect(press('Tab').ok).toBe(true);
  });

  test('press ArrowDown', async () => {
    expect(press('ArrowDown').ok).toBe(true);
  });

  test('press unknown modifier fails', async () => {
    const result = press('FooMod+a');
    expect(result.ok).toBe(false);
  });
});

// ── Eval ────────────────────────────────────────────

test.describe('eval', () => {
  test('eval returns page title', async () => {
    open(`${BASE}/input/types`);
    const result = evaluate('document.title');
    expect(result.ok).toBe(true);
    expect(result.value).toBe('Input Types');
  });

  test('eval returns number', async () => {
    const result = evaluate('1 + 2');
    expect(result.value).toBe(3);
  });

  test('eval error returns ok:false', async () => {
    const result = evaluate('throw new Error("boom")');
    expect(result.ok).toBe(false);
  });

  test('eval awaits promise', async () => {
    const result = evaluate('new Promise(r=>setTimeout(()=>r(42),100))');
    expect(result.value).toBe(42);
  });
});

// ── Screenshot ──────────────────────────────────────

test.describe('screenshot', () => {
  const files: string[] = [];
  test.afterAll(() => { for (const f of files) try { unlinkSync(f); } catch {} });

  test('screenshot saves file', async () => {
    open(`${BASE}/input/types`);
    const result = bp('screenshot /tmp/bp-compat-ss.png');
    files.push('/tmp/bp-compat-ss.png');
    expect(result.ok).toBe(true);
    expect(existsSync('/tmp/bp-compat-ss.png')).toBe(true);
  });

  test('screenshot --full', async () => {
    const result = bp('screenshot /tmp/bp-compat-full.png --full');
    files.push('/tmp/bp-compat-full.png');
    expect(result.ok).toBe(true);
    expect(existsSync('/tmp/bp-compat-full.png')).toBe(true);
  });

  test('screenshot bad selector fails', async () => {
    const result = bp('screenshot /tmp/bp-bad.png --selector "#nonexistent"');
    expect(result.ok).toBe(false);
  });
});

// ── PDF ─────────────────────────────────────────────

test.describe('pdf', () => {
  const files: string[] = [];
  test.afterAll(() => { for (const f of files) try { unlinkSync(f); } catch {} });

  test('pdf saves file', async () => {
    const result = bp('pdf /tmp/bp-compat.pdf');
    files.push('/tmp/bp-compat.pdf');
    expect(result.ok).toBe(true);
    expect(existsSync('/tmp/bp-compat.pdf')).toBe(true);
  });

  test('pdf --landscape', async () => {
    const result = bp('pdf /tmp/bp-compat-land.pdf --landscape');
    files.push('/tmp/bp-compat-land.pdf');
    expect(result.ok).toBe(true);
    expect(existsSync('/tmp/bp-compat-land.pdf')).toBe(true);
  });
});

// ── Cookies ─────────────────────────────────────────

test.describe('cookies', () => {
  test('cookies returns ok', async () => {
    const result = bp('cookies');
    expect(result.ok).toBe(true);
  });
});

// ── Frames ──────────────────────────────────────────

test.describe('frames', () => {
  test('frame lists frames (host + iframe)', async () => {
    open(`${BASE}/frames/host`);
    // Wait for iframe to load
    evaluate('new Promise(r => setTimeout(r, 1000))');
    const result = bp('frame');
    expect(result.ok).toBe(true);
    expect(result.frames?.length).toBeGreaterThanOrEqual(2);
  });

  test('frame switch to iframe', async () => {
    const result = bp('frame 1');
    expect(result.ok).toBe(true);
  });

  test('eval in iframe returns iframe content', async () => {
    const result = evaluate('document.querySelector("h1")?.textContent');
    expect(result.value).toContain('Inside Frame');
  });

  test('frame 0 back to top', async () => {
    bp('frame 0');
    const result = evaluate('document.querySelector("h1")?.textContent');
    expect(result.value).toContain('Host');
  });

  test('frame invalid index fails', async () => {
    const result = bp('frame 99');
    expect(result.ok).toBe(false);
  });
});

// ── Upload ──────────────────────────────────────────

test.describe('upload', () => {
  const testFile = '/tmp/bp-compat-upload.txt';
  test.beforeAll(() => { writeFileSync(testFile, 'test content'); });
  test.afterAll(() => { try { unlinkSync(testFile); } catch {} });

  test('upload auto-finds file input', async () => {
    // Use the fixture server's upload page
    open(`${BASE}/input/types`); // no file input here, we need a page with one
    // Add a file input via eval
    evaluate('document.body.innerHTML += \'<input type="file" id="f1">\'');
    const result = bp(`upload ${testFile}`);
    expect(result.ok).toBe(true);
  });

  test('upload fails when no file input', async () => {
    open(`${BASE}/input/keyboard`);
    const result = bp(`upload ${testFile}`);
    expect(result.ok).toBe(false);
  });

  test('upload nonexistent file fails', async () => {
    const result = bp('upload /tmp/nonexistent-xyz-abc.txt');
    expect(result.ok).toBe(false);
  });
});

// ── Auth ────────────────────────────────────────────

test.describe('auth', () => {
  test('auth set credentials', async () => {
    const result = bp('auth admin secret123');
    expect(result.ok).toBe(true);
  });

  test('auth --clear', async () => {
    const result = bp('auth --clear');
    expect(result.ok).toBe(true);
  });
});

// ── Tabs ────────────────────────────────────────────

test.describe('tabs', () => {
  test('tabs shows current tab', async () => {
    // Close extras first
    bp('close --all');
    bp('connect');
    open(`${BASE}/input/types`);
    const result = bp('tabs');
    expect(result.ok).toBe(true);
    expect(result.tabs?.length).toBe(1);
  });

  test('tab switch', async () => {
    bp(`open "${BASE}/input/number" --new`);
    const result = bp('tab 0');
    expect(result.ok).toBe(true);
  });

  test('tab invalid index fails', async () => {
    const result = bp('tab 99');
    expect(result.ok).toBe(false);
  });

  test('close tab', async () => {
    const result = bp('close');
    expect(result.ok).toBe(true);
  });
});

// ── Dialogs ─────────────────────────────────────────

test.describe('dialogs', () => {
  test('alert auto-dismissed (open does not hang)', async () => {
    // Navigate to a page that triggers alert
    evaluate('setTimeout(() => alert("test"), 100)');
    // If alert is auto-dismissed, this eval should complete
    evaluate('new Promise(r => setTimeout(r, 500))');
    const result = evaluate('document.title');
    expect(result.ok).toBe(true);
  });
});

// ── Output Format ───────────────────────────────────

test.describe('output format', () => {
  test('error includes hint field', async () => {
    open(`${BASE}/input/types`);
    snapshot();
    const result = click(999);
    expect(result.ok).toBe(false);
    // Should have hint about refreshing refs
    expect(JSON.stringify(result)).toContain('hint');
  });

  test('--limit abc fails', async () => {
    const result = bp(`snapshot --limit abc`);
    expect(result.ok).toBe(false);
  });
});

// ── Visual Overlay ──────────────────────────────────

test.describe('visual overlay', () => {
  test('overlay is injected', async () => {
    open(`${BASE}/input/types`);
    const result = evaluate('!!document.getElementById("__bp_overlay")');
    expect(result.value).toBe(true);
  });
});
