// Messages shared by the CLI, the daemon and the in-process client (docs/spec/daemon.md,
// "CLI 与 daemon 的协议"). Types only, plus two tiny type guards. Credential values never appear
// in any of these messages.
import type { ExitCode } from './render/exit-codes';
import type { ToolResult } from './render/types';

// Handshake -----------------------------------------------------------------------

/** Sent by the CLI right after connecting. */
export type Hello = { type: 'hello'; version: string; pid: number };
export type HelloAck = { type: 'hello'; version: string; ok: boolean };

/** Single-string tool reference, e.g. `linear/issue:create` (naming.md). */
export type ToolRef = string;

// Requests ------------------------------------------------------------------------

export type Request =
  | { id: string; type: 'status' }
  | { id: string; type: 'ls'; provider?: string; resource?: string; all?: boolean }
  | { id: string; type: 'find'; query: string; domain?: string; limit?: number }
  | { id: string; type: 'describe'; tool: ToolRef }
  | { id: string; type: 'call'; tool: ToolRef; args: unknown; timeoutMs?: number; confirm?: boolean; dryRun?: boolean }
  | { id: string; type: 'more'; cursor: string }
  | { id: string; type: 'batch'; calls: { tool: ToolRef; args: unknown }[] }
  | { id: string; type: 'auth'; action: 'login' | 'status' | 'logout'; provider: string }
  | { id: string; type: 'sync'; provider?: string };

export type RequestType = Request['type'];

// Responses -----------------------------------------------------------------------

/** Intermediate message (progress, log); zero or more per request. */
export type Event = { id: string; type: 'event'; event: 'progress' | 'log'; data: unknown };

export type ResultMeta = {
  /** Canonical form of the tool. */
  tool?: ToolRef;
  elapsedMs: number;
  /** Set when the result was truncated. */
  cursor?: string;
  totalBytes?: number;
};

/** Failure description; `exitCode` follows output.md ("退出码"). */
export type ErrorInfo = {
  exitCode: Exclude<ExitCode, 0>;
  message: string;
  /** Next command to run. */
  next?: string;
  /** Ambiguous matches or did-you-mean suggestions. */
  candidates?: string[];
};

export type Response =
  | { id: string; type: 'result'; ok: true; result: unknown; meta: ResultMeta }
  | { id: string; type: 'result'; ok: false; error: ErrorInfo };

// Raw MCP results -----------------------------------------------------------------

/**
 * Unrendered `tools/call` result as the server returned it (`content`, `structuredContent`,
 * `isError`). This is what `Response.result` carries for a `call`.
 */
export type ToolCallResult = ToolResult & { _meta?: Record<string, unknown> };

// Guards --------------------------------------------------------------------------

export function isErrorResponse(response: Response): response is Extract<Response, { ok: false }> {
  return response.ok === false;
}

/** Narrow an `unknown` thrown value to the `ErrorInfo` shape. */
export function isErrorInfo(value: unknown): value is ErrorInfo {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.exitCode === 'number' && typeof v.message === 'string';
}
