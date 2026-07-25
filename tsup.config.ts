import { defineConfig } from 'tsup';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const version: string = require('./package.json').version;
const shared = {
  define: {
    __BROWSER_PILOT_SELF_CONTAINED__: 'false',
    __BROWSER_PILOT_VERSION__: JSON.stringify(version),
  },
};

export default defineConfig([
  {
    entry: ['src/cli.ts'],
    ...shared,
    format: ['esm'],
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entry: ['src/daemon.ts'],
    ...shared,
    format: ['esm'],
  },
  {
    entry: ['src/managed-target-janitor.ts'],
    ...shared,
    format: ['esm'],
  },
  {
    entry: { protocol: 'src/protocol/index.ts' },
    ...shared,
    format: ['esm'],
  },
  {
    entry: { services: 'src/services/index.ts' },
    ...shared,
    format: ['esm'],
  },
  {
    entry: { bridge: 'src/bridge/index.ts' },
    ...shared,
    format: ['esm'],
  },
]);
