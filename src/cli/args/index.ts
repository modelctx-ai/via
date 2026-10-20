// Schema-driven tool arguments (arguments.md): mapping, JSON input, @file/stdin, anyOf/oneOf
// completion, local validation, help and usage text. CONTRACT STUB: shapes are fixed, bodies are
// filled in by the implementation.
import type { McpTool } from '../../catalog/types';

/** Which tool is being called, for usage lines and messages. */
export interface ToolArgsContext {
  provider: string;
  /** Canonical command-line form, e.g. `github issue:list`. */
  ref: string;
  rawName: string;
  readOnly: boolean;
  destructive: boolean;
}

export interface ToolArgsIO {
  readFile(path: string): Promise<string>;
  readStdin(): Promise<string>;
}

export interface ParseToolArgsOptions {
  io: ToolArgsIO;
  /** False for `--no-validate`: parse and convert, but skip schema validation. */
  validate: boolean;
  /** Replaces resolved credential values in messages with `***`. */
  redact?: (s: string) => string;
}

export interface ParsedToolArgs {
  /** The merged argument object to send upstream. */
  args: Record<string, unknown>;
  /** stderr warnings (`format` mismatches, uncompilable schema, external `$ref`), without the `warning: ` prefix. */
  warnings: string[];
  /** False when validation was skipped (`--no-validate` or an uncompilable schema): the meta line shows `unvalidated`. */
  validated: boolean;
}

/** One line of a validation report: `--state  must be one of: …`. */
export interface ArgIssue {
  /** Command-line spelling: `--filter.state`, `--labels[1]`. */
  arg: string;
  message: string;
}

/** Usage or validation failure; exit code 2 (arguments.md, "报错"). */
export class ToolArgsError extends Error {
  readonly exitCode = 2 as const;
  constructor(
    message: string,
    readonly issues: readonly ArgIssue[],
    /** The `usage: …` block, already formatted. */
    readonly usage: string,
    /** The `next:` command, if any. */
    readonly next?: string,
    /** Structured `details` for `-o json` (output.md, "错误"). */
    readonly details: readonly Record<string, unknown>[] = [],
  ) {
    super(message);
    this.name = 'ToolArgsError';
  }
}

/**
 * Parse the tool arguments that follow a tool reference. `argv` has had via's own global options
 * removed already; `--p.<name>` prefixes are still present and are handled here.
 * Throws ToolArgsError on any usage or validation failure.
 */
export async function parseToolArgs(
  argv: readonly string[],
  tool: McpTool,
  ctx: ToolArgsContext,
  options: ParseToolArgsOptions,
): Promise<ParsedToolArgs> {
  void argv, tool, ctx, options;
  throw new Error('parseToolArgs: not implemented');
}

/** `via <provider> <resource>:<verb> -h` output (arguments.md, "帮助"). */
export function formatToolHelp(tool: McpTool, ctx: ToolArgsContext): string {
  void tool, ctx;
  throw new Error('formatToolHelp: not implemented');
}

/** The `usage: …` block alone, as shown under errors. */
export function formatUsage(tool: McpTool, ctx: ToolArgsContext): string {
  void tool, ctx;
  throw new Error('formatUsage: not implemented');
}

/** Check `structuredContent` against `outputSchema`; returns warnings, never throws (arguments.md, "输出校验"). */
export async function validateOutput(tool: McpTool, structured: unknown): Promise<string[]> {
  void tool, structured;
  throw new Error('validateOutput: not implemented');
}
