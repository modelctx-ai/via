// Resolution of what the user typed (cli.md, "解析顺序"): provider first (exact, then unique
// prefix), then a resource or a tool inside it. Input is lenient, output is canonical.
import {
  didYouMean,
  normalizeInput,
  resolveProvider,
  resolveTarget,
  type Catalog,
  type CatalogTool,
  type ProviderCatalog,
  type ResourceGroup,
} from '../catalog';
import { notFoundError } from '../render/errors';
import { ExitCode } from '../render/exit-codes';
import type { App } from './app';
import { ALL_COMMANDS } from './builtins';
import { matchingDeny, type ProviderEntry } from './directory';
import { CliFailure, fail, usageFailure } from './failure';

const OTHER_DOMAIN_STUB = { source: 'other' as const, domains: [{ domain: 'other' }] };

/** Provider names only, enough for `resolveProvider` without fetching any tools. */
function nameCatalog(entries: readonly ProviderEntry[]): Catalog {
  return {
    warnings: [],
    providers: entries.map((e) => ({ provider: e.name, tools: [], resources: [], leaves: [], domain: OTHER_DOMAIN_STUB })),
  };
}

/** Find the provider the first argument names, or fail with candidates / did-you-mean (exit 3). */
export async function resolveEntry(app: App, input: string): Promise<ProviderEntry> {
  const { entries } = await app.table();
  if (input.startsWith('-')) throw usageFailure(`unknown option ${input}`, 'via -h');
  const result = resolveProvider(nameCatalog(entries), input);
  if (result.kind === 'provider') return entries.find((e) => e.name === result.provider.provider)!;
  if (result.kind === 'ambiguous') {
    throw fail(ExitCode.NotFound, `ambiguous provider: ${input}`, `via ${result.candidates[0]} -h`, [`candidates: ${result.candidates.join(' · ')}`]);
  }
  if (entries.length === 0) throw fail(ExitCode.NotFound, `no such provider: ${input} (no servers are configured)`, 'via servers');
  // Built-in names count as candidates too: `via sevrers` is more likely a typo than a provider.
  const suggestions = [...new Set([...result.suggestions, ...didYouMean(normalizeInput(input), ALL_COMMANDS.filter((c) => c !== 'help'))])].slice(0, 3);
  throw new CliFailure(notFoundError('provider', input, suggestions, input));
}

export type Target =
  | { kind: 'resource'; provider: ProviderCatalog; group: ResourceGroup }
  | { kind: 'tool'; provider: ProviderCatalog; tool: CatalogTool };

/**
 * Resolve the argument after the provider against what the user may see. A name that only
 * resolves when `deny` rules are ignored is a denied tool (exit 5), not a missing one (exit 3).
 */
export function resolveInProvider(
  views: { visible: ProviderCatalog; full: ProviderCatalog },
  deny: readonly RegExp[],
  input: string,
): Target {
  const { visible } = views;
  if (input.startsWith('-')) throw usageFailure(`unknown option ${input}`, `via ${visible.provider} -h`);
  const found = resolveTarget(visible, input);
  if (found.kind === 'tool') return { kind: 'tool', provider: visible, tool: found.tool };
  if (found.kind === 'resource') return { kind: 'resource', provider: visible, group: found.resource };
  if (found.kind === 'ambiguous') {
    const candidates = found.candidates.map((c) => `${visible.provider} ${c}`);
    throw fail(ExitCode.NotFound, `ambiguous name: ${input}`, `via ${candidates[0]} -h`, [`candidates: ${candidates.join(' · ')}`]);
  }
  // `views.full` is built on first access: only a name that did not resolve gets here.
  const hidden = resolveTarget(views.full, input);
  if (hidden.kind === 'tool') {
    const rule = matchingDeny(hidden.tool, deny);
    if (rule) {
      throw fail(ExitCode.Denied, `${hidden.tool.ref} is denied by the deny rule ${rule.toString()}`, `via ${visible.provider}`);
    }
  }
  throw new CliFailure(
    notFoundError('tool', input, found.suggestions.map((s) => `${visible.provider} ${s}`), `${visible.provider} ${input.replace(':', ' ')}`),
  );
}

/** The canonical spelling goes to stderr when the user typed an alias, a prefix or another case (cli.md). */
export function noteCanonical(app: App, typed: readonly string[], canonical: readonly string[]): void {
  if (typed.length !== canonical.length || typed.some((t, i) => t !== canonical[i])) {
    app.err(`· ${canonical.join(' ')}\n`);
  }
}
