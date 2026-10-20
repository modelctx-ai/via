import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'tsup';
import { lazyBuiltins } from './scripts/lib/lazy-builtins';

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

/**
 * Identifies the catalog rules of this build: the package version plus a hash of the data files and
 * of the code that derives a catalog from a tool list. The prebuilt-catalog cache
 * (src/cli/view-cache.ts) is keyed by it, so editing a verb table or the naming code can never
 * serve a stale build. Files are visited in sorted order, so the id is the same on every machine.
 */
function rulesId(): string {
  const files: string[] = [];
  const walk = (dir: string, accept: (name: string) => boolean): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.isDirectory()) walk(join(dir, entry.name), accept);
      else if (accept(entry.name)) files.push(join(dir, entry.name));
    }
  };
  readdirSync('data').filter((n) => n.endsWith('.json')).sort().forEach((n) => files.push(join('data', n)));
  walk('src/catalog', (n) => n.endsWith('.ts'));
  files.push('src/cli/view-cache.ts');
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file}\0`).update(readFileSync(file)).update('\0');
  const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
  return `${version}-${hash.digest('hex').slice(0, 16)}`;
}

/** Identifies the YAML parser of this build: via's version and the bundled `yaml` package's. */
function parseId(): string {
  const read = (path: string): string => (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
  return `${read('package.json')}+yaml-${read('node_modules/yaml/package.json')}`;
}

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
  define: { __VIA_RULES_ID__: JSON.stringify(rulesId()), __VIA_PARSE_ID__: JSON.stringify(parseId()) },
  // `fs` without the ES module facade that costs ~12 ms on a cold start (see the plugin).
  esbuildPlugins: [lazyBuiltins()],
  // Keep `node:` prefixes so the plugin above sees the import before tsup turns it into an external.
  removeNodeProtocol: false,
  // CommonJS packages in the bundle (ajv, cross-spawn, ...) call require() for Node built-ins.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __viaCreateRequire } from 'node:module';\nconst require = __viaCreateRequire(import.meta.url);",
  },
});
