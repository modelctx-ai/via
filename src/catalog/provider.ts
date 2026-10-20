import type { DomainRules, ProviderIdentity } from './domain';
import { classifyProvider, defaultDomainRules } from './domain';
import { defaultSplitRules, type SplitRules } from './rules';
import { extractParams } from './signature';
import { splitToolName } from './split';
import { kebab } from './tokenize';
import type { CatalogTool, McpTool, ProviderCatalog, ResourceGroup } from './types';

export interface CatalogRules {
  split: SplitRules;
  domains: DomainRules;
}

export function defaultCatalogRules(): CatalogRules {
  return { split: defaultSplitRules(), domains: defaultDomainRules() };
}

export interface ProviderInput {
  /** Provider name (server alias), already kebab-case. */
  provider: string;
  /** Extra names whose words are dropped from tool names, besides the provider itself. */
  aliases?: string[];
  tools: McpTool[];
  /** `servers.<name>.rename`: raw tool name -> `resource:verb` or a leaf name. */
  rename?: Record<string, string>;
  /** `deny` regular expressions, matched against `provider/resource:verb` and `provider/raw-name`. */
  deny?: readonly RegExp[];
  identity?: ProviderIdentity;
  /** `servers.<name>.domain`. */
  configDomain?: string;
  /** Top-level `domains` from config. */
  customDomains?: Record<string, string[]>;
}

interface Draft {
  def: McpTool;
  resource: string | null;
  verb: string | null;
  leafName: string;
  /** Leaf name to fall back to when a `resource:verb` conflict demotes the tool. */
  fallbackLeaf: string;
  renamed: boolean;
}

function parseRename(value: string): { resource: string; verb: string } | { leaf: string } {
  const i = value.indexOf(':');
  if (i < 0) return { leaf: kebab(value) };
  const resource = kebab(value.slice(0, i));
  const verb = kebab(value.slice(i + 1));
  return resource && verb ? { resource, verb } : { leaf: kebab(value) };
}

function paramsOf(def: McpTool) {
  return extractParams(def.inputSchema);
}

function toCatalogTool(provider: string, d: Draft): CatalogTool {
  const name = d.resource !== null ? `${d.resource}:${d.verb}` : d.leafName;
  return {
    provider,
    rawName: d.def.name,
    resource: d.resource,
    verb: d.verb,
    name,
    ref: `${provider} ${name}`,
    singleRef: `${provider}/${name}`,
    description: d.def.description ?? d.def.title ?? '',
    params: paramsOf(d.def),
    readOnly: d.def.annotations?.readOnlyHint === true,
    destructive: d.def.annotations?.destructiveHint === true,
    renamed: d.renamed,
    def: d.def,
  };
}

/**
 * Split every tool of one provider and resolve conflicts (naming.md rules 5 and 6),
 * then apply `deny`, group by resource and assign a domain.
 */
export function buildProviderCatalog(
  input: ProviderInput,
  rules: CatalogRules = defaultCatalogRules(),
): ProviderCatalog {
  const providerNames = [input.provider, ...(input.aliases ?? [])];

  const drafts: Draft[] = input.tools.map((def) => {
    const renamed = input.rename?.[def.name];
    if (renamed !== undefined) {
      const r = parseRename(renamed);
      return 'leaf' in r
        ? { def, resource: null, verb: null, leafName: r.leaf, fallbackLeaf: r.leaf, renamed: true }
        : { def, resource: r.resource, verb: r.verb, leafName: '', fallbackLeaf: kebab(def.name), renamed: true };
    }
    const s = splitToolName(def.name, { providerNames }, rules.split);
    return s.kind === 'resource'
      ? { def, resource: s.resource, verb: s.verb, leafName: '', fallbackLeaf: s.leafName, renamed: false }
      : { def, resource: null, verb: null, leafName: s.leafName, fallbackLeaf: s.leafName, renamed: false };
  });

  // Rule 6: two tools with the same `resource:verb` both fall back to leaf tools.
  // A user rename wins over a rule-based split, but two renames to one name still collide.
  const byKey = new Map<string, Draft[]>();
  for (const d of drafts) {
    if (d.resource === null) continue;
    const key = `${d.resource}:${d.verb}`;
    byKey.set(key, [...(byKey.get(key) ?? []), d]);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const renamedOnes = group.filter((d) => d.renamed);
    const losers = renamedOnes.length === 1 ? group.filter((d) => !d.renamed) : group;
    for (const d of losers) {
      d.resource = null;
      d.verb = null;
      d.leafName = d.fallbackLeaf;
    }
  }

  // Leaf names must not clash with each other or with a resource (resources win, cli.md).
  const resourceNames = new Set(drafts.filter((d) => d.resource !== null).map((d) => d.resource!));
  const leafCount = new Map<string, number>();
  for (const d of drafts) if (d.resource === null) leafCount.set(d.leafName, (leafCount.get(d.leafName) ?? 0) + 1);
  for (const d of drafts) {
    if (d.resource !== null || d.renamed) continue;
    if ((leafCount.get(d.leafName) ?? 0) > 1 || resourceNames.has(d.leafName)) d.leafName = kebab(d.def.name);
  }

  const all = drafts.map((d) => toCatalogTool(input.provider, d));
  // `g` / `y` flags make RegExp#test stateful; drop them so every tool is tested from the start.
  const deny = (input.deny ?? []).map((re) => (re.global || re.sticky ? new RegExp(re.source, re.flags.replace(/[gy]/g, '')) : re));
  const visible = all.filter((t) => !deny.some((re) => re.test(t.singleRef) || re.test(`${t.provider}/${t.rawName}`)));

  const groups = new Map<string, ResourceGroup>();
  const leaves: CatalogTool[] = [];
  for (const t of visible) {
    if (t.resource === null) {
      leaves.push(t);
      continue;
    }
    const g = groups.get(t.resource) ?? { name: t.resource, tools: [] };
    g.tools.push(t);
    groups.set(t.resource, g);
  }
  const resources = [...groups.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const domain = classifyProvider(
    {
      provider: input.provider,
      tools: visible,
      identity: input.identity,
      configDomain: input.configDomain,
      customDomains: input.customDomains,
    },
    rules.domains,
    rules.split,
  );

  return { provider: input.provider, tools: visible, resources, leaves, domain };
}
