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

interface Doc {
  tool: CatalogTool;
  tf: Map<string, number>;
  length: number;
  forms: string[];
  domains: ProviderCatalog['domain']['domains'];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Lower-case, `/` becomes a space, `_` becomes `-`, whitespace collapsed. */
function normalizeQuery(s: string): string {
  return s.toLowerCase().replace(/\//g, ' ').replace(/_/g, '-').replace(/\s+/g, ' ').trim();
}

/** Inverted index over a catalog: provider, resource, verb, raw name, description, parameter names. */
export class SearchIndex {
  private readonly docs: Doc[] = [];
  private readonly postings = new Map<string, Array<[docId: number, tf: number]>>();
  private avgLength = 1;
  private readonly rules: CatalogRules;

  constructor(catalog: Catalog, rules: CatalogRules = defaultCatalogRules()) {
    this.rules = rules;
    for (const provider of catalog.providers) {
      for (const tool of provider.tools) this.add(tool, provider);
    }
    this.avgLength = this.docs.length === 0 ? 1 : this.docs.reduce((n, d) => n + d.length, 0) / this.docs.length;
    this.docs.forEach((doc, id) => {
      for (const [term, tf] of doc.tf) {
        const list = this.postings.get(term) ?? [];
        list.push([id, tf]);
        this.postings.set(term, list);
      }
    });
  }

  get size(): number {
    return this.docs.length;
  }

  private terms(text: string, ignoreStopwords: boolean): string[] {
    const out: string[] = [];
    for (const w of tokenize(text)) {
      if (ignoreStopwords && (w.length < 2 || this.rules.domains.stopwords.has(w))) continue;
      out.push(singularize(w, this.rules.split));
    }
    return out;
  }

  private add(tool: CatalogTool, provider: ProviderCatalog): void {
    const tf = new Map<string, number>();
    let length = 0;
    const bump = (terms: string[], weight: number) => {
      for (const t of terms) {
        tf.set(t, (tf.get(t) ?? 0) + weight);
        length += weight;
      }
    };
    bump(this.terms(`${tool.provider} ${tool.name} ${tool.rawName}`, false), FIELD_WEIGHT.name);
    bump(this.terms(tool.params.map((p) => p.name).join(' '), false), FIELD_WEIGHT.param);
    bump(this.terms(tool.description, true), FIELD_WEIGHT.description);
    const forms = [tool.ref, tool.name].map(normalizeQuery);
    this.docs.push({ tool, tf, length, forms, domains: provider.domain.domains });
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
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
      for (const [id, tf] of list) {
        const len = this.docs[id]!.length;
        const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + (B * len) / this.avgLength));
        scores.set(id, (scores.get(id) ?? 0) + idf * norm);
      }
    }
    return scores;
  }
}
