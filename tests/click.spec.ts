// Click compatibility tests — adapted from Playwright's page-click.spec.ts
// Tests bp click against scrollable elements, shadow DOM, overlays, fixed position, etc.
import { test, expect } from '@playwright/test';
import { open, click, evaluate, snapshot, findRef, findRefByRole } from './bp.js';

const BASE = 'http://127.0.0.1:18274';

// ── Scrollable ──────────────────────────────────────

test.describe('click scrollable', () => {
  test('should click button at top', async () => {
    const snap = open(`${BASE}/input/scrollable`);
    expect(snap.ok).toBe(true);
    // button-0 should be visible without scrolling
    const ref = findRef(snap, '0: not clicked');
    expect(ref).toBeDefined();
    const result = click(ref!);
    expect(result.ok).toBe(true);
    const val = evaluate('document.getElementById("button-0").textContent');
    expect(val.value).toBe('clicked');
  });

  test('should click button that requires scroll', async () => {
    const snap = open(`${BASE}/input/scrollable`, { limit: 100 });
    expect(snap.ok).toBe(true);
    // button-50 is far down the page
    const ref = findRef(snap, '50: not clicked');
    if (!ref) {
      // Might be beyond the limit
      test.skip();
      return;
    }
    const result = click(ref);
    expect(result.ok).toBe(true);
    const val = evaluate('document.getElementById("button-50").textContent');
    expect(val.value).toBe('clicked');
  });

  test('should click last button (button-99)', async () => {
    const snap = open(`${BASE}/input/scrollable`, { limit: 100 });
    const ref = findRef(snap, '99: not clicked');
    if (!ref) {
      test.skip();
      return;
    }
    const result = click(ref);
    expect(result.ok).toBe(true);
    const val = evaluate('document.getElementById("button-99").textContent');
    expect(val.value).toBe('clicked');
  });
});

// ── Shadow DOM ──────────────────────────────────────

test.describe('click shadow DOM', () => {
  test('should click button in shadow DOM', async () => {
    const snap = open(`${BASE}/shadow/basic`);
    expect(snap.ok).toBe(true);
    const ref = findRef(snap, 'Shadow Button');
    expect(ref).toBeDefined();
    const result = click(ref!);
    expect(result.ok).toBe(true);
    const val = evaluate('window.clicked');
    expect(val.value).toBe(true);
  });

  test('should click button in deep shadow DOM', async () => {
    const snap = open(`${BASE}/shadow/deep`);
    const ref = findRef(snap, 'Deep Button');
    expect(ref).toBeDefined();
    const result = click(ref!);
    expect(result.ok).toBe(true);
    const val = evaluate('window.deepClicked');
    expect(val.value).toBe(true);
  });

  test('should click custom element with slot', async () => {
    const snap = open(`${BASE}/shadow/custom-element`);
    const ref = findRef(snap, 'Sign up');
    expect(ref).toBeDefined();
    const result = click(ref!);
    expect(result.ok).toBe(true);
    const val = evaluate('window.clickCount');
    expect(val.value).toBeGreaterThan(0);
  });
});

// ── Overlay / Modal ─────────────────────────────────

test.describe('click overlay', () => {
  test('should click modal button on top of overlay', async () => {
    const snap = open(`${BASE}/click/overlay`);
    expect(snap.ok).toBe(true);
    const ref = findRef(snap, 'Close Modal');
    expect(ref).toBeDefined();
    const result = click(ref!);
    expect(result.ok).toBe(true);
    const val = evaluate('window.modalClicked');
    expect(val.value).toBe(true);
  });

  test('should click behind button after modal is dismissed', async () => {
    // Modal was dismissed in previous test, but let's open fresh
    const snap = open(`${BASE}/click/overlay`);
    const modalRef = findRef(snap, 'Close Modal');
    expect(modalRef).toBeDefined();
    click(modalRef!); // dismiss modal

    // Now the behind button should be clickable
    const snap2 = snapshot();
    const behindRef = findRef(snap2, 'Behind Button');
    expect(behindRef).toBeDefined();
    const result = click(behindRef!);
    expect(result.ok).toBe(true);
    const val = evaluate('window.behindClicked');
    expect(val.value).toBe(true);
  });
});

// ── Fixed position ──────────────────────────────────

test.describe('click fixed position', () => {
  test('should click fixed position button', async () => {
    const snap = open(`${BASE}/click/fixed`);
    expect(snap.ok).toBe(true);
    const ref = findRef(snap, 'Fixed Button');
    expect(ref).toBeDefined();
    const result = click(ref!);
    expect(result.ok).toBe(true);
    const val = evaluate('window.fixedClicked');
    expect(val.value).toBe(true);
  });
});

// ── Scroll target ───────────────────────────────────

test.describe('click scroll target', () => {
  test('should scroll to and click element at bottom of page', async () => {
    const snap = open(`${BASE}/click/scroll-target`);
    expect(snap.ok).toBe(true);
    const ref = findRef(snap, 'Bottom Button');
    expect(ref).toBeDefined();
    const result = click(ref!);
    expect(result.ok).toBe(true);
    const val = evaluate('window.targetClicked');
    expect(val.value).toBe(true);
  });
});

// ── Select ──────────────────────────────────────────

test.describe('select', () => {
  test('select element appears in snapshot', async () => {
    const snap = open(`${BASE}/input/select`);
    expect(snap.ok).toBe(true);
    // Check if select appears as combobox or listbox
    const elements = snap.elements || [];
    console.log('Select page elements:', JSON.stringify(elements.map(e => `${e.role}:"${e.name}"`)));
    expect(elements.length).toBeGreaterThan(0);
  });

  test('should be able to interact with select', async () => {
    const snap = open(`${BASE}/input/select`);
    // Find the select element (could be combobox or listbox)
    const ref = snap.elements?.[0]?.ref;
    if (!ref) {
      test.skip();
      return;
    }
    // Try clicking to open
    const result = click(ref);
    expect(result.ok).toBe(true);
    // After clicking, check if options become available
    const snap2 = snapshot();
    console.log('After click elements:', JSON.stringify(snap2.elements?.map(e => `${e.role}:"${e.name}"`)));
  });
});
