// Calling a tool (arguments.md, "校验与报错", "危险操作", "调用过程"; output.md): local checks,
// the call itself, and the render pipeline for the result. `executeCall` is the one call path:
// `via <provider> …`, `via call` and `via batch` all end up here.
import { readFile } from 'node:fs/promises';
import { decodeText } from '../../platform/text';
import { isAbsolute, join, resolve } from 'node:path';
import type { CatalogTool, ProviderCatalog } from '../../catalog';
import { ClientError } from '../../client/errors';
import { formatError, type ErrorInfo } from '../../render/errors';
import { ExitCode } from '../../render/exit-codes';
import { FileMediaSink } from '../../render/media';
import type { MetaInfo } from '../../render/meta';
import { renderOptions, renderToolResult, sanitizeText } from '../../render/pipeline';
import { defaultNoise } from '../../render/rules';
import type { ToolResult } from '../../render/types';
import { formatToolHelp, parseToolArgs, validateOutput, type ParsedToolArgs, type ToolArgsContext, type ToolArgsIO } from '../args';
import { toErrorInfo, type App, type Listing } from '../app';
import { matchingDeny, type ProviderEntry } from '../directory';
import { shellArg, shellWords, visibleText } from '../../render/shell';
import type { TaskInfo } from '../../protocol';
import { alignRows } from '../../render/width';
import { CliFailure, fail, usageFailure } from '../failure';
import { compareSnapshot, readSnapshot, toolDetail, type SchemaChange } from '../args/snapshot';
import { Elicitation } from '../elicit';

/** A cached schema older than this is refreshed once when validation fails (arguments.md, "schema 不可靠时"). */
export const SCHEMA_STALE_MS = 5 * 60 * 1000;

export interface ToolTarget {
  entry: ProviderEntry;
  listing: Listing;
  views: { visible: ProviderCatalog; full: ProviderCatalog };
  tool: CatalogTool;
}

export function argsContext(tool: CatalogTool): ToolArgsContext {
  return { provider: tool.provider, ref: tool.ref, rawName: tool.rawName, readOnly: tool.readOnly, destructive: tool.destructive };
}

export function argsIo(app: App): ToolArgsIO {
  return {
    readFile: (path) => {
      const expanded = path === '~' || path.startsWith('~/') || path.startsWith('~\\') ? join(app.io.home, path.slice(1)) : path;
      return readFile(isAbsolute(expanded) ? expanded : resolve(app.io.cwd, expanded)).then(decodeText);
    },
    readStdin: () => app.io.readStdin(),
  };
}

const withNewline = (s: string): string => (s.endsWith('\n') ? s : `${s}\n`);

/**
 * `via <provider> <resource>:<verb> -h`; with `-o json` the tool detail (`ref`, `rawName`, both
 * schemas), which is also the file `--schema-snapshot` reads back (arguments.md, "schema 快照校验").
 */
export async function showToolHelp(app: App, initial: ToolTarget): Promise<number> {
  const target = await checkSchemaSnapshot(app, initial);
  if (app.options.format === 'json') {
    const { tool } = target;
    const detail = toolDetail(tool.def, tool.ref, { readOnly: tool.readOnly, destructive: tool.destructive });
    app.out(`${JSON.stringify(await app.redactValue(detail), null, 2)}\n`);
    return ExitCode.Ok;
  }
  app.out(withNewline(formatToolHelp(target.tool.def, argsContext(target.tool))));
  return ExitCode.Ok;
}

// Schema snapshot -----------------------------------------------------------------------------

/** The changes listed in the error and in the compatible-change warning. */
const CHANGES_SHOWN = 8;

async function loadSnapshot(app: App, file: string, tool: CatalogTool) {
  const shown = visibleText(file);
  let text: string;
  try {
    text = await argsIo(app).readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw usageFailure(`--schema-snapshot cannot read ${shown}: ${code === 'ENOENT' ? 'no such file' : code === 'EISDIR' ? 'it is a directory' : visibleText(String((error as Error).message).split('\n')[0]!.slice(0, 120))}`, `via ${shellWords(tool.ref)} -h -o json`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw usageFailure(`--schema-snapshot ${shown} is not JSON: ${visibleText((error as Error).message.slice(0, 120))}`, `via ${shellWords(tool.ref)} -h -o json`);
  }
  const snapshot = readSnapshot(value);
  if (typeof snapshot === 'string') throw usageFailure(`--schema-snapshot ${shown} is not a tool snapshot: ${snapshot}`, `via ${shellWords(tool.ref)} -h -o json`);
  if (snapshot.rawName !== undefined && snapshot.rawName !== tool.rawName) {
    throw usageFailure(`--schema-snapshot ${shown} is the snapshot of ${visibleText(snapshot.rawName.slice(0, 80))}, not of ${tool.ref}`, `via ${shellWords(tool.ref)} -h -o json`);
  }
  return snapshot;
}

/**
 * `--schema-snapshot <file>`: compare the tool's schemas with the saved ones before the call is sent
 * or the usage shown. A cached tool list older than five minutes is refreshed first, since the point
 * is to see what the server offers now. Returns the target to use (the refreshed one when the list
 * was fetched); throws exit code 2 when the tool no longer fits the snapshot.
 */
export async function checkSchemaSnapshot(app: App, target: ToolTarget): Promise<ToolTarget> {
  const file = app.options.schemaSnapshot;
  if (file === undefined) return target;
  const snapshot = await loadSnapshot(app, file, target.tool);
  let current = target;
  if (app.io.now() - target.listing.fetchedAt > SCHEMA_STALE_MS) {
    const listing = await app.listing(target.entry, { refresh: true }).catch(() => undefined);
    if (listing === undefined) {
      app.err(`warning: could not refresh the tool list of ${target.entry.name}; the snapshot was compared with the cached schema\n`);
    } else {
      const fresh = await refreshedTarget(app, target, listing);
      if (!fresh) throw fail(ExitCode.NotFound, `${target.tool.ref} is no longer offered by ${target.entry.name}`, `via ${shellWords(target.tool.provider)}`);
      current = fresh;
    }
  }
  const { tool } = current;
  const changes = compareSnapshot(snapshot, tool.def, app.options.schemaMode);
  const breaking = changes.filter((c) => c.breaking);
  if (breaking.length > 0) throw new CliFailure(snapshotError(tool.ref, visibleText(file), app.options.schemaMode, breaking, changes.length - breaking.length));
  if (changes.length > 0) {
    const listed = changes.slice(0, 3).map((c) => `${c.path || c.side} ${c.message}`);
    app.err(await app.redactText(`warning: ${tool.ref} changed compatibly since the snapshot: ${listed.join('; ')}${changes.length > 3 ? `; … ${changes.length - 3} more` : ''}\n`));
  }
  return current;
}

function snapshotError(ref: string, file: string, mode: string, breaking: readonly SchemaChange[], compatible: number): ErrorInfo {
  const rows = breaking.slice(0, CHANGES_SHOWN).map((c) => [`  ${c.side}`, c.path || '(schema)', c.message]);
  const lines = alignRows(rows, 2);
  if (breaking.length > CHANGES_SHOWN) lines.push(`  … ${breaking.length - CHANGES_SHOWN} more`);
  if (compatible > 0) lines.push(`  (${compatible} more change${compatible === 1 ? '' : 's'} that ${compatible === 1 ? 'is' : 'are'} compatible)`);
  return {
    code: ExitCode.Usage,
    message: `${ref}: ${breaking.length} breaking change${breaking.length === 1 ? '' : 's'} against ${file} (${mode}); nothing was sent`,
    lines,
    next: `via ${shellWords(ref)} -h -o json`,
    details: breaking.map((c) => ({ side: c.side, path: c.path, rule: c.kind, message: c.message })),
  };
}

/** `via <provider> <resource>:<verb> [args]`: parse the command-line arguments, run the call, print the outcome. */
export async function callTool(app: App, initial: ToolTarget, argv: readonly string[]): Promise<number> {
  const target = await checkSchemaSnapshot(app, initial);
  const outcome = await executeCall(
    app,
    {
      target,
      parseArgs: (tool) =>
        parseToolArgs(argv, tool.def, argsContext(tool), { io: argsIo(app), validate: !app.options.noValidate, redact: app.redact, compile: app.compile }),
      rerun: rerunCommand(app, target.tool.ref, argv),
    },
    { progress: (text) => app.err(text), warning: (text) => app.err(text) },
  );
  app.out(outcome.stdout);
  app.err(outcome.stderr);
  return outcome.exitCode;
}

// The shared call path ----------------------------------------------------------------------

/** What to run: a resolved tool and how to get its validated arguments. */
export interface CallRequest {
  target: ToolTarget;
  /**
   * Produces the validated arguments for `tool`. Called again with the refreshed definition when
   * validation failed against an old schema, so it must be repeatable.
   */
  parseArgs(tool: CatalogTool): Promise<ParsedToolArgs>;
  /** Extra markers for the meta line (`via batch` adds `line N`). */
  flags?: readonly string[];
  /** Replaces the `next:` of the missing-`--yes` refusal, for callers where "rerun" needs other advice. */
  confirmNext?: string;
  /** Re-fetches a provider's tool list after a failed validation; undefined when that is not possible. */
  refreshListing?: (entry: ProviderEntry) => Promise<Listing | undefined>;
  /** Whether a server's question can be put to a person; default: this process has a terminal (`via batch` says no). */
  interactive?: boolean;
  /** The command a person could run in a terminal to answer a server's question, for `next:`; absent when there is none to give. */
  rerun?: string;
}

/** Where output that happens during the call goes, as it happens (whole stderr lines, newline included). */
export interface CallSink {
  progress(text: string): void;
  warning(text: string): void;
}

export interface CallOutcome {
  exitCode: ExitCode;
  stdout: string;
  /** The meta line (with output warnings) or the error report; progress and parse warnings went to the sink. */
  stderr: string;
  /** Every warning of the call, redacted, without the `warning: ` prefix. */
  warnings: string[];
  /** The numbers behind the meta line, on a rendered success. */
  meta?: MetaInfo;
  /** The failure, structured; `stderr` is its text form. */
  error?: ErrorInfo;
}

/**
 * Run one resolved call: validate, dry-run or confirm, call, render (arguments.md, "调用过程").
 * A failed call does not throw: it comes back as an outcome with its exit code, and the caller
 * decides how to print it. The tool is reached only through `app.client()`, the one place that
 * knows whether the connection is in-process or a daemon.
 */
export async function executeCall(app: App, request: CallRequest, sink: CallSink): Promise<CallOutcome> {
  const warnings: string[] = [];
  // A server may ask the person for input in the middle of the call; with nobody to ask, the outcome says so (ADR 0018).
  const elicitation = new Elicitation(app, { interactive: () => request.interactive ?? app.io.interactive, ...(request.rerun !== undefined ? { rerun: request.rerun } : {}) });
  try {
    return await elicitation.apply(await attemptCall(app, request, sink, warnings, elicitation));
  } catch (error) {
    const info = await toErrorInfo(error);
    return elicitation.apply({ exitCode: info.code, stdout: '', stderr: await app.redactText(formatError(info, app.options.format, app.redact)), warnings, error: info });
  }
}

/** `via <ref> <arguments>` as a person would paste it, or undefined when the arguments cannot be given again (read from stdin). */
function rerunCommand(app: App, ref: string, argv: readonly string[]): string | undefined {
  if (argv.includes('-')) return undefined;
  const words = argv.map((word) => shellArg(word, { placeholder: 'value' }));
  return ['via', shellWords(ref), ...words, ...(app.options.yes ? ['--yes'] : [])].join(' ');
}

async function attemptCall(app: App, request: CallRequest, sink: CallSink, warnings: string[], elicitation: Elicitation): Promise<CallOutcome> {
  const { options } = app;
  const config = await app.config();
  const { entry } = request.target;
  const { server } = entry;
  let target = request.target;

  // 1. Parse and validate. A failure against a schema cached for more than five minutes may only
  // mean the server was upgraded: refresh the list once and try again (arguments.md).
  let parsed: ParsedToolArgs;
  try {
    parsed = await request.parseArgs(target.tool);
  } catch (error) {
    if (!(error instanceof Error && error.name === 'ToolArgsError') || app.io.now() - target.listing.fetchedAt <= SCHEMA_STALE_MS) throw error;
    const refresh = request.refreshListing ?? ((e: ProviderEntry) => app.listing(e, { refresh: true }).catch(() => undefined));
    const refreshed = await refresh(entry);
    const fresh = refreshed && (await refreshedTarget(app, target, refreshed));
    if (!fresh || JSON.stringify(fresh.tool.def) === JSON.stringify(target.tool.def)) throw error;
    target = fresh;
    parsed = await request.parseArgs(target.tool);
  }
  const { tool } = target;
  for (const warning of parsed.warnings) {
    const redacted = await app.redactText(warning);
    warnings.push(redacted);
    sink.warning(`warning: ${redacted}\n`);
  }

  // 2. Dry run: what would be sent, nothing else.
  const needsConfirm = tool.destructive && server.confirm !== 'never' && !options.yes;
  if (options.dryRun) {
    return { exitCode: ExitCode.Ok, stdout: await app.redactText(renderDryRun(app, target, await app.redactValue(parsed.args), needsConfirm)), stderr: '', warnings };
  }

  // 3. Dangerous tools need --yes (the deny check already happened during resolution).
  if (needsConfirm) {
    throw fail(ExitCode.Denied, `${tool.ref} is destructive and was not run`, request.confirmNext ?? 'rerun with --yes to confirm');
  }
  if (matchingDeny(tool, config.deny)) throw fail(ExitCode.Denied, `${tool.ref} is denied by a deny rule`, `via ${shellWords(tool.provider)}`);

  // 4. Call.
  const client = await app.client();
  const started = app.io.now();
  let result: ToolResult;
  let task: TaskInfo | undefined;
  // A call that became a task is recorded the moment it exists and named on stderr, so an interrupted run can be continued (cli.md, "任务").
  const flags: string[] = [];
  const callOptions = {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    retry: tool.readOnly,
    elicit: elicitation.sink,
    taskSupport: typeof tool.def.execution?.taskSupport === 'string' ? tool.def.execution.taskSupport : 'forbidden',
    onProgress: (p: { progress: number; total?: number; message?: string }) =>
      sink.progress(`progress: ${p.total !== undefined ? `${p.progress}/${p.total}` : String(p.progress)}${p.message ? ` ${app.redact(sanitizeText(p.message))}` : ''}\n`),
    onTask: (made: TaskInfo) => {
      task = made;
      records.put(server, { id: made.id, tool: tool.ref, createdAt: app.io.now(), status: made.status });
      sink.progress(`progress: task ${app.redact.scan(visibleText(`${entry.name}/${made.id}`))} ${visibleText(made.status)}\n`);
    },
  };
  let nextHint: string | undefined;
  const records = await app.taskRecords();
  try {
    if (options.detach) {
      const detached = await client.detachTool(server.name, tool.rawName, parsed.args, callOptions);
      if ('task' in detached) {
        const made = detached.task;
        nextHint = `via ${shellWords(['tasks', entry.name, made.id])}`;
        result = { content: [], structuredContent: { task: `${entry.name}/${made.id}`, status: made.status, ...(made.message ? { message: made.message } : {}) } };
      } else {
        // The server answered at once: nothing is left to detach from.
        flags.push('no task');
        result = detached.result;
      }
    } else {
      result = await client.callTool(server.name, tool.rawName, parsed.args, callOptions);
      if (task) records.put(server, { id: (task as TaskInfo).id, tool: tool.ref, createdAt: app.io.now(), status: result.isError ? 'failed' : 'completed' });
    }
  } catch (error) {
    // The server rejected the arguments at the protocol level: same report as an `isError` result. (Not the errors
    // that stop following a task: those have their own `next:`.)
    if (error instanceof ClientError && error.exitCode === ExitCode.ToolError && error.kind !== 'task') {
      const info: ErrorInfo = { code: ExitCode.ToolError, message: error.message, next: `via ${shellWords(tool.ref)} -h` };
      const text = await app.redactText(formatError(info, options.format, app.redact));
      return { exitCode: ExitCode.ToolError, stdout: '', stderr: addDisagreeHint(text, options.format, error.message), warnings, error: info };
    }
    throw error;
  }
  const elapsedMs = app.io.now() - started;

  // 5. Render.
  const outputWarnings: string[] = [];
  if (tool.def.outputSchema && result.structuredContent !== undefined && !result.isError) {
    outputWarnings.push(...(await validateOutput(tool.def, result.structuredContent, app.compile)).map((w) => app.redact.scan(w)));
  }
  warnings.push(...outputWarnings);
  const rendered = await renderToolResult(
    result,
    renderOptions({
      format: options.format,
      full: options.full,
      budget: server.budget ?? config.output.budget,
      cellWidth: config.output.cellWidth,
      noise: defaultNoise(server.noise),
      secrets: app.secrets(),
    }),
    {
      ref: tool.ref,
      elapsedMs,
      media: new FileMediaSink(join(app.cacheDir, 'media')),
      cursors: (await app.backend()).cursors(),
      now: app.io.now,
      flags: [...(parsed.validated ? [] : ['unvalidated']), ...flags, ...(request.flags ?? [])],
      warnings: outputWarnings,
      ...(nextHint ? { next: nextHint } : {}),
    },
  );
  const outcome: CallOutcome = {
    exitCode: rendered.exitCode,
    stdout: rendered.stdout,
    stderr: rendered.exitCode === ExitCode.ToolError ? addDisagreeHint(rendered.stderr, options.format, resultText(result)) : rendered.stderr,
    warnings,
  };
  if (rendered.meta) outcome.meta = rendered.meta;
  if (rendered.error) outcome.error = rendered.error;
  return outcome;
}

/** The same tool in a refreshed list, or undefined when the server no longer has it. */
async function refreshedTarget(app: App, old: ToolTarget, listing: Listing): Promise<ToolTarget | undefined> {
  const views = await app.providerViews(old.entry, listing);
  const tool = views.visible.tools.find((t) => t.rawName === old.tool.rawName);
  return tool ? { entry: old.entry, listing, views, tool } : undefined;
}

// Upstream argument errors ------------------------------------------------------------------

function resultText(result: ToolResult): string {
  return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

const ARGUMENT_ERROR = /\b(invalid (arguments?|params?|parameters?|input)|missing (required )?(arguments?|params?|parameters?|fields?)|validation|required|expected|must be|unrecognized|unknown (argument|parameter|field))\b/i;

/**
 * Local validation passed but the server complained about the arguments: say which side to doubt
 * (arguments.md, "schema 不可靠时"). Text mode only; the error JSON has a fixed shape.
 */
function addDisagreeHint(stderr: string, format: string, upstreamText: string): string {
  if (format === 'json' || !ARGUMENT_ERROR.test(upstreamText)) return stderr;
  const hint = 'note: the local schema accepted these arguments but the server rejected them; the tool schema and the server disagree (try --no-validate to rule the schema out)\n';
  const lines = stderr.split('\n');
  const nextAt = lines.findIndex((l) => l.startsWith('next: '));
  if (nextAt < 0) return `${stderr}${hint}`;
  lines.splice(nextAt, 0, hint.trimEnd());
  return lines.join('\n');
}

// Dry run -----------------------------------------------------------------------------------

function renderDryRun(app: App, target: ToolTarget, args: Record<string, unknown>, needsConfirm: boolean): string {
  const { tool, entry } = target;
  const { transport } = entry.server;
  // Scheme and host only: a URL's path and query may carry credentials (output.md, "错误").
  let where: string;
  if (transport.type === 'http') {
    try {
      where = `http ${new URL(transport.url).origin}`;
    } catch {
      where = 'http';
    }
  } else {
    where = `stdio ${transport.command}`;
  }
  if (app.options.format === 'json') {
    return `${JSON.stringify({ dryRun: true, tool: tool.ref, rawName: tool.rawName, server: entry.server.name, transport: where, args, ...(needsConfirm ? { requires: '--yes' } : {}) }, null, 2)}\n`;
  }
  const lines = ['dry run: nothing was sent', `tool: ${tool.ref}`, `raw name: ${tool.rawName}`, `server: ${entry.server.name} (${where})`];
  if (needsConfirm) lines.push('requires: --yes (destructive tool)');
  const keys = Object.keys(args);
  if (keys.length === 0) lines.push('args: {}');
  else lines.push('args:', ...JSON.stringify(args, null, 2).split('\n').map((l) => `  ${l}`));
  return `${lines.join('\n')}\n`;
}
