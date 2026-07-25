import { createRequire } from 'node:module';
import { defineConfig } from 'tsup';

const require = createRequire(import.meta.url);
const version: string = require('./package.json').version;
const shared = {
  bundle: true,
  clean: true,
  define: {
    __BROWSER_PILOT_SELF_CONTAINED__: 'true',
    __BROWSER_PILOT_VERSION__: JSON.stringify(version),
    'import.meta.url': 'undefined',
  },
  format: ['cjs'] as const,
  minify: false,
  noExternal: ['commander', 'ws'],
  outDir: 'build/standalone-js',
  outExtension: () => ({ js: '.cjs' }),
  platform: 'node' as const,
  sourcemap: false,
};

export default defineConfig([
  { ...shared, entry: { standalone: 'src/standalone.ts' } },
]);
