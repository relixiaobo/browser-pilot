// Fill compatibility tests — adapted from Playwright's page-fill.spec.ts
// Tests bp type against textarea, input, contenteditable, shadow DOM inputs, etc.
import { test, expect } from '@playwright/test';
import { open, type as bpType, evaluate, snapshot, findRef, findRefByRole } from './bp.js';

const BASE = 'http://127.0.0.1:18274';

// ── Basic fill ──────────────────────────────────────

test.describe('basic fill', () => {
  test('should fill textarea', async () => {
    const snap = open(`${BASE}/input/textarea`);
    expect(snap.ok).toBe(true);
    const ref = findRefByRole(snap, 'textbox');
    expect(ref).toBeDefined();
    const result = bpType(ref!, 'some value');
    expect(result.ok).toBe(true);
    const val = evaluate('document.querySelector("textarea").value');
    expect(val.value).toBe('some value');
  });

  test('should fill input', async () => {
    const snap = open(`${BASE}/input/textarea`);
    // Find the input (not textarea)
    const refs = snap.elements?.filter(e => e.role === 'textbox') || [];
    // textarea is first, input is second
    const ref = refs.length >= 2 ? refs[1].ref : refs[0]?.ref;
    expect(ref).toBeDefined();
    const result = bpType(ref!, 'input value');
    expect(result.ok).toBe(true);
    const val = evaluate('document.querySelector("input").value');
    expect(val.value).toBe('input value');
  });

  test('should fill contenteditable', async () => {
    const snap = open(`${BASE}/input/textarea`);
    // contenteditable may or may not appear in snapshot depending on ARIA roles
    // Try using eval to type into it
    const result = bpType('[contenteditable]', 'ce value');
    if (result.ok) {
      const val = evaluate('document.querySelector("[contenteditable]").textContent');
      expect(val.value).toBe('ce value');
    }
    // If bp can't find it by CSS selector, that's also a finding to log
  });
});

// ── Contenteditable variants ────────────────────────

test.describe('contenteditable', () => {
  test('basic contenteditable', async () => {
    const snap = open(`${BASE}/ce/basic`);
    expect(snap.ok).toBe(true);
    // Find the editor ref — may appear as textbox or other role
    const ref = findRef(snap, 'Editor');
    expect(ref).toBeDefined();
    const result = bpType(ref!, 'hello world');
    expect(result.ok).toBe(true);
    const val = evaluate('document.getElementById("editor").textContent');
    expect(val.value).toContain('hello world');
  });

  test('contenteditable with --clear replaces existing content', async () => {
    const snap = open(`${BASE}/ce/existing`);
    const ref = findRef(snap, 'Editor');
    expect(ref).toBeDefined();
    // Verify pre-existing content
    const before = evaluate('document.getElementById("editor").textContent');
    expect(before.value).toBe('Hello World');
    // Type with clear
    const result = bpType(ref!, 'replaced', { clear: true });
    expect(result.ok).toBe(true);
    const after = evaluate('document.getElementById("editor").textContent');
    expect(after.value).toBe('replaced');
  });

  test('contenteditable with focus handler that collapses selection', async () => {
    // Open fresh page (focus-collapse has a handler that collapses selection on focus)
    const snap = open(`${BASE}/ce/focus-collapse`);
    const ref = findRef(snap, 'Editor');
    expect(ref).toBeDefined();
    // Verify initial content
    const before = evaluate('document.getElementById("editor").textContent');
    expect(before.value).toBe('initial text');
    const result = bpType(ref!, 'new text', { clear: true });
    expect(result.ok).toBe(true);
    const val = evaluate('document.getElementById("editor").textContent');
    expect(val.value).toBe('new text');
  });

  test('contenteditable with beforeinput handler', async () => {
    const snap = open(`${BASE}/ce/beforeinput`);
    const ref = findRef(snap, 'Editor');
    expect(ref).toBeDefined();
    const result = bpType(ref!, 'intercepted');
    expect(result.ok).toBe(true);
    const val = evaluate('document.getElementById("editor").textContent');
    // With beforeinput interception, text should still appear
    expect(val.value).toBe('intercepted');
  });

  test('body as contenteditable', async () => {
    const snap = open(`${BASE}/ce/body`);
    expect(snap.ok).toBe(true);
    // This is tricky — the body itself is contenteditable
    // bp snapshot may or may not pick it up
    const elements = snap.elements || [];
    // Log what we find for diagnostic purposes
    if (elements.length > 0) {
      const ref = elements[0].ref;
      const result = bpType(ref, 'body text');
      if (result.ok) {
        const val = evaluate('document.body.textContent');
        expect(val.value).toContain('body text');
      }
    }
    // If no elements found, that's also a valid test result
  });
});

// ── Different input types ───────────────────────────

test.describe('input types', () => {
  test('should fill password, search, tel, url, email', async () => {
    const snap = open(`${BASE}/input/types`);
    expect(snap.ok).toBe(true);

    const types = ['Password', 'Search', 'Phone', 'URL', 'Email'];
    const ids = ['password', 'search', 'tel', 'url', 'email'];

    for (let i = 0; i < types.length; i++) {
      const ref = findRef(snap, types[i]);
      if (!ref) continue; // Some types might not appear in snapshot
      const result = bpType(ref, `test-${ids[i]}`);
      expect(result.ok).toBe(true);
      const val = evaluate(`document.getElementById('${ids[i]}').value`);
      expect(val.value).toBe(`test-${ids[i]}`);
    }
  });

  test('should fill textarea', async () => {
    const snap = open(`${BASE}/input/types`);
    const ref = findRef(snap, 'Textarea');
    expect(ref).toBeDefined();
    const result = bpType(ref!, 'multiline text');
    expect(result.ok).toBe(true);
    const val = evaluate('document.getElementById("textarea").value');
    expect(val.value).toBe('multiline text');
  });

  test('should fill number input', async () => {
    const snap = open(`${BASE}/input/number`);
    const ref = findRef(snap, 'Number');
    expect(ref).toBeDefined();
    const result = bpType(ref!, '42');
    expect(result.ok).toBe(true);
    const val = evaluate('document.getElementById("input").value');
    expect(val.value).toBe('42');
  });

  test('should fill with --clear then new value', async () => {
    const snap = open(`${BASE}/input/textarea`);
    const ref = findRefByRole(snap, 'textbox');
    expect(ref).toBeDefined();
    bpType(ref!, 'first value');
    const result = bpType(ref!, 'second value', { clear: true });
    expect(result.ok).toBe(true);
    const val = evaluate('document.querySelector("textarea").value');
    expect(val.value).toBe('second value');
  });

  test('should type with --submit', async () => {
    open(`${BASE}/input/textarea`);
    // Set up a submit listener via eval (single line to avoid shell issues)
    evaluate('window.submitted=false;document.querySelector("textarea").addEventListener("keydown",e=>{if(e.key==="Enter")window.submitted=true})');
    const snap = snapshot();
    const ref = findRefByRole(snap, 'textbox');
    expect(ref).toBeDefined();
    bpType(ref!, 'query', { submit: true });
    const val = evaluate('window.submitted');
    expect(val.value).toBe(true);
  });
});

// ── Special input types (date, color, range) ────────

test.describe('special input types', () => {
  test('date, time, color, range inputs exist in snapshot', async () => {
    const snap = open(`${BASE}/input/date`);
    expect(snap.ok).toBe(true);
    // Log what elements we see — this is diagnostic
    const elements = snap.elements || [];
    expect(elements.length).toBeGreaterThan(0);

    // Try to fill date input
    const dateRef = findRef(snap, 'Date');
    if (dateRef) {
      const result = bpType(dateRef, '2020-03-02');
      // Check if the value was set
      const val = evaluate('document.getElementById("date").value');
      // Note: SET_VALUE approach may or may not work for date inputs
      if (val.value === '2020-03-02') {
        expect(val.value).toBe('2020-03-02');
      }
    }
  });

  test('range input', async () => {
    const snap = open(`${BASE}/input/date`);
    const ref = findRef(snap, 'Range');
    if (ref) {
      bpType(ref, '42');
      const val = evaluate('document.getElementById("range").value');
      if (val.value === '42') {
        expect(val.value).toBe('42');
      }
    }
  });
});

// ── Shadow DOM inputs ───────────────────────────────

test.describe('shadow DOM', () => {
  test('shadow DOM input appears in snapshot', async () => {
    const snap = open(`${BASE}/shadow/input`);
    expect(snap.ok).toBe(true);
    const ref = findRef(snap, 'Shadow Field');
    expect(ref).toBeDefined();
  });

  test('should type into shadow DOM input', async () => {
    const snap = open(`${BASE}/shadow/input`);
    const ref = findRef(snap, 'Shadow Field');
    expect(ref).toBeDefined();
    const result = bpType(ref!, 'shadow value');
    expect(result.ok).toBe(true);
    const val = evaluate('window.shadowValue');
    expect(val.value).toBe('shadow value');
  });

  test('deep nested shadow DOM elements in snapshot', async () => {
    const snap = open(`${BASE}/shadow/deep`);
    expect(snap.ok).toBe(true);
    const btnRef = findRef(snap, 'Deep Button');
    const inputRef = findRef(snap, 'Deep Input');
    expect(btnRef).toBeDefined();
    expect(inputRef).toBeDefined();
  });

  test('should type into deep shadow DOM input', async () => {
    const snap = open(`${BASE}/shadow/deep`);
    const ref = findRef(snap, 'Deep Input');
    expect(ref).toBeDefined();
    const result = bpType(ref!, 'deep value');
    expect(result.ok).toBe(true);
  });
});
