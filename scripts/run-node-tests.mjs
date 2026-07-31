import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { playwrightChromeLaunchOptions } from './playwright-chrome.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testsDirectory = join(root, 'tests');
const browserTests = new Set([
  'browser-capability-fixtures.test.mjs',
  'editable-actions.test.mjs',
  'page-primitives.test.mjs',
]);

async function detectChrome() {
  let browser;
  try {
    browser = await chromium.launch(playwrightChromeLaunchOptions());
  } finally {
    await browser?.close();
  }
}

function runTests(files, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', ...files], {
      cwd: root,
      env: environment,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Node test runner exited from signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

const [mode, ...requestedFiles] = process.argv.slice(2);
if (mode !== 'unit' && mode !== 'browser') {
  throw new Error('Usage: node scripts/run-node-tests.mjs <unit|browser> [browser-test-file ...]');
}
if (mode === 'unit' && requestedFiles.length > 0) {
  throw new Error('Individual test files can only be selected in browser mode');
}

const allTests = (await readdir(testsDirectory))
  .filter(file => file.endsWith('.test.mjs'))
  .sort();
let selectedFiles;
if (mode === 'unit') {
  selectedFiles = allTests.filter(file => !browserTests.has(file));
} else if (requestedFiles.length > 0) {
  const unknown = requestedFiles.filter(file => !browserTests.has(file));
  if (unknown.length > 0) throw new Error(`Unknown browser test file: ${unknown.join(', ')}`);
  selectedFiles = requestedFiles;
} else {
  selectedFiles = allTests.filter(file => browserTests.has(file));
}

if (selectedFiles.length === 0) throw new Error(`No ${mode} test files found`);
if (mode === 'browser') {
  try {
    await detectChrome();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.env.CI) {
      throw new Error(`Google Chrome is required for browser tests in CI: ${message}`);
    }
    console.log(`1..0 # SKIP Google Chrome is unavailable: ${message.replaceAll('\n', ' ')}`);
    process.exit(0);
  }
}

const files = selectedFiles.map(file => relative(root, join(testsDirectory, file)));
process.exitCode = await runTests(files);
