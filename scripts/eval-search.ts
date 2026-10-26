// `npm run eval:search`: retrieval quality of `via find` over the fixture servers, lexical baseline
// (no synonyms) against the default (synonym expansion). `--misses` lists the queries the default
// still gets wrong.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildCatalog, SearchIndex, type McpTool } from '../src/catalog';
import { evaluate, formatReport, loadEvalQueries } from './lib/search-eval';

const fixtures = join(process.cwd(), 'test', 'fixtures');
const dir = join(fixtures, 'tools');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => join(dir, f));
const providers = (list: string[]) =>
  list.map((f) => ({ provider: basename(f, '.json'), tools: (JSON.parse(readFileSync(f, 'utf8')) as { tools: McpTool[] }).tools }));
const catalog = buildCatalog(providers(files));
// A server whose name is the plural of its resource (discovery.md, "搜索"), searched among all the others.
const withJobs = buildCatalog(providers([...files, join(fixtures, 'other', 'jobs.json')]));
for (const [name, file, target] of [
  ['tuning set', 'eval.json', catalog],
  ['held-out set', 'heldout.json', catalog],
  ['provider-scope set', 'provider-scope.json', withJobs],
] as const) {
  const queries = loadEvalQueries(join(fixtures, 'search', file));
  const before = evaluate(new SearchIndex(target, undefined, { synonyms: false }), queries);
  const after = evaluate(new SearchIndex(target), queries);
  console.log(`== ${name} (${file}) ==`);
  console.log(formatReport('lexical baseline (synonyms off)', before));
  console.log(formatReport('default (synonym expansion)', after));
  if (process.argv.includes('--misses')) {
    console.log('misses of the default (rank 0 = not in top 20):');
    for (const m of after.misses) console.log(`  [${m.rank}] ${m.q}  ->  ${m.top.join(' | ')}`);
  }
}
