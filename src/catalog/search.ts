import type { CatalogRules } from './provider';
import { defaultCatalogRules } from './provider';
import { singularize } from './singularize';
import { stripProviderWords } from './split';
import { defaultSynonyms, expandQuery, type Synonyms } from './synonyms';
import { tokenize } from './tokenize';
import type { Catalog, CatalogTool, ProviderCatalog } from './types';

// BM25 parameters and per-field weights. Name hits weigh most (discovery.md, "搜索").
const K1 = 1.2;
const B = 0.75;
const FIELD_WEIGHT = { name: 4, param: 2, description: 1 } as const;
// A tool whose raw name words are all in the query gets, per word, NAME_COVERED_BASE plus NAME_COVERED_RARITY times
// the word's idf over raw names, on top of its BM25 score (discovery.md, "provider 名与资源词相同").
const NAME_COVERED_BASE = 0.3;
const NAME_COVERED_RARITY = 0.25;
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
  /**
   * Cosine similarity of the query to each tool, keyed by `CatalogTool.ref` (optional embedding
   * retrieval, ADR 0011). When present the BM25 and semantic rankings are fused with RRF inside each tier.
   */
  semantic?: ReadonlyMap<string, number>;
}

export interface SearchIndexOptions {
  /** Query expansion with `data/synonyms.json`; `false` turns it off (the lexical baseline). Default: the bundled data. */
  synonyms?: Synonyms | false;
  /** The `docTerms` of tools whose terms are already known (a prebuilt catalog, view-cache.ts). */
  precomputed?: { get(tool: CatalogTool): DocTerms | undefined };
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
  /** The distinct words of the raw name without a leading provider name (`close_jobs` -> close, job). */
  nameWords: string[];
  forms: string[];
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
    if (ignoreStopwords && (w.length < 2 || rules.stopwords.has(w))) continue;
    out.push(singularize(w, rules.split));
  }
  return out;
}

/**
 * The terms a tool is indexed under: name and raw name (weight 4), parameter names (2), description (1).
 * The provider's own words are not among them (they are the same for every tool of the provider and
 * would stop the resource word that equals them from telling the tools apart): a query word that
 * names the provider is scored in `SearchIndex#providerScores`. Words the tool's name or raw name
 * contains besides the provider prefix or suffix (`create_todo` for `todos`) are indexed as usual.
 */
export function docTerms(tool: CatalogTool, rules: CatalogRules = defaultCatalogRules()): DocTerms {
  const tf = new Map<string, number>();
  let length = 0;
  const bump = (terms: string[], weight: number) => {
    for (const t of terms) {
      tf.set(t, (tf.get(t) ?? 0) + weight);
      length += weight;
    }
  };
  const rawWords = stripProviderWords(tokenize(tool.rawName), [tool.provider]).tokens.map((w) => singularize(w, rules.split));
  bump([...termsOf(tool.name, false, rules), ...rawWords], FIELD_WEIGHT.name);
  // The provider's words still count towards the length, as when they were indexed: only their postings are gone.
  length += FIELD_WEIGHT.name * termsOf(tool.provider, false, rules).length;
  bump(termsOf(tool.params.map((p) => p.name).join(' '), false, rules), FIELD_WEIGHT.param);
  bump(termsOf(tool.description, true, rules), FIELD_WEIGHT.description);
  return { length, pairs: [...tf].flat() };
}

/** Inverted index over a catalog: resource, verb, raw name, description, parameter names; the provider as a scope (`providerScores`). */
export class SearchIndex {
  private readonly docs: Doc[] = [];
  /** term -> `[docId, tf, docId, tf, ...]`, in doc order (flat: one array per term, not one per posting). */
  private readonly postings = new Map<string, number[]>();
  /** provider word -> ids of the docs of the providers named by it. */
  private readonly providerDocs = new Map<string, number[]>();
  private readonly providerWords = new Map<string, string[]>();
  /** name word -> number of tools whose raw name has it. */
  private readonly nameDf = new Map<string, number>();
  private avgLength = 1;
  private readonly rules: CatalogRules;
  private readonly synonymsOption: Synonyms | false | undefined;
  private compiledSynonyms?: Synonyms;

  /**
   * `options.precomputed` holds the `docTerms` of tools whose terms are already known (a cached
   * build); the others are computed here. Either way the index is the same.
   */
  constructor(catalog: Catalog, rules: CatalogRules = defaultCatalogRules(), options: SearchIndexOptions = {}) {
    this.rules = rules;
    this.synonymsOption = options.synonyms;
    for (const provider of catalog.providers) {
      for (const tool of provider.tools) this.add(tool, provider, options.precomputed?.get(tool));
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
    const nameWords = [...new Set(this.rawNameWords(tool))];
    for (const word of nameWords) this.nameDf.set(word, (this.nameDf.get(word) ?? 0) + 1);
    this.docs.push({ tool, length, nameWords, forms: [normalizeQuery(tool.ref), normalizeQuery(tool.name)] });
    let words = this.providerWords.get(tool.provider);
    if (!words) {
      words = [...new Set(this.terms(tool.provider, false))];
      this.providerWords.set(tool.provider, words);
    }
    for (const word of words) {
      const ids = this.providerDocs.get(word);
      if (ids) ids.push(id);
      else this.providerDocs.set(word, [id]);
    }
    for (let i = 0; i < pairs.length; i += 2) {
      const term = pairs[i] as string;
      const list = this.postings.get(term);
      if (list) list.push(id, pairs[i + 1] as number);
      else this.postings.set(term, [id, pairs[i + 1] as number]);
    }
  }

  /** Ranked search (discovery.md, "搜索"). An empty query lists every tool in canonical order. */
  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const limit = options.limit ?? 10;
    const candidates = this.docs.map((doc, id) => ({ doc, id }));

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
    const df = (this.postings.get(term)?.length ?? 0) / 2;
    return Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
  }

  /** Add `scale * idf * tf-norm` of `term` for every doc that has it to `into`; `idfCap` bounds the idf. */
  private accumulate(term: string, scale: number, into: Map<number, number>, idfCap = Infinity): void {
    const list = this.postings.get(term);
    if (!list) return;
    const idf = Math.min(this.idf(term), idfCap);
    for (let i = 0; i < list.length; i += 2) {
      const id = list[i]!;
      const tf = list[i + 1]!;
      const len = this.docs[id]!.length;
      const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + (B * len) / this.avgLength));
      into.set(id, (into.get(id) ?? 0) + scale * idf * norm);
    }
  }

  /**
   * A query word that is a word of a provider's name (`todo` for `todos`, `drive` for `google-drive`)
   * scores every tool of that provider alike, as a name-field hit with the idf of "tools of this
   * provider". It is a scope, not evidence about which of the provider's tools is meant: the word
   * still scores through the tools' own names and descriptions in `accumulate`, where its idf is not
   * flattened by the provider's name.
   */
  /**
   * The words of the raw name without a leading provider name (a namespace, which every split drops).
   * A trailing one stays: whether it is a brand or the resource (`close_jobs` on `jobs`) is a split
   * decision, and this must not depend on it.
   */
  private rawNameWords(tool: CatalogTool): string[] {
    const tokens = tokenize(tool.rawName);
    const lead = tokenize(tool.provider);
    let start = 0;
    while (lead.length > 0 && tokens.length - start > lead.length && lead.every((w, i) => tokens[start + i] === w)) start += lead.length;
    return tokens.slice(start).map((w) => singularize(w, this.rules.split));
  }

  private providerScores(terms: readonly string[], into: Map<number, number>): void {
    for (const term of terms) {
      const ids = this.providerDocs.get(term);
      if (!ids) continue;
      const idf = Math.log(1 + (this.docs.length - ids.length + 0.5) / (ids.length + 0.5));
      const tf = FIELD_WEIGHT.name;
      for (const id of ids) {
        const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + (B * this.docs[id]!.length) / this.avgLength));
        into.set(id, (into.get(id) ?? 0) + idf * norm);
      }
    }
  }

  /**
   * A tool whose name is made of query words only (`list jobs` for the tool `jobs`, `create job` for
   * `job:create`) is what the query names. BM25 cannot see that when the word is in most descriptions
   * and parameter names of the provider: saturation leaves a name hit and a passing mention almost
   * equal, its idf is near 0, and long parameter lists lower the score of the tool that was named.
   * The bonus has a fixed part per word, which stays when a word is in many names, and a part for
   * how few raw names have the word. Both come from the raw names (`nameWords`), never from the
   * `resource:verb` split, so that changing how tools are split does not change who gets the bonus.
   */
  private nameCovered(queryWords: readonly string[], scores: Map<number, number>): void {
    const words = new Set(queryWords);
    for (const [id, score] of scores) {
      const name = this.docs[id]!.nameWords;
      if (name.length === 0 || !name.every((w) => words.has(w))) continue;
      const rarity = name.reduce((sum, w) => {
        const df = this.nameDf.get(w)!;
        return sum + Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
      }, 0);
      scores.set(id, score + NAME_COVERED_BASE * name.length + NAME_COVERED_RARITY * rarity);
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
    this.providerScores(terms, scores);
    if (!syn) {
      for (const term of terms) this.accumulate(term, 1, scores);
      this.nameCovered(this.terms(normalizedQuery, false), scores);
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
    this.nameCovered([...this.terms(normalizedQuery, false), ...concepts.flatMap((c) => c.alts.flatMap((a) => a.terms))], scores);
    return scores;
  }
}
