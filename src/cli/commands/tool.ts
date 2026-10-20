// Calling a tool (arguments.md, "校验与报错", "危险操作", "调用过程"; output.md): local checks,
// the call itself, and the render pipeline for the result. `executeCall` is the one call path:
// `via <provider> …`, `via call` and `via batch` all end up here.
import { readFile } from 'node:fs/promises';
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
import { fail } from '../failure';

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

function argsIo(app: App): ToolArgsIO {
  return {
    readFile: (path) => {
      const expanded = path === '~' || path.startsWith('~/') ? join(app.io.home, path.slice(1)) : path;
      return readFile(isAbsolute(expanded) ? expanded : resolve(app.io.cwd, expanded), 'utf8');
    },
    readStdin: () => app.io.readStdin(),
  };
}

const withNewline = (s: string): string => (s.endsWith('\n') ? s : `${s}\n`);

/** `via <provider> <resource>:<verb> -h` */
export function showToolHelp(app: App, target: ToolTarget): number {
  app.out(withNewline(formatToolHelp(target.tool.def, argsContext(target.tool))));
  return ExitCode.Ok;
}

/** `via <provider> <resource>:<verb> [args]`: parse the command-line arguments, run the call, print the outcome. */
export async function callTool(app: App, initial: ToolTarget, argv: readonly string[]): Promise<number> {
  const outcome = await executeCall(
    app,
    {
      target: initial,
      parseArgs: (tool) =>
        parseToolArgs(argv, tool.def, argsContext(tool), { io: argsIo(app), validate: !app.options.noValidate, redact: app.redact, compile: app.compile }),
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
  try {
    return await attemptCall(app, request, sink, warnings);
  } catch (error) {
    const info = await toErrorInfo(error);
    return { exitCode: info.code, stdout: '', stderr: await app.redactText(formatError(info, app.options.format, app.redact)), warnings, error: info };
  }
}

async function attemptCall(app: App, request: CallRequest, sink: CallSink, warnings: string[]): Promise<CallOutcome> {
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
    return { exitCode: ExitCode.Ok, stdout: await app.redactText(renderDryRun(app, target, parsed.args, needsConfirm)), stderr: '', warnings };
  }

  // 3. Dangerous tools need --yes (the deny check already happened during resolution).
  if (needsConfirm) {
    throw fail(ExitCode.Denied, `${tool.ref} is destructive and was not run`, request.confirmNext ?? 'rerun with --yes to confirm');
  }
  if (matchingDeny(tool, config.deny)) throw fail(ExitCode.Denied, `${tool.ref} is denied by a deny rule`, `via ${tool.provider}`);

  // 4. Call.
  const client = await app.client();
  const started = app.io.now();
  let result: ToolResult;
  try {
    result = await client.callTool(server.name, tool.rawName, parsed.args, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      retry: tool.readOnly,
      onProgress: (p) => sink.progress(app.redact(`progress: ${p.total !== undefined ? `${p.progress}/${p.total}` : String(p.progress)}${p.message ? ` ${sanitizeText(p.message)}` : ''}\n`)),
    });
  } catch (error) {
    // The server rejected the arguments at the protocol level: same report as an `isError` result.
    if (error instanceof ClientError && error.exitCode === ExitCode.ToolError) {
      const info: ErrorInfo = { code: ExitCode.ToolError, message: error.message, next: `via ${tool.ref} -h` };
      const text = await app.redactText(formatError(info, options.format, app.redact));
      return { exitCode: ExitCode.ToolError, stdout: '', stderr: addDisagreeHint(text, options.format, error.message), warnings, error: info };
    }
    throw error;
  }
  const elapsedMs = app.io.now() - started;

  // 5. Render.
  const outputWarnings: string[] = [];
  if (tool.def.outputSchema && result.structuredContent !== undefined && !result.isError) {
    outputWarnings.push(...(await validateOutput(tool.def, result.structuredContent, app.compile)).map((w) => app.redact(w)));
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
      flags: [...(parsed.validated ? [] : ['unvalidated']), ...(request.flags ?? [])],
      warnings: outputWarnings,
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
