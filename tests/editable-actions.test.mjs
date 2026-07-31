import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { chromium } from 'playwright';
import { playwrightChromeLaunchOptions } from '../scripts/playwright-chrome.mjs';
import {
  ActionService,
  CdpActionContinuityGuard,
  MemoryRefStore,
  UploadService,
} from '../dist/services.js';

let browser;

before(async () => {
  browser = await chromium.launch(playwrightChromeLaunchOptions());
});

after(async () => {
  await browser?.close();
});

class CdpTransport {
  calls = [];

  constructor(client) {
    this.client = client;
  }

  async send(method, params) {
    this.calls.push({ method, params });
    return this.client.send(method, params);
  }

  close() {}
}

const observation = {
  text: '[page] Editable fixture | about:blank',
  data: { title: 'Editable fixture', url: 'about:blank', elements: [] },
};

function findNodeById(node, id) {
  const attributes = node.attributes ?? [];
  for (let index = 0; index < attributes.length; index += 2) {
    if (attributes[index] === 'id' && attributes[index + 1] === id) return node;
  }
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const match = findNodeById(child, id);
    if (match) return match;
  }
  return undefined;
}

async function createRefHarness(
  html,
  id,
  readbackDelayMs = 40,
  ref = { role: 'textbox', name: id },
) {
  const page = await browser.newPage();
  await page.setContent(html);
  const client = await page.context().newCDPSession(page);
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  const node = findNodeById(root, id);
  assert.ok(node?.backendNodeId, `Expected a backend node for #${id}`);

  const refs = new MemoryRefStore();
  refs.save('target:editable', [{ backendNodeId: node.backendNodeId, ...ref }]);
  const transport = new CdpTransport(client);
  const service = new ActionService(transport, 'session:editable', 'target:editable', {
    refStore: refs,
    readbackDelayMs,
    focusDelayMs: 0,
    observationService: {
      async observeAfterAction() { return observation; },
      async locate() { return { x: 0, y: 0 }; },
    },
  });
  return { page, service, transport };
}

test('native editing drives controlled inputs with trusted events and detects rollback', async () => {
  const accepted = await createRefHarness(`
    <input id="field" value="old">
    <script>
      (() => {
        const field = document.getElementById('field');
        window.eventLog = [];
        let model = field.value;
        for (const name of ['beforeinput', 'input', 'change']) {
          field.addEventListener(name, event => {
            window.eventLog.push({ name, trusted: event.isTrusted, inputType: event.inputType || '' });
          });
        }
        field.addEventListener('input', event => {
          model = event.target.value;
          setTimeout(() => { field.value = model; }, 0);
        });
      })();
    </script>
  `, 'field');
  try {
    const result = await accepted.service.type('1', '-accepted');
    assert.equal(result.evidence.status, 'verified');
    assert.equal(await accepted.page.locator('#field').inputValue(), 'old-accepted');
    assert.deepEqual(await accepted.page.evaluate(() => window.eventLog), [
      { name: 'beforeinput', trusted: true, inputType: 'insertText' },
      { name: 'input', trusted: true, inputType: 'insertText' },
    ]);
  } finally {
    await accepted.page.close();
  }

  const rolledBack = await createRefHarness(`
    <input id="field" value="fixed">
    <script>
      (() => {
        const field = document.getElementById('field');
        field.addEventListener('input', () => {
          setTimeout(() => { field.value = 'fixed'; }, 0);
        });
      })();
    </script>
  `, 'field');
  try {
    const result = await rolledBack.service.type('1', '-rejected');
    assert.deepEqual(result.evidence, {
      action: 'type',
      status: 'mismatch',
      kind: 'input',
      sensitive: false,
      beforeLength: 5,
      expectedLength: 14,
      afterLength: 5,
      reason: 'value_mismatch',
    });
    assert.equal(await rolledBack.page.locator('#field').inputValue(), 'fixed');
  } finally {
    await rolledBack.page.close();
  }
});

test('cancelled beforeinput remains unchanged and exact verification fails', async () => {
  const harness = await createRefHarness(`
    <input id="field" value="fixed">
    <script>
      document.getElementById('field').addEventListener('beforeinput', event => event.preventDefault());
    </script>
  `, 'field');
  try {
    await assert.rejects(
      () => harness.service.type('1', '-blocked', { verification: 'require_exact' }),
      error => error.code === 'action_not_verified' && error.context?.reason === 'value_mismatch',
    );
    assert.equal(await harness.page.locator('#field').inputValue(), 'fixed');
  } finally {
    await harness.page.close();
  }
});

test('email and number inputs use native append and replacement selection', async () => {
  for (const type of ['email', 'number']) {
    const harness = await createRefHarness(`
      <input id="field" type="${type}" value="12">
      <script>
        (() => {
          window.eventLog = [];
          const field = document.getElementById('field');
          for (const name of ['beforeinput', 'input']) {
            field.addEventListener(name, event => window.eventLog.push({ name, trusted: event.isTrusted }));
          }
        })();
      </script>
    `, 'field');
    try {
      const appended = await harness.service.type('1', '34');
      assert.equal(appended.evidence.status, 'verified');
      assert.equal(await harness.page.locator('#field').inputValue(), '1234');

      const replaced = await harness.service.type('1', '56', { clear: true });
      assert.equal(replaced.evidence.status, 'verified');
      assert.equal(await harness.page.locator('#field').inputValue(), '56');
      assert.deepEqual(await harness.page.evaluate(() => window.eventLog), [
        { name: 'beforeinput', trusted: true },
        { name: 'input', trusted: true },
        { name: 'beforeinput', trusted: true },
        { name: 'input', trusted: true },
      ]);
    } finally {
      await harness.page.close();
    }
  }
});

test('contenteditable replacement removes nested markup and append uses the final caret', async () => {
  const harness = await createRefHarness(`
    <div id="editor" contenteditable="true">one <strong>two</strong></div>
    <script>
      (() => {
        window.eventLog = [];
        const editor = document.getElementById('editor');
        for (const name of ['beforeinput', 'input']) {
          editor.addEventListener(name, event => {
            window.eventLog.push({ name, trusted: event.isTrusted, inputType: event.inputType });
          });
        }
      })();
    </script>
  `, 'editor');
  try {
    const replaced = await harness.service.type('1', 'replaced', { clear: true });
    assert.equal(replaced.evidence.status, 'verified');
    assert.equal(await harness.page.locator('#editor').innerText(), 'replaced');
    assert.equal(await harness.page.locator('#editor').innerHTML(), 'replaced');

    const appended = await harness.service.type('1', ' tail');
    assert.equal(appended.evidence.status, 'verified');
    assert.equal(await harness.page.locator('#editor').innerText(), 'replaced tail');
    assert.deepEqual(await harness.page.evaluate(() => window.eventLog), [
      { name: 'beforeinput', trusted: true, inputType: 'insertText' },
      { name: 'input', trusted: true, inputType: 'insertText' },
      { name: 'beforeinput', trusted: true, inputType: 'insertText' },
      { name: 'input', trusted: true, inputType: 'insertText' },
    ]);
  } finally {
    await harness.page.close();
  }
});

test('readonly and button-like inputs fail before any CDP input dispatch', async () => {
  for (const fixture of [
    { html: '<input id="field" readonly value="fixed">', code: 'action_not_verified', reason: 'readonly' },
    { html: '<input id="field" type="checkbox">', code: 'invalid_argument', reason: 'unsupported_input_type' },
    { html: '<div inert><input id="field" value="fixed"></div>', code: 'action_not_verified', reason: 'inert' },
  ]) {
    const harness = await createRefHarness(fixture.html, 'field');
    try {
      await assert.rejects(
        () => harness.service.type('1', 'mutation'),
        error => error.code === fixture.code && error.context?.reason === fixture.reason,
      );
      assert.equal(harness.transport.calls.some(call => call.method.startsWith('Input.')), false);
    } finally {
      await harness.page.close();
    }
  }
});

test('special value controls use input semantics without an early change event', async () => {
  const harness = await createRefHarness(`
    <input id="field" type="date">
    <script>
      (() => {
        window.eventLog = [];
        const field = document.getElementById('field');
        for (const name of ['beforeinput', 'input', 'change']) {
          field.addEventListener(name, event => window.eventLog.push({ name, inputType: event.inputType || '' }));
        }
      })();
    </script>
  `, 'field');
  try {
    const result = await harness.service.type('1', '2026-07-25', { clear: true });
    assert.equal(result.evidence.status, 'verified');
    assert.equal(await harness.page.locator('#field').inputValue(), '2026-07-25');
    assert.deepEqual(await harness.page.evaluate(() => window.eventLog), [
      { name: 'beforeinput', inputType: 'insertReplacementText' },
      { name: 'input', inputType: 'insertReplacementText' },
    ]);
  } finally {
    await harness.page.close();
  }
});

test('press evidence observes native checked and focus changes', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<input id="check" type="checkbox"><input id="next"><script>check.focus()</script>');
    const client = await page.context().newCDPSession(page);
    const service = new ActionService(
      new CdpTransport(client),
      'session:press',
      'target:press',
      {
        readbackDelayMs: 20,
        observationService: {
          async observeAfterAction() { return observation; },
          async locate() { return { x: 0, y: 0 }; },
        },
      },
    );

    const toggled = await service.press('Space');
    assert.deepEqual(toggled.evidence, {
      action: 'press',
      status: 'verified',
      kind: 'checkbox',
      effects: ['checked_changed'],
      sensitive: false,
    });
    assert.equal(await page.locator('#check').isChecked(), true);

    const moved = await service.press('Tab');
    assert.deepEqual(moved.evidence, {
      action: 'press',
      status: 'verified',
      kind: 'input',
      effects: ['focus_changed'],
      sensitive: false,
    });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'next');
  } finally {
    await page.close();
  }
});

test('click evidence verifies native checkbox and radio state transitions', async () => {
  for (const type of ['checkbox', 'radio']) {
    const accepted = await createRefHarness(
      `<input id="control" type="${type}" name="choice">`,
      'control',
      20,
      { role: type, name: `Native ${type}` },
    );
    try {
      const result = await accepted.service.click({ kind: 'ref', ref: '1' });
      assert.equal(result.evidence.action, 'click');
      assert.equal(result.evidence.status, 'verified');
      assert.equal(result.evidence.kind, type);
      assert.equal(result.evidence.checked, true);
      assert.ok(result.evidence.effects.includes('checked_changed'));
      assert.equal(await accepted.page.locator('#control').isChecked(), true);
    } finally {
      await accepted.page.close();
    }

    const prevented = await createRefHarness(
      `<input id="control" type="${type}" name="choice">
       <script>control.addEventListener('click', event => event.preventDefault())</script>`,
      'control',
      20,
      { role: type, name: `Prevented ${type}` },
    );
    try {
      const result = await prevented.service.click({ kind: 'ref', ref: '1' });
      assert.equal(result.evidence.action, 'click');
      assert.equal(result.evidence.status, 'mismatch');
      assert.equal(result.evidence.kind, type);
      assert.equal(result.evidence.checked, false);
      assert.equal(result.evidence.reason, 'expected_state_unchanged');
      assert.equal(await prevented.page.locator('#control').isChecked(), false);
    } finally {
      await prevented.page.close();
    }
  }
});

test('upload evidence reads back the selected browser file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-pilot-upload-evidence-'));
  const filePath = join(directory, 'resume.txt');
  await writeFile(filePath, 'resume');
  const page = await browser.newPage();
  try {
    await page.setContent('<input id="upload" type="file">');
    const client = await page.context().newCDPSession(page);
    const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    const node = findNodeById(root, 'upload');
    assert.ok(node?.backendNodeId);
    const service = new UploadService(
      new CdpTransport(client),
      'session:upload',
      { async observeAfterAction() { return observation; } },
      { readbackDelayMs: 20 },
    );

    const result = await service.upload(filePath, { backendNodeId: node.backendNodeId });

    assert.deepEqual(result.evidence, {
      action: 'upload',
      status: 'verified',
      expectedFileCount: 1,
      fileCount: 1,
      nameMatched: true,
    });
    assert.deepEqual(
      await page.evaluate(() => Array.from(document.querySelector('#upload').files, file => file.name)),
      ['resume.txt'],
    );
  } finally {
    await page.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('keyboard readback follows focus through nested open Shadow DOM', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div id="outer"></div>
      <script>
        (() => {
          const first = document.getElementById('outer').attachShadow({ mode: 'open' });
          const host = document.createElement('div');
          first.append(host);
          const second = host.attachShadow({ mode: 'open' });
          const field = document.createElement('input');
          field.value = 'deep';
          second.append(field);
          field.focus();
        })();
      </script>
    `);
    const client = await page.context().newCDPSession(page);
    const service = new ActionService(
      new CdpTransport(client),
      'session:shadow',
      'target:shadow',
      {
        readbackDelayMs: 20,
        observationService: {
          async observeAfterAction() { return observation; },
          async locate() { return { x: 0, y: 0 }; },
        },
      },
    );

    const result = await service.keyboard('-value');
    assert.equal(result.evidence.status, 'verified');
    assert.equal(
      await page.evaluate(() => document.querySelector('#outer').shadowRoot.firstChild.shadowRoot.firstChild.value),
      'deep-value',
    );
  } finally {
    await page.close();
  }
});

test('keyboard clear performs a real select-all before typing', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<textarea id="field">old value</textarea><script>field.focus()</script>');
    const client = await page.context().newCDPSession(page);
    const service = new ActionService(
      new CdpTransport(client),
      'session:keyboard-clear',
      'target:keyboard-clear',
      {
        readbackDelayMs: 20,
        observationService: {
          async observeAfterAction() { return observation; },
          async locate() { return { x: 0, y: 0 }; },
        },
      },
    );

    const result = await service.keyboard('replacement', { clear: true });
    assert.equal(result.evidence.status, 'verified');
    assert.equal(await page.locator('#field').inputValue(), 'replacement');
  } finally {
    await page.close();
  }
});

test('keyboard stops remaining characters when page code moves focus', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <input id="field"><input id="next">
      <script>
        field.addEventListener('input', () => next.focus(), { once: true });
        field.focus();
      </script>
    `);
    const client = await page.context().newCDPSession(page);
    const transport = new CdpTransport(client);
    const service = new ActionService(
      transport,
      'session:focus-guard',
      'target:focus-guard',
      {
        readbackDelayMs: 0,
        continuityFactory: action => CdpActionContinuityGuard.create(
          transport,
          'session:focus-guard',
          action,
        ),
        observationService: {
          async observeAfterAction() { return observation; },
          async locate() { return { x: 0, y: 0 }; },
        },
      },
    );

    await assert.rejects(
      () => service.keyboard('ab'),
      error => (
        error.code === 'unknown_outcome' &&
        error.context?.reason === 'focus_changed' &&
        error.context?.step === 'type_character:1' &&
        error.context?.dispatchedSteps === 1
      ),
    );
    assert.equal(await page.locator('#field').inputValue(), 'a');
    assert.equal(await page.locator('#next').inputValue(), '');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'next');
  } finally {
    await page.close();
  }
});
