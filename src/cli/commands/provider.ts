// `via <provider> [<resource>|<tool>] …` and `via call <provider>/<ref> …` (cli.md, "解析顺序").
import { renderProvider, renderResource, type ProviderCatalog } from '../../catalog';
import { ExitCode } from '../../render/exit-codes';
import { shellWords } from '../../render/shell';
import type { App, Listing } from '../app';
import type { ProviderEntry } from '../directory';
import { fail, usageFailure } from '../failure';
import { selfJson, selfLines, SELF_HEADER } from '../server-info';
import { noteCanonical, resolveEntry, resolveInProvider } from '../target';
import { callTool, showToolHelp, type ToolTarget } from './tool';

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

/** `--schema-snapshot` was given where there is no tool to check. */
const notATool = () => usageFailure('--schema-snapshot applies to a tool call or its usage (-h), not to a listing', 'via call -h');

const withNewline = (s: string): string => (s.endsWith('\n') ? s : `${s}\n`);

export async function providerCommand(app: App, words: readonly string[]): Promise<number> {
  const [typedProvider, typedTarget, ...toolArgv] = words as [string, ...string[]];
  if (app.options.schemaSnapshot !== undefined && typedTarget === undefined) throw notATool();
  const opened = await openProvider(app, typedProvider);
  const { visible } = opened.views;

  if (typedTarget === undefined) {
    noteCanonical(app, [typedProvider], [visible.provider]);
    const also = [
      ...(opened.listing.features?.resources ? [`via resources ${shellWords(visible.provider)}`] : []),
      ...(opened.listing.features?.prompts ? [`via prompts ${shellWords(visible.provider)}`] : []),
    ];
    const view = withNewline(renderProvider(visible, { all: app.options.all, also }));
    // `-h` adds what the server says about itself (instructions, description): only here (discovery.md, "server 自述").
    if (app.options.help) return showServerSelf(app, opened, view);
    app.out(view);
    return ExitCode.Ok;
  }

  const target = resolveInProvider(opened.views, (await app.config()).deny, typedTarget);
  if (target.kind === 'resource') {
    if (app.options.schemaSnapshot !== undefined) throw notATool();
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

/** `via <provider> -h`: the server's self-description, then the provider view. Reads the cache; asks the server once when the cache has none. */
async function showServerSelf(app: App, opened: OpenProvider, view: string): Promise<number> {
  const { server } = opened.entry;
  const cache = await app.cache();
  let self = cache.readInfo(server);
  if (self === undefined) {
    // A list cached before this was recorded, or a cache that could not be written: ask the server.
    await app.listing(opened.entry, { refresh: true }).then(
      () => undefined,
      () => app.err(`warning: could not ask ${opened.entry.name} what it says about itself\n`),
    );
    self = cache.readInfo(server);
  }
  const redact = (text: string): string => app.redact(text);
  const provider = opened.views.visible.provider;
  if (app.options.format === 'json') {
    app.out(`${JSON.stringify(await app.redactValue(selfJson(provider, self ?? {}, redact)), null, 2)}\n`);
    return ExitCode.Ok;
  }
  const lines = self ? selfLines(self, redact) : ['  (unknown: the server could not be reached)'];
  const text = await app.redactText(`${SELF_HEADER}\n${lines.join('\n')}\n\n`);
  app.out(text + view);
  return ExitCode.Ok;
}

/** `<provider>/<ref>` split at the first slash (cli.md, "工具引用的写法"). */
export function splitToolRef(ref: string | undefined, next: string): { provider: string; target: string } {
  const slash = ref === undefined ? -1 : ref.indexOf('/');
  if (ref === undefined || slash <= 0 || slash === ref.length - 1) {
    throw usageFailure('expected a tool reference like <provider>/<resource>:<verb>', next);
  }
  return { provider: ref.slice(0, slash), target: ref.slice(slash + 1) };
}

/** The tool a single-string reference names inside an opened provider; deny, ambiguity and resources fail here. */
export function resolveToolRef(opened: OpenProvider, deny: readonly RegExp[], ref: string, target: string): ToolTarget {
  const found = resolveInProvider(opened.views, deny, target);
  if (found.kind === 'resource') {
    throw fail(ExitCode.Usage, `${ref} is a resource, not a tool`, `via ${shellWords([found.provider.provider, found.group.name])}`);
  }
  return { entry: opened.entry, listing: opened.listing, views: opened.views, tool: found.tool };
}

/** `via call <provider>/<ref> [--args …]`: the single-string form, for scripts. */
export async function callCommand(app: App, words: readonly string[]): Promise<number> {
  const [ref, ...toolArgv] = words;
  const split = splitToolRef(ref, 'via call -h');
  const opened = await openProvider(app, split.provider);
  const toolTarget = resolveToolRef(opened, (await app.config()).deny, ref!, split.target);
  if (app.options.help) return showToolHelp(app, toolTarget);
  return callTool(app, toolTarget, toolArgv);
}
