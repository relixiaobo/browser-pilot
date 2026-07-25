#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startIsolatedChromeFixture } from './isolated-chrome-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await startIsolatedChromeFixture('browser-pilot-conformance-');
try {
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [
      resolve(root, 'scripts/run-stdio-conformance.mjs'),
      ...process.argv.slice(2),
    ], {
      cwd: root,
      env: { ...process.env, ...fixture.environment },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', code => resolveExit(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  await fixture.stop();
}
