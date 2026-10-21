import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultCatalogRules } from '../../src/catalog';
import { measureProvider } from '../../scripts/lib/split-stats';
import { FIXTURES, fixtureNames, loadTools } from '../helpers/fixtures';

// The numbers behind `npm run split-stats` (bench/results/0.4-split.md, roadmap d5): how many tools
// fall back to a leaf and why. The classification must agree with the split baselines the snapshot
// tests keep, so the statistics cannot drift from what the CLI shows.

const rules = defaultCatalogRules();
const tool = (name: string) => ({ name, inputSchema: { type: 'object' as const } });

describe('split statistics', () => {
  it('counts exactly the leaf tools of the split baselines, for every fixture server', () => {
    for (const name of fixtureNames('tools')) {
      const baseline = readFileSync(join(FIXTURES, 'splits', `${name}.txt`), 'utf8');
      const leaves = baseline.split('\n').filter((l) => l.endsWith('(leaf)'));
      const stats = measureProvider(name, loadTools('tools', name), rules);
      expect(stats.leaves.length, name).toBe(leaves.length);
      expect(stats.tools, name).toBe(baseline.split('\n').filter((l) => l.includes('→')).length);
    }
  });

  it('tells apart the four reasons a tool becomes a leaf', () => {
    const stats = measureProvider(
      'acme',
      [
        tool('whoami'), // no verb anywhere
        tool('acme_search'), // only the verb is left once the provider word is dropped
        tool('issue_read'),
        tool('read_issue'), // both want issue:read (rule 6)
        tool('create_issue'),
      ],
      rules,
    );
    const reasons = Object.fromEntries(stats.leaves.map((l) => [l.raw, l.reason]));
    expect(reasons).toEqual({ whoami: 'no-verb', acme_search: 'verb-only', issue_read: 'conflict', read_issue: 'conflict' });
    expect(stats.leaves.find((l) => l.raw === 'issue_read')!.detail).toBe('issue:read');
    expect(stats.split).toBe(3);

    // `search` is a leaf named like the resource `batch_search` would form (rule 7): the resource yields.
    const shadowed = measureProvider('acme', [tool('search'), tool('batch_search')], rules);
    expect(shadowed.leaves.map((l) => [l.raw, l.reason, l.detail])).toEqual([
      ['search', 'verb-only', undefined],
      ['batch_search', 'shadowed', 'search'],
    ]);
  });

  it('has no rule 6 or rule 7 fallback on the fixtures (bench/results/0.4-split.md says so; update both together)', () => {
    for (const name of fixtureNames('tools')) {
      const stats = measureProvider(name, loadTools('tools', name), rules);
      expect(stats.leaves.filter((l) => l.reason === 'conflict' || l.reason === 'shadowed'), name).toEqual([]);
    }
  });
});
