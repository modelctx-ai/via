import { ExitCode } from './exit-codes';
import { redactValue, scannerOf } from './redact';
import type { OutputFormat } from './types';

/** An error ready to print: first line is the reason, `next:` is a command to run. */
export interface ErrorInfo {
  code: ExitCode;
  message: string;
  /** Extra text lines between the reason and `next:` (usage, per-argument problems). */
  lines?: string[];
  /** The next command to run. */
  next?: string;
  /** Structured details, included in `-o json` output only. */
  details?: unknown[];
}

/** The object inside `{"error": …}` of `-o json` (output.md, "错误"): code, message, next, details. */
export function errorEnvelope(info: ErrorInfo): Record<string, unknown> {
  const error: Record<string, unknown> = { code: info.code, message: info.message };
  if (info.next) error.next = info.next;
  if (info.details) error.details = info.details;
  return error;
}

/**
 * Format an error for stderr. Text: `error:` line, detail lines, `next:` line.
 *
 * `redact` only has to scan: the labels, the JSON field names and the `rule`/`path` entries of
 * `details` are ours, so the text is checked for long credentials (`scannerOf`) and never for short
 * ones. Whatever echoes content (upstream error text, an argument's `got`) is redacted as a value
 * by whoever builds the {@link ErrorInfo}.
 */
export function formatError(info: ErrorInfo, format: OutputFormat, redact: (s: string) => string = (s) => s): string {
  const scan = scannerOf(redact);
  if (format === 'json') return `${JSON.stringify({ error: redactValue(errorEnvelope(info), scan) })}\n`;
  const lines = [`error: ${info.message}`, ...(info.lines ?? [])];
  if (info.next) lines.push(`next: ${info.next}`);
  return `${scan(lines.join('\n'))}\n`;
}

// Common errors ---------------------------------------------------------------

export function authRequiredError(provider: string): ErrorInfo {
  return { code: ExitCode.Auth, message: `${provider} requires auth`, next: `via auth login ${provider}` };
}

export function usageError(message: string, next: string, lines: string[] = []): ErrorInfo {
  return { code: ExitCode.Usage, message, lines, next };
}

/**
 * Something does not exist (exit code 3). `suggestions` are full command forms such as
 * `github issue:read`; with none, point at `via find`.
 */
export function notFoundError(what: string, input: string, suggestions: readonly string[], findQuery: string): ErrorInfo {
  if (suggestions.length === 0) {
    return { code: ExitCode.NotFound, message: `no such ${what}: ${input}`, next: `via find ${findQuery}` };
  }
  return {
    code: ExitCode.NotFound,
    message: `no such ${what}: ${input}`,
    lines: [`did you mean: ${suggestions.join(' · ')}`],
    next: `via ${suggestions[0]} -h`,
  };
}

export function internalError(message: string): ErrorInfo {
  return { code: ExitCode.Internal, message, next: 'via doctor' };
}
