import { defineConfig } from 'tsup';

// ESM bundle with code splitting: `via.js` is the thin entry, the command runner and everything
// behind it are separate chunks loaded by dynamic import(), so `--version` and `-h` never parse
// them (implementation.md, "启动速度"). data/*.json is imported from source and therefore inlined
// by esbuild.
export default defineConfig({
  entry: { via: 'src/cli/main.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: true,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
});
