import { describe, expect, it } from 'vitest';
import { buildCatalog, resolveProvider, resolveTarget, didYouMean, editDistance, type McpTool } from '../../src/catalog';
import { catalogFixture } from '../helpers/fixtures';

const catalog = catalogFixture('tools');
const target = (provider: string, input: string) => {
  const p = resolveProvider(catalog, provider);
  if (p.kind !== 'provider') throw new Error(`no provider ${provider}`);
  return resolveTarget(p.provider, input);
};

describe('resolveProvider', () => {
  it('accepts exact names case-insensitively, with - and _ equivalent', () => {
    expect(resolveProvider(catalog, 'GitHub').kind).toBe('provider');
    expect(resolveProvider(catalog, 'google_drive').kind).toBe('provider');
  });

  it('accepts a unique prefix', () => {
    const r = resolveProvider(catalog, 'play');
    expect(r.kind === 'provider' && r.provider.provider).toBe('playwright');
  });

  it('refuses an ambiguous prefix and lists the candidates', () => {
    expect(resolveProvider(catalog, 'g')).toEqual({ kind: 'ambiguous', candidates: ['github', 'gmail', 'google-drive'] });
  });

  it('suggests close names when nothing matches', () => {
    expect(resolveProvider(catalog, 'githb')).toEqual({ kind: 'not-found', suggestions: ['github'] });
    expect(resolveProvider(catalog, 'zzzzzz')).toEqual({ kind: 'not-found', suggestions: [] });
  });
});

describe('resolveTarget (cli.md, "解析顺序")', () => {
  it('resolves resource:verb', () => {
    const r = target('github', 'issue:read');
    expect(r.kind === 'tool' && r.tool.rawName).toBe('issue_read');
  });

  it('is lenient about case and - / _ ', () => {
    for (const input of ['ISSUE:READ', 'Issue:Read']) {
      const r = target('github', input);
      expect(r.kind === 'tool' && r.tool.rawName).toBe('issue_read');
    }
    const r = target('github', 'pull_request:read');
    expect(r.kind === 'tool' && r.tool.rawName).toBe('pull_request_read');
  });

  it('accepts a unique resource prefix before the colon', () => {
    const ok = target('linear', 'proj:create');
    expect(ok.kind === 'tool' && ok.tool.rawName).toBe('create_project');
    // `iss` is a prefix of issue, issue-label and issue-status: not unique, so nothing runs.
    expect(target('linear', 'iss:create')).toEqual({
      kind: 'ambiguous',
      candidates: ['issue', 'issue-label', 'issue-status'],
    });
  });

  it('keeps raw names valid as aliases', () => {
    for (const [provider, raw, canonical] of [
      ['linear', 'create_issue', 'issue:create'],
      ['notion', 'notion-create-pages', 'page:create'],
      ['github', 'create_or_update_file', 'file:create-or-update'],
      ['github', 'request_copilot_review', 'request-copilot-review'],
    ] as const) {
      const r = target(provider, raw);
      expect(r.kind === 'tool' && r.tool.name, raw).toBe(canonical);
    }
  });

  it('browses a resource when the argument has no colon and matches one', () => {
    const r = target('github', 'issue');
    expect(r.kind === 'resource' && r.resource.name).toBe('issue');
  });

  it('calls a leaf tool by name', () => {
    const r = target('notion', 'search');
    expect(r.kind === 'tool' && r.tool.rawName).toBe('notion-search');
  });

  it('prefers the resource when a resource and a leaf share a name; the leaf stays reachable by raw name', () => {
    const tools: McpTool[] = [{ name: 'list_search' }, { name: 'acme_search' }];
    // `list_search` -> resource `search` (verb list); `acme_search` -> leaf `search`, renamed `acme-search`.
    const p = buildCatalog([{ provider: 'acme', tools }]).providers[0]!;
    expect(resolveTarget(p, 'search').kind).toBe('resource');
    const byRaw = resolveTarget(p, 'acme_search');
    expect(byRaw.kind === 'tool' && byRaw.tool.name).toBe('acme-search');
  });

  it('resolves a leaf whose raw name is the resource name: the resource yielded (naming.md, rule 7)', () => {
    const tools: McpTool[] = [{ name: 'list_search' }, { name: 'search_search' }, { name: 'search' }];
    const p = buildCatalog([{ provider: 'acme', tools }]).providers[0]!;
    expect(p.resources).toEqual([]);
    const leaf = resolveTarget(p, 'search');
    expect(leaf.kind === 'tool' && leaf.tool.rawName).toBe('search');
    const other = resolveTarget(p, 'search_search');
    expect(other.kind === 'tool' && other.tool.name).toBe('search-search');
  });

  it('reports ambiguous prefixes with candidates', () => {
    const r = target('github', 'issue-');
    expect(r).toEqual({ kind: 'ambiguous', candidates: ['issue-comment', 'issue-field', 'issue-type'] });
  });

  it('suggests at most 3 per-segment corrections', () => {
    expect(target('github', 'isue:read')).toEqual({ kind: 'not-found', suggestions: ['issue:read'] });
    expect(target('github', 'issue:raed')).toEqual({ kind: 'not-found', suggestions: ['issue:read'] });
    expect(target('github', 'pul-request:merge')).toEqual({ kind: 'not-found', suggestions: ['pull-request:merge'] });
    // Nothing close: fall back to the verbs the resource does have, at most 3.
    expect(target('github', 'issue:x')).toEqual({
      kind: 'not-found',
      suggestions: ['issue:read', 'issue:write', 'issue:list'],
    });
    const none = target('github', 'zzzz:read');
    expect(none).toEqual({ kind: 'not-found', suggestions: [] });
  });

  it('suggests close resources and tools for a bare unknown word', () => {
    expect(target('github', 'isue')).toEqual({ kind: 'not-found', suggestions: ['issue'] });
    expect(target('notion', 'serch')).toEqual({ kind: 'not-found', suggestions: ['search'] });
  });
});

describe('edit distance helpers', () => {
  it('computes Levenshtein distance', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('same', 'same')).toBe(0);
    expect(editDistance('raed', 'read')).toBe(1); // transposition
  });

  it('limits suggestions to 3, nearest first', () => {
    expect(didYouMean('lst', ['list', 'lost', 'last', 'lust', 'zebra'])).toEqual(['last', 'list', 'lost']);
  });
});
