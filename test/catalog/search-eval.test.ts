import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SearchIndex } from '../../src/catalog';
import { evaluate, formatReport, loadEvalQueries } from '../../scripts/lib/search-eval';
import { catalogFixture } from '../helpers/fixtures';

// Retrieval quality of `via find` over the fixture servers (docs/spec/discovery.md, "搜索"): the
// same natural-language queries against the lexical baseline and the default (synonym expansion).
// `npm run eval:search` prints the same numbers. The floors below are the measured values rounded
// down; raise them when the data improves, never lower them to make a change pass.

const queries = loadEvalQueries();
const catalog = catalogFixture('tools');
const before = evaluate(new SearchIndex(catalog, undefined, { synonyms: false }), queries);
const after = evaluate(new SearchIndex(catalog), queries);

describe('find retrieval quality', () => {
  it('has a usable evaluation set', () => {
    expect(queries.length).toBeGreaterThanOrEqual(90);
    const known = new Set(catalog.providers.flatMap((p) => p.tools.map((t) => t.ref)));
    for (const q of queries) {
      expect(q.expect.length, q.q).toBeGreaterThan(0);
      for (const ref of q.expect) expect(known.has(ref), `${q.q} -> ${ref}`).toBe(true);
    }
  });

  it('synonym expansion does not drop any metric against the lexical baseline', () => {
    console.log(`${formatReport('before (lexical)', before)}\n${formatReport('after (synonyms)', after)}`);
    expect(after.recall1).toBeGreaterThanOrEqual(before.recall1);
    expect(after.recall5).toBeGreaterThanOrEqual(before.recall5);
    expect(after.mrr).toBeGreaterThanOrEqual(before.mrr);
    for (const group of Object.keys(before.byGroup)) {
      expect(after.byGroup[group]!.mrr, group).toBeGreaterThanOrEqual(before.byGroup[group]!.mrr);
    }
  });

  it('no query gets worse than rank 5 that was within the top 5 before', () => {
    const regressions = queries.filter((_, i) => before.ranks[i]! >= 1 && before.ranks[i]! <= 5 && (after.ranks[i]! === 0 || after.ranks[i]! > 5)).map((q) => q.q);
    expect(regressions).toEqual([]);
  });

  it('keeps the measured floors', () => {
    expect(after.recall1).toBeGreaterThanOrEqual(0.65);
    expect(after.recall5).toBeGreaterThanOrEqual(0.96);
    expect(after.mrr).toBeGreaterThanOrEqual(0.78);
    // Queries that already worked lexically keep working.
    expect(after.byGroup.direct!.recall1).toBe(1);
  });

  // heldout.json was written after the synonym data was tuned against eval.json and was never used to
  // tune it; it is the estimate of how the data generalises.
  it('also improves a held-out set', () => {
    const held = loadEvalQueries(join(process.cwd(), 'test', 'fixtures', 'search', 'heldout.json'));
    const b = evaluate(new SearchIndex(catalog, undefined, { synonyms: false }), held);
    const a = evaluate(new SearchIndex(catalog), held);
    console.log(`${formatReport('held-out before', b)}\n${formatReport('held-out after', a)}`);
    expect(a.recall1).toBeGreaterThanOrEqual(b.recall1);
    expect(a.recall5).toBeGreaterThanOrEqual(b.recall5);
    expect(a.mrr).toBeGreaterThanOrEqual(b.mrr);
    expect(a.recall1).toBeGreaterThanOrEqual(0.66);
    expect(a.recall5).toBeGreaterThanOrEqual(0.86);
    expect(a.mrr).toBeGreaterThanOrEqual(0.77);
    expect(a.byGroup.direct!.recall1).toBe(1);
  });
});
