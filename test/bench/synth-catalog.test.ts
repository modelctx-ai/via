import { describe, expect, it } from 'vitest';
import { buildCatalog, SearchIndex } from '../../src/catalog';
import { loadBaseProviders, synthesizeProviders } from '../../scripts/lib/synth-catalog';
import { FIXTURES } from '../helpers/fixtures';

// The performance benchmark (`npm run bench:perf`) times `find` over a synthetic 1,000-tool
// catalog. The timings are not asserted anywhere; what is asserted here is that the catalog is
// the same on every run and machine, and that search over it still gives sensible answers.
const bases = loadBaseProviders(FIXTURES);
const providers = synthesizeProviders(bases);
const catalog = buildCatalog(providers);
const index = new SearchIndex(catalog);

describe('synthetic 1,000-tool catalog', () => {
  it('has exactly the requested size', () => {
    expect(providers).toHaveLength(50);
    expect(providers.reduce((n, p) => n + p.tools.length, 0)).toBe(1000);
    expect(index.size).toBe(1000);
    expect(catalog.warnings).toEqual([]);
  });

  it('is deterministic for a seed and differs between seeds', () => {
    expect(synthesizeProviders(bases)).toEqual(providers);
    expect(synthesizeProviders(bases, { seed: 2 })).not.toEqual(providers);
    expect(synthesizeProviders(bases, { tools: 120, providers: 6 }).map((p) => p.tools.length)).toEqual([20, 20, 20, 20, 20, 20]);
  });

  it('keeps provider names and raw tool names unique', () => {
    expect(new Set(providers.map((p) => p.provider)).size).toBe(providers.length);
    for (const p of providers) expect(new Set(p.tools.map((t) => t.name)).size).toBe(p.tools.length);
  });

  it('finds the obvious tool first', () => {
    // Every tool is its own best match, whatever the provider clone it belongs to.
    for (const tool of [catalog.providers[0]!.tools[3]!, catalog.providers[17]!.tools[9]!, catalog.providers[49]!.tools[19]!]) {
      expect(index.search(tool.ref)[0]?.tool.ref).toBe(tool.ref);
    }
    expect(index.search('github create pull request')[0]?.tool.provider).toMatch(/^github/);
    expect(index.search('send an email message')[0]?.tool.provider).toMatch(/^gmail/);
    expect(index.search('run a sql statement')[0]?.tool.provider).toMatch(/^(postgres|sqlite|acme-sql)/);
    const hits = index.search('merge pull request', { limit: 5 });
    expect(hits.length).toBe(5);
    expect(hits[0]?.tool.provider).toMatch(/^(github|acme-git)/);
  });

  it('spreads clones of a provider over distinct names', () => {
    const github = providers.map((p) => p.provider).filter((n) => n.startsWith('github'));
    expect(github[0]).toBe('github');
    expect(github.length).toBeGreaterThan(1);
  });
});
