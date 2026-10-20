import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      expect(catalog.providers[0]?.domain.domains).toEqual([{ domain: 'code' }]);
      expect(lib.displayWidth('支持')).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
