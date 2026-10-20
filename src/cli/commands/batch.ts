// `via batch` (cli.md, "via batch"): JSONL on stdin, one call per line, run concurrently, results
// printed in input order. Every line goes through the same call path as `via call` (`executeCall`);
// this module only parses lines, resolves them, schedules them and frames the output.
import { Limiter } from '../../client/limiter';
import { errorEnvelope, formatError, type ErrorInfo } from '../../render/errors';
import { ExitCode } from '../../render/exit-codes';
import { formatElapsed } from '../../render/meta';
import type { CatalogTool } from '../../catalog';
import { toErrorInfo, type App, type Listing } from '../app';
import { parseToolArgs, type ParsedToolArgs } from '../args';
import { parseJson } from '../args/json';
import type { ProviderEntry } from '../directory';
import { fail, usageFailure } from '../failure';
import { COMMAND_USAGE } from '../help';
import { parseLocal } from '../options';
import { resolveEntry } from '../target';
import { resolveToolRef, splitToolRef, type OpenProvider } from './provider';
import { argsContext, executeCall, type CallOutcome, type ToolTarget } from './tool';

/** Lines in flight at once, across all servers; each server's own `concurrency` still applies on top. */
export const DEFAULT_BATCH_CONCURRENCY = 16;

/** One non-blank input line and its 1-based position in the input. */
interface InputLine {
  line: number;
  text: string;
}

/** What one line produced, ready to print: progress and warnings, then the data, then the meta line or error. */
interface Finished {
  before: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function batchCommand(app: App, argv: readonly string[]): Promise<number> {
  const { flags, positionals } = parseLocal('batch', argv, [{ name: 'concurrency', value: true }]);
  if (positionals.length > 0) throw usageFailure(COMMAND_USAGE.batch!, 'via batch -h');
  const concurrency = parseConcurrency(flags.concurrency);

  const lines = splitLines(await app.io.readStdin());
  if (lines.length === 0) {
    throw fail(ExitCode.Usage, 'no calls on stdin', 'via batch -h', ['expected one JSON object per line, for example {"tool":"gh/issue:get","args":{"id":1}}']);
  }

  // Everything the lines share is created before any of them starts: the lazily built parts of the
  // app would otherwise be built twice, once by each line that gets there first.
  await app.config();
  await app.table();
  await app.resolver();
  await app.cache();
  await app.client();

  const started = app.io.now();
  const run = new LineRunner(app);
  const limiter = new Limiter(concurrency);
  const finished: Array<Finished | undefined> = [];
  let next = 0;
  let exitCode = 0;
  let failed = 0;

  // Print results strictly in input order, as soon as everything before them is printed.
  const flush = (): void => {
    for (let entry = finished[next]; entry !== undefined; entry = finished[next]) {
      finished[next] = undefined;
      app.err(app.redact(entry.before));
      app.out(app.redact(entry.stdout));
      app.err(app.redact(entry.stderr));
      if (entry.exitCode !== 0) failed += 1;
      exitCode = Math.max(exitCode, entry.exitCode);
      next += 1;
    }
  };
  await Promise.all(
    lines.map((input, index) =>
      limiter.run(async () => {
        finished[index] = await run.line(input);
        flush();
      }),
    ),
  );
  flush();

  const count = lines.length;
  const parts = [`${count} ${count === 1 ? 'call' : 'calls'}`, `${count - failed} ok`];
  if (failed > 0) parts.push(`${failed} failed`);
  app.err(`· batch · ${parts.join(' · ')} · ${formatElapsed(app.io.now() - started)}\n`);
  return exitCode;
}

function parseConcurrency(value: string | true | undefined): number {
  if (value === undefined) return DEFAULT_BATCH_CONCURRENCY;
  const n = Number(value);
  if (typeof value !== 'string' || value.trim() === '' || !Number.isInteger(n) || n < 1) {
    throw usageFailure(`--concurrency must be a positive integer (got ${JSON.stringify(String(value).slice(0, 40))})`, 'via batch -h');
  }
  return n;
}

/** Non-blank lines of the input, numbered by their position (blank lines count, so numbers match the file). */
function splitLines(input: string): InputLine[] {
  const out: InputLine[] = [];
  input
    .replace(/^﻿/, '')
    .split('\n')
    .forEach((raw, index) => {
      const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (text.trim() !== '') out.push({ line: index + 1, text });
    });
  return out;
}

// One line ----------------------------------------------------------------------------------

interface ParsedLine {
  tool: string;
  args: Record<string, unknown>;
}

const LINE_FIELDS = new Set(['tool', 'args']);

/** A line is `{"tool": "<provider>/<ref>", "args": {…}}`; anything else is a usage error for that line. */
function parseLine(text: string): ParsedLine {
  const bad = (message: string): never => {
    throw fail(ExitCode.Usage, message, 'via batch -h');
  };
  const json = parseJson(text);
  if (!json.ok) {
    // Position and the offending character only: the rest of the line may hold a credential.
    const what = json.found === 'end of input' ? 'unexpected end of input' : `unexpected ${json.found}`;
    return bad(`invalid JSON at column ${json.col}: ${what}`);
  }
  const value = json.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return bad('expected a JSON object like {"tool":"<provider>/<resource>:<verb>","args":{…}}');
  }
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (!LINE_FIELDS.has(key)) return bad(`unknown field ${JSON.stringify(key.slice(0, 40))}; a line has "tool" and "args"`);
  }
  if (typeof object.tool !== 'string' || object.tool === '') {
    return bad('"tool" is required: a string like linear/issue:get');
  }
  const args = object.args ?? {};
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return bad('"args" must be a JSON object');
  return { tool: object.tool, args: args as Record<string, unknown> };
}

const NO_FILES = {
  readFile: (): Promise<string> => Promise.reject(new Error('batch arguments are JSON; there are no files to read')),
  readStdin: (): Promise<string> => Promise.reject(new Error('stdin carries the batch itself')),
};

class LineRunner {
  private readonly providers = new Map<string, Promise<OpenProvider>>();
  private readonly refreshes = new Map<string, Promise<Listing | undefined>>();

  constructor(private readonly app: App) {}

  /** Never rejects: whatever goes wrong becomes the result of that line. */
  async line(input: InputLine): Promise<Finished> {
    const { app } = this;
    const json = app.options.format === 'json';
    const buffered: string[] = [];
    let tool: string | undefined;
    let outcome: CallOutcome;
    try {
      const parsed = parseLine(input.text);
      const split = splitToolRef(parsed.tool, 'via batch -h');
      const opened = await this.open(split.provider);
      const target: ToolTarget = resolveToolRef(opened, (await app.config()).deny, parsed.tool, split.target);
      tool = target.tool.singleRef;
      outcome = await executeCall(
        app,
        {
          target,
          parseArgs: (t) => this.parseArgs(t, parsed.args),
          flags: [`line ${input.line}`],
          confirmNext: 'rerun only this line with: via batch --yes',
          refreshListing: (entry) => this.refresh(entry),
        },
        // Output of concurrent lines must not interleave: it waits for the line's turn. In JSON the
        // warnings are fields of the record, so only progress is kept.
        { progress: (text) => buffered.push(text), warning: (text) => json || buffered.push(text) },
      );
    } catch (error) {
      outcome = await failure(app, error);
    }
    return json ? this.asJson(input, tool, outcome, buffered) : this.asText(input, outcome, buffered);
  }

  private asText(input: InputLine, outcome: CallOutcome, buffered: string[]): Finished {
    // The failing line is named in the first line of the report, where an agent will look.
    const stderr = outcome.error ? outcome.stderr.replace(/^error: /, `error: line ${input.line}: `) : outcome.stderr;
    return { before: buffered.join(''), stdout: outcome.stdout, stderr, exitCode: outcome.exitCode };
  }

  /** One record per line: `{line, tool?, ok, exitCode, elapsedMs?, result | error | truncated+next, warnings?}`. */
  private asJson(input: InputLine, tool: string | undefined, outcome: CallOutcome, buffered: string[]): Finished {
    const record: Record<string, unknown> = { line: input.line };
    if (tool !== undefined) record.tool = tool;
    record.ok = outcome.exitCode === 0;
    record.exitCode = outcome.exitCode;
    const { meta } = outcome;
    if (meta) record.elapsedMs = meta.elapsedMs;
    if (outcome.error) {
      record.error = errorEnvelope(outcome.error);
    } else if (meta && meta.bytes.total > meta.bytes.shown) {
      // An over-budget JSON result is cut in the middle: it cannot be a value in a JSONL record.
      record.truncated = true;
      if (meta.next) record.next = meta.next;
    } else {
      record.result = resultValue(outcome.stdout);
    }
    if (meta?.flags?.includes('unvalidated')) record.unvalidated = true;
    if (outcome.warnings.length > 0) record.warnings = outcome.warnings;
    return { before: buffered.join(''), stdout: `${JSON.stringify(record)}\n`, stderr: '', exitCode: outcome.exitCode };
  }

  /** The provider a line names, opened once per batch however many lines use it. */
  private async open(typed: string): Promise<OpenProvider> {
    const entry = await resolveEntry(this.app, typed);
    let opened = this.providers.get(entry.name);
    if (!opened) {
      opened = (async () => {
        const listing = await this.app.listing(entry);
        return { entry, listing, views: await this.app.providerViews(entry, listing) };
      })();
      this.providers.set(entry.name, opened);
    }
    return opened;
  }

  /** The one-time schema refresh (arguments.md) happens once per provider, not once per line. */
  private refresh(entry: ProviderEntry): Promise<Listing | undefined> {
    let refreshed = this.refreshes.get(entry.name);
    if (!refreshed) {
      refreshed = this.app.listing(entry, { refresh: true }).catch(() => undefined);
      this.refreshes.set(entry.name, refreshed);
    }
    return refreshed;
  }

  /** The arguments object goes through the same parser and validator as `--args '{…}'`. */
  private parseArgs(tool: CatalogTool, args: Record<string, unknown>): Promise<ParsedToolArgs> {
    const { app } = this;
    return parseToolArgs(['--args', JSON.stringify(args)], tool.def, argsContext(tool), {
      io: NO_FILES,
      validate: !app.options.noValidate,
      redact: app.redact,
      compile: app.compile,
    });
  }
}

async function failure(app: App, error: unknown): Promise<CallOutcome> {
  const info: ErrorInfo = await toErrorInfo(error);
  return { exitCode: info.code, stdout: '', stderr: await app.redactText(formatError(info, app.options.format, app.redact)), warnings: [], error: info };
}

/** The `-o json` rendering of a result is JSON text; an empty result is `null`. */
function resultValue(stdout: string): unknown {
  if (stdout.trim() === '') return null;
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return stdout.replace(/\n$/, '');
  }
}
