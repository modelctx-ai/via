// Error mapping for the MCP client (output.md "退出码", auth.md "调用时的行为", daemon.md
// "独占资源的 server"). Everything the client throws is a ClientError whose fields match
// protocol.ts `ErrorInfo`, so the CLI can print it and a daemon can ship it over the socket.
import { CredentialError, type ServerConfig } from '../config/types';
import type { ErrorInfo } from '../protocol';
import { ExitCode } from '../render/exit-codes';
import { sanitizeText } from '../render/pipeline';

export class ClientError extends Error implements ErrorInfo {
  readonly exitCode: ErrorInfo['exitCode'];
  readonly next?: string;
  readonly candidates?: string[];
  /**
   * True for timeouts and lost connections, the cases where a read-only call may be retried once
   * (arguments.md, "调用过程"). Not part of `ErrorInfo`.
   */
  readonly retryable: boolean;

  constructor(info: ErrorInfo, retryable = false) {
    super(info.message);
    this.retryable = retryable;
    this.name = 'ClientError';
    this.exitCode = info.exitCode;
    if (info.next !== undefined) this.next = info.next;
    if (info.candidates !== undefined) this.candidates = info.candidates;
  }

  /** Plain, serializable form (what a daemon response carries). */
  get info(): ErrorInfo {
    const info: ErrorInfo = { exitCode: this.exitCode, message: this.message };
    if (this.next !== undefined) info.next = this.next;
    if (this.candidates !== undefined) info.candidates = this.candidates;
    return info;
  }
}

/** Where in the lifecycle an error happened; decides the wording of generic failures. */
export type Phase = 'connect' | 'request';

export interface ErrorContext {
  server: ServerConfig;
  phase: Phase;
  /** Replaces resolved credential values with `***`. */
  redact: (text: string) => string;
  /** Timeout that was in force, in milliseconds. */
  timeoutMs: number;
  /** Last lines the stdio child wrote to stderr, if any (already unredacted; redacted here). */
  stderrTail?: string;
}

/** Longest piece of upstream text we echo into an error message. */
const MAX_UPSTREAM_TEXT = 300;

// Constructors for the fixed error kinds ------------------------------------------------------

export function notFoundServer(name: string, known: readonly string[]): ClientError {
  const candidates = known.length > 0 ? [...known] : undefined;
  return new ClientError({
    exitCode: ExitCode.NotFound,
    message: `no such server: ${name}`,
    next: 'via servers',
    ...(candidates ? { candidates } : {}),
  });
}

export function untrustedServer(server: ServerConfig): ClientError {
  const path = server.untrustedPaths?.[0] ?? server.origin.path;
  const what = server.transport.type === 'stdio' ? 'its command was not started' : 'no request was sent';
  return new ClientError({
    exitCode: ExitCode.Denied,
    message: `${server.provider} is defined in an untrusted project config${path ? ` (${path})` : ''}; ${what}`,
    next: path ? `via trust ${path}` : 'via trust',
  });
}

/** `auth: oauth` on a stdio server: OAuth is an HTTP mechanism (auth.md). */
export function oauthNeedsHttp(server: ServerConfig): ClientError {
  return new ClientError({
    exitCode: ExitCode.Usage,
    message: `${server.provider} is a stdio server; auth: oauth applies to HTTP servers only`,
    next: `set servers.${server.name}.auth to none and pass credentials through env`,
  });
}

export function internal(message: string): ClientError {
  return new ClientError({ exitCode: ExitCode.Internal, message, next: 'via doctor' });
}

// Mapping -------------------------------------------------------------------------------------

/** Turn anything thrown while connecting or calling into a ClientError. */
export function mapError(err: unknown, ctx: ErrorContext): ClientError {
  if (err instanceof ClientError) return err;
  const { server } = ctx;
  const provider = server.provider;
  const loginNext = `via auth login ${provider}`;

  // OAuth layer (matched by name: it lives next to the lazily loaded SDK).
  if (err instanceof Error && err.name === 'LoginRequiredError') {
    const expired = (err as { reason?: unknown }).reason === 'expired';
    return new ClientError({
      exitCode: ExitCode.Auth,
      message: expired ? `${provider} requires auth (the saved login expired)` : `${provider} requires auth`,
      next: loginNext,
    });
  }
  if (err instanceof Error && err.name === 'TokenRefreshError') {
    return new ClientError({ exitCode: ExitCode.Upstream, message: `${provider}: ${clean(err.message, ctx)}`, next: 'via doctor' }, true);
  }

  if (isCredentialError(err)) {
    return new ClientError({
      exitCode: ExitCode.Auth,
      message: clean(err.message, ctx),
      next: err.next ?? loginNext,
    });
  }

  const status = httpStatus(err);
  if (status === 401 || status === 403 || isUnauthorized(err)) {
    const hasCredentials = server.auth.type !== 'none';
    const reason =
      status === 403
        ? `${provider} denied access (HTTP 403)`
        : hasCredentials
          ? `${provider} rejected the credentials (HTTP 401)`
          : `${provider} requires auth`;
    return new ClientError({ exitCode: ExitCode.Auth, message: reason, next: loginNext });
  }

  if (isTimeout(err)) {
    const seconds = formatSeconds(ctx.timeoutMs);
    const what = ctx.phase === 'connect' ? `connecting to ${provider}` : `${provider}`;
    return new ClientError({
      exitCode: ExitCode.Upstream,
      message: ctx.phase === 'connect' ? `timed out after ${seconds}s ${what}` : `${what} did not answer within ${seconds}s`,
      next: 'rerun with a larger --timeout',
    }, true);
  }

  if (ctx.phase === 'connect') return startupFailure(err, ctx);

  // The server rejected the arguments at the protocol level: a tool-level failure (exit 1), not a
  // transport one (arguments.md, "校验与报错"). The CLI adds the "schema and server disagree" hint.
  if (mcpCode(err) === INVALID_PARAMS) {
    const detail = clean(errorMessage(err).replace(/^MCP error -32602:\s*/, ''), ctx);
    return new ClientError({ exitCode: ExitCode.ToolError, message: detail || `${provider} rejected the arguments`, next: 'check the arguments with -h' });
  }

  if (status !== undefined) {
    const detail = clean(stripSdkPrefix(errorMessage(err)), ctx);
    return new ClientError({
      exitCode: ExitCode.Upstream,
      message: `${provider} returned HTTP ${status}${detail ? `: ${detail}` : ''}`,
      next: 'via doctor',
    });
  }

  if (isConnectionClosed(err) || networkCode(err) !== undefined) {
    return new ClientError({
      exitCode: ExitCode.Upstream,
      message: `lost the connection to ${provider}${stderrSuffix(ctx)}`,
      next: 'via doctor',
    }, true);
  }

  return new ClientError({
    exitCode: ExitCode.Upstream,
    message: `${provider}: ${clean(errorMessage(err), ctx)}`,
    next: 'via doctor',
  });
}

/** Failures while spawning the child or opening the HTTP session. */
function startupFailure(err: unknown, ctx: ErrorContext): ClientError {
  const { server } = ctx;
  const provider = server.provider;
  const status = httpStatus(err);
  let reason: string;
  let spawnFailedToFindCommand = false;

  if (server.transport.type === 'stdio') {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
      spawnFailedToFindCommand = code === 'ENOENT';
      reason = `cannot run ${server.transport.command} (${code})`;
    } else if (isConnectionClosed(err)) {
      reason = `the process exited before the MCP handshake finished${stderrSuffix(ctx)}`;
    } else {
      reason = clean(errorMessage(err), ctx);
    }
  } else if (status !== undefined) {
    const detail = clean(stripSdkPrefix(errorMessage(err)), ctx);
    reason = `HTTP ${status}${detail ? `: ${detail}` : ''}`;
  } else if (networkCode(err) !== undefined || isFetchFailure(err)) {
    reason = `cannot reach ${originOf(server.transport.url)} (${networkCode(err) ?? 'network error'})`;
  } else {
    reason = clean(errorMessage(err), ctx);
  }

  let message = `cannot start ${provider}: ${reason}`;
  if (server.exclusive && server.transport.type === 'stdio' && !spawnFailedToFindCommand) {
    message += '; it may conflict with a same-named server still running in an agent framework';
  }
  const transient = isConnectionClosed(err) || networkCode(err) !== undefined || isFetchFailure(err);
  return new ClientError({ exitCode: ExitCode.Upstream, message, next: 'via doctor' }, transient);
}

// Helpers -------------------------------------------------------------------------------------

function isCredentialError(err: unknown): err is CredentialError {
  return err instanceof CredentialError || (err instanceof Error && err.name === 'CredentialError');
}

/** SDK `UnauthorizedError` (only raised with an auth provider; matched by name to keep the SDK lazy). */
function isUnauthorized(err: unknown): boolean {
  return err instanceof Error && err.constructor.name === 'UnauthorizedError';
}

/** SDK `StreamableHTTPError`: message starts with "Streamable HTTP error:" and `code` is the HTTP status (or -1). */
function httpStatus(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'number' && code >= 100 && err.message.startsWith('Streamable HTTP error')) return code;
  return undefined;
}

const REQUEST_TIMEOUT = -32001;
const CONNECTION_CLOSED = -32000;
const INVALID_PARAMS = -32602;

function mcpCode(err: unknown): number | undefined {
  if (err instanceof Error && err.name === 'McpError') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number') return code;
  }
  return undefined;
}

function isTimeout(err: unknown): boolean {
  return mcpCode(err) === REQUEST_TIMEOUT;
}

function isConnectionClosed(err: unknown): boolean {
  return mcpCode(err) === CONNECTION_CLOSED;
}

function errnoCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Node network error code (`ECONNREFUSED`, …), looking through `fetch failed` causes. */
function networkCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i += 1) {
    const code = errnoCode(cur);
    if (code && /^(E[A-Z]+|UND_ERR_[A-Z_]+)$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function isFetchFailure(err: unknown): boolean {
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stripSdkPrefix(message: string): string {
  return message
    .replace(/^Streamable HTTP error:\s*/, '')
    .replace(/^Error POSTing to endpoint:\s*/, '')
    .replace(/^Failed to open SSE stream:\s*/, '');
}

/** Redact, strip control characters, flatten to one line and cap the length. */
function clean(text: string, ctx: ErrorContext): string {
  const flat = sanitizeText(ctx.redact(text)).replace(/\s+/g, ' ').trim();
  return flat.length > MAX_UPSTREAM_TEXT ? `${flat.slice(0, MAX_UPSTREAM_TEXT)}…` : flat;
}

function stderrSuffix(ctx: ErrorContext): string {
  if (!ctx.stderrTail) return '';
  const last = ctx.stderrTail
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return last ? ` (stderr: ${clean(last, ctx)})` : '';
}

function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
}

/** Scheme and host only: URLs may carry credentials in the path or query. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'the configured URL';
  }
}
