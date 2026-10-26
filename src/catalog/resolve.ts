import { didYouMean, editDistance, closeness } from './edit-distance';
import { defaultSplitRules } from './rules';
import { singularizeName } from './singularize';
import { splitToolName } from './split';
import type { Catalog, CatalogTool, ProviderCatalog, ResourceGroup } from './types';

/** Input is lenient: case-insensitive, `-` and `_` equivalent (cli.md). */
export function normalizeInput(s: string): string {
  return s.trim().toLowerCase().replace(/_/g, '-');
}

export type ResolveProviderResult =
  | { kind: 'provider'; provider: ProviderCatalog }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'not-found'; suggestions: string[] };

/** Exact match, else unique prefix. */
export function resolveProvider(catalog: Catalog, input: string): ResolveProviderResult {
  const name = normalizeInput(input);
  const names = catalog.providers.map((p) => p.provider);
  const exact = catalog.providers.find((p) => p.provider === name);
  if (exact) return { kind: 'provider', provider: exact };
  const prefixed = catalog.providers.filter((p) => p.provider.startsWith(name));
  if (name && prefixed.length === 1) return { kind: 'provider', provider: prefixed[0]! };
  if (name && prefixed.length > 1) return { kind: 'ambiguous', candidates: prefixed.map((p) => p.provider) };
  return { kind: 'not-found', suggestions: didYouMean(name, names) };
}

export type ResolveTargetResult =
  | { kind: 'tool'; tool: CatalogTool }
  | { kind: 'resource'; resource: ResourceGroup }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'not-found'; suggestions: string[] };

function rawKey(tool: CatalogTool): string {
  return normalizeInput(tool.rawName);
}

function findResource(provider: ProviderCatalog, name: string): ResourceGroup | 'ambiguous' | undefined {
  const exact = provider.resources.find((r) => r.name === name);
  if (exact) return exact;
  const prefixed = provider.resources.filter((r) => r.name.startsWith(name));
  if (name && prefixed.length === 1) return prefixed[0];
  return prefixed.length > 1 ? 'ambiguous' : undefined;
}

/** Tool names (canonical, leaf and raw) usable as did-you-mean candidates. */
function allNames(provider: ProviderCatalog): string[] {
  return [
    ...provider.resources.map((r) => r.name),
    ...provider.leaves.map((t) => t.name),
    ...provider.tools.map(rawKey),
  ];
}

/**
 * Resolve the first argument after a provider (cli.md, "解析顺序"):
 *
 * - contains `:` -> a tool reference (`resource:verb`), resource accepts a unique prefix;
 * - otherwise a resource (browse), then a leaf tool or raw name (call);
 * - nothing matches -> not-found with at most 3 suggestions, per segment edit distance.
 *
 * A resource and a leaf tool with the same name resolve to the resource; the leaf stays reachable
 * through its raw name.
 */
export function resolveTarget(provider: ProviderCatalog, input: string): ResolveTargetResult {
  const arg = normalizeInput(input);

  const colon = arg.indexOf(':');
  if (colon >= 0) {
    // A raw name that happens to contain a colon is still a valid alias.
    const byRaw = provider.tools.find((t) => rawKey(t) === arg);
    if (byRaw) return { kind: 'tool', tool: byRaw };

    const resName = arg.slice(0, colon);
    const verb = arg.slice(colon + 1);
    const group = findResource(provider, resName);
    if (group === 'ambiguous') {
      return {
        kind: 'ambiguous',
        candidates: provider.resources.filter((r) => r.name.startsWith(resName)).map((r) => r.name),
      };
    }
    if (group) {
      const tool = group.tools.find((t) => t.verb === verb);
      if (tool) return { kind: 'tool', tool };
      return { kind: 'not-found', suggestions: suggestFor(provider, group.name, verb, group) };
    }
    return { kind: 'not-found', suggestions: suggestFor(provider, resName, verb) };
  }

  const resource = provider.resources.find((r) => r.name === arg);
  if (resource) return { kind: 'resource', resource };

  const exact = provider.tools.filter((t) => (t.resource === null && t.name === arg) || rawKey(t) === arg);
  if (exact.length === 1) return { kind: 'tool', tool: exact[0]! };
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact.map((t) => t.rawName) };

  const prefixed = findResource(provider, arg);
  if (prefixed === 'ambiguous') {
    return {
      kind: 'ambiguous',
      candidates: provider.resources.filter((r) => r.name.startsWith(arg)).map((r) => r.name),
    };
  }
  if (prefixed) return { kind: 'resource', resource: prefixed };

  // `list-todos` is a way to write `todo:list`: read it with the split rules, then suggest like `todo:list`.
  const split = splitToolName(arg, { providerNames: [provider.provider] }, defaultSplitRules());
  const parsed = split.kind === 'resource' ? suggestFor(provider, split.resource, split.verb) : [];
  return { kind: 'not-found', suggestions: [...new Set([...parsed, ...didYouMean(arg, allNames(provider))])].slice(0, 3) };
}

/** Leaf tools of the provider whose name, singularised, is `resource`: `secrets` for the resource `secret` (discovery.md). */
export function sameNameLeaves(provider: ProviderCatalog, resource: string): CatalogTool[] {
  const rules = defaultSplitRules();
  const want = singularizeName(resource, rules);
  return provider.leaves.filter((t) => {
    // `name` is what the tool is called now; the split name is what it is called before a clash with a
    // resource moved it to its raw name (`acme-search` was `search`).
    const split = t.leafSingleRef.slice(t.provider.length + 1);
    return singularizeName(t.name, rules) === want || singularizeName(split, rules) === want;
  });
}

/**
 * Did-you-mean names for `resource:verb` that does not exist (discovery.md, "找不到时"), at most 3.
 * In this order, the first group that is not empty and, after it, the groups below it:
 *
 * 1. verbs of the resource that are a typo away from `verb`. A word that is itself a verb of the
 *    verb table (`get`, `set`) is a different action, not a typo, however close it is;
 * 2. leaf tools whose singularised name is the resource (`secrets` for `secret:list`): the tool that
 *    lists a resource is often named for the collection and has no verb, so no edit distance reaches it;
 * 3. the other verbs of the resource, in `tools/list` order, destructive ones last;
 * 4. when the resource does not exist, names close to both parts (they can share no more than a spelling).
 *
 * Groups 2 to 4 are left out when group 1 is not empty: a typo is answered with what was meant.
 */
function suggestFor(provider: ProviderCatalog, resWord: string, verb: string, found?: ResourceGroup): string[] {
  const rules = defaultSplitRules();
  const resource = singularizeName(resWord, rules);
  const group = found ?? provider.resources.find((r) => r.name === resource);
  const tools = group?.tools ?? [];
  const typos = rules.verbs.has(verb) ? [] : didYouMean(verb, tools.map((t) => t.verb!)).map((v) => tools.find((t) => t.verb === v)!);
  if (typos.length > 0) return typos.map((t) => t.name);
  const others = [...tools.filter((t) => !t.destructive), ...tools.filter((t) => t.destructive)];
  const names = [...sameNameLeaves(provider, resource), ...others].map((t) => t.name);
  if (!group) names.push(...suggestTools(provider, resWord, verb));
  return [...new Set(names)].slice(0, 3);
}

/** Per-segment distance over `resource:verb` names; both segments must be close. */
function suggestTools(provider: ProviderCatalog, resName: string, verb: string): string[] {
  const scored: Array<[number, string]> = [];
  for (const t of provider.tools) {
    if (t.resource === null) continue;
    const dr = editDistance(resName, t.resource);
    const dv = editDistance(verb, t.verb!);
    if (dr <= closeness(resName) && dv <= closeness(verb || 'x')) scored.push([dr + dv, t.name]);
  }
  scored.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
  const tools = scored.slice(0, 3).map(([, n]) => n);
  if (tools.length > 0) return tools;
  return didYouMean(resName, provider.resources.map((r) => r.name));
}
