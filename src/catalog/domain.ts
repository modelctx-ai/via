import domainsData from '../../data/domains.json';
import lexiconData from '../../data/domain-lexicon.json';
import type { CatalogTool, DomainAssignment, DomainScore, JsonSchema } from './types';
import type { SplitRules } from './rules';
import { singularize } from './singularize';
import { kebab, tokenize } from './tokenize';

// ---------------------------------------------------------------------------
// Rule data (data/domains.json, data/domain-lexicon.json)
// ---------------------------------------------------------------------------

export type MatchBasis = 'alias' | 'package' | 'host';
export type SignalSource = 'param' | 'resource' | 'identity' | 'description';

export interface DomainsData {
  version: number;
  domains: Record<string, { servers: string[] }>;
  match: MatchBasis[];
  heuristic: HeuristicParams;
}

export interface HeuristicParams {
  /** Minimum normalised confidence of the winning domain. */
  threshold: number;
  /** The winner must score at least this many times the runner-up. */
  leadRatio: number;
  signalWeights: Record<SignalSource, number>;
  /** Minimum raw score (summed over all signals) before a verdict is attempted. */
  minScore: number;
  /** Generic words ignored in tool descriptions (verbs from the verb table are ignored too). */
  stopwords: string[];
  /** At or below this many providers, `via` does not group by domain (ADR 0006). */
  flatBelowProviders: number;
}

export interface LexiconData {
  version: number;
  generatedFrom?: string;
  terms: Record<string, Record<string, number>>;
}

export interface DomainRules {
  /** Domain names in table order. */
  order: string[];
  servers: Array<{ domain: string; name: string; tokens: string[] }>;
  match: ReadonlySet<MatchBasis>;
  heuristic: HeuristicParams;
  stopwords: ReadonlySet<string>;
  lexicon: ReadonlyMap<string, Readonly<Record<string, number>>>;
}

export function compileDomainRules(data: DomainsData, lexicon: LexiconData): DomainRules {
  const servers: DomainRules['servers'] = [];
  for (const [domain, def] of Object.entries(data.domains)) {
    for (const name of def.servers) servers.push({ domain, name, tokens: tokenize(name) });
  }
  return {
    order: Object.keys(data.domains),
    servers,
    match: new Set(data.match),
    heuristic: data.heuristic,
    stopwords: new Set(data.heuristic.stopwords),
    lexicon: new Map(Object.entries(lexicon.terms)),
  };
}

let defaults: DomainRules | undefined;

/** Rules compiled from the bundled `data/domains.json` and `data/domain-lexicon.json`. */
export function defaultDomainRules(): DomainRules {
  defaults ??= compileDomainRules(domainsData as DomainsData, lexiconData as LexiconData);
  return defaults;
}

export const OTHER_DOMAIN = 'other';

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** What is known about a server beyond its tools. All fields optional. */
export interface ProviderIdentity {
  /** npm, PyPI or container image names found in the server's command line. */
  packages?: string[];
  /** Hostname of an HTTP server URL. */
  host?: string;
  /** `serverInfo.name` from `initialize`. */
  serverInfoName?: string;
  /** `instructions` from `initialize`. */
  instructions?: string;
}

export interface ClassifyInput {
  provider: string;
  tools: CatalogTool[];
  identity?: ProviderIdentity;
  /** `servers.<name>.domain` from config. */
  configDomain?: string;
  /** Top-level `domains` from config: domain -> member providers. */
  customDomains?: Record<string, string[]>;
}

function containsSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((w, j) => haystack[i + j] === w)) return true;
  }
  return false;
}

/** Look the provider up in the built-in table by alias, package name and URL host. */
export function matchBuiltin(
  provider: string,
  identity: ProviderIdentity | undefined,
  rules: DomainRules,
): string[] {
  const found: string[] = [];
  const aliasTokens = tokenize(provider);
  const packageTokens = (identity?.packages ?? []).map((p) => tokenize(p));
  const hostTokens = identity?.host ? tokenize(identity.host) : [];
  for (const entry of rules.servers) {
    const hit =
      (rules.match.has('alias') && aliasTokens.join('-') === entry.tokens.join('-')) ||
      (rules.match.has('package') && packageTokens.some((t) => containsSequence(t, entry.tokens))) ||
      (rules.match.has('host') && containsSequence(hostTokens, entry.tokens));
    if (hit && !found.includes(entry.domain)) found.push(entry.domain);
  }
  return found;
}

// Signals ---------------------------------------------------------------

function propertyNames(schema: JsonSchema | undefined, depth = 0): string[] {
  const props = schema?.properties;
  if (!props || depth > 1) return [];
  const names: string[] = [];
  for (const [name, child] of Object.entries(props)) {
    names.push(name);
    names.push(...propertyNames(child, depth + 1));
  }
  return names;
}

function terms(words: string[], rules: SplitRules): string[] {
  const out: string[] = [];
  for (const w of words) {
    if (w.length < 2 || /^\d+$/.test(w)) continue;
    out.push(singularize(w, rules));
  }
  return out;
}

export interface ToolSignals {
  param: Set<string>;
  resource: Set<string>;
  description: Set<string>;
}

export function toolSignals(tool: CatalogTool, rules: DomainRules, split: SplitRules): ToolSignals {
  const param = new Set(terms(propertyNames(tool.def.inputSchema).flatMap(tokenize), split));
  const resource = new Set(tool.resource ? terms(tool.resource.split('-'), split) : []);
  const ignored = (t: string) => t.length < 3 || rules.stopwords.has(t) || split.verbs.has(t);
  const description = new Set(terms(tokenize(tool.description), split).filter((t) => !ignored(t)));
  return { param, resource, description };
}

interface Accumulator {
  total: number;
  byTerm: Map<string, number>;
}

function score(
  tools: CatalogTool[],
  identityTerms: string[],
  rules: DomainRules,
  singular: SplitRules,
): Map<string, Accumulator> {
  // Count, per source and term, how many tools carry the signal.
  const counts: Record<SignalSource, Map<string, number>> = {
    param: new Map(),
    resource: new Map(),
    identity: new Map(),
    description: new Map(),
  };
  for (const tool of tools) {
    const s = toolSignals(tool, rules, singular);
    for (const source of ['param', 'resource', 'description'] as const) {
      for (const t of s[source]) counts[source].set(t, (counts[source].get(t) ?? 0) + 1);
    }
  }
  for (const t of identityTerms) counts.identity.set(t, 1);

  const result = new Map<string, Accumulator>();
  for (const source of Object.keys(counts) as SignalSource[]) {
    const weight = rules.heuristic.signalWeights[source];
    for (const [term, count] of counts[source]) {
      const entry = rules.lexicon.get(term);
      if (!entry) continue;
      const damping = 1 + Math.log(count); // repeated signals count, with diminishing returns
      for (const [domain, w] of Object.entries(entry)) {
        const acc = result.get(domain) ?? { total: 0, byTerm: new Map() };
        const contribution = weight * w * damping;
        acc.total += contribution;
        acc.byTerm.set(term, (acc.byTerm.get(term) ?? 0) + contribution);
        result.set(domain, acc);
      }
    }
  }
  return result;
}

function ranked(scores: Map<string, Accumulator>, rules: DomainRules): Array<[string, Accumulator]> {
  const rank = (d: string) => {
    const i = rules.order.indexOf(d);
    return i < 0 ? rules.order.length : i;
  };
  return [...scores.entries()].sort((a, b) => b[1].total - a[1].total || rank(a[0]) - rank(b[0]) || (a[0] < b[0] ? -1 : 1));
}

interface Verdict {
  domains: string[];
  confidence: number;
}

/** Apply threshold / lead ratio (discovery.md, "打分规则"). */
function decide(r: Array<[string, Accumulator]>, rules: DomainRules): Verdict | undefined {
  const { threshold, leadRatio, minScore } = rules.heuristic;
  const total = r.reduce((sum, [, a]) => sum + a.total, 0);
  if (r.length === 0 || total < minScore) return undefined;
  const s1 = r[0]![1].total;
  const s2 = r[1]?.[1].total ?? 0;
  const s3 = r[2]?.[1].total ?? 0;
  if (s1 / total >= threshold && s1 >= leadRatio * s2) {
    return { domains: [r[0]![0]], confidence: s1 / total };
  }
  // Two domains close to each other, both clearly ahead of the rest.
  if (r.length >= 2 && (s1 + s2) / total >= threshold && s2 >= leadRatio * s3) {
    return { domains: [r[0]![0], r[1]![0]], confidence: (s1 + s2) / total };
  }
  return undefined;
}

function explain(r: Array<[string, Accumulator]>): Record<string, DomainScore> {
  const out: Record<string, DomainScore> = {};
  for (const [domain, acc] of r.slice(0, 3)) {
    const top = [...acc.byTerm.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 4);
    out[domain] = { score: Math.round(acc.total * 10) / 10, terms: top.map(([t]) => t) };
  }
  return out;
}

function identityTerms(provider: string, identity: ProviderIdentity | undefined, singular: SplitRules): string[] {
  const words = [
    ...tokenize(provider),
    ...(identity?.packages ?? []).flatMap(tokenize),
    ...(identity?.host ? tokenize(identity.host) : []),
    ...(identity?.serverInfoName ? tokenize(identity.serverInfoName) : []),
    ...(identity?.instructions ? tokenize(identity.instructions) : []),
  ];
  return [...new Set(terms(words, singular))];
}

/**
 * Infer the domain(s) of a provider. Priority (discovery.md): config -> built-in table ->
 * heuristic scoring -> `other`. Deterministic; the result is a browsing view only (ADR 0006).
 */
export function classifyProvider(input: ClassifyInput, rules: DomainRules, singular: SplitRules): DomainAssignment {
  // 1. Config: servers.<name>.domain and top-level `domains` membership.
  const configured: string[] = [];
  if (input.configDomain) configured.push(kebab(input.configDomain));
  for (const [domain, members] of Object.entries(input.customDomains ?? {})) {
    if (members.map(kebab).includes(kebab(input.provider)) && !configured.includes(kebab(domain))) {
      configured.push(kebab(domain));
    }
  }
  if (configured.length > 0) {
    return { source: 'config', domains: configured.map((domain) => ({ domain })) };
  }

  // 2. Built-in table.
  const builtin = matchBuiltin(input.provider, input.identity, rules);
  if (builtin.length > 0) {
    return { source: 'builtin', domains: builtin.map((domain) => ({ domain })) };
  }

  // 3. Heuristic scoring over all tools.
  const idTerms = identityTerms(input.provider, input.identity, singular);
  const overall = ranked(score(input.tools, idTerms, rules, singular), rules);
  const verdict = decide(overall, rules);
  if (verdict && verdict.domains.length === 1) {
    return {
      source: 'heuristic',
      domains: [{ domain: verdict.domains[0]! }],
      confidence: round2(verdict.confidence),
      scores: explain(overall),
    };
  }

  // Mixed or unclear: score each resource separately (discovery.md, "按资源拆分").
  const byResource = splitByResource(input.tools, rules, singular);
  if (byResource) {
    return {
      source: 'heuristic',
      domains: byResource,
      confidence: verdict ? round2(verdict.confidence) : undefined,
      scores: explain(overall),
    };
  }
  if (verdict) {
    return {
      source: 'heuristic',
      domains: verdict.domains.map((domain) => ({ domain })),
      confidence: round2(verdict.confidence),
      scores: explain(overall),
    };
  }

  // 4. Nothing convincing.
  return {
    source: 'other',
    domains: [{ domain: OTHER_DOMAIN }],
    ...(overall.length > 0 ? { scores: explain(overall) } : {}),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Per-resource verdicts; returns a multi-domain split only when resources clearly differ. */
function splitByResource(
  tools: CatalogTool[],
  rules: DomainRules,
  singular: SplitRules,
): Array<{ domain: string; resources: string[] }> | undefined {
  const groups = new Map<string, CatalogTool[]>();
  for (const tool of tools) {
    if (!tool.resource) continue;
    const list = groups.get(tool.resource) ?? [];
    list.push(tool);
    groups.set(tool.resource, list);
  }
  const byDomain = new Map<string, string[]>();
  for (const [resource, group] of groups) {
    const verdict = decide(ranked(score(group, [], rules, singular), rules), rules);
    if (verdict?.domains.length !== 1) continue;
    const list = byDomain.get(verdict.domains[0]!) ?? [];
    list.push(resource);
    byDomain.set(verdict.domains[0]!, list);
  }
  if (byDomain.size < 2) return undefined;
  const order = (d: string) => {
    const i = rules.order.indexOf(d);
    return i < 0 ? rules.order.length : i;
  };
  return [...byDomain.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]) || (a[0] < b[0] ? -1 : 1))
    .map(([domain, resources]) => ({ domain, resources: resources.sort() }));
}
