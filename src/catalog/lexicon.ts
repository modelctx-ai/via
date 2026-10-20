import type { LexiconData } from './domain';
import type { DomainRules } from './domain';
import { toolSignals } from './domain';
import type { SplitRules } from './rules';
import type { CatalogTool } from './types';

export interface LexiconSample {
  /** Known domain of the sampled server (from the built-in table). */
  domain: string;
  tools: CatalogTool[];
}

export interface LexiconOptions {
  /** Entries whose best weight is below this are dropped as non-discriminating. Default 0.4. */
  minWeight?: number;
  /** A description-only term must appear in at least this many tools of a domain. Default 2. */
  minDescriptionTools?: number;
}

/**
 * Build the term -> domain weight table used by heuristic domain scoring (discovery.md,
 * "词典怎么来"). A term's weight in a domain is its share of the term's per-domain frequency
 * (fraction of that domain's tools carrying the term), so terms seen in a single domain weigh
 * near 1 and terms common to many domains weigh little. Deterministic.
 */
export function buildLexicon(
  samples: readonly LexiconSample[],
  domainRules: DomainRules,
  split: SplitRules,
  options: LexiconOptions = {},
): Pick<LexiconData, 'terms'> {
  const minWeight = options.minWeight ?? 0.4;
  const minDescriptionTools = options.minDescriptionTools ?? 2;

  const toolCount = new Map<string, number>();
  // domain -> term -> { tools carrying the term, whether it is a parameter/resource word }
  const stats = new Map<string, Map<string, { tools: number; structural: boolean }>>();

  for (const { domain, tools } of samples) {
    toolCount.set(domain, (toolCount.get(domain) ?? 0) + tools.length);
    const perDomain = stats.get(domain) ?? new Map();
    stats.set(domain, perDomain);
    for (const tool of tools) {
      const s = toolSignals(tool, domainRules, split);
      const seen = new Set<string>([...s.param, ...s.resource, ...s.description]);
      for (const term of seen) {
        const entry = perDomain.get(term) ?? { tools: 0, structural: false };
        entry.tools += 1;
        entry.structural ||= s.param.has(term) || s.resource.has(term);
        perDomain.set(term, entry);
      }
    }
  }

  // frequency[term][domain]
  const frequency = new Map<string, Map<string, number>>();
  for (const [domain, perDomain] of stats) {
    for (const [term, entry] of perDomain) {
      if (!entry.structural && entry.tools < minDescriptionTools) continue;
      const byDomain = frequency.get(term) ?? new Map();
      byDomain.set(domain, entry.tools / (toolCount.get(domain) ?? 1));
      frequency.set(term, byDomain);
    }
  }

  const terms: Record<string, Record<string, number>> = {};
  for (const term of [...frequency.keys()].sort()) {
    const byDomain = frequency.get(term)!;
    const total = [...byDomain.values()].reduce((a, b) => a + b, 0);
    const weights = [...byDomain.entries()]
      .map(([domain, f]) => [domain, Math.round((f / total) * 100) / 100] as const)
      .filter(([, w]) => w >= minWeight)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    if (weights.length > 0) terms[term] = Object.fromEntries(weights);
  }
  return { terms };
}

/** Serialise one term per line so regenerated lexicons diff cleanly. */
export function formatLexicon(data: LexiconData): string {
  const lines = Object.entries(data.terms).map(
    ([term, w]) =>
      `    ${JSON.stringify(term)}: { ${Object.entries(w)
        .map(([d, n]) => `${JSON.stringify(d)}: ${n}`)
        .join(', ')} }`,
  );
  const head = [`  "version": ${data.version}`];
  if (data.generatedFrom) head.push(`  "generatedFrom": ${JSON.stringify(data.generatedFrom)}`);
  return `{\n${head.join(',\n')},\n  "terms": {\n${lines.join(',\n')}\n  }\n}\n`;
}
