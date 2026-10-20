import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  compileSynonyms,
  defaultSplitRules,
  defaultSynonyms,
  expandQuery,
  SearchIndex,
  stemCandidates,
  type McpTool,
  type SynonymsData,
} from '../../src/catalog';
import { catalogFixture } from '../helpers/fixtures';

const split = defaultSplitRules();
const syn = defaultSynonyms(split);

const catalog = catalogFixture('tools');
const index = new SearchIndex(catalog);
const lexical = new SearchIndex(catalog, undefined, { synonyms: false });
const refs = (i: SearchIndex, q: string, limit = 10) => i.search(q, { limit }).map((h) => h.tool.ref);

function small(tools: Array<[string, string]>, synonyms?: SynonymsData): SearchIndex {
  const defs: McpTool[] = tools.map(([name, description]) => ({ name, description }));
  const rules = synonyms ? compileSynonyms(synonyms, split) : undefined;
  return new SearchIndex(buildCatalog([{ provider: 'acme', tools: defs }]), undefined, rules ? { synonyms: rules } : {});
}

describe('stemCandidates (data/synonyms.json suffixes)', () => {
  const stems = (w: string) => stemCandidates(w, syn.suffixes);
  it('restores the base form of inflected verbs', () => {
    expect(stems('creating')).toContain('create');
    expect(stems('deleted')).toContain('delete');
    expect(stems('searching')).toContain('search');
    expect(stems('listed')).toContain('list');
    expect(stems('copied')).toContain('copy');
    expect(stems('creation')).toContain('create');
    expect(stems('deletion')).toContain('delete');
    expect(stems('reader')).toContain('read');
  });
  it('undoes doubled consonants', () => {
    expect(stems('running')).toContain('run');
    expect(stems('mapped')).toContain('map');
  });
  it('does not stem very short bases', () => {
    expect(stems('using')).toEqual([]);
    expect(stems('red')).toEqual([]);
  });
});

describe('data-driven expansion', () => {
  const terms = (q: string) => q.split(' ');
  const expand = (q: string, vocabulary: string[]) => expandQuery(syn, terms(q), terms(q), (t) => vocabulary.includes(t));

  it('expands single words to the other members of their groups, down-weighted', () => {
    const [concept] = expand('delete', ['remove', 'destroy', 'delete']);
    expect(concept?.alts.map((a) => a.terms[0]).sort()).toEqual(['destroy', 'remove']);
    expect(concept?.alts.every((a) => a.weight < 1)).toBe(true);
  });

  it('expands phrases and expands to phrases', () => {
    const phrase = expand('pull request', ['pr', 'merge', 'pull', 'request']).find((c) => c.term === null);
    expect(phrase?.alts.map((a) => a.terms.join(' '))).toEqual(expect.arrayContaining(['pr', 'merge']));
    const [pr] = expand('pr', ['pull', 'request']);
    expect(pr?.alts.map((a) => a.terms.join(' '))).toContain('pull request');
  });

  it('only offers terms that exist in the index and are not already in the query', () => {
    expect(expand('delete remove', ['remove', 'delete', 'drop']).flatMap((c) => c.alts.flatMap((a) => a.terms))).not.toContain('remove');
    expect(expand('delete', ['nothing-here'])[0]?.alts).toEqual([]);
  });

  it('offers stems at the stem weight', () => {
    const [c] = expand('creating', ['create']);
    expect(c?.alts).toContainEqual({ terms: ['create'], weight: syn.stemWeight });
  });

  it('is deterministic', () => {
    const vocabulary = ['remove', 'destroy', 'delete', 'drop', 'erase'];
    expect(expand('delete', vocabulary)).toEqual(expand('delete', vocabulary));
  });
});

describe('search with synonym expansion (discovery.md, "搜索")', () => {
  it('finds a tool by a synonym of its verb or resource', () => {
    expect(refs(index, 'remove a page')).toContain('notion page:delete');
    expect(refs(lexical, 'remove a page', 100)).toContain('notion page:delete');
    expect(refs(index, 'edit a ticket', 5)).toContain('linear issue:update');
    expect(refs(index, 'merge a PR')).toContain('github pull-request:merge');
    expect(refs(index, 'list sprints')[0]).toBe('linear cycle:list');
    expect(refs(index, 'share a document with someone')[0]).toBe('google-drive share-file');
  });

  it('ranks synonym matches below exact matches of the same shape', () => {
    const idx = small([
      ['remove_widget', 'Removes a widget.'],
      ['delete_widget', 'Deletes a widget.'],
      ['rename_widget', 'Renames a widget.'],
    ]);
    expect(idx.search('remove widget').map((h) => h.tool.rawName)).toEqual(['remove_widget', 'delete_widget', 'rename_widget']);
    expect(idx.search('delete widget').map((h) => h.tool.rawName)[0]).toBe('delete_widget');
  });

  it('never lets a synonym outscore an exact hit on the same concept', () => {
    const idx = small([
      ['archive_widget', 'Archive it.'],
      ['destroy_widget', 'Destroy it.'],
      ['delete_widget', 'Delete it. Delete deletes delete.'],
    ]);
    // delete_widget has the exact word; destroy_widget only the synonym, however rare it is.
    expect(idx.search('delete widget')[0]?.tool.rawName).toBe('delete_widget');
  });

  it('keeps the canonical tiers: exact, prefix and substring matches precede expansion-only hits', () => {
    const hits = index.search('page:delete', { limit: 100 });
    expect(hits[0]?.tier).toBe(1);
    const tiers = index.search('issue', { limit: 100 }).map((h) => h.tier);
    expect(tiers).toEqual([...tiers].sort());
    expect(refs(index, 'github issue:read')[0]).toBe('github issue:read');
  });

  it('breaks ties by canonical form, so repeated runs and fresh indexes agree', () => {
    const a = refs(index, 'remove a page', 30);
    expect(refs(index, 'remove a page', 30)).toEqual(a);
    expect(refs(new SearchIndex(catalogFixture('tools')), 'remove a page', 30)).toEqual(a);
    const hits = index.search('delete', { limit: 100 });
    for (let i = 1; i < hits.length; i += 1) {
      const [p, q] = [hits[i - 1]!, hits[i]!];
      if (p.tier === q.tier && p.score === q.score) expect(p.tool.ref < q.tool.ref).toBe(true);
    }
  });

  it('gives the same results with synonyms off as the lexical rules for queries without synonyms', () => {
    expect(refs(index, 'github issue:read')).toEqual(refs(lexical, 'github issue:read'));
    expect(refs(index, 'sql')).toEqual(expect.arrayContaining(['postgres query']));
  });

  it('matches inflected verbs', () => {
    expect(refs(index, 'creating issues', 5)).toContain('linear issue:create');
    expect(refs(index, 'searching repositories', 3)).toContain('github repository:search');
  });

  it('ignores conversational filler when real words remain', () => {
    expect(refs(index, 'I want to delete my emails')).toEqual(refs(index, 'delete emails'));
    // ...but a query made only of filler still searches for it.
    expect(() => index.search('please')).not.toThrow();
  });

  it('does not let a rare abbreviation outweigh the words it stands for', () => {
    expect(refs(index, 'merge pull request')[0]).toBe('github pull-request:merge');
  });

  it('honours the domain filter and the limit with expansion on', () => {
    expect(index.search('remove a page', { limit: 3 })).toHaveLength(3);
    const hits = index.search('remove a page', { domain: 'docs', limit: 50 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => ['notion', 'google-drive'].includes(h.tool.provider))).toBe(true);
  });

  it('works with custom synonym data', () => {
    const custom: SynonymsData = { version: 1, weights: { verb: 0.5, resource: 0.5, stem: 0.8 }, verbs: [['zap', 'delete']], resources: [] };
    const idx = small([['delete_widget', 'x'], ['list_widget', 'y']], custom);
    expect(idx.search('zap')[0]?.tool.rawName).toBe('delete_widget');
  });
});
