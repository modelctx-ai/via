// Resolution of what the user typed (cli.md, "解析顺序"): provider first (exact, then unique
// prefix), then a resource or a tool inside it. Input is lenient, output is canonical.
import {
  didYouMean,
  normalizeInput,
  resolveProvider,
  resolveTarget,
  sameNameLeaves,
  type Catalog,
  type CatalogTool,
  type ProviderCatalog,
  type ResourceGroup,
} from '../catalog';
import { notFoundError } from '../render/errors';
import { ExitCode } from '../render/exit-codes';
import { shellWords, visibleText } from '../render/shell';
import type { App } from './app';
import { ALL_COMMANDS } from './builtins';
import { matchingDeny, type ProviderEntry } from './directory';
import { CliFailure, fail, usageFailure } from './failure';

/** Provider names only, enough for `resolveProvider` without fetching any tools. */
function nameCatalog(entries: readonly ProviderEntry[]): Catalog {
  return {
    warnings: [],
    providers: entries.map((e) => ({ provider: e.name, tools: [], resources: [], leaves: [] })),
  };
}

/** Find the provider the first argument names, or fail with candidates / did-you-mean (exit 3). */
export async function resolveEntry(app: App, input: string): Promise<ProviderEntry> {
  const { entries } = await app.table();
  if (input.startsWith('-')) throw usageFailure(`unknown option ${visibleText(input)}`, 'via -h');
  const result = resolveProvider(nameCatalog(entries), input);
  if (result.kind === 'provider') return entries.find((e) => e.name === result.provider.provider)!;
  if (result.kind === 'ambiguous') {
    throw fail(ExitCode.NotFound, `ambiguous provider: ${visibleText(input)}`, `via ${shellWords(result.candidates[0]!)} -h`, [`candidates: ${result.candidates.map((c) => shellWords(c)).join(' · ')}`]);
  }
  if (entries.length === 0) throw fail(ExitCode.NotFound, `no such provider: ${visibleText(input)} (no servers are configured)`, 'via servers');
  // Built-in names count as candidates too: `via sevrers` is more likely a typo than a provider.
  const suggestions = [...new Set([...result.suggestions, ...didYouMean(normalizeInput(input), ALL_COMMANDS.filter((c) => c !== 'help'))])].slice(0, 3);
  // The providers are few, so the error lists them: cheaper than another command to find the right name,
  // and the next step is always one that exists (discovery.md, "找不到时").
  const info = notFoundError('provider', input, suggestions, input);
  info.lines = [...(info.lines ?? []), providersLine(entries)];
  info.next = suggestions.length > 0 ? `via ${shellWords(suggestions[0]!)}` : 'via';
  throw new CliFailure(info);
}

/** Providers named in a "no such provider" error before the rest are summarised. */
const PROVIDERS_SHOWN = 12;

function providersLine(entries: readonly ProviderEntry[]): string {
  const names = entries.map((e) => shellWords(e.name)).sort();
  const shown = names.slice(0, PROVIDERS_SHOWN);
  return `providers: ${[...shown, ...(names.length > PROVIDERS_SHOWN ? [`… ${names.length - PROVIDERS_SHOWN} more`, 'via'] : [])].join(' · ')}`;
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
  if (input.startsWith('-')) throw usageFailure(`unknown option ${visibleText(input)}`, `via ${shellWords(visible.provider)} -h`);
  const found = resolveTarget(visible, input);
  if (found.kind === 'tool') return { kind: 'tool', provider: visible, tool: found.tool };
  if (found.kind === 'resource') return { kind: 'resource', provider: visible, group: found.resource };
  if (found.kind === 'ambiguous') {
    const candidates = found.candidates.map((c) => shellWords([visible.provider, c]));
    throw fail(ExitCode.NotFound, `ambiguous name: ${visibleText(input)}`, `via ${candidates[0]} -h`, [`candidates: ${candidates.join(' · ')}`]);
  }
  // `views.full` is built on first access: only a name that did not resolve gets here.
  const hidden = resolveTarget(views.full, input);
  if (hidden.kind === 'tool') {
    const rule = matchingDeny(hidden.tool, deny);
    if (rule) {
      throw fail(ExitCode.Denied, `${hidden.tool.ref} is denied by ${rule}`, `via ${shellWords(visible.provider)}`);
    }
  }
  throw new CliFailure(
    notFoundError('tool', input, found.suggestions.map((s) => [visible.provider, s]), `${visible.provider} ${input.replace(':', ' ')}`),
  );
}

/** Longest stretch of a word the person typed that is echoed in a message. */
const ECHO_MAX = 40;

/**
 * `via <provider> <resource> <word>` (cli.md, "解析顺序"): when `<word>` is exactly one of the
 * resource's verbs it means `<resource>:<word>`, so `via gh issue read --number 1` works the way
 * `gh issue read` does everywhere else. Anything else is a usage error (exit 2): the word would be
 * dropped, and a silent browse that ignores it looks like a call that printed nothing. A word that
 * is not a verb but names a tool of this resource (a raw name, or `resource:verb` written after the
 * resource) is offered as did-you-mean; a word starting with `-` is an option nothing here takes.
 */
export function resolveVerbWord(
  views: { visible: ProviderCatalog; full: ProviderCatalog },
  deny: readonly RegExp[],
  group: ResourceGroup,
  word: string,
): CatalogTool {
  const { visible } = views;
  const where = shellWords([visible.provider, group.name]);
  if (word.startsWith('-')) throw usageFailure(`unknown option ${visibleText(word.slice(0, ECHO_MAX))}`, `via ${where}`);
  const verb = normalizeInput(word);
  const tool = group.tools.find((t) => t.verb === verb);
  if (tool) return tool;

  // A verb that only exists when `deny` is ignored is denied (exit 5), not unexpected.
  const hidden = views.full.resources.find((r) => r.name === group.name)?.tools.find((t) => t.verb === verb);
  const rule = hidden && matchingDeny(hidden, deny);
  if (hidden && rule) throw fail(ExitCode.Denied, `${hidden.ref} is denied by ${rule}`, `via ${shellWords(visible.provider)}`);

  const named = group.tools.find((t) => normalizeInput(t.rawName) === verb);
  const written = verb.includes(':') ? resolveTarget(visible, word) : undefined;
  const close = didYouMean(verb, group.tools.map((t) => t.verb!)).map((v) => group.tools.find((t) => t.verb === v)!);
  // A leaf tool named for the resource (`secrets` for `secret`) is where a word such as `list` usually leads.
  const suggestions = [...new Set([...(named ? [named] : []), ...(written?.kind === 'tool' ? [written.tool] : []), ...close, ...sameNameLeaves(visible, group.name)])].slice(0, 3);
  const shown = word.length > ECHO_MAX ? `${word.slice(0, ECHO_MAX - 1)}…` : word;
  const message = `unexpected argument "${visibleText(shown)}"`;
  if (suggestions.length > 0) {
    throw fail(ExitCode.Usage, message, `via ${shellWords([visible.provider, suggestions[0]!.name])} -h`, [`did you mean: ${suggestions.map((t) => shellWords([visible.provider, t.name])).join(' · ')}`]);
  }
  const verbs = group.tools.map((t) => shellWords(t.verb!));
  throw fail(ExitCode.Usage, message, `via ${where}`, [`verbs of ${where}: ${verbs.slice(0, 8).join(' · ')}${verbs.length > 8 ? ` · … ${verbs.length - 8} more` : ''}`]);
}

/** The canonical spelling goes to stderr when the user typed an alias, a prefix or another case (cli.md). */
export function noteCanonical(app: App, typed: readonly string[], canonical: readonly string[]): void {
  if (typed.length !== canonical.length || typed.some((t, i) => t !== canonical[i])) {
    app.err(`· ${canonical.join(' ')}\n`);
  }
}
