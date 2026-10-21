import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  buildProviderCatalog,
  extractParams,
  formatSignature,
  shortDescription,
  type McpTool,
} from '../../src/catalog';

const tools = (...names: string[]): McpTool[] => names.map((name) => ({ name }));
const names = (c: ReturnType<typeof buildProviderCatalog>) => c.tools.map((t) => t.name);

describe('conflicts (naming.md, rule 6)', () => {
  it('turns both tools into leaf tools when two split to the same resource:verb', () => {
    const c = buildProviderCatalog({ provider: 'acme', tools: tools('create_issue', 'issue_create', 'list_issues') });
    expect(names(c)).toEqual(['create-issue', 'issue-create', 'issue:list']);
    expect(c.leaves.map((t) => t.rawName)).toEqual(['create_issue', 'issue_create']);
    expect(c.resources.map((r) => r.name)).toEqual(['issue']);
  });

  it('keeps the original name usable as an alias even after a conflict', () => {
    const c = buildProviderCatalog({ provider: 'acme', tools: tools('create_issue', 'issue_create') });
    expect(c.tools.map((t) => t.rawName)).toEqual(['create_issue', 'issue_create']);
  });

  it('lets a user rename win over a rule-based split', () => {
    const c = buildProviderCatalog({
      provider: 'linear',
      tools: tools('list_issues', 'list_my_issues'),
      rename: { list_my_issues: 'issue:list' },
    });
    const byRaw = Object.fromEntries(c.tools.map((t) => [t.rawName, t]));
    expect(byRaw.list_my_issues?.name).toBe('issue:list');
    expect(byRaw.list_my_issues?.renamed).toBe(true);
    expect(byRaw.list_issues?.resource).toBeNull(); // the rule-based one steps aside
    expect(byRaw.list_issues?.name).toBe('list-issues');
  });

  it('applies renames to resource:verb and to leaf names', () => {
    const c = buildProviderCatalog({
      provider: 'linear',
      tools: tools('list_my_issues', 'whoami'),
      rename: { list_my_issues: 'issue:list-mine', whoami: 'Me' },
    });
    expect(names(c)).toEqual(['issue:list-mine', 'me']);
  });

  it('avoids a leaf named like a resource by falling back to the full kebab-case name', () => {
    const c = buildProviderCatalog({ provider: 'acme', tools: tools('list_search', 'acme_search') });
    // `acme_search` -> leaf `search`, which would shadow the resource `search`.
    expect(c.resources.map((r) => r.name)).toEqual(['search']);
    expect(c.leaves.map((t) => t.name)).toEqual(['acme-search']);
  });
});

describe('a leaf named like a resource (naming.md, rule 7)', () => {
  // Anysearch: `search` is a leaf, `batch_search` splits into `search:batch`; the leaf's raw name
  // is the resource's name, so the raw name cannot keep it reachable.
  const anysearch = () => buildProviderCatalog({ provider: 'anysearch', tools: tools('search', 'batch_search', 'extract') });

  it('lets the resource yield when the leaf has no other name: its tools become leaf tools', () => {
    const c = anysearch();
    expect(names(c)).toEqual(['search', 'batch-search', 'extract']);
    expect(c.resources).toEqual([]);
    expect(c.leaves.map((t) => t.rawName)).toEqual(['search', 'batch_search', 'extract']);
  });

  it('does not depend on the order of tools/list', () => {
    const c = buildProviderCatalog({ provider: 'anysearch', tools: tools('batch_search', 'extract', 'search') });
    expect([...names(c)].sort()).toEqual(['batch-search', 'extract', 'search']);
  });

  it('keeps the other resources and the rule 7 fallback where the raw name differs', () => {
    const c = buildProviderCatalog({ provider: 'acme', tools: tools('search', 'batch_search', 'list_search', 'acme_issue', 'list_issues') });
    // `search` has only its own name, so the whole `search` resource yields; `acme_issue` -> leaf
    // `issue` is reachable as `acme-issue`, so the `issue` resource stays.
    expect(c.resources.map((r) => r.name)).toEqual(['issue']);
    expect(names(c)).toEqual(['search', 'batch-search', 'list-search', 'acme-issue', 'issue:list']);
  });

  it('keeps a resource that a user rename put there', () => {
    const c = buildProviderCatalog({ provider: 'anysearch', tools: tools('search', 'batch_search'), rename: { batch_search: 'search:batch' } });
    expect(c.resources.map((r) => r.name)).toEqual(['search']);
    expect(names(c)).toEqual(['search', 'search:batch']);
  });
});

describe('deny filter (discovery.md, step 6)', () => {
  it('removes denied tools from the catalog; patterns match canonical and raw forms', () => {
    const c = buildProviderCatalog({
      provider: 'github',
      tools: tools('delete_file', 'create_branch', 'get_me'),
      deny: [/^github\/file:delete$/, /^github\/get_me$/],
    });
    expect(names(c)).toEqual(['branch:create']);
  });
});

describe('buildCatalog', () => {
  it('sorts providers by name and normalises provider names', () => {
    const c = buildCatalog([
      { provider: 'Zeta_Server', tools: tools('get_a') },
      { provider: 'alpha', tools: tools('get_b') },
    ]);
    expect(c.providers.map((p) => p.provider)).toEqual(['alpha', 'zeta-server']);
  });

  it('leaves out providers whose name collides with a built-in subcommand, with a warning', () => {
    const c = buildCatalog([
      { provider: 'find', tools: tools('get_a') },
      { provider: 'ok', tools: tools('get_b') },
    ]);
    expect(c.providers.map((p) => p.provider)).toEqual(['ok']);
    expect(c.warnings).toMatchObject([{ provider: 'find', code: 'reserved-name' }]);
  });

  it('warns about duplicate providers and keeps the first', () => {
    const c = buildCatalog([
      { provider: 'dup', tools: tools('get_a') },
      { provider: 'dup', tools: tools('get_b') },
    ]);
    expect(c.providers).toHaveLength(1);
    expect(c.providers[0]?.tools[0]?.rawName).toBe('get_a');
    expect(c.warnings[0]?.code).toBe('duplicate-provider');
  });

  it('is independent of tools/list order for names (only the view order follows it)', () => {
    const forward = buildProviderCatalog({ provider: 'p', tools: tools('get_a', 'list_as', 'create_b') });
    const backward = buildProviderCatalog({ provider: 'p', tools: tools('create_b', 'list_as', 'get_a') });
    expect([...names(forward)].sort()).toEqual([...names(backward)].sort());
    expect(forward.resources.map((r) => r.name)).toEqual(backward.resources.map((r) => r.name));
  });
});

describe('canonical forms', () => {
  it('provides command-line and single-string forms', () => {
    const c = buildProviderCatalog({ provider: 'linear', tools: tools('create_issue', 'whoami') });
    expect(c.tools.map((t) => [t.ref, t.singleRef])).toEqual([
      ['linear issue:create', 'linear/issue:create'],
      ['linear whoami', 'linear/whoami'],
    ]);
  });

  it('reads annotations', () => {
    const c = buildProviderCatalog({
      provider: 'x',
      tools: [
        { name: 'get_a', annotations: { readOnlyHint: true } },
        { name: 'delete_a', annotations: { destructiveHint: true } },
        { name: 'search_a', annotations: { readOnlyHint: true, destructiveHint: true } },
        { name: 'update_a', annotations: { readOnlyHint: false, destructiveHint: true } },
      ],
    });
    // MCP: destructiveHint means something only when readOnlyHint is false, so read-only wins.
    expect(c.tools.map((t) => [t.readOnly, t.destructive])).toEqual([
      [true, false],
      [false, true],
      [true, false],
      [false, true],
    ]);
  });
});

describe('signatures (discovery.md, "浏览视图")', () => {
  it('puts required parameters first, optional ones in brackets, names in kebab-case', () => {
    const params = extractParams({
      type: 'object',
      properties: { perPage: {}, owner: {}, issue_number: {}, state: {} },
      required: ['owner', 'issue_number'],
    });
    expect(formatSignature(params)).toBe('owner, issue-number, [per-page], [state]');
  });

  it('keeps original names when two parameters collide after normalisation', () => {
    const params = extractParams({ properties: { issue_number: {}, issueNumber: {}, repo: {} } });
    expect(params.map((p) => p.arg)).toEqual(['issue_number', 'issueNumber', 'repo']);
  });

  it('never cuts required parameters but caps the optional ones', () => {
    const properties = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n) => [n, {}]));
    expect(formatSignature(extractParams({ properties, required: ['a', 'b'] }))).toBe('a, b, [c], [d], [e], [f], …');
    expect(formatSignature(extractParams({ properties, required: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }))).toBe(
      'a, b, c, d, e, f, g, …',
    );
  });

  it('handles tools without a schema', () => {
    expect(formatSignature(extractParams(undefined))).toBe('');
  });
});

describe('shortDescription', () => {
  it('uses the first non-empty line and cuts to 60 characters', () => {
    expect(shortDescription('\n  Get   issue details \nMore text')).toBe('Get issue details');
    const long = 'x'.repeat(100);
    expect(Array.from(shortDescription(long))).toHaveLength(60);
    expect(shortDescription(long).endsWith('…')).toBe(true);
  });

  it('counts CJK characters as characters', () => {
    expect(shortDescription('获取'.repeat(40))).toHaveLength(60);
  });
});
