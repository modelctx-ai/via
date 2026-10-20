// `npm run eval:search`: retrieval quality of `via find` over the fixture servers, lexical baseline
// (no synonyms) against the default (synonym expansion). `--misses` lists the queries the default
// still gets wrong.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildCatalog, SearchIndex, type McpTool } from '../src/catalog';
import { evaluate, formatReport, loadEvalQueries } from './lib/search-eval';

const dir = join(process.cwd(), 'test', 'fixtures', 'tools');
const catalog = buildCatalog(
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ provider: basename(f, '.json'), tools: (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { tools: McpTool[] }).tools })),
);
for (const [name, file] of [['tuning set', 'eval.json'], ['held-out set', 'heldout.json']] as const) {
  const queries = loadEvalQueries(join(process.cwd(), 'test', 'fixtures', 'search', file));
  const before = evaluate(new SearchIndex(catalog, undefined, { synonyms: false }), queries);
  const after = evaluate(new SearchIndex(catalog), queries);
  console.log(`== ${name} (${file}) ==`);
  console.log(formatReport('lexical baseline (synonyms off)', before));
  console.log(formatReport('default (synonym expansion)', after));
  if (process.argv.includes('--misses')) {
    console.log('misses of the default (rank 0 = not in top 20):');
    for (const m of after.misses) console.log(`  [${m.rank}] ${m.q}  ->  ${m.top.join(' | ')}`);
  }
}
