import { describe, expect, it } from 'vitest';
import { buildCatalog, docTerms, SearchIndex, type McpTool } from '../../src/catalog';
import { normalizeQuery } from '../../src/catalog/search';
import { catalogFixture, loadTools } from '../helpers/fixtures';

const catalog = catalogFixture('tools');
const index = new SearchIndex(catalog);
const refs = (q: string, opts?: Parameters<SearchIndex['search']>[1]) => index.search(q, opts).map((h) => h.tool.ref);

describe('SearchIndex ranking (discovery.md, "搜索")', () => {
  it('1. exact canonical match comes first, in either written form', () => {
    expect(refs('github issue:read')[0]).toBe('github issue:read');
    expect(refs('github/issue:read')[0]).toBe('github issue:read');
    expect(refs('GitHub Issue:Read')[0]).toBe('github issue:read');
    expect(index.search('github issue:read')[0]?.tier).toBe(1);
  });

  it('1. matches the tool part alone across providers', () => {
    const hits = index.search('page:create');
    expect(hits[0]?.tier).toBe(1);
    expect(hits.map((h) => h.tool.ref)).toContain('notion page:create');
  });

  it('2. prefix match precedes substring match', () => {
    const hits = index.search('github issue');
    expect(hits.slice(0, 4).every((h) => h.tier === 2)).toBe(true);
    expect(hits[0]?.tool.ref.startsWith('github issue')).toBe(true);
  });

  it('3. substring of the canonical form', () => {
    const sub = index.search('request:merge');
    expect(sub[0]?.tier).toBe(3);
    expect(sub[0]?.tool.ref).toBe('github pull-request:merge');
    // Tiers never interleave: every exact/prefix/substring hit precedes BM25-only hits.
    const tiers = index.search('issue', { limit: 100 }).map((h) => h.tier);
    expect(tiers).toEqual([...tiers].sort());
  });

  it('4. multi-word queries rank by BM25 over name, description and parameter names', () => {
    expect(refs('merge pull request')[0]).toBe('github pull-request:merge');
    expect(refs('web search')[0]).toBe('exa web:search');
    expect(refs('take screenshot')).toEqual(expect.arrayContaining(['playwright browser-take-screenshot']));
    // Parameter names are indexed: `sql` is a parameter of postgres `query` only.
    expect(refs('run a sql statement')[0]).toBe('postgres query');
    // Descriptions are indexed.
    expect(refs('send an email message')).toContain('gmail message:send');
  });

  it('matches plurals and singulars alike', () => {
    const plural = refs('comments', { limit: 30 });
    expect(plural).toContain('github issue-comment:add');
    expect(plural).toContain('linear comment:list');
    expect(refs('comment create', { limit: 3 })).toContain('linear comment:create');
  });

  it('weighs name hits above description and parameter hits', () => {
    const small = new SearchIndex(
      buildCatalog([
        {
          provider: 'acme',
          tools: [
            { name: 'frobnicate', description: 'Does things with a widget. Widget widget widget.' },
            { name: 'make_widget', description: 'Makes it.' },
            { name: 'ping', description: 'Ping.', inputSchema: { type: 'object', properties: { widget: { type: 'string' } } } },
          ],
        },
      ]),
    );
    expect(small.search('widget').map((h) => h.tool.rawName)).toEqual(['make_widget', 'frobnicate', 'ping']);
  });

  it('5. lists everything in canonical order for an empty query', () => {
    const hits = index.search('', { limit: 1000 });
    expect(hits).toHaveLength(index.size);
    const sorted = hits.map((h) => h.tool.ref);
    expect(sorted).toEqual([...sorted].sort());
  });

  it('returns 10 results by default and honours the limit', () => {
    expect(index.search('get')).toHaveLength(10);
    expect(index.search('get', { limit: 3 })).toHaveLength(3);
  });

  it('returns nothing for gibberish', () => {
    expect(index.search('qqqqzzzz')).toEqual([]);
  });

  it('is deterministic', () => {
    expect(refs('create comment')).toEqual(refs('create comment'));
  });
});

describe('SearchIndex: a provider named after its resource (discovery.md, "搜索")', () => {
  // jobs.json: server `jobs`, tools `create_job` -> job:create, `jobs` (leaf), `close_jobs`, `create_topic`, ...
  // whose descriptions and parameters mention jobs throughout.
  const jobs = new SearchIndex(buildCatalog([{ provider: 'jobs', tools: loadTools('other', 'jobs') }]));
  const raw = (q: string, n = 1) => jobs.search(q, { limit: n }).map((h) => h.tool.rawName);

  it('ranks the tool named by the query first, whatever its split', () => {
    expect(raw('create job')).toEqual(['create_job']);
    expect(raw('list jobs')).toEqual(['jobs']);
    expect(raw('read job')).toEqual(['jobs']);
    expect(raw('create topic')).toEqual(['create_topic']);
    expect(raw('delete secrets')).toEqual(['delete_secrets']);
  });

  it('does not index the provider name in the name field of its tools', () => {
    const weightsOf = (rawName: string) => {
      const tool = jobs.search(rawName, { limit: 50 }).find((h) => h.tool.rawName === rawName)!.tool;
      const terms = docTerms(tool);
      return new Map(Array.from({ length: terms.pairs.length / 2 }, (_, i) => [terms.pairs[2 * i] as string, terms.pairs[2 * i + 1] as number]));
    };
    // `job` is the resource and the raw name (4 + 4) and the description (1): not the provider (4).
    expect(weightsOf('create_job').get('job')).toBe(9);
    // `secrets` only mentions jobs in its description.
    expect(weightsOf('secrets').get('job')).toBe(1);
  });

  it('still lets a provider word in the query scope the search to that provider', () => {
    const all = new SearchIndex(
      buildCatalog([
        { provider: 'jobs', tools: loadTools('other', 'jobs') },
        { provider: 'github', tools: loadTools('tools', 'github') },
      ]),
    );
    // github has a `job-log` tool; the query word `job` is also the name of the jobs provider.
    expect(all.search('read job', { limit: 1 })[0]!.tool.provider).toBe('jobs');
    expect(all.search('github read issue', { limit: 1 })[0]!.tool.ref).toBe('github issue:read');
  });

  it('indexes a provider word that the tool name has besides the provider prefix', () => {
    const small = new SearchIndex(
      buildCatalog([
        {
          provider: 'acme',
          tools: [
            { name: 'acme_list_widgets', description: 'Lists them.' },
            { name: 'acme_widgets_acme', description: 'Other.' },
            { name: 'list_acme_accounts', description: 'Lists accounts.' },
          ],
        },
      ]),
    );
    expect(small.search('list accounts', { limit: 1 })[0]!.tool.rawName).toBe('list_acme_accounts');
  });
});

describe('SearchIndex at scale', () => {
  it('searches 1,000 tools well inside the interactive budget', () => {
    const tools: McpTool[] = [];
    for (let i = 0; i < 1000; i++) {
      tools.push({
        name: `${['get', 'list', 'create', 'update'][i % 4]}_thing${i % 50}_item`,
        description: `Operate on thing ${i % 50} items for case ${i}`,
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, [`field_${i % 7}`]: { type: 'string' } } },
      });
    }
    const big = new SearchIndex(buildCatalog([{ provider: 'bulk', tools }]));
    expect(big.size).toBe(1000);
    const started = performance.now();
    for (let i = 0; i < 10; i++) big.search('update thing 7 item');
    const perQuery = (performance.now() - started) / 10;
    expect(perQuery).toBeLessThan(30);
  });
});

describe('normalizeQuery fast path', () => {
  const reference = (s: string): string => s.toLowerCase().replace(/\//g, ' ').replace(/_/g, '-').replace(/\s+/g, ' ').trim();

  it('gives what the four replacements give, for canonical and messy strings alike', () => {
    const alphabet = 'abcXYZ09_-/: \t\n Éé';
    let state = 99;
    const next = (): number => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state >>> 8;
    };
    for (let i = 0; i < 20_000; i += 1) {
      let s = '';
      for (let j = next() % 12; j > 0; j -= 1) s += alphabet[next() % alphabet.length];
      expect(normalizeQuery(s), JSON.stringify(s)).toBe(reference(s));
    }
    for (const tool of catalog.providers.flatMap((p) => p.tools)) {
      expect(normalizeQuery(tool.ref)).toBe(reference(tool.ref));
      expect(normalizeQuery(tool.name)).toBe(reference(tool.name));
    }
  });
});
