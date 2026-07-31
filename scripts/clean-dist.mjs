#!/usr/bin/env node

import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function cleanDist(directory = join(root, 'dist')) {
  return rm(directory, { recursive: true, force: true });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await cleanDist();
}
