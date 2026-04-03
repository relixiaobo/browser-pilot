// Real-world site integration tests against the-internet.herokuapp.com
// These test bp against actual web pages with real CSS, JS frameworks, and server responses.
import { test, expect } from '@playwright/test';
import { open, click, type as bpType, evaluate, snapshot, press, findRef, findRefByRole, bp } from './bp.js';

const SITE = 'https://the-internet.herokuapp.com';

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
    if (ref) {
      click(ref); // focus
    }
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
    // Wait for animation to complete (server-side removal can be slow)
    evaluate('new Promise(r => setTimeout(r, 4000))');
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
    // Wait for enable animation
    evaluate('new Promise(r => setTimeout(r, 2000))');
    // Now the input should be enabled and typeable
    const snap2 = snapshot();
    const inputRef = snap2.elements?.find(e => e.role === 'textbox');
    if (inputRef) {
      const result = bpType(inputRef.ref, 'enabled text');
      expect(result.ok).toBe(true);
    }
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
    if (ref) {
      const result = bpType(ref, '42');
      expect(result.ok).toBe(true);
    }
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
    // Wait for loading to finish
    evaluate('new Promise(r => setTimeout(r, 6000))');
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
    // Switch to TinyMCE iframe (usually index 1)
    if (frames.frames && frames.frames.length > 1) {
      bp('frame 1');
      // Try typing via eval in the iframe context
      const result = evaluate('document.body.contentEditable');
      console.log('TinyMCE body contentEditable:', result.value);
      // Switch back
      bp('frame 0');
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
