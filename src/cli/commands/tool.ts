// Calling a tool (arguments.md, "校验与报错", "危险操作", "调用过程"; output.md): local checks,
// the call itself, and the render pipeline for the result.
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { CatalogTool, ProviderCatalog } from '../../catalog';
import { ClientError } from '../../client';
import { FileCursorStore } from '../../render/cursor-file';
import { formatError } from '../../render/errors';
import { ExitCode } from '../../render/exit-codes';
import { FileMediaSink } from '../../render/media';
import { renderOptions, renderToolResult, sanitizeText } from '../../render/pipeline';
import { defaultNoise } from '../../render/rules';
import type { ToolResult } from '../../render/types';
import { formatToolHelp, parseToolArgs, validateOutput, type ParsedToolArgs, type ToolArgsContext, type ToolArgsIO } from '../args';
import type { App, Listing } from '../app';
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

export async function callTool(app: App, initial: ToolTarget, argv: readonly string[]): Promise<number> {
  const { options } = app;
  const config = await app.config();
  const { entry } = initial;
  const { server } = entry;
  let target = initial;

  // 1. Parse and validate. A failure against a schema cached for more than five minutes may only
  // mean the server was upgraded: refresh the list once and try again (arguments.md).
  const parse = (t: CatalogTool): Promise<ParsedToolArgs> =>
    parseToolArgs(argv, t.def, argsContext(t), { io: argsIo(app), validate: !options.noValidate, redact: app.redact });
  let parsed: ParsedToolArgs;
  try {
    parsed = await parse(target.tool);
  } catch (error) {
    if (!(error instanceof Error && error.name === 'ToolArgsError') || app.io.now() - target.listing.fetchedAt <= SCHEMA_STALE_MS) throw error;
    const refreshed = await app.listing(entry, { refresh: true }).catch(() => undefined);
    const fresh = refreshed && (await refreshedTarget(app, target, refreshed));
    if (!fresh || JSON.stringify(fresh.tool.def) === JSON.stringify(target.tool.def)) throw error;
    target = fresh;
    parsed = await parse(target.tool);
  }
  const { tool } = target;
  for (const warning of parsed.warnings) app.err(app.redact(`warning: ${warning}\n`));

  // 2. Dry run: what would be sent, nothing else.
  const needsConfirm = tool.destructive && server.confirm !== 'never' && !options.yes;
  if (options.dryRun) {
    app.out(app.redact(renderDryRun(app, target, parsed.args, needsConfirm)));
    return ExitCode.Ok;
  }

  // 3. Dangerous tools need --yes (the deny check already happened during resolution).
  if (needsConfirm) {
    throw fail(ExitCode.Denied, `${tool.ref} is destructive and was not run`, 'rerun with --yes to confirm');
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
      onProgress: (p) => app.err(app.redact(`progress: ${p.total !== undefined ? `${p.progress}/${p.total}` : String(p.progress)}${p.message ? ` ${sanitizeText(p.message)}` : ''}\n`)),
    });
  } catch (error) {
    // The server rejected the arguments at the protocol level: same report as an `isError` result.
    if (error instanceof ClientError && error.exitCode === ExitCode.ToolError) {
      const text = formatError({ code: ExitCode.ToolError, message: error.message, next: `via ${tool.ref} -h` }, options.format, app.redact);
      app.err(addDisagreeHint(text, options.format, error.message));
      return ExitCode.ToolError;
    }
    throw error;
  }
  const elapsedMs = app.io.now() - started;

  // 5. Render.
  const warnings: string[] = [];
  if (tool.def.outputSchema && result.structuredContent !== undefined && !result.isError) {
    warnings.push(...(await validateOutput(tool.def, result.structuredContent)));
  }
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
      cursors: new FileCursorStore(join(app.cacheDir, 'cursors'), { now: app.io.now }),
      now: app.io.now,
      flags: parsed.validated ? [] : ['unvalidated'],
      warnings: warnings.map((w) => app.redact(w)),
    },
  );
  app.out(rendered.stdout);
  app.err(rendered.exitCode === ExitCode.ToolError ? addDisagreeHint(rendered.stderr, options.format, resultText(result)) : rendered.stderr);
  return rendered.exitCode;
}

/** The same tool in a refreshed list, or undefined when the server no longer has it. */
async function refreshedTarget(app: App, old: ToolTarget, listing: Listing): Promise<ToolTarget | undefined> {
  const views = await app.providerViews(old.entry, listing.tools);
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
