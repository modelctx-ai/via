// `via resources <provider>`, `via read <provider> <uri>`, `via prompts <provider> [<name> [args]]`
// (cli.md; ADR 0010). They share the provider resolution and the render pipeline with tool calls;
// the requests go through `app.backend()`, so the daemon and the in-process path behave the same.
import { join } from 'node:path';
import { didYouMean, normalizeInput } from '../../catalog';
import type { CompletionRef, McpPrompt } from '../../protocol';
import type { McpTool } from '../../catalog/types';
import { notFoundError } from '../../render/errors';
import { ExitCode } from '../../render/exit-codes';
import { FileMediaSink } from '../../render/media';
import { renderOptions, renderToolResult } from '../../render/pipeline';
import { shellArg, shellWords, visibleText } from '../../render/shell';
import { redactProtocol } from '../../render/redact';
import { defaultNoise } from '../../render/rules';
import type { ToolResult } from '../../render/types';
import { formatToolHelp, parseToolArgs } from '../args';
import type { App } from '../app';
import type { ProviderEntry } from '../directory';
import { CliFailure, usageFailure } from '../failure';
import { completionResult, promptListing, promptResult, promptTool, readResult, resourceListing, templateTool } from '../mcp-data';
import { noteCanonical, resolveEntry } from '../target';
import { argsIo } from './tool';

/** The provider the first argument names, with the canonical spelling noted on stderr. */
export async function open(app: App, command: string, typed: string): Promise<{ entry: ProviderEntry; timeoutMs: number }> {
  const entry = await resolveEntry(app, typed);
  noteCanonical(app, [command, typed], [command, entry.name]);
  return { entry, timeoutMs: app.options.timeoutMs ?? entry.server.timeout * 1000 };
}

/**
 * A raw MCP result with this process's credentials replaced field by field, keeping the protocol's own
 * fields (`role`, `mimeType`, …) intact. The daemon has done the same for the credentials it holds.
 */
export const safe = <T>(app: App, value: T): T => redactProtocol(value, app.redact) as T;

/**
 * Render `result` (built from a result that went through `safe`) as a tool result is rendered and
 * print it; the exit code of the command.
 */
export async function print(app: App, entry: ProviderEntry, ref: string, started: number, result: ToolResult, refWords?: readonly string[]): Promise<number> {
  const config = await app.config();
  const { server } = entry;
  const rendered = await renderToolResult(
    result,
    renderOptions({
      format: app.options.format,
      full: app.options.full,
      budget: server.budget ?? config.output.budget,
      cellWidth: config.output.cellWidth,
      noise: defaultNoise(server.noise),
      secrets: app.secrets(),
      redacted: true,
    }),
    { ref, ...(refWords ? { refWords } : {}), elapsedMs: app.io.now() - started, media: new FileMediaSink(join(app.cacheDir, 'media')), cursors: (await app.backend()).cursors(), now: app.io.now },
  );
  app.out(rendered.stdout);
  app.err(rendered.stderr);
  return rendered.exitCode;
}

export const noOptions = (command: string, argv: readonly string[]): void => {
  const flag = argv.find((a) => a.startsWith('-'));
  if (flag !== undefined) throw usageFailure(`via ${command}: unknown option ${visibleText(flag)}`, `via ${command} -h`);
};

/** `via resources <provider>` */
export async function resourcesCommand(app: App, argv: readonly string[]): Promise<number> {
  if (app.options.complete !== undefined) return completeTemplate(app, argv);
  noOptions('resources', argv);
  if (argv.length !== 1) throw usageFailure('usage: via resources <provider>', 'via resources -h');
  const { entry, timeoutMs } = await open(app, 'resources', argv[0]!);
  const started = app.io.now();
  const listing = await (await app.backend()).listResources(entry.server.name, { timeoutMs });
  return print(app, entry, `resources ${entry.name}`, started, resourceListing(safe(app, listing), entry.name, app.options.format));
}

/** `via resources <provider> <template> [--var value…] --complete <var>` (cli.md, "补全"). */
async function completeTemplate(app: App, argv: readonly string[]): Promise<number> {
  const [typed, uriTemplate, ...rest] = argv;
  const usage = 'usage: via resources <provider> <uri-template> [--<variable> <value>…] --complete <variable>';
  if (typed === undefined || typed.startsWith('-') || uriTemplate === undefined || uriTemplate.startsWith('-')) throw usageFailure(usage, 'via resources -h');
  const { entry, timeoutMs } = await open(app, 'resources', typed);
  const backend = await app.backend();
  const started = app.io.now();
  const { templates } = await backend.listResources(entry.server.name, { timeoutMs });
  const template = templates.find((t) => t.uriTemplate === uriTemplate);
  if (!template) {
    const info = notFoundError('resource template', uriTemplate, [], uriTemplate);
    info.next = `via resources ${shellWords(entry.name)}`;
    throw new CliFailure(info);
  }
  return completeArgument(app, entry, { tool: templateTool(template), ref: `resources ${entry.name}`, refWords: ['resources', entry.name], rest, completionRef: { type: 'ref/resource', uri: template.uriTemplate }, timeoutMs, started, what: 'resource template' });
}

/** Parse the `--var value` pairs as context, take the typed value of the argument being completed, ask the server and print its suggestions. */
async function completeArgument(
  app: App,
  entry: ProviderEntry,
  job: { tool: McpTool; ref: string; refWords: readonly string[]; rest: readonly string[]; completionRef: CompletionRef; timeoutMs: number; started: number; what: string },
): Promise<number> {
  const name = app.options.complete!;
  const properties = job.tool.inputSchema?.properties ?? {};
  if (!Object.hasOwn(properties, name)) {
    const names = Object.keys(properties);
    throw new CliFailure({
      code: ExitCode.Usage,
      message: `${visibleText(job.what)} has no argument ${visibleText(name)}`,
      lines: names.length > 0 ? [`arguments: ${names.map((n) => shellArg(n, { placeholder: 'name' })).join(' · ')}`] : [],
      next: `via ${job.refWords.map((w) => shellWords(w)).join(' ')} -h`,
    });
  }
  const ctx = { provider: entry.name, ref: job.ref, refWords: job.refWords, rawName: job.tool.name, readOnly: true, destructive: false };
  const parsed = await parseToolArgs(job.rest, job.tool, ctx, { io: argsIo(app), validate: false, redact: app.redact, compile: app.compile });
  const strings = Object.fromEntries(Object.entries(parsed.args).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  const value = strings[name] ?? '';
  const context = Object.fromEntries(Object.entries(strings).filter(([key]) => key !== name));
  const result = await (await app.backend()).complete(entry.server.name, job.completionRef, { name, value }, Object.keys(context).length > 0 ? context : undefined, { timeoutMs: job.timeoutMs });
  return print(app, entry, job.ref, job.started, completionResult(safe(app, result), app.options.format), job.refWords);
}

/** `via read <provider> <uri>` */
export async function readCommand(app: App, argv: readonly string[]): Promise<number> {
  noOptions('read', argv);
  if (argv.length !== 2) throw usageFailure('usage: via read <provider> <uri>', 'via read -h');
  const { entry, timeoutMs } = await open(app, 'read', argv[0]!);
  const started = app.io.now();
  const result = await (await app.backend()).readResource(entry.server.name, argv[1]!, { timeoutMs });
  return print(app, entry, `read ${entry.name}`, started, readResult(safe(app, result)));
}

/** `via prompts <provider>` lists; `via prompts <provider> <name> [args]` gets one. */
export async function promptsCommand(app: App, argv: readonly string[]): Promise<number> {
  const [typed, name, ...rest] = argv;
  if (typed === undefined || typed.startsWith('-')) throw usageFailure('usage: via prompts <provider> [<name> [--arg value…]]', 'via prompts -h');
  if (name === undefined && app.options.complete !== undefined) throw usageFailure('usage: via prompts <provider> <name> [--<argument> <value>…] --complete <argument>', 'via prompts -h');
  const { entry, timeoutMs } = await open(app, 'prompts', typed);
  const backend = await app.backend();
  const started = app.io.now();
  const prompts = await backend.listPrompts(entry.server.name, { timeoutMs });
  if (name === undefined) {
    return print(app, entry, `prompts ${entry.name}`, started, promptListing(safe(app, prompts), entry.name, app.options.format));
  }

  const prompt = findPrompt(prompts, name, entry.name);
  const tool = promptTool(prompt);
  const ref = `prompts ${entry.name} ${prompt.name}`;
  const refWords = ['prompts', entry.name, prompt.name];
  const ctx = { provider: entry.name, ref, refWords, rawName: prompt.name, readOnly: true, destructive: false };
  if (app.options.help) {
    // The last line of a tool's help (alias, read-only, destructive) means nothing for a prompt.
    const hint = prompt.arguments?.length && (await app.cache()).read(entry.server)?.features?.completions ? 'complete: --complete <argument> lists the values the server suggests for it\n' : '';
    app.out(`${formatToolHelp(tool, ctx).split('\n').slice(0, -1).join('\n')}\n${hint}`);
    return ExitCode.Ok;
  }
  if (app.options.complete !== undefined) return completeArgument(app, entry, { tool, ref, refWords, rest, completionRef: { type: 'ref/prompt', name: prompt.name }, timeoutMs, started, what: `prompt ${prompt.name}` });
  const parsed = await parseToolArgs(rest, tool, ctx, { io: argsIo(app), validate: !app.options.noValidate, redact: app.redact, compile: app.compile });
  for (const warning of parsed.warnings) app.err(`warning: ${await app.redactText(warning)}\n`);
  // Prompt arguments are strings; with --no-validate other JSON may have slipped through.
  const args = Object.fromEntries(Object.entries(parsed.args).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  const result = await backend.getPrompt(entry.server.name, prompt.name, args, { timeoutMs });
  return print(app, entry, ref, started, promptResult(safe(app, result), app.options.format), refWords);
}

/** The prompt `input` names: the name as listed, else the same name leniently written, else a unique prefix. */
function findPrompt(prompts: readonly McpPrompt[], input: string, provider: string): McpPrompt {
  const wanted = normalizeInput(input);
  const exact = prompts.find((p) => p.name === input) ?? prompts.find((p) => normalizeInput(p.name) === wanted);
  if (exact) return exact;
  const prefixed = prompts.filter((p) => normalizeInput(p.name).startsWith(wanted));
  if (prefixed.length === 1) return prefixed[0]!;
  if (prefixed.length > 1) {
    const names = prefixed.map((p) => p.name);
    const commands = names.map((n) => shellWords(['prompts', provider, n]));
    throw new CliFailure({ code: ExitCode.NotFound, message: `ambiguous prompt: ${visibleText(input)}`, lines: [`candidates: ${names.map((n) => shellArg(n, { placeholder: 'name' })).join(' · ')}`], next: `via ${commands[0]} -h` });
  }
  const suggestions = didYouMean(wanted, prompts.map((p) => normalizeInput(p.name)))
    .map((n) => prompts.find((p) => normalizeInput(p.name) === n)!.name)
    .map((n) => ['prompts', provider, n]);
  const info = notFoundError('prompt', input, suggestions, input);
  if (suggestions.length === 0) info.next = `via prompts ${shellWords(provider)}`;
  throw new CliFailure(info);
}
