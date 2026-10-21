// One MCP session per server over stdio or Streamable HTTP. The SDK is imported lazily, on the first
// connection, so nothing here costs CLI cold start (implementation.md, "启动速度").
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import pkg from '../../package.json';
import type { CredentialResolver, ServerConfig } from '../config/types';
import type { GetPromptResult, McpPrompt, ReadResourceResult, ResourceListing, ServerFeatures, ToolCallResult } from '../protocol';
import type { McpTool } from '../catalog/types';
import { createRedactor } from '../render/redact';
import { resolveConnection, type ResolvedConnection } from './credentials';
import { ClientError, internal, mapError, noFeature, notFoundServer, resourceNotFound, timedOut, untrustedServer, type Phase } from './errors';
import { prepareStdioCommand } from '../platform/command';
import { Limiter } from './limiter';
import { resolveRoots } from './roots';
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
  /** Something the person should know about, caused by this operation (see `SessionOptions.onWarning`). */
  onWarning?: (message: string) => void;
}

export interface SessionOptions {
  /** Where OAuth logins live (auth.md). Default: the user's keychain / data directory. */
  oauthStore?: OAuthStore;
  /** Clock for token expiry; tests inject one. */
  now?: () => number;
  /**
   * The server sent `notifications/tools/list_changed` (the daemon refreshes its catalog on it).
   * Runs on the connection that received it; must not throw.
   */
  onToolsChanged?: () => void;
  /**
   * A warning for the person running the command (`warning: …` on stderr), e.g. a refreshed OAuth
   * login that could not be saved. Per-operation `onWarning` takes precedence. Each warning is
   * given once per session.
   */
  onWarning?: (message: string) => void;
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

interface Handle {
  client: Client;
  closed: boolean;
  stderr: () => string;
  /** Process id of the stdio child. */
  pid?: () => number | null;
  terminate?: () => Promise<void>;
}

type Sdk = {
  Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client;
  ResultSchema: typeof import('@modelcontextprotocol/sdk/types.js').ResultSchema;
  ToolListChangedNotificationSchema: typeof import('@modelcontextprotocol/sdk/types.js').ToolListChangedNotificationSchema;
  ListRootsRequestSchema: typeof import('@modelcontextprotocol/sdk/types.js').ListRootsRequestSchema;
};

let sdkPromise: Promise<Sdk> | undefined;

function loadSdk(): Promise<Sdk> {
  sdkPromise ??= Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]).then(([c, t]) => ({
    Client: c.Client,
    ResultSchema: t.ResultSchema,
    ToolListChangedNotificationSchema: t.ToolListChangedNotificationSchema,
    ListRootsRequestSchema: t.ListRootsRequestSchema,
  }));
  return sdkPromise;
}

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

  /** `tools/list`, following `nextCursor` until the server stops returning one. */
  listTools(options: ListOptions = {}): Promise<McpTool[]> {
    return this.operate(options.timeoutMs ?? this.defaultTimeoutMs(), options.onWarning, (handle, left) =>
      this.pages<McpTool>(handle, 'tools/list', 'tools', left, (e): e is McpTool => hasString(e, 'name')),
    );
  }

  /** What the server declared at `initialize`, once connected; undefined before the first connection. */
  features(): ServerFeatures | undefined {
    const capabilities = this.handle && !this.handle.closed ? this.handle.client.getServerCapabilities() : undefined;
    return capabilities ? { resources: capabilities.resources !== undefined, prompts: capabilities.prompts !== undefined } : undefined;
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
      const { ResultSchema } = await loadSdk();
      const raw = await handle.client.request({ method: 'resources/read', params: { uri } }, ResultSchema, { timeout: left() }).catch((err: unknown) => {
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
      const { ResultSchema } = await loadSdk();
      const raw = await handle.client.request({ method: 'prompts/get', params: { name, arguments: args } }, ResultSchema, { timeout: left() });
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
          const { ResultSchema } = await loadSdk();
          const raw = await handle.client.request(
            { method: 'tools/call', params: { name: rawName, arguments: args ?? {} } },
            ResultSchema,
            {
              timeout: left(),
              ...(options.onProgress ? { onprogress: options.onProgress } : {}),
            },
          );
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
  private async pages<T>(handle: Handle, method: string, key: string, left: () => number, keep: (entry: unknown) => entry is T): Promise<T[]> {
    const { ResultSchema } = await loadSdk();
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const raw = await handle.client.request({ method, params: cursor === undefined ? {} : { cursor } }, ResultSchema, { timeout: left() });
      const entries = (raw as Record<string, unknown>)[key];
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
    const attempt: { aborted: boolean; client?: Client } = { aborted: false };
    const abort = (): void => {
      attempt.aborted = true;
      void attempt.client?.close().catch(() => undefined); // kills a half-started child
    };
    this.abortConnect = abort;
    return this.open(attempt).finally(() => {
      if (this.abortConnect === abort) this.abortConnect = undefined;
    });
  }

  private async open(attempt: { aborted: boolean; client?: Client }): Promise<Handle> {
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

    let stderrBuf = '';
    let client: Client | undefined;
    let handle: Handle | undefined;
    try {
      const { Client: ClientCtor, ToolListChangedNotificationSchema, ListRootsRequestSchema } = await loadSdk();
      // The `roots` capability is declared only when the server has roots configured (ADR 0010), and
      // never as `listChanged`: the roots of a session do not change during its life.
      const roots = resolveRoots(server.roots, this.options.roots ?? { cwd: process.cwd(), home: process.env.HOME ?? '' });
      client = new ClientCtor({ name: 'via', version: pkg.version }, { capabilities: roots.length > 0 ? { roots: { listChanged: false } } : {} });
      attempt.client = client;
      if (roots.length > 0) client.setRequestHandler(ListRootsRequestSchema, () => ({ roots }));
      const onToolsChanged = this.options.onToolsChanged;
      if (onToolsChanged) client.setNotificationHandler(ToolListChangedNotificationSchema, () => onToolsChanged());
      let transport: Transport;
      let terminate: (() => Promise<void>) | undefined;
      let pid: (() => number | null) | undefined;

      if (resolved.type === 'stdio') {
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
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
        const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
        const http = new StreamableHTTPClientTransport(url, { requestInit: { headers: resolved.headers }, ...(authFetch ? { fetch: authFetch } : {}) });
        terminate = () => http.terminateSession();
        transport = http;
      }

      const created: Handle = { client, closed: false, stderr: () => stderrBuf, ...(pid ? { pid } : {}), ...(terminate ? { terminate } : {}) };
      handle = created;
      client.onclose = () => {
        created.closed = true;
      };
      if (attempt.aborted) throw new Error('the session was closed while connecting');
      await client.connect(transport, { timeout: timeoutMs });
      return created;
    } catch (err) {
      const mapped = mapError(err, { server, phase: 'connect', timeoutMs, redact: this.redactor(), stderrTail: stderrBuf });
      if (client) await client.close().catch(() => undefined); // kills a half-started child
      if (handle) handle.closed = true;
      throw mapped;
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
    return this.oauth.createFetch();
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
