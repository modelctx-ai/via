import type { CatalogRules } from './provider';
import { defaultCatalogRules } from './provider';
import { singularize } from './singularize';
import { tokenize } from './tokenize';
import type { Catalog, CatalogTool, ProviderCatalog } from './types';

// BM25 parameters and per-field weights. Name hits weigh most (discovery.md, "搜索").
const K1 = 1.2;
const B = 0.75;
const FIELD_WEIGHT = { name: 4, param: 2, description: 1 } as const;

export interface SearchHit {
  tool: CatalogTool;
  /** 1 exact, 2 prefix, 3 substring of the canonical form, 4 BM25 only. */
  tier: 1 | 2 | 3 | 4;
  /** BM25 score; 0 when the tool matched on the canonical form only. */
  score: number;
}

export interface SearchOptions {
  /** Maximum results; default 10. */
  limit?: number;
  /** Only tools that belong to this domain (`via find --domain`). */
  domain?: string;
}

/** What the index keeps per tool besides the tool itself: weighted term frequencies and their sum. */
export interface DocTerms {
  /** Sum of the weights. */
  length: number;
  /** `[term, weight, term, weight, ...]`, each term once. */
  pairs: ReadonlyArray<string | number>;
}

interface Doc {
  tool: CatalogTool;
  length: number;
  forms: string[];
  domains: ProviderCatalog['domain']['domains'];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Words of one or more non-space characters other than `/` and `_`, separated by single spaces. */
const ALREADY_NORMAL = /^(?:[^\s/_]+(?: [^\s/_]+)*)?$/;

/** Lower-case, `/` becomes a space, `_` becomes `-`, whitespace collapsed. */
export function normalizeQuery(s: string): string {
  // Canonical tool names (lower-case kebab, one space between provider and name) are already normal.
  if (ALREADY_NORMAL.test(s) && s === s.toLowerCase()) return s;
  return s.toLowerCase().replace(/\//g, ' ').replace(/_/g, '-').replace(/\s+/g, ' ').trim();
}

/** Lower-case words of `text` in index form: singular, and without stop words when asked. */
function termsOf(text: string, ignoreStopwords: boolean, rules: CatalogRules): string[] {
  const out: string[] = [];
  for (const w of tokenize(text)) {
    if (ignoreStopwords && (w.length < 2 || rules.domains.stopwords.has(w))) continue;
    out.push(singularize(w, rules.split));
  }
  return out;
}

/** The terms a tool is indexed under: provider, name and raw name (weight 4), parameter names (2), description (1). */
export function docTerms(tool: CatalogTool, rules: CatalogRules = defaultCatalogRules()): DocTerms {
  const tf = new Map<string, number>();
  let length = 0;
  const bump = (terms: string[], weight: number) => {
    for (const t of terms) {
      tf.set(t, (tf.get(t) ?? 0) + weight);
      length += weight;
    }
  };
  bump(termsOf(`${tool.provider} ${tool.name} ${tool.rawName}`, false, rules), FIELD_WEIGHT.name);
  bump(termsOf(tool.params.map((p) => p.name).join(' '), false, rules), FIELD_WEIGHT.param);
  bump(termsOf(tool.description, true, rules), FIELD_WEIGHT.description);
  return { length, pairs: [...tf].flat() };
}

/** Inverted index over a catalog: provider, resource, verb, raw name, description, parameter names. */
export class SearchIndex {
  private readonly docs: Doc[] = [];
  /** term -> `[docId, tf, docId, tf, ...]`, in doc order (flat: one array per term, not one per posting). */
  private readonly postings = new Map<string, number[]>();
  private avgLength = 1;
  private readonly rules: CatalogRules;

  /**
   * `precomputed` holds the `docTerms` of tools whose terms are already known (a cached build);
   * the others are computed here. Either way the index is the same.
   */
  constructor(catalog: Catalog, rules: CatalogRules = defaultCatalogRules(), precomputed?: { get(tool: CatalogTool): DocTerms | undefined }) {
    this.rules = rules;
    for (const provider of catalog.providers) {
      for (const tool of provider.tools) this.add(tool, provider, precomputed?.get(tool));
    }
    this.avgLength = this.docs.length === 0 ? 1 : this.docs.reduce((n, d) => n + d.length, 0) / this.docs.length;
  }

  get size(): number {
    return this.docs.length;
  }

  private terms(text: string, ignoreStopwords: boolean): string[] {
    return termsOf(text, ignoreStopwords, this.rules);
  }

  private add(tool: CatalogTool, provider: ProviderCatalog, known: DocTerms | undefined): void {
    const { length, pairs } = known ?? docTerms(tool, this.rules);
    const id = this.docs.length;
    this.docs.push({ tool, length, forms: [normalizeQuery(tool.ref), normalizeQuery(tool.name)], domains: provider.domain.domains });
    for (let i = 0; i < pairs.length; i += 2) {
      const term = pairs[i] as string;
      const list = this.postings.get(term);
      if (list) list.push(id, pairs[i + 1] as number);
      else this.postings.set(term, [id, pairs[i + 1] as number]);
    }
  }

  private inDomain(doc: Doc, domain: string): boolean {
    return doc.domains.some(
      (d) => d.domain === domain && (d.resources === undefined || (doc.tool.resource !== null && d.resources.includes(doc.tool.resource))),
    );
  }

  /** Ranked search (discovery.md, "搜索"). An empty query lists every tool in canonical order. */
  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const limit = options.limit ?? 10;
    const candidates = this.docs.map((doc, id) => ({ doc, id })).filter(({ doc }) => !options.domain || this.inDomain(doc, options.domain));

    const q = normalizeQuery(query);
    if (q === '') {
      return candidates
        .map(({ doc }) => ({ tool: doc.tool, tier: 4 as const, score: 0 }))
        .sort((a, b) => cmp(a.tool.ref, b.tool.ref))
        .slice(0, limit);
    }

    const scores = this.bm25(q);
    const hits: SearchHit[] = [];
    for (const { doc, id } of candidates) {
      const [ref, name] = doc.forms as [string, string];
      let tier: SearchHit['tier'] | 0 = 0;
      if (q === ref || q === name) tier = 1;
      else if (ref.startsWith(q) || name.startsWith(q)) tier = 2;
      else if (ref.includes(q)) tier = 3;
      const score = scores.get(id) ?? 0;
      if (tier === 0 && score <= 0) continue;
      hits.push({ tool: doc.tool, tier: tier === 0 ? 4 : tier, score });
    }
    hits.sort((a, b) => a.tier - b.tier || b.score - a.score || cmp(a.tool.ref, b.tool.ref));
    return hits.slice(0, limit);
  }

  private bm25(normalizedQuery: string): Map<number, number> {
    const significant = [...new Set(this.terms(normalizedQuery, true))];
    const terms = significant.length > 0 ? significant : [...new Set(this.terms(normalizedQuery, false))];
    const n = this.docs.length;
    const scores = new Map<number, number>();
    for (const term of terms) {
      const list = this.postings.get(term);
      if (!list) continue;
      const df = list.length / 2;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (let i = 0; i < list.length; i += 2) {
        const id = list[i]!;
        const tf = list[i + 1]!;
        const len = this.docs[id]!.length;
        const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + (B * len) / this.avgLength));
        scores.set(id, (scores.get(id) ?? 0) + idf * norm);
      }
    }
    return scores;
  }
}
