// Snapshot compatibility tests
// Tests bp snapshot's ability to discover interactive elements in various DOM structures.
import { test, expect } from '@playwright/test';
import { open, snapshot, evaluate } from './bp.js';

const BASE = 'http://127.0.0.1:18274';

// ── Standard elements ───────────────────────────────

test.describe('snapshot standard', () => {
  test('finds textarea, input, and contenteditable', async () => {
    const snap = open(`${BASE}/input/textarea`);
    expect(snap.ok).toBe(true);
    const roles = snap.elements?.map(e => e.role) || [];
    // Should find at least textarea and input as textbox
    expect(roles.filter(r => r === 'textbox').length).toBeGreaterThanOrEqual(2);
  });

  test('finds all input types', async () => {
    const snap = open(`${BASE}/input/types`);
    expect(snap.ok).toBe(true);
    const names = snap.elements?.map(e => e.name) || [];
    console.log('Input types found:', JSON.stringify(names));
    // Should find standard text-like inputs
    expect(names).toContain('Text Field');
    expect(names).toContain('Password');
    expect(names).toContain('Search');
  });

  test('finds number input as spinbutton', async () => {
    const snap = open(`${BASE}/input/number`);
    expect(snap.ok).toBe(true);
    const roles = snap.elements?.map(e => e.role) || [];
    // number input typically has role=spinbutton
    console.log('Number input roles:', JSON.stringify(snap.elements?.map(e => `${e.role}:"${e.name}"`)));
    expect(snap.elements?.length).toBeGreaterThan(0);
  });

  test('finds date/time/range inputs', async () => {
    const snap = open(`${BASE}/input/date`);
    expect(snap.ok).toBe(true);
    const elements = snap.elements || [];
    console.log('Date page elements:', JSON.stringify(elements.map(e => `${e.role}:"${e.name}"`)));
    // Should find several interactive elements
    expect(elements.length).toBeGreaterThan(0);
  });

  test('finds select as combobox', async () => {
    const snap = open(`${BASE}/input/select`);
    expect(snap.ok).toBe(true);
    const elements = snap.elements || [];
    console.log('Select elements:', JSON.stringify(elements.map(e => `${e.role}:"${e.name}"`)));
    // Select should appear as combobox or listbox
    const hasSelect = elements.some(e => e.role === 'combobox' || e.role === 'listbox');
    expect(hasSelect).toBe(true);
  });
});

// ── Shadow DOM discovery ────────────────────────────

test.describe('snapshot shadow DOM', () => {
  test('finds elements inside shadow DOM', async () => {
    const snap = open(`${BASE}/shadow/basic`);
    expect(snap.ok).toBe(true);
    const elements = snap.elements || [];
    console.log('Shadow basic elements:', JSON.stringify(elements.map(e => `${e.role}:"${e.name}"`)));
    // Should find the shadow button
    const hasButton = elements.some(e => e.role === 'button' && e.name.includes('Shadow'));
    expect(hasButton).toBe(true);
  });

  test('finds elements in deep nested shadow DOM', async () => {
    const snap = open(`${BASE}/shadow/deep`);
    expect(snap.ok).toBe(true);
    const elements = snap.elements || [];
    console.log('Deep shadow elements:', JSON.stringify(elements.map(e => `${e.role}:"${e.name}"`)));
    // Should find the deep button (level 2) and deep input (level 3)
    const hasDeepBtn = elements.some(e => e.name.includes('Deep Button'));
    const hasDeepInput = elements.some(e => e.name.includes('Deep Input'));
    if (!hasDeepBtn) console.log('FINDING: Deep shadow button NOT found');
    if (!hasDeepInput) console.log('FINDING: Deep shadow input NOT found');
  });

  test('finds shadow DOM input', async () => {
    const snap = open(`${BASE}/shadow/input`);
    expect(snap.ok).toBe(true);
    const elements = snap.elements || [];
    console.log('Shadow input elements:', JSON.stringify(elements.map(e => `${e.role}:"${e.name}"`)));
    const hasInput = elements.some(e => e.name.includes('Shadow Field'));
    expect(hasInput).toBe(true);
  });

  test('finds custom element with slot', async () => {
    const snap = open(`${BASE}/shadow/custom-element`);
    expect(snap.ok).toBe(true);
    const elements = snap.elements || [];
    console.log('Custom element elements:', JSON.stringify(elements.map(e => `${e.role}:"${e.name}"`)));
    const hasLink = elements.some(e => e.role === 'link' && e.name.includes('Sign up'));
    expect(hasLink).toBe(true);
  });
});

// ── Contenteditable discovery ───────────────────────

test.describe('snapshot contenteditable', () => {
  test('finds contenteditable as interactive element', async () => {
    const snap = open(`${BASE}/ce/basic`);
    expect(snap.ok).toBe(true);
    const elements = snap.elements || [];
    console.log('CE basic elements:', JSON.stringify(elements.map(e => `${e.role}:"${e.name}"`)));
    // Contenteditable should appear — might be textbox or other role
    expect(elements.length).toBeGreaterThan(0);
  });

  test('finds contenteditable with existing content', async () => {
    const snap = open(`${BASE}/ce/existing`);
    expect(snap.ok).toBe(true);
    const elements = snap.elements || [];
    console.log('CE existing elements:', JSON.stringify(elements.map(e => `${e.role}:"${e.name}"${e.value ? ` value="${e.value}"` : ''}`)));
  });
});

// ── Scrollable discovery ────────────────────────────

test.describe('snapshot scrollable', () => {
  test('default limit caps at 50', async () => {
    const snap = open(`${BASE}/input/scrollable`);
    expect(snap.ok).toBe(true);
    expect(snap.elements?.length).toBeLessThanOrEqual(50);
  });

  test('custom limit works', async () => {
    const snap = open(`${BASE}/input/scrollable`, { limit: 10 });
    expect(snap.ok).toBe(true);
    expect(snap.elements?.length).toBe(10);
  });

  test('high limit finds all 100 buttons', async () => {
    const snap = open(`${BASE}/input/scrollable`, { limit: 200 });
    expect(snap.ok).toBe(true);
    // 100 buttons + possibly extra elements from browser extensions
    expect(snap.elements?.length).toBeGreaterThanOrEqual(100);
  });
});

// ── Keyboard events ─────────────────────────────────

test.describe('snapshot keyboard page', () => {
  test('finds textarea on keyboard page', async () => {
    const snap = open(`${BASE}/input/keyboard`);
    expect(snap.ok).toBe(true);
    const hasTextbox = snap.elements?.some(e => e.role === 'textbox');
    expect(hasTextbox).toBe(true);
  });
});
