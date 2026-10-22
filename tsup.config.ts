import { defineConfig } from 'tsup';
import { parseId, rulesId } from './scripts/lib/build-ids';
import { writeDistManifest } from './scripts/lib/dist-manifest';
import { lazyBuiltins } from './scripts/lib/lazy-builtins';
import { stripUnusedRequire } from './scripts/lib/strip-require';

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

export default defineConfig((flags) => ({
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
  define: { __VIA_RULES_ID__: JSON.stringify(rulesId()), __VIA_PARSE_ID__: JSON.stringify(parseId()) },
  // `fs` without the ES module facade that costs ~12 ms on a cold start (see the plugin).
  esbuildPlugins: [lazyBuiltins()],
  // Keep `node:` prefixes so the plugin above sees the import before tsup turns it into an external.
  removeNodeProtocol: false,
  // CommonJS packages in the bundle (ajv, cross-spawn, ...) call require() for Node built-ins. The
  // banner goes on every chunk; the step after the build removes it from those that never use it.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __viaCreateRequire } from 'node:module';\nconst require = __viaCreateRequire(import.meta.url);",
  },
  onSuccess: async () => {
    stripUnusedRequire(flags.outDir ?? 'dist');
    writeDistManifest(flags.outDir ?? 'dist');
  },
}));
