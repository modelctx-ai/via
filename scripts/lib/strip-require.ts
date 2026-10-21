// Post-build step for tsup: give `require` only to the chunks that use it.
//
// CommonJS packages in the bundle (cross-spawn, the esbuild runtime shim...) look for a `require`,
// which an ES module does not have, so the build puts
//
//     import { createRequire as __viaCreateRequire } from 'node:module';
//     const require = __viaCreateRequire(import.meta.url);
//
// at the top of every output file (tsup's `banner` cannot be conditional). Making a require costs
// URL parsing and package.json lookups, and a browse command loads ~40 chunks: about 4 ms spent for
// a handful of chunks that mention `require` at all. This removes the two lines, and the shebang,
// from every chunk whose code never mentions it; the entry keeps its shebang.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const REQUIRE_BANNER = "import { createRequire as __viaCreateRequire } from 'node:module';\nconst require = __viaCreateRequire(import.meta.url);\n";
const SHEBANG = '#!/usr/bin/env node\n';

export function stripUnusedRequire(dir: string, entry = 'via.js'): { kept: string[]; stripped: number } {
  const kept: string[] = [];
  let stripped = 0;
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const path = join(dir, name);
    const text = readFileSync(path, 'utf8');
    const banner = `${SHEBANG}${REQUIRE_BANNER}`;
    if (!text.startsWith(banner)) continue;
    const rest = text.slice(banner.length);
    if (/\brequire\b/.test(rest)) {
      kept.push(name);
      if (name !== entry) writeFileSync(path, `${REQUIRE_BANNER}${rest}`);
      continue;
    }
    writeFileSync(path, name === entry ? `${SHEBANG}${rest}` : rest);
    stripped += 1;
  }
  return { kept, stripped };
}
