import synonymsData from '../../data/synonyms.json';
import { singularize, type SingularRules } from './singularize';

/** Shape of `data/synonyms.json` (data-files.md). */
export interface SynonymsData {
  version: number;
  weights: { verb: number; resource: number; stem: number };
  queryStopwords?: string[];
  verbs: string[][];
  resources: string[][];
  suffixes?: Array<{ suffix: string; append: string[]; undouble?: boolean }>;
}

/** An alternative way to say a query term: its index terms (all must be present to count in full) and its down-weight. */
export interface Alternative {
  terms: string[];
  weight: number;
}

/** A query term (or a multi-word phrase when `term` is null) with the alternatives it may be matched by. */
export interface Concept {
  term: string | null;
  /** The query words the alternatives stand in for; an alternative never counts for more than these would. */
  anchors: string[];
  alts: Alternative[];
}

interface Group {
  weight: number;
  /** Members as singularised token lists, e.g. `pull request` -> [pull, request]. */
  members: string[][];
}

/** Compiled `data/synonyms.json`. Query-side only: nothing here touches the index. */
export interface Synonyms {
  /** Conversational words dropped from a query when other words remain. */
  queryStopwords: ReadonlySet<string>;
  stemWeight: number;
  suffixes: NonNullable<SynonymsData['suffixes']>;
  groups: readonly Group[];
  /** Space-joined member tokens -> (group, member) pairs. */
  lookup: ReadonlyMap<string, ReadonlyArray<{ group: number; member: number }>>;
  /** Longest member, in tokens. */
  maxPhrase: number;
}

export function compileSynonyms(data: SynonymsData, rules: SingularRules): Synonyms {
  const groups: Group[] = [];
  const lookup = new Map<string, Array<{ group: number; member: number }>>();
  let maxPhrase = 1;
  const add = (lists: string[][], weight: number) => {
    for (const list of lists) {
      // Members are lower-case words separated by single spaces (the schema enforces it), so no tokenizer is needed.
      const members = list.map((m) => m.split(' ').map((t) => singularize(t, rules)));
      const group = groups.length;
      groups.push({ weight, members });
      members.forEach((tokens, member) => {
        maxPhrase = Math.max(maxPhrase, tokens.length);
        const key = tokens.join(' ');
        const entries = lookup.get(key) ?? [];
        entries.push({ group, member });
        lookup.set(key, entries);
      });
    }
  };
  add(data.verbs, data.weights.verb);
  add(data.resources, data.weights.resource);
  return {
    queryStopwords: new Set(data.queryStopwords ?? []),
    stemWeight: data.weights.stem,
    suffixes: data.suffixes ?? [],
    groups,
    lookup,
    maxPhrase,
  };
}

let defaults: Synonyms | undefined;

/** Synonyms compiled from the bundled `data/synonyms.json`. */
export function defaultSynonyms(rules: SingularRules): Synonyms {
  defaults ??= compileSynonyms(synonymsData as SynonymsData, rules);
  return defaults;
}

const MIN_STEM = 3;

/**
 * Base forms a word could have lost a suffix from (`creating` -> `create`, `running` -> `run`).
 * Candidates only; the caller keeps those that exist in the index vocabulary, so a wrong guess
 * costs nothing.
 */
export function stemCandidates(word: string, suffixes: Synonyms['suffixes']): string[] {
  const out = new Set<string>();
  for (const rule of suffixes) {
    if (!word.endsWith(rule.suffix)) continue;
    const base = word.slice(0, -rule.suffix.length);
    if (base.length < MIN_STEM) continue;
    for (const tail of rule.append) out.add(base + tail);
    if (rule.undouble && base.length > MIN_STEM && base.at(-1) === base.at(-2)) {
      for (const tail of rule.append) out.add(base.slice(0, -1) + tail);
    }
  }
  out.delete(word);
  return [...out];
}

/**
 * Alternatives for one lookup key: every other member of every group the key belongs to. Terms
 * already in the query, or absent from the index, are dropped; an alternative with nothing left is
 * dropped too.
 */
function alternativesFor(
  syn: Synonyms,
  key: string,
  originals: ReadonlySet<string>,
  has: (term: string) => boolean,
  into: Map<string, Alternative>,
): void {
  for (const { group, member } of syn.lookup.get(key) ?? []) {
    const g = syn.groups[group]!;
    g.members.forEach((tokens, i) => {
      if (i === member) return;
      const terms = [...new Set(tokens)].filter((t) => !originals.has(t) && has(t));
      if (terms.length === 0) return;
      const id = terms.join(' ');
      const known = into.get(id);
      if (!known || known.weight < g.weight) into.set(id, { terms, weight: g.weight });
    });
  }
}

/**
 * Expand a query. `tokens` are all singularised words of the query in order (phrases are looked up
 * over these), `terms` the significant ones that BM25 scores. Deterministic: map iteration follows
 * insertion order, which follows the data file.
 */
export function expandQuery(syn: Synonyms, tokens: readonly string[], terms: readonly string[], has: (term: string) => boolean): Concept[] {
  const originals = new Set(terms);
  const concepts: Concept[] = [];
  for (const term of terms) {
    const alts = new Map<string, Alternative>();
    const stems = stemCandidates(term, syn.suffixes);
    for (const stem of stems) {
      if (!originals.has(stem) && has(stem)) alts.set(stem, { terms: [stem], weight: syn.stemWeight });
    }
    for (const key of [term, ...stems]) alternativesFor(syn, key, originals, has, alts);
    concepts.push({ term, anchors: [term], alts: [...alts.values()] });
  }
  for (let len = 2; len <= syn.maxPhrase; len += 1) {
    for (let i = 0; i + len <= tokens.length; i += 1) {
      const key = tokens.slice(i, i + len).join(' ');
      if (!syn.lookup.has(key)) continue;
      const alts = new Map<string, Alternative>();
      alternativesFor(syn, key, originals, has, alts);
      if (alts.size > 0) concepts.push({ term: null, anchors: tokens.slice(i, i + len), alts: [...alts.values()] });
    }
  }
  return concepts;
}
