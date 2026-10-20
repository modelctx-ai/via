// Offline split check (naming.md, "稳定性约定"): re-split the tools/list fixtures with the
// current rules in data/verbs.json and show which canonical names changed against the checked-in
// baselines in test/fixtures/splits/. Run with `npm run split-diff`; add --update to accept.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildProviderCatalog, formatSplitTable } from '../src/catalog';
import type { McpTool } from '../src/catalog';

const args = process.argv.slice(2);
const update = args.includes('--update');
const dirs = args.filter((a) => !a.startsWith('--'));
const baselineDir = 'test/fixtures/splits';

function parse(table: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of table.split('\n')) {
    const m = /^(\S+)\s+→\s+(.+)$/.exec(line);
    if (m) rows.set(m[1]!, m[2]!);
  }
  return rows;
}

let changed = 0;
for (const dir of dirs.length > 0 ? dirs : ['test/fixtures/tools', 'test/fixtures/other']) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const provider = basename(file, '.json');
    const tools = (JSON.parse(readFileSync(join(dir, file), 'utf8')) as { tools: McpTool[] }).tools;
    const current = formatSplitTable(buildProviderCatalog({ provider, tools }));
    const baselinePath = join(baselineDir, `${provider}.txt`);
    const baseline = existsSync(baselinePath) ? readFileSync(baselinePath, 'utf8') : '';
    if (current === baseline) continue;

    const before = parse(baseline);
    const after = parse(current);
    for (const [raw, now] of after) {
      const was = before.get(raw);
      if (was !== now) {
        changed += 1;
        process.stdout.write(`${provider}: ${raw}: ${was ?? '(new)'} -> ${now}\n`);
      }
    }
    for (const raw of before.keys()) {
      if (!after.has(raw)) {
        changed += 1;
        process.stdout.write(`${provider}: ${raw}: removed\n`);
      }
    }
    if (update) writeFileSync(baselinePath, current);
  }
}

if (changed === 0) process.stdout.write('no changes in canonical names\n');
else if (update) process.stdout.write(`${changed} change(s) written to ${baselineDir}\n`);
else process.stdout.write(`${changed} change(s); list them in CHANGELOG.md and rerun with --update\n`);
process.exitCode = changed === 0 || update ? 0 : 1;
