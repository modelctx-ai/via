import type { CatalogRules } from './provider';
import { defaultCatalogRules } from './provider';
import { singularize } from './singularize';
import { defaultSynonyms, expandQuery, type Synonyms } from './synonyms';
import { tokenize } from './tokenize';
import type { Catalog, CatalogTool, ProviderCatalog } from './types';

// BM25 parameters and per-field weights. Name hits weigh most (discovery.md, "搜索").
const K1 = 1.2;
const B = 0.75;
const FIELD_WEIGHT = { name: 4, param: 2, description: 1 } as const;
// Reciprocal rank fusion constant for hybrid ranking (discovery.md, "语义检索").
const RRF_K = 60;
// Semantic candidates beyond the requested limit that take part in fusion.
const SEMANTIC_MIN_DEPTH = 30;

export interface SearchHit {
  tool: CatalogTool;
  /** 1 exact, 2 prefix, 3 substring of the canonical form, 4 BM25 only. */
  tier: 1 | 2 | 3 | 4;
  /** BM25 score; 0 when the tool matched on the canonical form only. */
  score: number;
  /** Reciprocal-rank-fusion score, present only when semantic scores took part in the ranking. */
  fused?: number;
}

export interface SearchOptions {
  /** Maximum results; default 10. */
  limit?: number;
  /** Only tools that belong to this domain (`via find --domain`). */
  domain?: string;
  /**
   * Cosine similarity of the query to each tool, keyed by `CatalogTool.ref` (optional embedding
   * retrieval, ADR 0010). When present the BM25 and semantic rankings are fused with RRF inside each tier.
   */
  semantic?: ReadonlyMap<string, number>;
}

export interface SearchIndexOptions {
  /** Query expansion with `data/synonyms.json`; `false` turns it off (the lexical baseline). Default: the bundled data. */
  synonyms?: Synonyms | false;
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
  private readonly synonymsOption: Synonyms | false | undefined;
  private compiledSynonyms?: Synonyms;

  constructor(catalog: Catalog, rules: CatalogRules = defaultCatalogRules(), options: SearchIndexOptions = {}) {
    this.rules = rules;
    this.synonymsOption = options.synonyms;
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
    const fusion = options.semantic ? this.fusion(candidates, scores, options.semantic, Math.max(limit * 3, SEMANTIC_MIN_DEPTH)) : undefined;
    const hits: SearchHit[] = [];
    for (const { doc, id } of candidates) {
      const [ref, name] = doc.forms as [string, string];
      let tier: SearchHit['tier'] | 0 = 0;
      if (q === ref || q === name) tier = 1;
      else if (ref.startsWith(q) || name.startsWith(q)) tier = 2;
      else if (ref.includes(q)) tier = 3;
      const score = scores.get(id) ?? 0;
      const fused = fusion?.get(id);
      if (tier === 0 && score <= 0 && fused === undefined) continue;
      hits.push({ tool: doc.tool, tier: tier === 0 ? 4 : tier, score, ...(fusion ? { fused: fused ?? 0 } : {}) });
    }
    hits.sort((a, b) => a.tier - b.tier || (b.fused ?? 0) - (a.fused ?? 0) || b.score - a.score || cmp(a.tool.ref, b.tool.ref));
    return hits.slice(0, limit);
  }

  /**
   * Reciprocal rank fusion of the BM25 ranking and the semantic ranking (top `depth` only), per doc id.
   * Ranks are 1-based and ties break on the canonical form, so the same inputs always fuse the same way.
   */
  private fusion(
    candidates: ReadonlyArray<{ doc: Doc; id: number }>,
    bm25: ReadonlyMap<number, number>,
    semantic: ReadonlyMap<string, number>,
    depth: number,
  ): Map<number, number> {
    const rank = (entries: Array<{ id: number; score: number; ref: string }>): Array<{ id: number }> =>
      entries.sort((a, b) => b.score - a.score || cmp(a.ref, b.ref));
    const lexical = rank(candidates.filter(({ id }) => (bm25.get(id) ?? 0) > 0).map(({ doc, id }) => ({ id, score: bm25.get(id)!, ref: doc.tool.ref })));
    const sem = rank(
      candidates.filter(({ doc }) => semantic.has(doc.tool.ref)).map(({ doc, id }) => ({ id, score: semantic.get(doc.tool.ref)!, ref: doc.tool.ref })),
    ).slice(0, depth);
    const fused = new Map<number, number>();
    for (const list of [lexical, sem]) {
      list.forEach(({ id }, i) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + i + 1)));
    }
    return fused;
  }

  private synonyms(): Synonyms | undefined {
    if (this.synonymsOption === false) return undefined;
    this.compiledSynonyms ??= this.synonymsOption ?? defaultSynonyms(this.rules.split);
    return this.compiledSynonyms;
  }

  private idf(term: string): number {
    const df = this.postings.get(term)?.length ?? 0;
    return Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
  }

  /** Add `scale * idf * tf-norm` of `term` for every doc that has it to `into`; `idfCap` bounds the idf. */
  private accumulate(term: string, scale: number, into: Map<number, number>, idfCap = Infinity): void {
    const list = this.postings.get(term);
    if (!list) return;
    const idf = Math.min(this.idf(term), idfCap);
    for (const [id, tf] of list) {
      const len = this.docs[id]!.length;
      const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + (B * len) / this.avgLength));
      into.set(id, (into.get(id) ?? 0) + scale * idf * norm);
    }
  }

  private bm25(normalizedQuery: string): Map<number, number> {
    const syn = this.synonyms();
    const significant = [...new Set(this.terms(normalizedQuery, true))];
    let terms = significant.length > 0 ? significant : [...new Set(this.terms(normalizedQuery, false))];
    if (syn) {
      const kept = terms.filter((t) => !syn.queryStopwords.has(t));
      if (kept.length > 0) terms = kept;
    }
    const scores = new Map<number, number>();
    if (!syn) {
      for (const term of terms) this.accumulate(term, 1, scores);
      return scores;
    }
    // Each query term scores as before; where it has synonyms or stems, a doc counts the better of
    // the term itself and its best alternative (down-weighted), so an exact hit is never outscored
    // by a synonym hit and a doc is not rewarded twice for one concept.
    const concepts = expandQuery(syn, this.terms(normalizedQuery, false), terms, (t) => this.postings.has(t));
    for (const { term, anchors, alts } of concepts) {
      if (alts.length === 0 && term !== null) {
        this.accumulate(term, 1, scores);
        continue;
      }
      const best = new Map<number, number>();
      if (term !== null) this.accumulate(term, 1, best);
      // A rare synonym (`pr`) must not outweigh the commoner words it stands for (`pull request`).
      const cap = anchors.reduce((sum, a) => sum + this.idf(a), 0) / anchors.length;
      for (const alt of alts) {
        const sum = new Map<number, number>();
        for (const t of alt.terms) this.accumulate(t, alt.weight, sum, cap);
        for (const [id, s] of sum) if (s > (best.get(id) ?? 0)) best.set(id, s);
      }
      for (const [id, s] of best) scores.set(id, (scores.get(id) ?? 0) + s);
    }
    return scores;
  }
}
