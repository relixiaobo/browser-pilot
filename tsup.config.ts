import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entry: ['src/daemon.ts'],
    format: ['esm'],
  },
]);
