// `via resources <provider>`, `via read <provider> <uri>`, `via prompts <provider> [<name> [args]]`
// (cli.md; ADR 0010). They share the provider resolution and the render pipeline with tool calls;
// the requests go through `app.backend()`, so the daemon and the in-process path behave the same.
import { join } from 'node:path';
import { didYouMean, normalizeInput } from '../../catalog';
import type { McpPrompt } from '../../protocol';
import { notFoundError } from '../../render/errors';
import { ExitCode } from '../../render/exit-codes';
import { FileMediaSink } from '../../render/media';
import { renderOptions, renderToolResult } from '../../render/pipeline';
import { defaultNoise } from '../../render/rules';
import type { ToolResult } from '../../render/types';
import { formatToolHelp, parseToolArgs } from '../args';
import type { App } from '../app';
import type { ProviderEntry } from '../directory';
import { CliFailure, usageFailure } from '../failure';
import { promptListing, promptResult, promptTool, readResult, resourceListing } from '../mcp-data';
import { noteCanonical, resolveEntry } from '../target';
import { argsIo } from './tool';

/** The provider the first argument names, with the canonical spelling noted on stderr. */
async function open(app: App, command: string, typed: string): Promise<{ entry: ProviderEntry; timeoutMs: number }> {
  const entry = await resolveEntry(app, typed);
  noteCanonical(app, [command, typed], [command, entry.name]);
  return { entry, timeoutMs: app.options.timeoutMs ?? entry.server.timeout * 1000 };
}

/** Render `result` as a tool result is rendered and print it; the exit code of the command. */
async function print(app: App, entry: ProviderEntry, ref: string, started: number, result: ToolResult): Promise<number> {
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
    }),
    { ref, elapsedMs: app.io.now() - started, media: new FileMediaSink(join(app.cacheDir, 'media')), cursors: (await app.backend()).cursors(), now: app.io.now },
  );
  app.out(rendered.stdout);
  app.err(rendered.stderr);
  return rendered.exitCode;
}

const noOptions = (command: string, argv: readonly string[]): void => {
  const flag = argv.find((a) => a.startsWith('-'));
  if (flag !== undefined) throw usageFailure(`via ${command}: unknown option ${flag}`, `via ${command} -h`);
};

/** `via resources <provider>` */
export async function resourcesCommand(app: App, argv: readonly string[]): Promise<number> {
  noOptions('resources', argv);
  if (argv.length !== 1) throw usageFailure('usage: via resources <provider>', 'via resources -h');
  const { entry, timeoutMs } = await open(app, 'resources', argv[0]!);
  const started = app.io.now();
  const listing = await (await app.backend()).listResources(entry.server.name, { timeoutMs });
  return print(app, entry, `resources ${entry.name}`, started, resourceListing(listing, entry.name, app.options.format));
}

/** `via read <provider> <uri>` */
export async function readCommand(app: App, argv: readonly string[]): Promise<number> {
  noOptions('read', argv);
  if (argv.length !== 2) throw usageFailure('usage: via read <provider> <uri>', 'via read -h');
  const { entry, timeoutMs } = await open(app, 'read', argv[0]!);
  const started = app.io.now();
  const result = await (await app.backend()).readResource(entry.server.name, argv[1]!, { timeoutMs });
  return print(app, entry, `read ${entry.name}`, started, readResult(result));
}

/** `via prompts <provider>` lists; `via prompts <provider> <name> [args]` gets one. */
export async function promptsCommand(app: App, argv: readonly string[]): Promise<number> {
  const [typed, name, ...rest] = argv;
  if (typed === undefined || typed.startsWith('-')) throw usageFailure('usage: via prompts <provider> [<name> [--arg value…]]', 'via prompts -h');
  const { entry, timeoutMs } = await open(app, 'prompts', typed);
  const backend = await app.backend();
  const started = app.io.now();
  const prompts = await backend.listPrompts(entry.server.name, { timeoutMs });
  if (name === undefined) {
    return print(app, entry, `prompts ${entry.name}`, started, promptListing(prompts, entry.name, app.options.format));
  }

  const prompt = findPrompt(prompts, name, entry.name);
  const tool = promptTool(prompt);
  const ref = `prompts ${entry.name} ${prompt.name}`;
  const ctx = { provider: entry.name, ref, rawName: prompt.name, readOnly: true, destructive: false };
  if (app.options.help) {
    // The last line of a tool's help (alias, read-only, destructive) means nothing for a prompt.
    app.out(`${formatToolHelp(tool, ctx).split('\n').slice(0, -1).join('\n')}\n`);
    return ExitCode.Ok;
  }
  const parsed = await parseToolArgs(rest, tool, ctx, { io: argsIo(app), validate: !app.options.noValidate, redact: app.redact, compile: app.compile });
  for (const warning of parsed.warnings) app.err(`warning: ${await app.redactText(warning)}\n`);
  // Prompt arguments are strings; with --no-validate other JSON may have slipped through.
  const args = Object.fromEntries(Object.entries(parsed.args).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  const result = await backend.getPrompt(entry.server.name, prompt.name, args, { timeoutMs });
  return print(app, entry, ref, started, promptResult(result, app.options.format));
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
    throw new CliFailure({ code: ExitCode.NotFound, message: `ambiguous prompt: ${input}`, lines: [`candidates: ${names.join(' · ')}`], next: `via prompts ${provider} ${names[0]} -h` });
  }
  const suggestions = didYouMean(wanted, prompts.map((p) => normalizeInput(p.name)))
    .map((n) => prompts.find((p) => normalizeInput(p.name) === n)!.name)
    .map((n) => `prompts ${provider} ${n}`);
  const info = notFoundError('prompt', input, suggestions, input);
  if (suggestions.length === 0) info.next = `via prompts ${provider}`;
  throw new CliFailure(info);
}
