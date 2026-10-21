// One MCP session per server over stdio or Streamable HTTP. The SDK is imported lazily, on the first
// connection, so nothing here costs CLI cold start (implementation.md, "启动速度").
import type { Client, ClientOptions, FetchLike, McpSubscription, StandardSchemaV1, SubscriptionFilter, Transport } from '@modelcontextprotocol/client';
import pkg from '../../package.json';
import type { CredentialResolver, ServerConfig } from '../config/types';
import type { CompletionRef, CompletionResult, GetPromptResult, McpPrompt, ProtocolInfo, ReadResourceResult, ResourceListing, ServerFeatures, ServerSelf, ToolCallResult } from '../protocol';
import type { McpTool } from '../catalog/types';
import { createRedactor } from '../render/redact';
import { resolveConnection, type ResolvedConnection } from './credentials';
import { ClientError, internal, mapError, noFeature, notFoundServer, resourceNotFound, timedOut, untrustedServer, type Phase } from './errors';
import { prepareStdioCommand } from '../platform/command';
import { isModernProtocolVersion } from '../protocol-versions';
import { proxyFetch } from '../proxy';
import { Limiter } from './limiter';
import { resolveRoots } from './roots';
import { describeServer } from './server-info';
import type { ViaOAuthProvider } from './oauth/provider';
import type { OAuthStore } from './oauth/store';

export interface CallOptions {
  /** Overrides `ServerConfig.timeout` for this call. */
  timeoutMs?: number;
  /** Retry once after a timeout or lost connection. Callers pass this only for `readOnlyHint` tools. */
  retry?: boolean;
  /** Called for upstream `notifications/progress` (arguments.md, "调用过程"). */
  onProgress?: (progress: { progress: number; total?: number; message?: string }) => void;
  /** Something the person should know about, caused by this call (see `SessionOptions.onWarning`). */
  onWarning?: (message: string) => void;
}

export interface ListOptions {
  timeoutMs?: number;
  /**
   * The server's own cache hint for what is being listed: `ttlMs` of a stateless-protocol `tools/list`
   * result, called only for a positive value (a server that sends `0` or nothing gave no usable hint:
   * discovery.md, "缓存").
   */
  onTtl?: (ttlMs: number) => void;
  /** Something the person should know about, caused by this operation (see `SessionOptions.onWarning`). */
  onWarning?: (message: string) => void;
}

export interface SessionOptions {
  /** Where OAuth logins live (auth.md). Default: the user's keychain / data directory. */
  oauthStore?: OAuthStore;
  /** Clock for token expiry; tests inject one. */
  now?: () => number;
  /**
   * The tool list may have changed: the server sent `notifications/tools/list_changed` (a push on the old
   * protocol, an event on the `subscriptions/listen` stream of the stateless one), or that stream dropped
   * and was opened again, so events may have been missed. The daemon refreshes its catalog on it. Runs on
   * the connection that received it; must not throw.
   */
  onToolsChanged?: () => void;
  /**
   * A warning for the person running the command (`warning: …` on stderr), e.g. a refreshed OAuth
   * login that could not be saved. Per-operation `onWarning` takes precedence. Each warning is
   * given once per session.
   */
  onWarning?: (message: string) => void;
  /**
   * What is known about the protocol this server spoke before this session connected (the catalog cache
   * remembers it). Only a stdio server is asked: see `McpSession.open`.
   */
  knownProtocol?: (server: ServerConfig) => ProtocolInfo | undefined;
  /**
   * The environment whose proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`) this session's HTTP
   * requests follow (config.md, "代理"): the CLI's in-process, the daemon's own in the daemon. Default: none,
   * so a library caller is never surprised by a proxy it did not ask for.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /** Base of relative `roots` entries and the meaning of `~`: the CLI's working directory and home (config.md, `roots`). */
  roots?: { cwd: string; home: string };
}

const METHOD_NOT_FOUND = -32601;

/** An object with a string member `key`: the minimum a list entry needs to be usable. */
function hasString(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)[key] === 'string';
}

/** Safety net against a server that keeps returning cursors. */
const MAX_LIST_PAGES = 1000;
/** How much of a stdio child's stderr we keep for error messages. */
const STDERR_KEEP = 4096;
/** Ceiling for the best-effort HTTP session termination on close. */
const TERMINATE_WAIT_MS = 1000;
/**
 * How long the `server/discover` probe of a stdio server may stay unanswered before it counts as a server
 * of the old protocol: some never answer a request that comes before `initialize`, and waiting out the
 * whole connect timeout would make every such server slow to start. HTTP has no such limit: silence there
 * is an outage, not an answer.
 */
const STDIO_PROBE_TIMEOUT_MS = 3000;
/** Delays between attempts to open the `subscriptions/listen` stream again after it dropped. */
const RELISTEN_FIRST_MS = 1000;
const RELISTEN_MAX_MS = 30_000;

/**
 * How the connection settles on a protocol version (config.md, `protocolVersion`; daemon.md, "协议版本与无状态连接").
 * Unpinned: newest first, automatically. The probe is `server/discover`; a server that answers it speaks the
 * stateless protocol, any other answer falls back to the `initialize` handshake on the same connection. A
 * stdio probe runs on a short-lived copy of the server process, so the real one starts once the protocol is
 * known (the SDK's choice; a server that dies on a request before `initialize` is then simply an old server).
 * Pinned: that version or an error. A stateless pin must be offered by the probe; an older pin is the
 * plain handshake that offers nothing else and rejects another counter-offer.
 */
function negotiation(pin: string | undefined, stdio: boolean): Pick<ClientOptions, 'versionNegotiation' | 'supportedProtocolVersions'> {
  const probe = stdio ? { timeoutMs: STDIO_PROBE_TIMEOUT_MS } : {};
  if (pin === undefined) return { versionNegotiation: { mode: 'auto', probe } };
  if (isModernProtocolVersion(pin)) return { versionNegotiation: { mode: { pin }, probe } };
  return { versionNegotiation: { mode: 'legacy' }, supportedProtocolVersions: [pin] };
}

/** A connection being made; `close()` abandons it. */
interface Attempt {
  aborted: boolean;
  controller: AbortController;
  client?: Client;
}

interface Handle {
  client: Client;
  closed: boolean;
  /** What the handshake (or the probe) settled on. */
  protocol: ProtocolInfo;
  stderr: () => string;
  /** Process id of the stdio child. */
  pid?: () => number | null;
  terminate?: () => Promise<void>;
}

type Sdk = {
  Client: typeof import('@modelcontextprotocol/client').Client;
};

let sdkPromise: Promise<Sdk> | undefined;

function loadSdk(): Promise<Sdk> {
  sdkPromise ??= import('@modelcontextprotocol/client').then(({ Client }) => ({ Client }));
  return sdkPromise;
}

/**
 * Result "schema" that accepts anything. via sends requests through it instead of the SDK's typed
 * methods (`listTools()`, `readResource()`, …): those check every result against the full MCP schema
 * and fail the whole operation on one malformed entry, while via keeps what it can use (a list entry
 * with a `name`, a content with a `uri`) and renders the rest as the server sent it.
 */
const RAW: StandardSchemaV1<unknown, unknown> = {
  '~standard': { version: 1, vendor: 'via', validate: (value: unknown) => ({ value }) },
};

/**
 * The SDK's `callTool()` checks the result against the tool's `outputSchema` and throws when
 * `structuredContent` is missing, does not match, or the schema does not compile. via shows a result
 * as the server sent it and only warns about a mismatch (arguments.md, "输出校验"; done in the CLI),
 * so this provider hands the SDK no validator at all: with none, `callTool()` skips every check.
 */
const LENIENT_VALIDATOR = { getValidator: () => undefined } as unknown as NonNullable<ClientOptions['jsonSchemaValidator']>;

/**
 * A lazily connected session to one server. Operations are limited to `ServerConfig.concurrency`
 * at a time; the rest queue. A broken session is dropped and reconnected on the next operation.
 */
export class McpSession {
  private handle?: Handle;
  private connecting?: Promise<Handle>;
  private readonly limiter: Limiter;
  private oauth?: ViaOAuthProvider;
  /** Where warnings go: the operation that started last (the one that most likely caused it). */
  private warnSink?: (message: string) => void;
  private warnedSave = false;
  /** What the last connection of this session negotiated (kept across reconnects). */
  private lastProtocol?: ProtocolInfo;
  /** Abandons the connection being made (`close()` while connecting). */
  private abortConnect?: () => void;

  constructor(
    readonly server: ServerConfig,
    private readonly resolver: CredentialResolver,
    private readonly options: SessionOptions = {},
  ) {
    this.limiter = new Limiter(server.concurrency);
  }

  /** Whether a live connection exists right now. */
  get connected(): boolean {
    return this.handle !== undefined && !this.handle.closed;
  }

  /** Process id of the running stdio child, if any. */
  get pid(): number | undefined {
    if (!this.handle || this.handle.closed) return undefined;
    return this.handle.pid?.() ?? undefined;
  }

  /** The negotiated protocol version and whether the connection is stateful; undefined while not connected. */
  protocol(): ProtocolInfo | undefined {
    return this.handle && !this.handle.closed ? this.handle.protocol : undefined;
  }

  /** `tools/list`, following `nextCursor` until the server stops returning one. */
  listTools(options: ListOptions = {}): Promise<McpTool[]> {
    return this.operate(options.timeoutMs ?? this.defaultTimeoutMs(), options.onWarning, (handle, left) =>
      this.pages<McpTool>(handle, 'tools/list', 'tools', left, (e): e is McpTool => hasString(e, 'name'), (page) => {
        const ttl = page.ttlMs;
        if (typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0) options.onTtl?.(ttl);
      }),
    );
  }

  /** What the server declared at `initialize`, once connected; undefined before the first connection. */
  features(): ServerFeatures | undefined {
    const capabilities = this.handle && !this.handle.closed ? this.handle.client.getServerCapabilities() : undefined;
    return capabilities ? { resources: capabilities.resources !== undefined, prompts: capabilities.prompts !== undefined, completions: capabilities.completions !== undefined } : undefined;
  }

  /** What the server says about itself (`serverInfo`, `instructions`), once connected; undefined before the first connection. */
  info(): ServerSelf | undefined {
    if (!this.handle || this.handle.closed) return undefined;
    return describeServer(this.handle.client.getServerVersion() as Record<string, unknown> | undefined, this.handle.client.getInstructions(), this.redactor());
  }

  /**
   * `completion/complete`: the server's suggestions for one argument of a prompt or resource template, given
   * what is typed so far and the other arguments as context. A server without the capability is refused
   * before any request. Suggestions are kept in the server's order (it sends at most 100).
   */
  complete(ref: CompletionRef, argument: { name: string; value: string }, context: Record<string, string> | undefined, options: ListOptions = {}): Promise<CompletionResult> {
    return this.operate(options.timeoutMs ?? this.defaultTimeoutMs(), undefined, async (handle, left) => {
      this.require(handle, 'completions');
      const params = { ref, argument, ...(context && Object.keys(context).length > 0 ? { context: { arguments: context } } : {}) };
      const raw = (await handle.client.request({ method: 'completion/complete', params }, RAW, { timeout: left() })) as { completion?: unknown };
      const completion = raw.completion as { values?: unknown; total?: unknown; hasMore?: unknown } | undefined;
      if (typeof completion !== 'object' || completion === null || !Array.isArray(completion.values)) throw new Error('completion/complete result has no "completion.values" array');
      return {
        values: completion.values.filter((v): v is string => typeof v === 'string'),
        ...(typeof completion.total === 'number' ? { total: completion.total } : {}),
        ...(typeof completion.hasMore === 'boolean' ? { hasMore: completion.hasMore } : {}),
      };
    });
  }

  /** `resources/list` and `resources/templates/list` (ADR 0010). A server without the capability is refused before any request. */
  listResources(options: ListOptions = {}): Promise<ResourceListing> {
    return this.operate(options.timeoutMs ?? this.defaultTimeoutMs(), undefined, async (handle, left) => {
      this.require(handle, 'resources');
      const resources = await this.pages<ResourceListing['resources'][number]>(handle, 'resources/list', 'resources', left, (e): e is ResourceListing['resources'][number] => hasString(e, 'uri'));
      // Templates are optional even for a server with resources: "method not found" means none.
      const templates = await this.pages<ResourceListing['templates'][number]>(handle, 'resources/templates/list', 'resourceTemplates', left, (e): e is ResourceListing['templates'][number] => hasString(e, 'uriTemplate')).catch((err: unknown) => {
        if ((err as { code?: unknown } | null)?.code === METHOD_NOT_FOUND) return [];
        throw err;
      });
      return { resources, templates };
    });
  }

  /** `resources/read`. An unknown or unreadable URI is a "not found" (exit code 3). */
  readResource(uri: string, options: ListOptions = {}): Promise<ReadResourceResult> {
    return this.operate(options.timeoutMs ?? this.defaultTimeoutMs(), undefined, async (handle, left) => {
      this.require(handle, 'resources');
      const raw = await handle.client.request({ method: 'resources/read', params: { uri } }, RAW, { timeout: left() }).catch((err: unknown) => {
        throw resourceNotFound(err, uri, this.server.provider, this.redactor()) ?? err;
      });
      const contents = (raw as { contents?: unknown }).contents;
      if (!Array.isArray(contents)) throw new Error('resources/read result has no "contents" array');
      return { contents: contents.filter((c): c is ReadResourceResult['contents'][number] => hasString(c, 'uri')) };
    });
  }

  /** `prompts/list`, following `nextCursor`. */
  listPrompts(options: ListOptions = {}): Promise<McpPrompt[]> {
    return this.operate(options.timeoutMs ?? this.defaultTimeoutMs(), undefined, async (handle, left) => {
      this.require(handle, 'prompts');
      return this.pages<McpPrompt>(handle, 'prompts/list', 'prompts', left, (e): e is McpPrompt => hasString(e, 'name'));
    });
  }

  /** `prompts/get`. The server rejecting the arguments surfaces like a tool doing so (exit code 1). */
  getPrompt(name: string, args: Record<string, string>, options: ListOptions = {}): Promise<GetPromptResult> {
    return this.operate(options.timeoutMs ?? this.defaultTimeoutMs(), undefined, async (handle, left) => {
      this.require(handle, 'prompts');
      const raw = await handle.client.request({ method: 'prompts/get', params: { name, arguments: args } }, RAW, { timeout: left() });
      const messages = (raw as { messages?: unknown }).messages;
      if (!Array.isArray(messages)) throw new Error('prompts/get result has no "messages" array');
      const description = (raw as { description?: unknown }).description;
      return {
        ...(typeof description === 'string' ? { description } : {}),
        messages: messages.filter((m): m is GetPromptResult['messages'][number] => hasString(m, 'role') && typeof (m as { content?: unknown }).content === 'object'),
      };
    });
  }

  /** `tools/call`; returns the server's result untouched (`isError` included). */
  callTool(rawName: string, args: Record<string, unknown> | undefined, options: CallOptions = {}): Promise<ToolCallResult> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs();
    let deadline = Date.now() + timeoutMs;
    const left = (): number => Math.max(1, deadline - Date.now());
    return this.limiter.run(async () => {
      if (options.onWarning) this.warnSink = options.onWarning;
      const attempt = async (): Promise<ToolCallResult> => {
        const handle = await this.ensureConnected(left(), timeoutMs);
        return this.request(handle, 'request', timeoutMs, async () => {
          const params = { name: rawName, arguments: args ?? {} };
          const send = { timeout: left(), ...(options.onProgress ? { onprogress: options.onProgress } : {}) };
          // The stateless protocol has the SDK mirror tool arguments the tool declared with `x-mcp-header`
          // into request headers (a server refuses the call without them); on the old protocol the result
          // is taken as the server sent it.
          const raw: unknown =
            handle.client.getProtocolEra() === 'modern'
              ? await handle.client.callTool(params, send)
              : await handle.client.request({ method: 'tools/call', params }, RAW, send);
          if (typeof raw !== 'object' || raw === null) throw new Error('tools/call returned a non-object result');
          return raw as ToolCallResult;
        });
      };
      try {
        return await attempt();
      } catch (err) {
        if (!(options.retry && err instanceof ClientError && err.retryable)) throw err;
        await this.drop();
        deadline = Date.now() + timeoutMs; // the retry has a budget of its own
        return attempt();
      }
    }, this.queueWait(timeoutMs));
  }

  /**
   * Close the session and kill the stdio child, if any. A connection still being made is abandoned
   * (its child killed) rather than waited for: a server that hangs in its handshake must not hold
   * up a daemon that is stopping. Safe to call repeatedly.
   */
  async close(): Promise<void> {
    const pending = this.connecting;
    if (pending) {
      this.abortConnect?.();
      await pending.catch(() => undefined);
    }
    await this.drop();
  }

  // Internals ---------------------------------------------------------------------------------

  /**
   * One operation within one budget of `timeoutMs`: the wait for a free slot (`concurrency`), for the
   * connection, and every request it sends all count against it (`left` is what remains). A server
   * that hangs in its handshake (the connection itself may take the server's own `timeout`) or sits
   * behind a long call then fails this operation in time, instead of holding its caller (a CLI
   * waiting on the daemon) for as long as the slowest step takes.
   */
  private operate<T>(timeoutMs: number, onWarning: ((message: string) => void) | undefined, fn: (handle: Handle, left: () => number) => Promise<T>): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    const left = (): number => Math.max(1, deadline - Date.now());
    return this.limiter.run(async () => {
      if (onWarning) this.warnSink = onWarning;
      const handle = await this.ensureConnected(left(), timeoutMs);
      return this.request(handle, 'request', timeoutMs, () => fn(handle, left));
    }, this.queueWait(timeoutMs));
  }

  /** How long an operation may wait for a slot: its whole budget; it then fails as a timeout. */
  private queueWait(timeoutMs: number): { ms: number; error: () => Error } {
    return { ms: timeoutMs, error: () => timedOut(this.server, 'request', timeoutMs) };
  }

  /** Follow `nextCursor` of a list method and collect `key` from every page; `left` is the time remaining. */
  private async pages<T>(handle: Handle, method: string, key: string, left: () => number, keep: (entry: unknown) => entry is T, first?: (page: Record<string, unknown>) => void): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const raw = (await handle.client.request({ method, params: cursor === undefined ? {} : { cursor } }, RAW, { timeout: left() })) as Record<string, unknown>;
      if (page === 0) first?.(raw);
      const entries = raw[key];
      if (!Array.isArray(entries)) throw new Error(`${method} result has no "${key}" array`);
      for (const entry of entries) if (keep(entry)) items.push(entry);
      const next = (raw as { nextCursor?: unknown }).nextCursor;
      if (typeof next !== 'string' || next === '') return items;
      if (seen.has(next)) throw new Error(`${method} returned the same cursor twice`);
      seen.add(next);
      cursor = next;
    }
    throw new Error(`${method} did not finish after ${MAX_LIST_PAGES} pages`);
  }

  /** Refuse a request the server did not declare support for, instead of sending it. */
  private require(handle: Handle, feature: keyof ServerFeatures): void {
    if (handle.client.getServerCapabilities()?.[feature] === undefined) throw noFeature(this.server, feature);
  }

  private defaultTimeoutMs(): number {
    return this.server.timeout * 1000;
  }

  private redactor(): (text: string) => string {
    return createRedactor(this.resolver.resolvedValues());
  }

  /** Run `fn`, mapping any failure to a ClientError. */
  private async request<T>(handle: Handle, phase: Phase, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw mapError(err, {
        server: this.server,
        phase,
        timeoutMs,
        redact: this.redactor(),
        stderrTail: handle.stderr(),
      });
    }
  }

  /**
   * The live connection, made on first use and shared by every operation. An operation waits for it
   * at most `waitMs` and then fails as a connect timeout of `timeoutMs`; the connection attempt itself
   * goes on (up to the server's `timeout`), so the next operation may find it ready.
   */
  private ensureConnected(waitMs: number, timeoutMs: number): Promise<Handle> {
    if (this.handle && !this.handle.closed) return Promise.resolve(this.handle);
    this.handle = undefined;
    this.connecting ??= this.connect().then(
      (handle) => {
        this.handle = handle;
        this.connecting = undefined;
        return handle;
      },
      (err: unknown) => {
        this.connecting = undefined;
        throw err;
      },
    );
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timedOut(this.server, 'connect', timeoutMs)), waitMs);
    });
    return Promise.race([this.connecting, late]).finally(() => clearTimeout(timer));
  }

  private connect(): Promise<Handle> {
    const attempt: Attempt = { aborted: false, controller: new AbortController() };
    const abort = (): void => {
      attempt.aborted = true;
      attempt.controller.abort(); // ends a protocol probe in progress (the SDK would otherwise finish it first)
      void attempt.client?.close().catch(() => undefined); // kills a half-started child
    };
    this.abortConnect = abort;
    return this.open(attempt).finally(() => {
      if (this.abortConnect === abort) this.abortConnect = undefined;
    });
  }

  private async open(attempt: Attempt): Promise<Handle> {
    const { server } = this;
    // Checks that must pass before anything is spawned or sent.
    if (server.disabled) throw notFoundServer(server.name, []);
    if (!server.trusted) throw untrustedServer(server);

    const timeoutMs = this.defaultTimeoutMs();
    let resolved: ResolvedConnection;
    let authFetch: FetchLike | undefined;
    try {
      resolved = await resolveConnection(server, this.resolver);
      // Without a saved login this fails right here, before any request (auth.md, "调用时的行为").
      if (server.auth.type === 'oauth') authFetch = await this.oauthFetch();
    } catch (err) {
      throw mapError(err, { server, phase: 'connect', timeoutMs, redact: this.redactor() });
    }

    // Probing a stdio server starts it twice (the SDK probes a copy), which is slow for a server that
    // takes seconds to start and wrong for one with side effects at startup. So a stdio server that was
    // last seen speaking the old protocol is connected with the plain handshake and no probe; if that
    // fails for a reason other than a timeout, it is tried once more with the probe (it may have moved on).
    const known = resolved.type === 'stdio' && server.protocolVersion === undefined ? (this.lastProtocol ?? this.options.knownProtocol?.(server)) : undefined;
    const skipProbe = known !== undefined && known.version !== '' && !isModernProtocolVersion(known.version);
    try {
      return await this.establish(attempt, resolved, authFetch, skipProbe);
    } catch (err) {
      if (!skipProbe || attempt.aborted || !(err instanceof ClientError) || err.retryable) throw err;
      return this.establish(attempt, resolved, authFetch, false);
    }
  }

  /** Make the client and its transport and connect them: one try, `legacy` meaning "plain handshake, no probe". */
  private async establish(attempt: Attempt, resolved: ResolvedConnection, authFetch: FetchLike | undefined, legacy: boolean): Promise<Handle> {
    const { server } = this;
    const timeoutMs = this.defaultTimeoutMs();
    let stderrBuf = '';
    let client: Client | undefined;
    let handle: Handle | undefined;
    try {
      const { Client: ClientCtor } = await loadSdk();
      // The `roots` capability is declared only when the server has roots configured (ADR 0010), and
      // never as `listChanged`: the roots of a session do not change during its life.
      const roots = resolveRoots(server.roots, this.options.roots ?? { cwd: process.cwd(), home: process.env.HOME ?? '' });
      const onToolsChanged = this.options.onToolsChanged;
      client = new ClientCtor(
        { name: 'via', version: pkg.version },
        {
          capabilities: roots.length > 0 ? { roots: { listChanged: false } } : {},
          jsonSchemaValidator: LENIENT_VALIDATOR,
          ...negotiation(server.protocolVersion, resolved.type === 'stdio'),
          // Only a signal: via lists again itself (the daemon's catalog refresh), not the SDK.
          ...(onToolsChanged ? { listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => onToolsChanged() } } } : {}),
        },
      );
      attempt.client = client;
      if (roots.length > 0) client.setRequestHandler('roots/list', () => ({ roots }));
      let transport: Transport;
      let terminate: (() => Promise<void>) | undefined;
      let pid: (() => number | null) | undefined;
      let sessionId: (() => string | undefined) | undefined;

      if (resolved.type === 'stdio') {
        const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
        // Windows: PATH/PATHEXT lookup that never looks in the working directory, `.cmd` shims checked
        // for arguments `cmd.exe` cannot carry (platform/command.ts). A no-op elsewhere.
        const prepared = prepareStdioCommand(resolved.command, resolved.args, { env: resolved.env, cwd: resolved.cwd ?? process.cwd(), platform: process.platform });
        if (!prepared.ok) throw Object.assign(new Error(prepared.message), { code: prepared.code });
        const stdio = new StdioClientTransport({
          command: prepared.command,
          args: resolved.args,
          env: resolved.env,
          ...(resolved.cwd !== undefined ? { cwd: resolved.cwd } : {}),
          stderr: 'pipe',
        });
        // Child stderr is never forwarded: it could echo credentials. Keep a tail for error messages.
        stdio.stderr?.on('data', (chunk: Buffer | string) => {
          stderrBuf = (stderrBuf + chunk.toString()).slice(-STDERR_KEEP);
        });
        pid = () => stdio.pid;
        transport = stdio;
      } else {
        let url: URL;
        try {
          url = new URL(resolved.url);
        } catch {
          throw internal(`invalid url for ${server.provider}: not a URL`);
        }
        const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
        // Through the proxy the environment asks for, if any; the OAuth fetch (made in `oauthFetch`) wraps the same one.
        const send = authFetch ?? this.proxied();
        const http = new StreamableHTTPClientTransport(url, { requestInit: { headers: resolved.headers }, ...(send ? { fetch: send } : {}) });
        terminate = () => http.terminateSession();
        sessionId = () => http.sessionId;
        transport = http;
      }

      const created: Handle = { client, closed: false, protocol: { version: '', stateful: false }, stderr: () => stderrBuf, ...(pid ? { pid } : {}), ...(terminate ? { terminate } : {}) };
      handle = created;
      client.onclose = () => {
        created.closed = true;
      };
      if (attempt.aborted) throw new Error('the session was closed while connecting');
      await client.connect(transport, { timeout: timeoutMs, signal: attempt.controller.signal, ...(legacy ? { prior: { kind: 'legacy' as const } } : {}) });
      const modern = client.getProtocolEra() === 'modern';
      // A stdio process is a session of its own; an HTTP server of the old protocol has one if it handed out an id.
      created.protocol = { version: client.getNegotiatedProtocolVersion() ?? '', stateful: !modern && (resolved.type === 'stdio' || sessionId?.() !== undefined) };
      if (onToolsChanged) this.watchListen(created, client.autoOpenedSubscription);
      this.lastProtocol = created.protocol;
      return created;
    } catch (err) {
      const mapped = mapError(err, { server, phase: 'connect', timeoutMs, redact: this.redactor(), stderrTail: stderrBuf });
      if (client) await client.close().catch(() => undefined); // kills a half-started child
      if (handle) handle.closed = true;
      throw mapped;
    }
  }

  /**
   * On the stateless protocol list changes arrive on a `subscriptions/listen` stream the SDK opened at
   * connect. The SDK never opens it again after a drop, and without it the catalog would silently stop
   * following the server, so a stream that ends without the server saying goodbye is opened again with a
   * growing delay (1 s to 30 s), and the daemon is told to refresh: events may have been missed meanwhile.
   */
  private watchListen(handle: Handle, subscription: McpSubscription | undefined): void {
    if (!subscription) return;
    void subscription.closed.then((reason) => {
      if (reason === 'remote' && !handle.closed) void this.relisten(handle, subscription.honoredFilter);
    });
  }

  private async relisten(handle: Handle, filter: SubscriptionFilter): Promise<void> {
    let delay = RELISTEN_FIRST_MS;
    while (!handle.closed) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay).unref());
      if (handle.closed) return;
      try {
        const next = await handle.client.listen(filter, { timeout: this.defaultTimeoutMs() });
        if (handle.closed) {
          await next.close().catch(() => undefined);
          return;
        }
        this.watchListen(handle, next);
        this.options.onToolsChanged?.();
        return;
      } catch {
        delay = Math.min(delay * 2, RELISTEN_MAX_MS);
      }
    }
  }

  /**
   * A fetch that attaches the OAuth access token and refreshes it when due. The provider outlives
   * reconnects: a long-lived session (a daemon's) keeps refreshing through it.
   */
  private async oauthFetch(): Promise<FetchLike> {
    if (!this.oauth) {
      const { createCallProvider, createOAuthStore } = await import('./oauth');
      const track = (value: string): void => this.resolver.track?.(value);
      this.oauth = createCallProvider(this.server, this.options.oauthStore ?? createOAuthStore(), {
        track,
        resolveCredential: (ref) => this.resolver.resolve(ref, this.server.origin),
        ...(this.proxied() ? { fetch: this.proxied()! } : {}),
        ...(this.options.now ? { now: this.options.now } : {}),
        onSaveFailed: (reason) => {
          if (this.warnedSave) return;
          this.warnedSave = true;
          this.warn(
            `could not save the refreshed OAuth login for ${this.server.provider} (${reason}); the new token is used for now, but a server that rotates refresh tokens will ask for a new login. Make the login store writable (via doctor)`,
          );
        },
      });
    }
    await this.oauth.requireLogin();
    return this.oauth.createFetch(this.proxied());
  }

  /** A `fetch` through the configured proxy, or undefined when the environment names none. */
  private proxied(): FetchLike | undefined {
    return this.options.env ? proxyFetch(this.options.env, { track: (value) => this.resolver.track?.(value) }) : undefined;
  }

  private warn(message: string): void {
    (this.warnSink ?? this.options.onWarning)?.(message);
  }

  /** Tear down the current connection (if any). */
  private async drop(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    if (!handle) return;
    handle.closed = true;
    if (handle.terminate) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        handle.terminate().catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, TERMINATE_WAIT_MS);
          timer.unref();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    await handle.client.close().catch(() => undefined);
  }
}
