import { formatSignature, shortDescription } from './signature';
import type { CatalogTool, ProviderCatalog, ResourceGroup } from './types';
import type { SearchHit } from './search';
import { alignRows } from '../render/width';

// Browse views (discovery.md, "浏览视图"). Pure functions returning the text to print.

/** Default number of resource rows on a screen (discovery.md). */
export const DEFAULT_MAX_ROWS = 20;
/** Default number of leaf tool names on the `tools:` line before it is cut. */
export const DEFAULT_MAX_LEAVES = 12;

export type ProviderStatus = 'ok' | 'needs-auth' | 'error' | 'untrusted';

const STATUS_LABEL: Record<Exclude<ProviderStatus, 'ok'>, string> = {
  'needs-auth': 'needs auth',
  error: 'failed',
  untrusted: 'untrusted',
};

export interface RootEntry {
  provider: string;
  /** Visible tools; 0 when the catalog could not be loaded. */
  toolCount: number;
  status: ProviderStatus;
}

export function rootEntries(
  providers: readonly ProviderCatalog[],
  statuses: Readonly<Record<string, ProviderStatus>> = {},
): RootEntry[] {
  return providers.map((p) => ({
    provider: p.provider,
    // A catalog restored from the cache knows its size without restoring its tools.
    toolCount: (p as { toolCount?: number }).toolCount ?? p.tools.length,
    status: statuses[p.provider] ?? 'ok',
  }));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function marker(tool: CatalogTool): string {
  return tool.destructive ? '!' : '';
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `via` — status line, then one row per provider with its tool count. */
export function renderRoot(entries: readonly RootEntry[]): string {
  const total = entries.reduce((n, e) => n + e.toolCount, 0);
  const summary = [plural(entries.length, 'provider'), plural(total, 'tool')];
  for (const status of ['needs-auth', 'error', 'untrusted'] as const) {
    const names = entries.filter((e) => e.status === status).map((e) => e.provider);
    if (names.length > 0) summary.push(`${names.length} ${STATUS_LABEL[status]} (${names.join(', ')})`);
  }
  const lines = [summary.join(' · ')];
  const hint = '→ via <provider> to browse · via find <query> to search';

  const rows = [...entries]
    .sort((a, b) => byName(a.provider, b.provider))
    .map((e) => [e.provider, e.status === 'ok' ? plural(e.toolCount, 'tool') : STATUS_LABEL[e.status]]);
  lines.push(...alignRows(rows));
  lines.push(hint);
  return lines.join('\n');
}

export interface ProviderViewOptions {
  /** `--all`: do not truncate the resource list. */
  all?: boolean;
  maxRows?: number;
  maxLeaves?: number;
  /** Commands for what the server offers besides tools (`via resources <p>`); shown on an `also:` line. */
  also?: readonly string[];
}

function verbList(group: ResourceGroup): string {
  return group.tools.map((t) => `${t.verb}${marker(t)}`).join(' · ');
}

/** `via <provider>` — one row per resource with verbs inline, leaf tools on the last line. */
export function renderProvider(provider: ProviderCatalog, options: ProviderViewOptions = {}): string {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const shown = options.all ? provider.resources : provider.resources.slice(0, maxRows);
  const lines = alignRows(shown.map((g) => [g.name, verbList(g)]));
  const hidden = provider.resources.length - shown.length;
  if (hidden > 0) lines.push(`… ${hidden} more · via ${provider.provider} --all`);
  if (provider.leaves.length > 0) {
    const maxLeaves = options.maxLeaves ?? DEFAULT_MAX_LEAVES;
    const leaves = options.all ? provider.leaves : provider.leaves.slice(0, maxLeaves);
    const names = leaves.map((t) => `${t.name}${marker(t)}`);
    const cut = provider.leaves.length - leaves.length;
    if (cut > 0) names.push(`… ${cut} more · via ${provider.provider} --all`);
    lines.push(`tools: ${names.join(' · ')}`);
  }
  if (provider.tools.length === 0) lines.push('(no tools)');
  if (options.also && options.also.length > 0) lines.push(`also: ${options.also.join(' · ')}`);
  if (provider.tools.length > 0 && provider.resources.length > 0) lines.push(`→ via ${provider.provider} <resource> for signatures`);
  return lines.join('\n');
}

/** `[read-only]` / `[destructive]` tag shown after the description (arguments.md: hints are shown in the resource view). */
function hintTag(tool: CatalogTool): string {
  if (tool.destructive) return '[destructive]';
  return tool.readOnly ? '[read-only]' : '';
}

/**
 * Name, signature and description columns shared by the resource view and `find`. The name
 * column stays copyable, so safety hints go after the description rather than into the name.
 */
function toolRows(label: (t: CatalogTool) => string, tools: readonly CatalogTool[]): string[] {
  return alignRows(
    tools.map((t) => {
      const row = [label(t), formatSignature(t.params)];
      const tail = [shortDescription(t.description), hintTag(t)].filter(Boolean).join(' ');
      if (tail) row.push(tail);
      return row;
    }),
  );
}

/** `via <provider> <resource>` — one row per tool: verb, signature, short description. */
export function renderResource(provider: ProviderCatalog, group: ResourceGroup): string {
  const lines = toolRows((t) => t.name, group.tools);
  lines.push(`→ via ${provider.provider} ${group.name}:<verb> -h for usage`);
  return lines.join('\n');
}

/** `via find` results: like the resource view, with the provider prefix. */
export function renderFind(hits: readonly SearchHit[], query: string): string {
  if (hits.length === 0) return `no tools match "${query}"\n→ via to list providers`;
  return toolRows((t) => t.ref, hits.map((h) => h.tool)).join('\n');
}
