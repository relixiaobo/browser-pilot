#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const bundleIndex = process.argv.indexOf('--bundle');
const defaultBundle = join(
  root,
  'release',
  `browser-pilot-${packageJson.version}-${process.platform}-${process.arch}`,
);
const bundle = bundleIndex === -1 ? defaultBundle : resolve(process.argv[bundleIndex + 1] ?? '');

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', value => { stderr += value.toString(); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(
        `${command} exited ${signal ? `from ${signal}` : `with code ${code ?? 'unknown'}`}` +
        (stderr ? `: ${stderr.trim().slice(0, 2000)}` : ''),
      ));
    });
  });
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'));
assert.equal(manifest.product, 'browser-pilot');
assert.equal(manifest.version, packageJson.version);
for (const file of manifest.files) {
  const path = resolve(bundle, file.path);
  const relativePath = relative(bundle, path);
  assert.equal(
    isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`),
    false,
    `Invalid manifest path ${file.path}`,
  );
  assert.equal((await stat(path)).size, file.bytes, `Size mismatch for ${file.path}`);
  assert.equal(await sha256(path), file.sha256, `Hash mismatch for ${file.path}`);
}

const archiveExtension = process.platform === 'linux' ? '.tar.gz' : '.zip';
const archive = `${bundle}${archiveExtension}`;
await rm(archive, { force: true });
if (process.platform === 'darwin') {
  await run('/usr/bin/ditto', [
    '-c', '-k', '--norsrc', '--noextattr', '--keepParent', bundle, archive,
  ]);
} else if (process.platform === 'win32') {
  await run('tar.exe', ['-a', '-c', '-f', archive, basename(bundle)], { cwd: dirname(bundle) });
} else {
  await run('tar', ['-czf', archive, basename(bundle)], { cwd: dirname(bundle) });
}
const digest = await sha256(archive);
const checksumPath = `${archive}.sha256`;
await writeFile(checksumPath, `${digest}  ${basename(archive)}\n`);
process.stdout.write(`${JSON.stringify({
  ok: true,
  bundle,
  archive,
  bytes: (await stat(archive)).size,
  sha256: digest,
  checksumPath,
  signature: manifest.signature,
})}\n`);
