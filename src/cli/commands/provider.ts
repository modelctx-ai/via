// `via <provider> [<resource>|<tool>] …` and `via call <provider>/<ref> …` (cli.md, "解析顺序").
import { renderProvider, renderResource } from '../../catalog';
import { ExitCode } from '../../render/exit-codes';
import { shellWords } from '../../render/shell';
import type { App } from '../app';
import { usageFailure } from '../failure';
import { openProvider, resolveToolRef, splitToolRef, type OpenProvider } from '../open-provider';
import { selfJson, selfLines, SELF_HEADER } from '../server-info';
import { noteCanonical, resolveInProvider, resolveVerbWord, type Target } from '../target';

// `./tool` (argument parsing, validation, the render pipeline) is imported where a tool is called or
// described: browsing a provider or a resource never loads it.
const toolCommands = (): Promise<typeof import('./tool')> => import('./tool');

/** `--schema-snapshot` was given where there is no tool to check. */
const notATool = () => usageFailure('--schema-snapshot applies to a tool call or its usage (-h), not to a listing', 'via call -h');
const notACall = () => usageFailure('--detach applies to a tool call, not to a listing', 'via call -h');

const withNewline = (s: string): string => (s.endsWith('\n') ? s : `${s}\n`);

export async function providerCommand(app: App, words: readonly string[]): Promise<number> {
  const [typedProvider, typedTarget, ...restArgv] = words as [string, ...string[]];
  if (app.options.schemaSnapshot !== undefined && typedTarget === undefined) throw notATool();
  if (app.options.detach && typedTarget === undefined) throw notACall();
  const opened = await openProvider(app, typedProvider);
  const { visible } = opened.views;

  if (typedTarget === undefined) {
    noteCanonical(app, [typedProvider], [visible.provider]);
    const also = [
      ...(opened.listing.features?.resources ? [`via resources ${shellWords(visible.provider)}`] : []),
      ...(opened.listing.features?.prompts ? [`via prompts ${shellWords(visible.provider)}`] : []),
      ...(opened.listing.features?.skills ? [`via skills ${shellWords(visible.provider)}`] : []),
    ];
    const view = withNewline(renderProvider(visible, { all: app.options.all, also }));
    // `-h` adds what the server says about itself (instructions, description): only here (discovery.md, "server 自述").
    if (app.options.help) return showServerSelf(app, opened, view);
    app.out(view);
    return ExitCode.Ok;
  }

  const deny = (await app.config()).deny;
  let target: Target = resolveInProvider(opened.views, deny, typedTarget);
  let toolArgv = restArgv;
  // `via gh issue read …` is `via gh issue:read …`; any other word after a resource is an error (cli.md, "解析顺序").
  const typedWords = [typedProvider, typedTarget];
  if (target.kind === 'resource' && restArgv.length > 0) {
    target = { kind: 'tool', provider: visible, tool: resolveVerbWord(opened.views, deny, target.group, restArgv[0]!) };
    typedWords.push(restArgv[0]!);
    toolArgv = restArgv.slice(1);
  }
  if (target.kind === 'resource') {
    if (app.options.schemaSnapshot !== undefined) throw notATool();
    if (app.options.detach) throw notACall();
    noteCanonical(app, [typedProvider, typedTarget], [visible.provider, target.group.name]);
    app.out(withNewline(renderResource(visible, target.group)));
    return ExitCode.Ok;
  }
  const toolTarget = { entry: opened.entry, listing: opened.listing, views: opened.views, tool: target.tool };
  if (app.options.help) {
    noteCanonical(app, typedWords, [visible.provider, target.tool.name]);
    return (await toolCommands()).showToolHelp(app, toolTarget);
  }
  return (await toolCommands()).callTool(app, toolTarget, toolArgv);
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

/** `via call <provider>/<ref> [--args …]`: the single-string form, for scripts. */
export async function callCommand(app: App, words: readonly string[]): Promise<number> {
  const [ref, ...toolArgv] = words;
  const split = splitToolRef(ref, 'via call -h');
  const opened = await openProvider(app, split.provider);
  const toolTarget = resolveToolRef(opened, (await app.config()).deny, ref!, split.target);
  const tool = await toolCommands();
  if (app.options.help) return tool.showToolHelp(app, toolTarget);
  return tool.callTool(app, toolTarget, toolArgv);
}
