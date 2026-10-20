import { didYouMean, editDistance, closeness } from './edit-distance';
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
      return { kind: 'not-found', suggestions: suggestInResource(group, verb) };
    }
    return { kind: 'not-found', suggestions: suggestTools(provider, resName, verb) };
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

  return { kind: 'not-found', suggestions: didYouMean(arg, allNames(provider)) };
}

function suggestInResource(group: ResourceGroup, verb: string): string[] {
  const verbs = group.tools.map((t) => t.verb!);
  const close = didYouMean(verb, verbs);
  const names = close.length > 0 ? close : verbs.slice(0, 3);
  return names.map((v) => `${group.name}:${v}`);
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
