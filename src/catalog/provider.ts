import { findDenyRule } from './deny';
import { defaultSplitRules, type SplitRules } from './rules';
import { extractParams } from './signature';
import { splitToolName } from './split';
import { defaultStopwords } from './stopwords';
import { kebab } from './tokenize';
import type { CatalogTool, McpTool, ProviderCatalog, ResourceGroup } from './types';

export interface CatalogRules {
  split: SplitRules;
  /** Generic words the search index leaves out of descriptions (data/stopwords.json). */
  stopwords: ReadonlySet<string>;
}

export function defaultCatalogRules(): CatalogRules {
  return { split: defaultSplitRules(), stopwords: defaultStopwords() };
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
}

interface Draft {
  def: McpTool;
  resource: string | null;
  verb: string | null;
  leafName: string;
  /** Leaf name to fall back to when a `resource:verb` conflict demotes the tool. */
  fallbackLeaf: string;
  renamed: boolean;
  /** The name part the split rules give, before `rename` and conflict handling (deny rules match it too). */
  defaultName: string;
  /** The tool's leaf spelling, whatever the split decided (deny rules match it too). */
  splitLeaf: string;
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

/** `readOnlyHint: true` (arguments.md, "危险操作"). */
function readOnlyOf(def: McpTool): boolean {
  return def.annotations?.readOnlyHint === true;
}

/**
 * `destructiveHint: true` on a tool that is not read-only. MCP gives `destructiveHint` meaning only
 * when `readOnlyHint` is false, so a tool marked both is read-only: no `--yes`, and it is retried
 * like any read-only tool (arguments.md, "危险操作").
 */
function destructiveOf(def: McpTool): boolean {
  return !readOnlyOf(def) && def.annotations?.destructiveHint === true;
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
    defaultSingleRef: `${provider}/${d.defaultName}`,
    leafSingleRef: `${provider}/${d.splitLeaf}`,
    description: d.def.description ?? d.def.title ?? '',
    params: paramsOf(d.def),
    readOnly: readOnlyOf(d.def),
    destructive: destructiveOf(d.def),
    renamed: d.renamed,
    def: d.def,
  };
}

/**
 * Split every tool of one provider and resolve conflicts (naming.md rules 5 and 6),
 * then apply `deny` and group by resource.
 */
export function buildProviderCatalog(
  input: ProviderInput,
  rules: CatalogRules = defaultCatalogRules(),
): ProviderCatalog {
  const providerNames = [input.provider, ...(input.aliases ?? [])];

  const drafts: Draft[] = input.tools.map((def) => {
    const s = splitToolName(def.name, { providerNames }, rules.split);
    const defaultName = s.kind === 'resource' ? `${s.resource}:${s.verb}` : s.leafName;
    const splitLeaf = s.leafName;
    const renamed = input.rename?.[def.name];
    if (renamed !== undefined) {
      const r = parseRename(renamed);
      return 'leaf' in r
        ? { def, resource: null, verb: null, leafName: r.leaf, fallbackLeaf: r.leaf, renamed: true, defaultName, splitLeaf }
        : { def, resource: r.resource, verb: r.verb, leafName: '', fallbackLeaf: kebab(def.name), renamed: true, defaultName, splitLeaf };
    }
    return s.kind === 'resource'
      ? { def, resource: s.resource, verb: s.verb, leafName: '', fallbackLeaf: s.leafName, renamed: false, defaultName, splitLeaf }
      : { def, resource: null, verb: null, leafName: s.leafName, fallbackLeaf: s.leafName, renamed: false, defaultName, splitLeaf };
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

  // Leaf names must not clash with each other or with a resource (naming.md rule 7). The resource
  // wins and the leaf goes by its raw name; when the raw name is the resource's name too (`search`
  // next to `batch_search`), the leaf has nothing else to go by, so the resource yields: its tools
  // fall back to leaf tools as in rule 6. Each round removes a resource, so this ends.
  for (;;) {
    const resourceNames = new Set(drafts.filter((d) => d.resource !== null).map((d) => d.resource!));
    const leafCount = new Map<string, number>();
    for (const d of drafts) if (d.resource === null) leafCount.set(d.leafName, (leafCount.get(d.leafName) ?? 0) + 1);
    for (const d of drafts) {
      if (d.resource !== null || d.renamed) continue;
      if ((leafCount.get(d.leafName) ?? 0) > 1 || resourceNames.has(d.leafName)) d.leafName = kebab(d.def.name);
    }
    const shadowed = new Set(drafts.filter((d) => d.resource === null && !d.renamed && resourceNames.has(d.leafName)).map((d) => d.leafName));
    let demoted = false;
    for (const d of drafts) {
      if (d.resource === null || d.renamed || !shadowed.has(d.resource)) continue;
      d.resource = null;
      d.verb = null;
      d.leafName = d.fallbackLeaf;
      demoted = true;
    }
    // A resource made only of renamed tools stays: the user chose that name.
    if (!demoted) break;
  }

  const all = drafts.map((d) => toCatalogTool(input.provider, d));
  const deny = input.deny ?? [];
  const visible = all.filter((t) => findDenyRule(t, deny) === undefined);

  return assembleProvider(input.provider, visible);
}

/**
 * The provider view over its visible tools: resource groups sorted by name, leaf tools in list
 * order. Shared by the build and by restoring a cached build, so both group the same way.
 */
export function assembleProvider(provider: string, visible: CatalogTool[]): ProviderCatalog {
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
  return { provider, tools: visible, resources, leaves };
}
