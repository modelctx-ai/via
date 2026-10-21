import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// The shipped CLI is one ESM file with data/*.json inlined (implementation.md). Bundle the library
// entry points the same way and run them from a directory that has no data/ next to it.
describe('bundling', () => {
  it('inlines data/*.json so the bundle needs no files at runtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'via-bundle-'));
    try {
      const entry = join(dir, 'entry.ts');
      const root = fileURLToPath(new URL('..', import.meta.url));
      writeFileSync(
        entry,
        `export * from ${JSON.stringify(join(root, 'src/catalog/index.ts'))};
         export * from ${JSON.stringify(join(root, 'src/render/index.ts'))};`,
      );
      const outfile = join(dir, 'bundle.mjs');
      await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'silent' });

      const lib = (await import(pathToFileURL(outfile).href)) as typeof import('../src/catalog') & typeof import('../src/render');
      const catalog = lib.buildCatalog([
        { provider: 'github', tools: [{ name: 'create_or_update_file' }, { name: 'actions_run_trigger' }] },
      ]);
      expect(catalog.providers[0]?.tools.map((t) => t.name)).toEqual(['file:create-or-update', 'action-run:trigger']);
      expect(lib.displayWidth('支持')).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('inlines data/frameworks/*.json and loads parsers only when a file needs them', async () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    mkdirSync(join(root, '.build'), { recursive: true });
    // Inside the repo so the bundle can resolve the runtime dependencies kept external.
    const dir = mkdtempSync(join(root, '.build', 'bundle-config-'));
    try {
      const outfile = join(dir, 'config.mjs');
      await build({
        entryPoints: [join(root, 'src/config/index.ts')],
        outfile,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        packages: 'external',
        logLevel: 'silent',
      });
      const bundled = readFileSync(outfile, 'utf8');
      expect(bundled).not.toMatch(/^import .* from ['"](yaml|smol-toml|jsonc-parser|@napi-rs\/keyring)['"]/m);
      const lib = (await import(pathToFileURL(outfile).href)) as typeof import('../src/config');
      expect(lib.BUNDLED_FRAMEWORKS.map((f) => f.id)).toContain('codex');
      const home = join(dir, 'home');
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.x]\ncommand = "x"\n');
      const config = await lib.loadConfig({ home, cwd: dir, projectRoot: dir, env: {}, platform: 'linux', dataDir: join(dir, 'data') });
      expect(config.servers.map((s) => s.name)).toEqual(['x']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
