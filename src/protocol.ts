// Messages shared by the CLI, the daemon and the in-process client (docs/spec/daemon.md,
// "CLI 与 daemon 的协议"). Types only, plus two tiny type guards. Credential values never appear
// in any of these messages: servers travel as definitions that hold credential *references*.
import type { McpTool } from './catalog/types';
import type { ServerConfig } from './config/types';
import type { CursorRecord } from './render/cursor';
import type { ExitCode } from './render/exit-codes';
import type { ContentBlock, ToolResult } from './render/types';

// Handshake -----------------------------------------------------------------------

/** Sent by the CLI right after connecting; nothing else is accepted before it. */
export type Hello = {
  type: 'hello';
  version: string;
  pid: number;
  /** Contents of the daemon's token file (a second, filesystem-independent check next to the socket mode). */
  token?: string;
};

/**
 * The daemon's answer. `ok: false` closes the connection; `reason` says why: a different `version`
 * (the daemon then drains and exits so the CLI can start a matching one), a wrong `token`, or a
 * daemon that is already `draining`.
 */
export type HelloAck = {
  type: 'hello';
  version: string;
  ok: boolean;
  pid?: number;
  reason?: 'version' | 'token' | 'draining';
};

/** Single-string tool reference, e.g. `linear/issue:create` (naming.md). */
export type ToolRef = string;

// Requests ------------------------------------------------------------------------

/**
 * Names the server a request is about. The CLI loads the configuration (project files depend on
 * the working directory) and sends the one definition involved, so the daemon never reads config.
 */
export type ServerTarget = {
  /** The definition as configured: credential references, never values. */
  server: ServerConfig;
  /** The CLI's working directory: base for a relative `file:` reference and default `cwd` of a stdio server. */
  cwd: string;
  /** Seconds an idle stdio session is kept (`daemon.serverIdleTimeout`). */
  idleTimeout: number;
  /** One-way digest of the caller's values for the `env:` references of this server; see `envStamp`. */
  envStamp: string;
};

export type Request =
  | { id: string; type: 'status' }
  /**
   * `tools/list` of one server: daemon memory, then the disk cache, then the server. `have` is the
   * `fetchedAt` of a list the caller already holds (or a build made from it): when the daemon's
   * list is that one it answers without the tools (`unchanged`). Ignored with `refresh`.
   */
  | ({ id: string; type: 'list'; timeoutMs: number; refresh?: boolean; have?: number } & ServerTarget)
  /** `tools/call`; the result comes back raw but with resolved credentials replaced by `***`. */
  | ({ id: string; type: 'call'; rawName: string; args: Record<string, unknown>; timeoutMs?: number; retry?: boolean; progress?: boolean } & ServerTarget)
  /** `resources/list` plus `resources/templates/list` of one server. Never cached. */
  | ({ id: string; type: 'resources-list'; timeoutMs: number } & ServerTarget)
  /** `resources/read`. */
  | ({ id: string; type: 'resource-read'; uri: string; timeoutMs: number } & ServerTarget)
  /** `prompts/list`. */
  | ({ id: string; type: 'prompts-list'; timeoutMs: number } & ServerTarget)
  /** `prompts/get`. */
  | ({ id: string; type: 'prompt-get'; name: string; args: Record<string, string>; timeoutMs: number } & ServerTarget)
  /** Compile a JSON Schema (cached by the daemon) and check `data`; keeps ajv out of the CLI process. */
  | { id: string; type: 'validate'; schema: unknown; label: string; data?: unknown; compileOnly?: boolean }
  /**
   * Replace the credential values the daemon knows with `***`. `text` is composed by the CLI (only
   * long values are looked for); `value` is content the CLI echoes (any JSON, every string redacted).
   */
  | { id: string; type: 'redact'; text: string }
  | { id: string; type: 'redact'; value: unknown }
  | { id: string; type: 'cursor-put'; record: CursorRecord }
  | { id: string; type: 'cursor-get'; cursor: string }
  /** Finish the requests in flight, then exit (`via daemon stop`). */
  | { id: string; type: 'shutdown'; force?: boolean }
  // Reserved for features that route through the daemon later; the daemon answers exit code 7.
  | { id: string; type: 'batch'; calls: { tool: ToolRef; args: unknown }[] }
  | { id: string; type: 'auth'; action: 'login' | 'status' | 'logout'; provider: string };

export type RequestType = Request['type'];

/** A request as the caller writes it; the connection assigns `id`. */
export type RequestBody = Request extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never;

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

/**
 * The request was not run because the daemon's environment differs from the caller's for a variable
 * a credential reference points at. The caller handles that server's request in-process; the daemon
 * is neither restarted nor given the caller's values.
 */
export type Stale = { id: string; type: 'stale'; reason: 'environment' };

/** Everything the daemon may write after the handshake. */
export type Message = Response | Event | Stale;

// Payloads ------------------------------------------------------------------------

/** What a server declared at `initialize` that via can use besides tools (discovery.md, "浏览视图"). */
export type ServerFeatures = { resources: boolean; prompts: boolean };

/**
 * What a connection negotiated (daemon.md, "协议版本与无状态连接"). `stateful` is false for the stateless
 * protocol (`2026-07-28`: no handshake, no server-side session) and for an old-protocol HTTP server that
 * assigned no session id; a stdio process, and an HTTP server that assigned a session id, are stateful.
 */
export type ProtocolInfo = { version: string; stateful: boolean };

/**
 * `result` of `list`. `features` is absent when it is not known (a cache written before it was
 * recorded). `unchanged` replaces `tools` when the request's `have` is the `fetchedAt` of the list
 * the daemon would have sent; the credentials and trust checks ran all the same.
 */
export type ListResult = ListedTools | ListUnchanged;
export type ListedTools = { tools: McpTool[]; fetchedAt: number; fromCache: boolean; features?: ServerFeatures; protocol?: ProtocolInfo };
export type ListUnchanged = { unchanged: true; fetchedAt: number; fromCache: true; features?: ServerFeatures; protocol?: ProtocolInfo };

/** `result` of `validate`. `ok: false` means the schema cannot be compiled. */
export type ValidateResult =
  | { ok: true; warnings: string[]; errors: unknown[]; formats: unknown[] }
  | { ok: false; reason: string; warnings: string[] };

/** `result` of `cursor-get`. */
export type CursorGetResult = { record: CursorRecord | null };

/** `result` of `status`. Names and counters only: no URLs, arguments or credentials. */
export type DaemonStatus = {
  pid: number;
  version: string;
  socket: string;
  startedAt: number;
  uptimeMs: number;
  idleTimeoutMs: number;
  /** Milliseconds until the daemon exits if nothing happens; absent while busy. */
  idleExitInMs?: number;
  requests: number;
  cursors: number;
  rssBytes: number;
  sessions: SessionStatus[];
};

export type SessionStatus = {
  /** Key under `servers`. */
  server: string;
  provider: string;
  transport: 'stdio' | 'http';
  connected: boolean;
  /** Process id of the stdio child, when running. */
  pid?: number;
  /** Tools in the daemon's copy of the catalog. */
  tools?: number;
  /** What the live connection negotiated; absent while not connected. */
  protocol?: ProtocolInfo;
  calls: number;
  /** Requests running right now. */
  active: number;
  lastUsedAgoMs: number;
};

// Resources and prompts -----------------------------------------------------------

export type McpResource = { uri: string; name: string; title?: string; description?: string; mimeType?: string; size?: number };

export type McpResourceTemplate = { uriTemplate: string; name: string; title?: string; description?: string; mimeType?: string };

/** `result` of `resources-list`. */
export type ResourceListing = { resources: McpResource[]; templates: McpResourceTemplate[] };

/** `result` of `resource-read`: one entry per content, text or base64 `blob`. */
export type ReadResourceResult = { contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> };

export type McpPromptArgument = { name: string; title?: string; description?: string; required?: boolean };

export type McpPrompt = { name: string; title?: string; description?: string; arguments?: McpPromptArgument[] };

/** `result` of `prompt-get`. */
export type GetPromptResult = { description?: string; messages: Array<{ role: string; content: ContentBlock }> };

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
