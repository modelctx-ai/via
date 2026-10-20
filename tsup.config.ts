import { defineConfig } from 'tsup';

// ESM bundle with code splitting: `via.js` is the thin entry, the command runner and everything
// behind it are separate chunks loaded by dynamic import(), so `--version` and `-h` never parse
// them (implementation.md, "启动速度"). data/*.json is imported from source and therefore inlined
// by esbuild.
//
// The pure-JS dependencies are bundled too (into the chunks that import them, so they still load
// lazily). Left external, each is dozens to hundreds of files that Node resolves, stats and reads
// one by one: `yaml` alone costs ~30 ms against ~6 ms bundled, the MCP SDK and ajv more
// (`npm run bench:perf`). Only the native keychain binding has to stay a real package.
const NATIVE = ['@napi-rs/keyring'];

export default defineConfig({
  entry: { via: 'src/cli/main.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: true,
  sourcemap: false,
  noExternal: [/^(?!@napi-rs\/keyring(\/|$))/],
  external: NATIVE,
  // CommonJS packages in the bundle (ajv, cross-spawn, ...) call require() for Node built-ins.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __viaCreateRequire } from 'node:module';\nconst require = __viaCreateRequire(import.meta.url);",
  },
});
