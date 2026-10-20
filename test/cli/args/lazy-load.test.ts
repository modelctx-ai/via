import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// implementation.md ("启动速度"): ajv is loaded on demand, never in the static import graph of the
// argument parser, so a CLI invocation that does not validate pays nothing for it.
describe('lazy loading of ajv', () => {
  it('has no static import of ajv or ajv-formats, only dynamic ones', async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'via-args-'));
    try {
      const result = await build({
        entryPoints: [join(root, 'src/cli/args/index.ts')],
        outfile: join(dir, 'args.mjs'),
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        packages: 'external',
        metafile: true,
        logLevel: 'silent',
        write: false,
      });
      const imports = Object.values(result.metafile.outputs).flatMap((o) => o.imports);
      const ajv = imports.filter((i) => /^ajv(-formats)?(\/|$)/.test(i.path));
      expect(ajv.length).toBeGreaterThan(0);
      expect(ajv.filter((i) => i.kind === 'import-statement')).toEqual([]);
      expect(ajv.every((i) => i.kind === 'dynamic-import')).toBe(true);

      // The source files themselves only import ajv types.
      const inputs = Object.entries(result.metafile.inputs).filter(([file]) => file.startsWith('src/cli/args/'));
      for (const [file, input] of inputs) {
        const staticAjv = input.imports.filter((i) => /^ajv/.test(i.path) && i.kind === 'import-statement');
        expect(staticAjv, file).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
