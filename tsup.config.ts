import { defineConfig } from 'tsup';

// Single ESM bundle; data/*.json is imported from source and therefore inlined by esbuild.
export default defineConfig({
  entry: { via: 'src/cli/main.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
});
