// `via <provider> [<resource>|<tool>] …` and `via call <provider>/<ref> …` (cli.md, "解析顺序").
import { normalizeInput, providerHint, providerJson, renderProvider, renderResource, resourceHint, resourceTools, toolListing, type ProviderCatalog } from '../../catalog';
import { ExitCode } from '../../render/exit-codes';
import { shellWords } from '../../render/shell';
import type { App } from '../app';
import { usageFailure } from '../failure';
import { rejectRaw, writeJson } from '../listing-output';
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

type Views = { visible: ProviderCatalog; full: ProviderCatalog };

/** One thing to show: what was typed for it and what it resolved to. */
interface Shown {
  typed: string[];
  target: Target;
}

/**
 * The resource or tool a further word names (cli.md, "一次看几个"). Without a colon the word must
 * be the whole name: a unique prefix is fine for the first word, but a later one may as well be an
 * argument of the tool before it. With a colon it is a tool reference and has to resolve.
 */
function namedTarget(views: Views, deny: readonly RegExp[], word: string, tools: boolean): Target | undefined {
  const reference = word.includes(':');
  let target: Target;
  try {
    target = resolveInProvider(views, deny, word);
  } catch (error) {
    if (reference && tools) throw error;
    return undefined;
  }
  if (target.kind === 'tool' && !tools) return undefined;
  if (reference) return target;
  const typed = normalizeInput(word);
  const whole = target.kind === 'resource' ? target.group.name === typed : target.tool.name === typed || normalizeInput(target.tool.rawName) === typed;
  return whole ? target : undefined;
}

/** The leading words that each name something to show; stops at the first option or word that names nothing. */
function furtherTargets(views: Views, deny: readonly RegExp[], words: readonly string[], tools: boolean): Shown[] {
  const out: Shown[] = [];
  for (const word of words) {
    if (word.startsWith('-')) break;
    const target = namedTarget(views, deny, word, tools);
    if (!target) break;
    out.push({ typed: [word], target });
  }
  return out;
}

/** `via gh issue pull-request`, `via gh issue:read issue:write -h`: each view or usage in turn, a blank line between them. */
async function showSeveral(app: App, opened: OpenProvider, typedProvider: string, items: readonly Shown[]): Promise<number> {
  if (app.options.schemaSnapshot !== undefined) throw usageFailure('--schema-snapshot compares one tool; name one', 'via call -h');
  if (app.options.detach) throw notACall();
  rejectRaw(app, [typedProvider, ...items.flatMap((item) => item.typed)]);
  const { visible } = opened.views;
  // The same thing named twice is shown once.
  const key = (t: Target): string => (t.kind === 'resource' ? `r ${t.group.name}` : `t ${t.tool.name}`);
  const unique = items.filter((item, i) => items.findIndex((other) => key(other.target) === key(item.target)) === i);
  if (app.options.format === 'json') {
    const tool = unique.some((item) => item.target.kind === 'tool') ? await toolCommands() : undefined;
    const values = unique.map(({ target }) => (target.kind === 'resource' ? resourceTools(visible, target.group).map((t) => toolListing(t)) : tool!.detailOf(target.tool)));
    app.out(`${JSON.stringify(await app.redactValue(values), null, 2)}\n`);
    return ExitCode.Ok;
  }
  for (const [i, { typed, target }] of unique.entries()) {
    if (i > 0) app.out('\n');
    if (target.kind === 'resource') {
      noteCanonical(app, [typedProvider, ...typed], [visible.provider, target.group.name]);
      app.out(withNewline(renderResource(visible, target.group)));
    } else {
      noteCanonical(app, [typedProvider, ...typed], [visible.provider, target.tool.name]);
      await (await toolCommands()).showToolHelp(app, { entry: opened.entry, listing: opened.listing, views: opened.views, tool: target.tool });
    }
  }
  return ExitCode.Ok;
}

export async function providerCommand(app: App, words: readonly string[]): Promise<number> {
  const [typedProvider, typedTarget, ...restArgv] = words as [string, ...string[]];
  if (app.options.schemaSnapshot !== undefined && typedTarget === undefined) throw notATool();
  if (app.options.detach && typedTarget === undefined) throw notACall();
  if (typedTarget === undefined) rejectRaw(app, [typedProvider]);
  const opened = await openProvider(app, typedProvider);
  const { visible } = opened.views;

  if (typedTarget === undefined) {
    noteCanonical(app, [typedProvider], [visible.provider]);
    // What else the server offers, as far as the commands for it are shown (ADR 0028).
    const offered = opened.listing.features;
    const features = {
      resources: !!offered?.resources && app.commandVisible('resources'),
      prompts: !!offered?.prompts && app.commandVisible('prompts'),
      skills: !!offered?.skills && app.commandVisible('skills'),
    };
    const also = [
      ...(features.resources ? [`via resources ${shellWords(visible.provider)}`] : []),
      ...(features.prompts ? [`via prompts ${shellWords(visible.provider)}`] : []),
      ...(features.skills ? [`via skills ${shellWords(visible.provider)}`] : []),
    ];
    const view = withNewline(renderProvider(visible, { all: app.options.all, also }));
    // `-h` adds what the server says about itself (instructions, description): only here (discovery.md, "server 自述").
    if (app.options.help) return showServerSelf(app, opened, view);
    if (app.options.format === 'json') {
      // The data on stdout, the `→` hint (as in the text view) on stderr.
      await writeJson(app, providerJson(visible, features));
      if (visible.tools.length > 0 && visible.resources.length > 0) app.err(`${providerHint(visible)}\n`);
      return ExitCode.Ok;
    }
    app.out(view);
    return ExitCode.Ok;
  }

  const deny = (await app.config()).deny;
  let target: Target = resolveInProvider(opened.views, deny, typedTarget);
  let toolArgv = restArgv;
  // `via gh issue read …` is `via gh issue:read …`; any other word after a resource is an error (cli.md, "解析顺序").
  const typedWords = [typedProvider, typedTarget];
  if (target.kind === 'resource' && restArgv.length > 0) {
    // Words that are not a verb of this resource may name more things to look at: more resources, and with -h tools too.
    const group = target.group;
    const verb = normalizeInput(restArgv[0]!);
    const more = group.tools.some((t) => t.verb === verb) ? [] : furtherTargets(opened.views, deny, restArgv, app.options.help);
    const words = restArgv.findIndex((w) => w.startsWith('-'));
    const named = words < 0 ? restArgv.length : words;
    if (more.length > 0) {
      // After a resource every word has to mean something (cli.md, "解析顺序"): the first that does not is the error.
      if (more.length < named) {
        resolveVerbWord(opened.views, deny, group, restArgv[more.length]!);
        // It is a verb of the first resource, in the middle of a list of things to show: one or the other.
        throw usageFailure(`unexpected argument "${restArgv[more.length]!.slice(0, 40)}" after ${shellWords(more[more.length - 1]!.typed)}`, `via ${shellWords([visible.provider, group.name])}`);
      }
      return showSeveral(app, opened, typedProvider, [{ typed: [typedTarget], target }, ...more]);
    }
    target = { kind: 'tool', provider: visible, tool: resolveVerbWord(opened.views, deny, group, restArgv[0]!) };
    typedWords.push(restArgv[0]!);
    toolArgv = restArgv.slice(1);
  }
  if (target.kind === 'resource') {
    if (app.options.schemaSnapshot !== undefined) throw notATool();
    if (app.options.detach) throw notACall();
    rejectRaw(app, [typedProvider, typedTarget]);
    noteCanonical(app, [typedProvider, typedTarget], [visible.provider, target.group.name]);
    if (app.options.format === 'json') {
      await writeJson(app, resourceTools(visible, target.group).map((t) => toolListing(t)));
      app.err(`${resourceHint(visible, target.group)}\n`);
      return ExitCode.Ok;
    }
    app.out(withNewline(renderResource(visible, target.group)));
    return ExitCode.Ok;
  }
  const toolTarget = { entry: opened.entry, listing: opened.listing, views: opened.views, tool: target.tool };
  if (app.options.help) {
    // `via gh issue:read issue:write -h`: the usage of each. Words that name nothing are arguments, which -h does not read.
    const more = furtherTargets(opened.views, deny, toolArgv, true);
    if (more.length > 0) return showSeveral(app, opened, typedProvider, [{ typed: typedWords.slice(1), target }, ...more]);
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
  const visible = opened.views.visible;
  // `--all` adds every tool: its usage line (text), or its detail, the `-h -o json` of that tool (json).
  const every = app.options.all ? await (await toolCommands()).providerTools(visible) : undefined;
  if (app.options.format === 'json') {
    await writeJson(app, every ? every.details : selfJson(visible.provider, self ?? {}, redact));
    return ExitCode.Ok;
  }
  const lines = self ? selfLines(self, redact) : ['  (unknown: the server could not be reached)'];
  const text = await app.redactText(`${SELF_HEADER}\n${lines.join('\n')}\n\n`);
  app.out(text + view + (every && every.usage.length > 0 ? `\n${every.usage.join('\n')}\n` : ''));
  return ExitCode.Ok;
}

/**
 * `via call <provider>/<ref> [--args …]`: the single-string form, for scripts. The reference may
 * also be written as the listings print it, quoted as one word or as two words.
 */
export async function callCommand(app: App, words: readonly string[]): Promise<number> {
  let [ref, ...toolArgv] = words;
  // `via call gh issue:read …`: a first word that is no reference by itself, followed by a word that is not an option.
  if (ref !== undefined && !/[\s/]/.test(ref) && toolArgv[0] !== undefined && !toolArgv[0].startsWith('-')) {
    ref = `${ref} ${toolArgv[0]}`;
    toolArgv = toolArgv.slice(1);
  }
  const split = splitToolRef(ref, 'via call -h');
  const opened = await openProvider(app, split.provider);
  const toolTarget = resolveToolRef(opened, (await app.config()).deny, `${split.provider}/${split.target}`, split.target);
  const tool = await toolCommands();
  if (app.options.help) return tool.showToolHelp(app, toolTarget);
  return tool.callTool(app, toolTarget, toolArgv);
}
