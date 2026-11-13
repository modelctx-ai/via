// Opening a provider for a command: resolving the name, fetching its tools (disk cache first) and
// resolving a `<provider>/<ref>` reference inside it. Shared by `via <provider>` (provider.ts) and
// `via batch`, and apart from both so that neither is a module the other loads.
import { ExitCode } from '../render/exit-codes';
import { shellWords } from '../render/shell';
import type { App, Listing } from './app';
import type { ProviderEntry } from './directory';
import { fail, usageFailure } from './failure';
import { resolveEntry, resolveInProvider } from './target';
import type { ToolTarget } from './commands/tool';
import type { ProviderCatalog } from '../catalog';

export interface OpenProvider {
  entry: ProviderEntry;
  listing: Listing;
  views: { visible: ProviderCatalog; full: ProviderCatalog };
}

/** Resolve the provider and fetch only its tools (disk cache first). */
export async function openProvider(app: App, input: string): Promise<OpenProvider> {
  const entry = await resolveEntry(app, input);
  const listing = await app.listing(entry);
  return { entry, listing, views: await app.providerViews(entry, listing) };
}

/**
 * A tool reference in one string (cli.md, "工具引用的写法"): `<provider>/<ref>`, split at the first
 * slash, or the two words the listings print, `<provider> <ref>`. An agent copies what `via find`
 * showed it, so both spellings name the same tool.
 */
export function splitToolRef(ref: string | undefined, next: string): { provider: string; target: string } {
  const expected = (): never => {
    throw usageFailure('expected a tool reference like <provider>/<resource>:<verb> or "<provider> <resource>:<verb>"', next);
  };
  if (ref === undefined) return expected();
  const words = ref.trim().split(/\s+/);
  if (words.length === 2 && words.every((w) => w !== '' && !w.startsWith('-'))) return { provider: words[0]!, target: words[1]! };
  if (words.length !== 1) return expected();
  const slash = words[0]!.indexOf('/');
  if (slash <= 0 || slash === words[0]!.length - 1) return expected();
  return { provider: words[0]!.slice(0, slash), target: words[0]!.slice(slash + 1) };
}

/** The tool a single-string reference names inside an opened provider; deny, ambiguity and resources fail here. */
export function resolveToolRef(opened: OpenProvider, deny: readonly RegExp[], ref: string, target: string): ToolTarget {
  const found = resolveInProvider(opened.views, deny, target);
  if (found.kind === 'resource') {
    throw fail(ExitCode.Usage, `${ref} is a resource, not a tool`, `via ${shellWords([found.provider.provider, found.group.name])}`);
  }
  return { entry: opened.entry, listing: opened.listing, views: opened.views, tool: found.tool };
}
