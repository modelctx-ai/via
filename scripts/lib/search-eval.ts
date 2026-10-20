// Retrieval evaluation for `via find` (discovery.md, "搜索"): natural-language queries with the
// canonical tools an agent would accept, scored as recall@1, recall@5 and MRR. Shared by the
// `eval:search` script and the regression test.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SearchIndex } from '../../src/catalog';

export interface EvalQuery {
  q: string;
  group: 'direct' | 'synonym' | 'phrase';
  /** Acceptable canonical refs; the query is scored by the best rank among them. */
  expect: string[];
}

export interface EvalMetrics {
  queries: number;
  recall1: number;
  recall5: number;
  mrr: number;
}

export interface EvalReport extends EvalMetrics {
  byGroup: Record<string, EvalMetrics>;
  /** Queries whose best rank is worse than 5, with the rank (0 = not in the top 20). */
  misses: Array<{ q: string; rank: number; top: string[] }>;
  /** Best rank per query (0 = absent), in file order. */
  ranks: number[];
}

/** Relative to the repository root, which is the working directory of `npm run` scripts and of vitest. */
export const EVAL_FILE = join(process.cwd(), 'test', 'fixtures', 'search', 'eval.json');

export function loadEvalQueries(file = EVAL_FILE): EvalQuery[] {
  return (JSON.parse(readFileSync(file, 'utf8')) as { queries: EvalQuery[] }).queries;
}

const DEPTH = 20;

function metrics(ranks: number[]): EvalMetrics {
  const n = ranks.length || 1;
  return {
    queries: ranks.length,
    recall1: ranks.filter((r) => r === 1).length / n,
    recall5: ranks.filter((r) => r >= 1 && r <= 5).length / n,
    mrr: ranks.reduce((sum, r) => sum + (r > 0 ? 1 / r : 0), 0) / n,
  };
}

export function evaluate(
  index: SearchIndex,
  queries: readonly EvalQuery[],
  search: (index: SearchIndex, q: string) => string[] = (i, q) => i.search(q, { limit: DEPTH }).map((h) => h.tool.ref),
): EvalReport {
  const ranks: number[] = [];
  const misses: EvalReport['misses'] = [];
  for (const query of queries) {
    const refs = search(index, query.q);
    const accepted = query.expect.map((e) => refs.indexOf(e)).filter((i) => i >= 0);
    const rank = accepted.length > 0 ? Math.min(...accepted) + 1 : 0;
    ranks.push(rank);
    if (rank === 0 || rank > 5) misses.push({ q: query.q, rank, top: refs.slice(0, 3) });
  }
  const byGroup: Record<string, EvalMetrics> = {};
  for (const group of [...new Set(queries.map((q) => q.group))]) {
    byGroup[group] = metrics(ranks.filter((_, i) => queries[i]!.group === group));
  }
  return { ...metrics(ranks), byGroup, misses, ranks };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function formatReport(label: string, report: EvalReport): string {
  const row = (name: string, m: EvalMetrics) =>
    `  ${name.padEnd(9)} n=${String(m.queries).padStart(3)}  recall@1 ${pct(m.recall1).padStart(6)}  recall@5 ${pct(m.recall5).padStart(6)}  MRR ${m.mrr.toFixed(3)}`;
  return [label, row('all', report), ...Object.entries(report.byGroup).map(([g, m]) => row(g, m))].join('\n');
}
