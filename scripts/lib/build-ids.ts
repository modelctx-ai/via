// Identifiers the builds (tsup for the npm package, Bun for the single-file executable) bake into
// the bundle with `define`, so a cache written by one build is never read by a build whose rules or
// parser differ.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Identifies the catalog rules of this build: the package version plus a hash of the data files and
 * of the code that derives a catalog from a tool list. The prebuilt-catalog cache
 * (src/cli/view-cache.ts) is keyed by it, so editing a verb table or the naming code can never
 * serve a stale build. Files are visited in sorted order, so the id is the same on every machine.
 */
export function rulesId(): string {
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
export function parseId(): string {
  const read = (path: string): string => (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
  return `${read('package.json')}+yaml-${read('node_modules/yaml/package.json')}`;
}
