import { sameNameLeaves } from './resolve';
import { formatSignature, shortDescription, signatureLists, SIGNATURE_MAX_PARAMS } from './signature';
import type { CatalogTool, DestructiveBy, ProviderCatalog, ResourceGroup } from './types';
import type { SearchHit } from './search';
import { shellArg, shellWords, visibleText } from '../render/shell';
import { alignRows } from '../render/width';

// Browse views (discovery.md, "浏览视图"). Pure functions returning the text to print.

/** Default number of resource rows on a screen (discovery.md). */
export const DEFAULT_MAX_ROWS = 20;
/** Default number of leaf tool names on the `tools:` line before it is cut. */
export const DEFAULT_MAX_LEAVES = 12;

/**
 * What a provider's tool list came to in a browse (discovery.md, "浏览视图"). The names are the ones
 * `-o json` prints. `starting`: the wait ran out but nothing failed for certain (the server is still
 * starting, a daemon goes on connecting); `failed`: it certainly did not work (the process exited, the
 * command is missing, the handshake was refused), with a reason.
 */
export const PROVIDER_STATUSES = ['ok', 'needs-auth', 'starting', 'failed', 'untrusted'] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

const STATUS_LABEL: Record<Exclude<ProviderStatus, 'ok'>, string> = {
  'needs-auth': 'needs auth',
  starting: 'starting',
  failed: 'failed',
  untrusted: 'untrusted',
};

export interface RootEntry {
  provider: string;
  /** Visible tools; 0 when the catalog could not be loaded. */
  toolCount: number;
  status: ProviderStatus;
  /** One line after the status label: the reason for `failed`, what to do for `starting`. Already redacted. */
  detail?: string;
}

export function rootEntries(
  providers: readonly ProviderCatalog[],
  statuses: Readonly<Record<string, ProviderStatus>> = {},
  details: Readonly<Record<string, string>> = {},
): RootEntry[] {
  return providers.map((p) => {
    const detail = details[p.provider];
    return {
      provider: p.provider,
      // A catalog restored from the cache knows its size without restoring its tools.
      toolCount: (p as { toolCount?: number }).toolCount ?? p.tools.length,
      status: statuses[p.provider] ?? 'ok',
      ...(detail ? { detail } : {}),
    };
  });
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

/** The line that ends the root view; with `-o json` it goes to stderr, so that stdout is only the data. */
export const ROOT_HINT = '→ via <provider> to browse · via find <query> to search';

/** `via -o json` (discovery.md, "浏览视图"): `{"providers": [{"provider", "tools", "status"}]}`, in the order of the text view. */
export function rootJson(entries: readonly RootEntry[]): { providers: Array<{ provider: string; tools: number; status: string }> } {
  return {
    providers: [...entries]
      .sort((a, b) => byName(a.provider, b.provider))
      .map((e) => ({ provider: e.provider, tools: e.toolCount, status: e.status === 'ok' ? 'ok' : STATUS_LABEL[e.status] })),
  };
}

/** `via` — status line, then one row per provider with its tool count. */
export function renderRoot(entries: readonly RootEntry[]): string {
  const total = entries.reduce((n, e) => n + e.toolCount, 0);
  const summary = [plural(entries.length, 'provider'), plural(total, 'tool')];
  for (const status of ['needs-auth', 'starting', 'failed', 'untrusted'] as const) {
    const names = entries.filter((e) => e.status === status).map((e) => e.provider);
    if (names.length > 0) summary.push(`${names.length} ${STATUS_LABEL[status]} (${names.join(', ')})`);
  }
  const lines = [summary.join(' · ')];

  const rows = [...entries]
    .sort((a, b) => byName(a.provider, b.provider))
    .map((e) => [e.provider, e.status === 'ok' ? plural(e.toolCount, 'tool') : e.detail ? `${STATUS_LABEL[e.status]} · ${e.detail}` : STATUS_LABEL[e.status]]);
  lines.push(...alignRows(rows));
  lines.push(ROOT_HINT);
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
  if (hidden > 0) lines.push(`… ${hidden} more · via ${shellWords(provider.provider)} --all`);
  if (provider.leaves.length > 0) {
    const maxLeaves = options.maxLeaves ?? DEFAULT_MAX_LEAVES;
    const leaves = options.all ? provider.leaves : provider.leaves.slice(0, maxLeaves);
    const names = leaves.map((t) => `${t.name}${marker(t)}`);
    const cut = provider.leaves.length - leaves.length;
    if (cut > 0) names.push(`… ${cut} more · via ${shellWords(provider.provider)} --all`);
    lines.push(`tools: ${names.join(' · ')}`);
  }
  if (provider.tools.length === 0) lines.push('(no tools)');
  if (options.also && options.also.length > 0) lines.push(`also: ${options.also.join(' · ')}`);
  if (provider.tools.length > 0 && provider.resources.length > 0) lines.push(providerHint(provider));
  return lines.join('\n');
}

/** The `→` line that ends the provider view. */
export function providerHint(provider: ProviderCatalog): string {
  return `→ via ${shellWords(provider.provider)} <resource> for signatures`;
}

/**
 * `via <provider> -o json`: every resource with its verbs and every leaf tool, whole (the text view's
 * `--all` cut is for the screen, not for a program), and which other kinds of content the server has.
 */
export function providerJson(
  provider: ProviderCatalog,
  also: { resources: boolean; prompts: boolean; skills: boolean },
): { provider: string; resources: Array<{ name: string; verbs: string[] }>; tools: string[]; also: typeof also } {
  return {
    provider: provider.provider,
    resources: provider.resources.map((g) => ({ name: g.name, verbs: g.tools.map((t) => t.verb!) })),
    tools: provider.leaves.map((t) => t.name),
    also,
  };
}

/** `[read-only]` / `[destructive]` tag shown after the description (arguments.md: hints are shown in the resource view). */
function hintTag(tool: CatalogTool): string {
  // `?`: via's guess from the name; `[confirm]`: the user's `confirm.tools` rule. Only `[destructive]` is the server's word.
  if (tool.destructive) return tool.destructiveBy === 'inferred' ? '[destructive?]' : tool.destructiveBy === 'config' ? '[confirm]' : '[destructive]';
  return tool.readOnly ? '[read-only]' : '';
}

/**
 * Name, signature and description columns shared by the resource view and `find`. The name
 * column stays copyable, so safety hints go after the description rather than into the name.
 */
function toolRows(label: (t: CatalogTool) => string, tools: readonly CatalogTool[]): string[] {
  return alignRows(
    tools.map((t) => {
      // Types and allowed values in the signature: enough to write the call without `-h` (discovery.md).
      const row = [label(t), formatSignature(t.params, SIGNATURE_MAX_PARAMS, true)];
      const tail = [shortDescription(t.description), hintTag(t)].filter(Boolean).join(' ');
      if (tail) row.push(tail);
      return row;
    }),
  );
}

/** A tool as `-o json` lists it in the resource view and in `via find`. */
export interface ToolListing {
  ref: string;
  provider: string;
  resource: string | null;
  verb: string | null;
  rawName: string;
  signature: { required: string[]; optional: string[] };
  description: string;
  readOnly: boolean;
  destructive: boolean;
  /** Present with `destructive: true`: `server` (declared), `inferred` (from the raw name) or `config` (`confirm.tools`). */
  destructiveBy?: DestructiveBy;
  example?: string;
}

/**
 * The `example:` line `-h` shows, as a command: the words of the tool's canonical form and the
 * arguments kept in the prebuilt catalog. Undefined for a tool without one.
 */
export function exampleCommand(tool: CatalogTool): string | undefined {
  return tool.exampleArgs === undefined ? undefined : `via ${shellWords(tool.ref)} ${tool.exampleArgs}`;
}

/** Fields from the prebuilt catalog only: no schema is read. `example` only where the command asks for it. */
export function toolListing(tool: CatalogTool, options: { example?: boolean } = {}): ToolListing {
  const example = options.example ? exampleCommand(tool) : undefined;
  return {
    ref: tool.ref,
    provider: tool.provider,
    resource: tool.resource,
    verb: tool.verb,
    rawName: tool.rawName,
    signature: signatureLists(tool.params),
    description: tool.description,
    readOnly: tool.readOnly,
    destructive: tool.destructive,
    ...(tool.destructiveBy ? { destructiveBy: tool.destructiveBy } : {}),
    ...(example !== undefined ? { example } : {}),
  };
}

/**
 * What the resource view lists: the resource's tools, then the leaf tools named for the resource
 * (`secrets` under `secret`), which have no verb and so are in no resource (discovery.md).
 */
export function resourceTools(provider: ProviderCatalog, group: ResourceGroup): CatalogTool[] {
  return [...group.tools, ...sameNameLeaves(provider, group.name)];
}

/** `via <provider> <resource>` — one row per tool: verb, signature, short description. */
export function renderResource(provider: ProviderCatalog, group: ResourceGroup): string {
  const lines = toolRows((t) => t.name, resourceTools(provider, group));
  lines.push(resourceHint(provider, group));
  return lines.join('\n');
}

/** The `→` line that ends the resource view. */
export function resourceHint(provider: ProviderCatalog, group: ResourceGroup): string {
  return `→ via ${shellWords(provider.provider)} ${shellArg(group.name, { placeholder: 'resource' })}:<verb> -h for usage`;
}

/** What `via find` says when nothing matches; the second line is a `→` hint. */
export function findNoMatch(query: string): { message: string; hint: string } {
  return { message: `no tools match "${visibleText(query)}"`, hint: '→ via to list providers' };
}

/**
 * `via find` results: like the resource view, with the provider prefix. Unless `brief`, each result
 * is followed by its `example:` line, the one `-h` would show, indented under it.
 */
export function renderFind(hits: readonly SearchHit[], query: string, options: { brief?: boolean } = {}): string {
  if (hits.length === 0) {
    const none = findNoMatch(query);
    return `${none.message}\n${none.hint}`;
  }
  const tools = hits.map((h) => h.tool);
  const rows = toolRows((t) => t.ref, tools);
  if (options.brief) return rows.join('\n');
  return rows.flatMap((row, i) => {
    const example = exampleCommand(tools[i]!);
    return example === undefined ? [row] : [row, `  example: ${example}`];
  }).join('\n');
}
