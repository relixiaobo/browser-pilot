// Real-world site integration tests against the-internet.herokuapp.com
// These test bp against actual web pages with real CSS, JS frameworks, and server responses.
import { test, expect } from '@playwright/test';
import {
  open as bpOpen,
  click,
  type as bpType,
  evaluate,
  snapshot,
  press,
  findRef,
  findRefByRole,
  bp,
  type BpResult,
} from './bp.js';
import { waitForEvaluation } from './helpers/playwright.js';

const SITE = 'https://the-internet.herokuapp.com';
let availabilityError: string | undefined;

test.beforeAll(async ({ request }) => {
  try {
    const response = await request.get(SITE, { timeout: 10_000 });
    if (!response.ok()) availabilityError = `HTTP ${response.status()}`;
  } catch (error) {
    availabilityError = error instanceof Error ? error.message : String(error);
  }
});

test.beforeEach(() => {
  test.skip(
    availabilityError !== undefined,
    `third_party_unavailable: ${(availabilityError ?? '').slice(0, 300)}`,
  );
});

function open(url: string): BpResult {
  const result = bpOpen(url);
  if (!result.ok && /net::ERR_|timed?\s*out|timeout|ENOTFOUND|ECONNRESET|ECONNREFUSED/i.test(
    result.error ?? '',
  )) {
    test.skip(true, `third_party_unavailable: ${(result.error ?? 'navigation failed').slice(0, 300)}`);
  }
  return result;
}

// ── Checkboxes ──────────────────────────────────────

test.describe('checkboxes', () => {
  test('should find and toggle checkboxes', async () => {
    const snap = open(`${SITE}/checkboxes`);
    expect(snap.ok).toBe(true);
    const checks = snap.elements?.filter(e => e.role === 'checkbox') || [];
    expect(checks.length).toBe(2);
    // Toggle first checkbox
    const ref = checks[0].ref;
    const before = checks[0].checked;
    click(ref);
    const snap2 = snapshot();
    const after = snap2.elements?.find(e => e.ref === ref)?.checked;
    expect(after).not.toBe(before);
  });
});

// ── Dropdown ────────────────────────────────────────

test.describe('dropdown', () => {
  test('should find select element', async () => {
    const snap = open(`${SITE}/dropdown`);
    expect(snap.ok).toBe(true);
    const select = snap.elements?.find(e => e.role === 'combobox');
    expect(select).toBeDefined();
  });

  test('should change dropdown value via eval', async () => {
    open(`${SITE}/dropdown`);
    // Use eval to set value (bp doesn't have native select support yet)
    evaluate('document.getElementById("dropdown").value = "1"; document.getElementById("dropdown").dispatchEvent(new Event("change"))');
    const val = evaluate('document.getElementById("dropdown").value');
    expect(val.value).toBe('1');
  });
});

// ── Key Presses ─────────────────────────────────────

test.describe('key presses', () => {
  test('should detect key press events', async () => {
    const snap = open(`${SITE}/key_presses`);
    expect(snap.ok).toBe(true);
    const ref = findRefByRole(snap, 'textbox');
    expect(ref).toBeDefined();
    click(ref!); // focus
    press('a');
    const result = evaluate('document.getElementById("result").textContent');
    expect(result.value).toContain('A');
  });
});

// ── Dynamic Controls ────────────────────────────────

test.describe('dynamic controls', () => {
  test('should find checkbox and remove button', async () => {
    const snap = open(`${SITE}/dynamic_controls`);
    expect(snap.ok).toBe(true);
    const hasCheckbox = snap.elements?.some(e => e.role === 'checkbox');
    const hasRemoveBtn = snap.elements?.some(e => e.name?.includes('Remove'));
    expect(hasCheckbox).toBe(true);
    expect(hasRemoveBtn).toBe(true);
  });

  test('should click Remove and verify checkbox gone', async () => {
    const snap = open(`${SITE}/dynamic_controls`);
    const removeRef = findRef(snap, 'Remove');
    expect(removeRef).toBeDefined();
    click(removeRef!);
    await waitForEvaluation('document.querySelector("#checkbox-example input") === null', undefined, 6_000);
    const snap2 = snapshot();
    const hasCheckbox = snap2.elements?.some(e => e.role === 'checkbox');
    // Checkbox should be gone after Remove
    expect(hasCheckbox).toBe(false);
  });

  test('should enable disabled input', async () => {
    const snap = open(`${SITE}/dynamic_controls`);
    const enableRef = findRef(snap, 'Enable');
    expect(enableRef).toBeDefined();
    click(enableRef!);
    const enabled = await waitForEvaluation(
      'document.querySelector("#input-example input")?.disabled === false',
      undefined,
      6_000,
    );
    expect(enabled.value).toBe(true);
    // Now the input should be enabled and typeable
    const snap2 = snapshot();
    const inputRef = snap2.elements?.find(e => e.role === 'textbox');
    expect(inputRef).toBeDefined();
    const result = bpType(inputRef!.ref, 'enabled text');
    expect(result.ok).toBe(true);
  });
});

// ── Shadow DOM ──────────────────────────────────────

test.describe('shadow DOM', () => {
  test('should detect shadow DOM content', async () => {
    const snap = open(`${SITE}/shadowdom`);
    expect(snap.ok).toBe(true);
    // The page has shadow DOM elements — check if bp can see any content
    const elements = snap.elements || [];
    console.log('Shadow DOM page elements:', JSON.stringify(elements.map(e => `${e.role}:"${e.name}"`)));
  });
});

// ── File Upload ─────────────────────────────────────

test.describe('file upload', () => {
  test('should find upload elements', async () => {
    const snap = open(`${SITE}/upload`);
    expect(snap.ok).toBe(true);
    // Should find file input and submit button
    const hasButton = snap.elements?.some(e => e.role === 'button');
    expect(hasButton).toBe(true);
  });
});

// ── Inputs ──────────────────────────────────────────

test.describe('inputs', () => {
  test('should type into number input', async () => {
    const snap = open(`${SITE}/inputs`);
    expect(snap.ok).toBe(true);
    const ref = findRefByRole(snap, 'spinbutton') || findRefByRole(snap, 'textbox');
    expect(ref).toBeDefined();
    const result = bpType(ref!, '42');
    expect(result.ok).toBe(true);
  });
});

// ── Nested Frames ───────────────────────────────────

test.describe('nested frames', () => {
  test('should list frames', async () => {
    open(`${SITE}/nested_frames`);
    const result = bp('frame');
    expect(result.ok).toBe(true);
    // Should find multiple frames
    const frames = result.frames || [];
    expect(frames.length).toBeGreaterThan(1);
    console.log('Nested frames:', JSON.stringify(frames.map((f: any) => f.url)));
  });
});

// ── Dynamic Loading ─────────────────────────────────

test.describe('dynamic loading', () => {
  test('should handle dynamically loaded element', async () => {
    const snap = open(`${SITE}/dynamic_loading/1`);
    expect(snap.ok).toBe(true);
    const startRef = findRef(snap, 'Start');
    expect(startRef).toBeDefined();
    click(startRef!);
    await waitForEvaluation(
      'document.getElementById("finish")?.textContent?.includes("Hello World")',
      undefined,
      8_000,
    );
    const result = evaluate('document.getElementById("finish")?.textContent');
    expect(result.value).toContain('Hello World');
  });
});

// ── TinyMCE Editor (iframe contenteditable) ─────────

test.describe('TinyMCE editor', () => {
  test('should find TinyMCE iframe', async () => {
    const snap = open(`${SITE}/tinymce`);
    expect(snap.ok).toBe(true);
    // TinyMCE uses an iframe — check if we can find it via frames
    const frames = bp('frame');
    console.log('TinyMCE frames:', JSON.stringify(frames.frames?.map((f: any) => f.url)));
    expect(frames.ok).toBe(true);
    // Should have at least the main frame + TinyMCE iframe
    expect(frames.frames?.length).toBeGreaterThan(1);
  });

  test('should type into TinyMCE via iframe', async () => {
    open(`${SITE}/tinymce`);
    const frames = bp('frame');
    expect(frames.frames?.length).toBeGreaterThan(1);
    expect(bp('frame 1').ok).toBe(true);
    try {
      const editable = evaluate('document.body.isContentEditable');
      test.skip(
        editable.value !== true,
        'third_party_drift: TinyMCE rendered its external demo editor as read-only',
      );
      const editor = snapshot().elements?.find(element => element.role === 'textbox');
      expect(editor).toBeDefined();
      expect(bpType(editor!.ref, 'Browser Pilot iframe input').ok).toBe(true);
    } finally {
      expect(bp('frame 0').ok).toBe(true);
    }
  });
});

// ── Large DOM ───────────────────────────────────────

test.describe('large DOM', () => {
  test('should handle large page without timeout', async () => {
    const snap = open(`${SITE}/large`);
    expect(snap.ok).toBe(true);
    // Should still return elements within timeout
    expect(snap.elements).toBeDefined();
  });
});
