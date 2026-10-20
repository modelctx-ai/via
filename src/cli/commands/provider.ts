// `via <provider> [<resource>|<tool>] …` and `via call <provider>/<ref> …` (cli.md, "解析顺序").
import { renderProvider, renderResource, type ProviderCatalog } from '../../catalog';
import { ExitCode } from '../../render/exit-codes';
import type { App, Listing } from '../app';
import type { ProviderEntry } from '../directory';
import { fail, usageFailure } from '../failure';
import { noteCanonical, resolveEntry, resolveInProvider } from '../target';
import { callTool, showToolHelp } from './tool';

export interface OpenProvider {
  entry: ProviderEntry;
  listing: Listing;
  views: { visible: ProviderCatalog; full: ProviderCatalog };
}

/** Resolve the provider and fetch only its tools (disk cache first). */
export async function openProvider(app: App, input: string): Promise<OpenProvider> {
  const entry = await resolveEntry(app, input);
  const listing = await app.listing(entry);
  return { entry, listing, views: await app.providerViews(entry, listing.tools) };
}

const withNewline = (s: string): string => (s.endsWith('\n') ? s : `${s}\n`);

export async function providerCommand(app: App, words: readonly string[]): Promise<number> {
  const [typedProvider, typedTarget, ...toolArgv] = words as [string, ...string[]];
  const opened = await openProvider(app, typedProvider);
  const { visible } = opened.views;

  if (typedTarget === undefined) {
    noteCanonical(app, [typedProvider], [visible.provider]);
    app.out(withNewline(renderProvider(visible, { all: app.options.all })));
    return ExitCode.Ok;
  }

  const target = resolveInProvider(opened.views, (await app.config()).deny, typedTarget);
  if (target.kind === 'resource') {
    noteCanonical(app, [typedProvider, typedTarget], [visible.provider, target.group.name]);
    app.out(withNewline(renderResource(visible, target.group)));
    return ExitCode.Ok;
  }
  const toolTarget = { entry: opened.entry, listing: opened.listing, views: opened.views, tool: target.tool };
  if (app.options.help) {
    noteCanonical(app, [typedProvider, typedTarget], [visible.provider, target.tool.name]);
    return showToolHelp(app, toolTarget);
  }
  return callTool(app, toolTarget, toolArgv);
}

/** `via call <provider>/<ref> [--args …]`: the single-string form, for scripts. */
export async function callCommand(app: App, words: readonly string[]): Promise<number> {
  const [ref, ...toolArgv] = words;
  const slash = ref === undefined ? -1 : ref.indexOf('/');
  if (ref === undefined || slash <= 0 || slash === ref.length - 1) {
    throw usageFailure('expected a tool reference like <provider>/<resource>:<verb>', 'via call -h');
  }
  const opened = await openProvider(app, ref.slice(0, slash));
  const target = resolveInProvider(opened.views, (await app.config()).deny, ref.slice(slash + 1));
  if (target.kind === 'resource') {
    throw fail(ExitCode.Usage, `${ref} is a resource, not a tool`, `via ${target.provider.provider} ${target.group.name}`);
  }
  const toolTarget = { entry: opened.entry, listing: opened.listing, views: opened.views, tool: target.tool };
  if (app.options.help) return showToolHelp(app, toolTarget);
  return callTool(app, toolTarget, toolArgv);
}
