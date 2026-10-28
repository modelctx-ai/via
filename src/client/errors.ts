// Error mapping for the MCP client (output.md "退出码", auth.md "调用时的行为", daemon.md
// "独占资源的 server"). Everything the client throws is a ClientError whose fields match
// protocol.ts `ErrorInfo`, so the CLI can print it and a daemon can ship it over the socket.
import { CredentialError, type ServerConfig } from '../config/types';
import type { ErrorInfo } from '../protocol';
import { ExitCode } from '../render/exit-codes';
import { askToRun, askUser } from '../render/ask';
import { shellArg, shellWord, shellWords } from '../render/shell';
import { sanitizeText } from '../render/sanitize';
import { ClientError } from './client-error';
import { urlElicitationsOf } from './elicit';

export { ClientError };

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
  /** This via runs inside `sandbox.command` (config.md, `sandbox`): the proxy it goes through is the sandbox's. */
  sandboxed?: boolean;
}

/** Longest piece of upstream text we echo into an error message. */
const MAX_UPSTREAM_TEXT = 300;
const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';

// Constructors for the fixed error kinds ------------------------------------------------------

/** `timeoutMs` ran out while connecting to `server`, or waiting for its answer (exit code 6, retryable). */
export function timedOut(server: ServerConfig, phase: Phase, timeoutMs: number): ClientError {
  const seconds = formatSeconds(timeoutMs);
  const err = new ClientError(
    {
      exitCode: ExitCode.Upstream,
      message: phase === 'connect' ? `timed out after ${seconds}s connecting to ${server.provider}` : `${server.provider} did not answer within ${seconds}s`,
      next: 'rerun with a larger --timeout',
    },
    true,
  );
  err.kind = 'timeout';
  return err;
}

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
  const paths = server.untrustedPaths ?? (server.origin.path ? [server.origin.path] : []);
  const path = paths[0];
  const what = server.transport.type === 'stdio' ? 'its command was not started' : 'no request was sent';
  return new ClientError({
    exitCode: ExitCode.Denied,
    message: `${server.provider} is defined in an untrusted project config${paths.length > 0 ? ` (${paths.join(', ')})` : ''}; ${what}`,
    // Trusting a project's config is the person's decision, made at a terminal (security.md, "via trust").
    next: askToRun(path && paths.length === 1 ? `via trust ${shellWord(path)}` : 'via trust'),
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

/** The server did not declare the capability behind `via resources` / `via prompts` (exit code 3, nothing was sent). */
export function noFeature(server: ServerConfig, feature: 'resources' | 'prompts' | 'completions'): ClientError {
  return new ClientError({
    exitCode: ExitCode.NotFound,
    message: `${server.provider} does not offer MCP ${feature === 'completions' ? 'argument completion' : feature}`,
    next: `via ${server.provider}`,
  });
}

/**
 * `resources/read` failed because the server does not know the URI (-32002, or -32602 from servers
 * that report it as invalid params). Other failures return undefined and map as usual.
 */
export function resourceNotFound(err: unknown, uri: string, provider: string, redact: (text: string) => string): ClientError | undefined {
  const code = mcpCode(err);
  if (code !== RESOURCE_NOT_FOUND && code !== INVALID_PARAMS) return undefined;
  const flat = (text: string): string => sanitizeText(redact(text)).replace(/\s+/g, ' ').trim().slice(0, MAX_UPSTREAM_TEXT);
  const detail = flat(errorMessage(err).replace(/^(?:MCP error -?\d+:\s*)+/, ''));
  return new ClientError({
    exitCode: ExitCode.NotFound,
    message: `no such resource: ${flat(uri)}${detail ? ` (${detail})` : ''}`,
    next: `via resources ${provider}`,
  });
}

// Skills (ADR 0020) -----------------------------------------------------------------------------

/** One line of server text for a message: redacted, cleaned, folded and cut. */
function oneLine(redact: (text: string) => string, text: string): string {
  return sanitizeText(redact(text)).replace(/\s+/g, ' ').trim().slice(0, MAX_UPSTREAM_TEXT);
}

/** `via skills` on a server that has none: an old protocol, or the extension not declared (exit code 3, nothing was sent). */
export function noSkills(server: ServerConfig, why: { protocol: string } | { extension: string }): ClientError {
  const reason =
    'protocol' in why
      ? `it speaks MCP ${why.protocol}; skills need 2026-07-28 and the ${SKILLS_EXTENSION_ID} extension`
      : `it did not declare the ${why.extension} extension`;
  return new ClientError({ exitCode: ExitCode.NotFound, message: `${server.provider} does not offer MCP skills: ${reason}`, next: `via ${server.provider}` });
}

/** The server does not know the skill (`skills/get` answered -32602 or -32002), or the typed file is not one of its files. */
export function skillNotFound(server: ServerConfig, what: string, redact: (text: string) => string, candidates: readonly string[] = []): ClientError {
  const list = candidates.slice(0, 5).map((c) => oneLine(redact, c));
  return new ClientError({
    exitCode: ExitCode.NotFound,
    message: `${oneLine(redact, what)}`,
    next: `via skills ${server.provider}`,
    ...(list.length > 0 ? { candidates: list } : {}),
  });
}

/** Content that does not match the skill's manifest: refused, nothing is printed (exit code 6: the server disagrees with itself). */
export function skillRefused(server: ServerConfig, uri: string, problem: string, redact: (text: string) => string): ClientError {
  return new ClientError({
    exitCode: ExitCode.Upstream,
    message: `refused ${oneLine(redact, uri)}: ${oneLine(redact, problem)}; nothing was printed`,
    next: `via skills ${server.provider}`,
  });
}

// Tasks (ADR 0020) -------------------------------------------------------------------------------

/** The `<provider>/<task id>` spelling of a task (cli.md, "任务"). */
export function taskRef(provider: string, id: string): string {
  return `${provider}/${id}`;
}

const taskNext = (server: ServerConfig, id: string, flag = ''): string => `${shellWords(['via', 'tasks', server.provider, id])}${flag}`;

/** `--timeout` ran out while following a task. The task was not cancelled; the same task id continues it (exit code 6). */
export function taskStillRunning(server: ServerConfig, id: string, seconds: string, redact: (text: string) => string): ClientError {
  const err = new ClientError({ exitCode: ExitCode.Upstream, message: `still running as task ${oneLine(redact, taskRef(server.provider, id))} after ${seconds}s; it was not cancelled`, next: taskNext(server, id) }, false);
  err.kind = 'task';
  return err;
}

/** A task that waits for input via cannot give (exit code 1; `--cancel` ends it). */
export function taskNeedsInput(server: ServerConfig, id: string, methods: readonly string[], redact: (text: string) => string): ClientError {
  const what = methods.length > 0 ? ` (${methods.map((m) => oneLine(redact, m)).join(', ')})` : '';
  const err = new ClientError({ exitCode: ExitCode.ToolError, message: `task ${oneLine(redact, taskRef(server.provider, id))} is waiting for input${what}, which via cannot give`, next: taskNext(server, id, ' --cancel') });
  err.kind = 'task';
  return err;
}

/** The server does not know the task (never had it, or it expired): exit code 3. */
export function taskNotFound(server: ServerConfig, id: string, redact: (text: string) => string): ClientError {
  return new ClientError({ exitCode: ExitCode.NotFound, message: `no such task: ${oneLine(redact, id)} (it may have expired)`, next: `via tasks ${server.provider}` });
}

/** `via tasks` on a server without tasks (exit code 3, nothing was sent). */
export function noTasks(server: ServerConfig, why: string): ClientError {
  return new ClientError({ exitCode: ExitCode.NotFound, message: `${server.provider} does not offer MCP tasks: ${why}`, next: `via ${server.provider}` });
}

/** `--detach` that cannot be honored: the server or the tool cannot run as a task (exit code 2, nothing was sent). */
export function cannotDetach(server: ServerConfig, why: string): ClientError {
  return new ClientError({ exitCode: ExitCode.Usage, message: `cannot detach: ${why}`, next: 'rerun without --detach' });
}

export function internal(message: string): ClientError {
  return new ClientError({ exitCode: ExitCode.Internal, message, next: 'via doctor' });
}

// Mapping -------------------------------------------------------------------------------------

/** Turn anything thrown while connecting or calling into a ClientError. */
export function mapError(err: unknown, ctx: ErrorContext): ClientError {
  if (err instanceof ClientError) return err;
  // The SDK wraps whatever went wrong while it probed the protocol version (a refused connection, a login that
  // cannot be refreshed) in an `ERA_NEGOTIATION_FAILED`; the cause is the failure to report.
  if (sdkCode(err) === 'ERA_NEGOTIATION_FAILED' && (err as { cause?: unknown }).cause instanceof Error) return mapError((err as { cause: Error }).cause, ctx);
  const { server } = ctx;
  const provider = server.provider;
  // Logging in needs a browser or a terminal: for the person, not for the agent (output.md, "错误").
  const loginNext = askToRun(`via auth login ${shellArg(provider, { placeholder: 'provider', positional: true })}`);
  // A static credential the server rejected: nothing to log in to, somebody has to look at the credential.
  const rejectedNext = askUser(`the credentials of ${clean(provider, ctx)} were refused; check servers.${clean(server.name, ctx)}.auth in the via config (the token may be wrong, expired or missing a scope)`);
  // A proxy variable that cannot be used (config.md, "代理"): the environment's mistake, not the server's.
  if (err instanceof Error && err.name === 'ProxyConfigError') {
    return new ClientError({ exitCode: ExitCode.Usage, message: `cannot reach ${provider}: ${clean(err.message, ctx)}`, next: 'fix the proxy variable, or unset it (via doctor shows what is in effect)' });
  }
  if (ctx.phase === 'connect' && server.protocolVersion !== undefined && refusesVersion(err)) return pinRefused(err, server.protocolVersion, ctx);

  // OAuth layer (matched by name: it lives next to the lazily loaded SDK).
  if (err instanceof Error && err.name === 'LoginRequiredError') {
    const expired = (err as { reason?: unknown }).reason === 'expired';
    return new ClientError({
      exitCode: ExitCode.Auth,
      message: expired ? `${provider} requires auth (the saved login expired)` : `${provider} requires auth`,
      next: loginNext,
    });
  }
  if (err instanceof Error && err.name === 'AuthorizationServerChangedError') {
    const { recorded, current } = err as Error & { recorded: string; current: string };
    return new ClientError({
      exitCode: ExitCode.Auth,
      message: `${provider}: its authorization server changed from ${clean(recorded, ctx)} to ${clean(current, ctx)}; the saved client credentials belong to the first and were not sent to the second`,
      next: `via auth logout ${provider}`,
    });
  }
  if (err instanceof Error && err.name === 'PinnedIssuerMismatchError') {
    const { pinned, actual, savedLogin } = err as Error & { pinned: string; actual: string; savedLogin: boolean };
    return new ClientError({
      exitCode: ExitCode.Auth,
      message: `${provider}: its authorization server is ${clean(actual, ctx)}, not ${clean(pinned, ctx)} as pinned by auth.oauth.issuer; nothing was sent to it`,
      next: savedLogin ? `via auth logout ${provider}` : `check auth.oauth.issuer of ${provider} in your via config`,
    });
  }
  if (err instanceof Error && err.name === 'ClientCredentialsRejectedError') {
    return new ClientError({
      exitCode: ExitCode.Auth,
      message: `${provider}: the authorization server refused the client credentials (${clean((err as Error & { code: string }).code, ctx)})`,
      next: `check auth.oauth of ${provider} in your via config`,
    });
  }
  if (err instanceof Error && err.name === 'TokenRefreshError') {
    return new ClientError({ exitCode: ExitCode.Upstream, message: `${provider}: ${clean(err.message, ctx)}`, next: 'via doctor' }, true);
  }

  if (isCredentialError(err)) {
    return new ClientError({
      exitCode: ExitCode.Auth,
      message: clean(err.message, ctx),
      next: err.next ?? (server.auth.type === 'oauth' ? loginNext : askUser(`fix the credential reference in servers.${clean(server.name, ctx)}.auth of the via config`)),
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
    return new ClientError({ exitCode: ExitCode.Auth, message: reason, next: hasCredentials && server.auth.type !== 'oauth' ? rejectedNext : loginNext });
  }

  if (isTimeout(err)) return timedOut(server, ctx.phase, ctx.timeoutMs);

  if (ctx.phase === 'connect') return startupFailure(err, ctx);

  // The server rejected the arguments at the protocol level: a tool-level failure (exit 1), not a
  // transport one (arguments.md, "校验与报错"). The CLI adds the "schema and server disagree" hint.
  if (mcpCode(err) === INVALID_PARAMS) {
    const detail = clean(errorMessage(err).replace(/^MCP error -32602:\s*/, ''), ctx);
    return new ClientError({ exitCode: ExitCode.ToolError, message: detail || `${provider} rejected the arguments`, next: 'check the arguments with -h' });
  }

  // `URLElicitationRequired` the person did not (or could not) act on: a refusal of the call, not a transport failure.
  const pages = urlElicitationsOf(err);
  if (pages) {
    const why = clean(pages[0]!.message, ctx);
    return new ClientError({ exitCode: ExitCode.ToolError, message: `${provider} needs you to open a web page before this call can run${why ? ` (${why})` : ''}`, next: 'rerun the command in a terminal and accept the request to open the page' });
  }

  if (status !== undefined) {
    const detail = clean(upstreamText(err), ctx);
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

// Pinned protocol version (config.md, `protocolVersion`) ---------------------------------------

/**
 * Whether the failure to connect is the server declining the protocol version via asked for: the SDK's
 * "did not offer the pinned version" (a probe without a better cause), a counter-offer it does not accept,
 * or the server's own -32022 "unsupported protocol version" (a 400 with a JSON-RPC body).
 */
function refusesVersion(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (sdkCode(err) === 'ERA_NEGOTIATION_FAILED' && !((err as { cause?: unknown }).cause instanceof Error)) return true;
  if (httpStatus(err) === 400 && /-32022|unsupported protocol version/i.test(httpBody(err))) return true;
  return /protocol version.*(?:not supported|unsupported)|unsupported protocol version/i.test(err.message);
}

function httpBody(err: Error): string {
  const text = (err as { data?: { text?: unknown } }).data?.text;
  return typeof text === 'string' ? text : '';
}

/** The versions the server said it supports, when its refusal listed them (`error.data.supported`). */
function offeredVersions(err: Error): string[] {
  try {
    const supported = (JSON.parse(httpBody(err)) as { error?: { data?: { supported?: unknown } } }).error?.data?.supported;
    return Array.isArray(supported) ? supported.filter((v): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v)) : [];
  } catch {
    return [];
  }
}

function pinRefused(err: unknown, pin: string, ctx: ErrorContext): ClientError {
  const offered = err instanceof Error ? offeredVersions(err) : [];
  return new ClientError({
    exitCode: ExitCode.Upstream,
    message: `cannot start ${ctx.server.provider}: it does not support protocol version ${pin}${offered.length > 0 ? ` (it supports ${offered.join(', ')})` : ''}; servers.${ctx.server.name}.protocolVersion pins it`,
    next: `remove protocolVersion from servers.${ctx.server.name}, or pin a version the server supports`,
  });
}

/** Failures while spawning the child or opening the HTTP session. */
function startupFailure(err: unknown, ctx: ErrorContext): ClientError {
  const { server } = ctx;
  const provider = server.provider;
  const status = httpStatus(err);
  const refused = tunnelRefusal(err);
  let reason: string;
  let spawnFailedToFindCommand = false;
  // What only a person can fix says so in `next:`; what may pass on its own points at `via doctor` (output.md, "错误").
  let next = 'via doctor';

  if (server.transport.type === 'stdio') {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
      spawnFailedToFindCommand = code === 'ENOENT';
      const program = clean(server.transport.command, ctx);
      reason = `cannot run ${program} (${code})`;
      next = askUser(
        code === 'ENOENT'
          ? `${program} is not installed (needed by ${provider})`
          : code === 'EACCES'
            ? `${program} is not executable by this user (needed by ${provider}); its permissions need fixing`
            : `${program} cannot be found: a part of its path is not a directory (needed by ${provider})`,
      );
    } else if (isConnectionClosed(err)) {
      reason = `the process exited before the MCP handshake finished${stderrSuffix(ctx)}`;
    } else {
      reason = clean(errorMessage(err), ctx);
    }
  } else if (status !== undefined) {
    const detail = clean(upstreamText(err), ctx);
    reason = `HTTP ${status}${detail ? `: ${detail}` : ''}`;
  } else if (refused !== undefined) {
    // Not the server's answer and not a network hiccup: a proxy that will not connect via to this host, every
    // time. The sandbox's proxy answers 403 for a domain its policy does not allow (config.md, `sandbox`).
    const origin = originOf(server.transport.url);
    const host = hostOf(server.transport.url);
    if (ctx.sandboxed && refused === 403) {
      reason = `the sandbox's proxy refused ${origin} (HTTP 403)`;
      next = askUser(`add ${host} to sandbox.policy.network.allowedDomains in the via config`);
    } else {
      reason = `the proxy did not connect to ${origin} (HTTP ${refused})`;
      next = askUser(`the proxy did not let via reach ${origin} (HTTP ${refused}); check the proxy, or list ${host} in NO_PROXY`);
    }
    return new ClientError({ exitCode: ExitCode.Upstream, message: `cannot start ${provider}: ${reason}`, next });
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
  return new ClientError({ exitCode: ExitCode.Upstream, message, next }, transient);
}

// Helpers -------------------------------------------------------------------------------------

function isCredentialError(err: unknown): err is CredentialError {
  return err instanceof CredentialError || (err instanceof Error && err.name === 'CredentialError');
}

/** SDK `UnauthorizedError` (only raised with an auth provider; matched by name to keep the SDK lazy). */
function isUnauthorized(err: unknown): boolean {
  return err instanceof Error && err.constructor.name === 'UnauthorizedError';
}

/** SDK `SdkHttpError`: the transport got an HTTP status it cannot use (matched by name, like the rest, to keep the SDK lazy). */
function httpStatus(err: unknown): number | undefined {
  if (!(err instanceof Error) || err.name !== 'SdkHttpError') return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && status >= 100 ? status : undefined;
}

const REQUEST_TIMEOUT = 'REQUEST_TIMEOUT';
const CONNECTION_LOST = new Set(['CONNECTION_CLOSED', 'NOT_CONNECTED', 'SEND_FAILED']);
const CONNECTION_CLOSED = -32000;
const INVALID_PARAMS = -32602;
const RESOURCE_NOT_FOUND = -32002;

/** Whether `err` is the server saying it does not know what was asked for (-32002), or calling it invalid (-32602). */
export function isNotFoundCode(err: unknown): boolean {
  const code = mcpCode(err);
  return code === RESOURCE_NOT_FOUND || code === INVALID_PARAMS;
}

/** The JSON-RPC code of an error the server answered with (SDK `ProtocolError`); undefined for anything else. */
function mcpCode(err: unknown): number | undefined {
  if (err instanceof Error && err.name === 'ProtocolError') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number') return code;
  }
  return undefined;
}

/** SDK `SdkError`: a failure of the client itself (timeout, closed connection, …), with a string `code`. */
function sdkCode(err: unknown): string | undefined {
  if (err instanceof Error && (err.name === 'SdkError' || err.name === 'SdkHttpError')) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function isTimeout(err: unknown): boolean {
  return sdkCode(err) === REQUEST_TIMEOUT;
}

function isConnectionClosed(err: unknown): boolean {
  const code = sdkCode(err);
  return (code !== undefined && CONNECTION_LOST.has(code)) || mcpCode(err) === CONNECTION_CLOSED;
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

/**
 * The status a proxy answered a CONNECT with when it did not open the tunnel, looking through `fetch failed`
 * causes. undici words it `Proxy response (403) !== 200 when HTTP Tunneling` (the ProxyAgent of undici 7).
 */
function tunnelRefusal(err: unknown): number | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i += 1) {
    const match = /^Proxy response \((\d{3})\) !== 200 when HTTP Tunneling/.exec(errorMessage(cur));
    if (match) return Number(match[1]);
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'the configured host';
  }
}

function isFetchFailure(err: unknown): boolean {
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What the SDK says about a failed HTTP exchange, plus the response body it kept separately (a probe answered with 5xx carries it only there). */
function upstreamText(err: unknown): string {
  const message = stripSdkPrefix(errorMessage(err));
  const body = err instanceof Error && err.name === 'SdkHttpError' ? (err as { data?: { text?: unknown } }).data?.text : undefined;
  return typeof body === 'string' && body !== '' && !message.includes(body) ? `${message}: ${body}` : message;
}

function stripSdkPrefix(message: string): string {
  return message
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
