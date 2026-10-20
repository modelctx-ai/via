// One MCP session per server over stdio or Streamable HTTP. The SDK is imported lazily, on the first
// connection, so nothing here costs CLI cold start (implementation.md, "启动速度").
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import pkg from '../../package.json';
import type { CredentialResolver, ServerConfig } from '../config/types';
import type { ToolCallResult } from '../protocol';
import type { McpTool } from '../catalog/types';
import { createRedactor } from '../render/redact';
import { resolveConnection, type ResolvedConnection } from './credentials';
import { ClientError, internal, mapError, notFoundServer, untrustedServer, type Phase } from './errors';
import { Limiter } from './limiter';
import type { ViaOAuthProvider } from './oauth/provider';
import type { OAuthStore } from './oauth/store';

export interface CallOptions {
  /** Overrides `ServerConfig.timeout` for this call. */
  timeoutMs?: number;
  /** Retry once after a timeout or lost connection. Callers pass this only for `readOnlyHint` tools. */
  retry?: boolean;
  /** Called for upstream `notifications/progress` (arguments.md, "调用过程"). */
  onProgress?: (progress: { progress: number; total?: number; message?: string }) => void;
}

export interface ListOptions {
  timeoutMs?: number;
}

export interface SessionOptions {
  /** Where OAuth logins live (auth.md). Default: the user's keychain / data directory. */
  oauthStore?: OAuthStore;
  /** Clock for token expiry; tests inject one. */
  now?: () => number;
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
  terminate?: () => Promise<void>;
}

type Sdk = {
  Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client;
  ResultSchema: typeof import('@modelcontextprotocol/sdk/types.js').ResultSchema;
};

let sdkPromise: Promise<Sdk> | undefined;

function loadSdk(): Promise<Sdk> {
  sdkPromise ??= Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]).then(([c, t]) => ({ Client: c.Client, ResultSchema: t.ResultSchema }));
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

  /** `tools/list`, following `nextCursor` until the server stops returning one. */
  listTools(options: ListOptions = {}): Promise<McpTool[]> {
    return this.limiter.run(async () => {
      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs();
      const handle = await this.ensureConnected();
      return this.request(handle, 'request', timeoutMs, async () => {
        const { ResultSchema } = await loadSdk();
        const tools: McpTool[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
          const raw = await handle.client.request(
            { method: 'tools/list', params: cursor === undefined ? {} : { cursor } },
            ResultSchema,
            { timeout: timeoutMs },
          );
          const entries = (raw as { tools?: unknown }).tools;
          if (!Array.isArray(entries)) throw new Error('tools/list result has no "tools" array');
          for (const entry of entries) {
            if (typeof entry === 'object' && entry !== null && typeof (entry as McpTool).name === 'string') {
              tools.push(entry as McpTool);
            }
          }
          const next = (raw as { nextCursor?: unknown }).nextCursor;
          if (typeof next !== 'string' || next === '') return tools;
          if (seen.has(next)) throw new Error('tools/list returned the same cursor twice');
          seen.add(next);
          cursor = next;
        }
        throw new Error(`tools/list did not finish after ${MAX_LIST_PAGES} pages`);
      });
    });
  }

  /** `tools/call`; returns the server's result untouched (`isError` included). */
  callTool(rawName: string, args: Record<string, unknown> | undefined, options: CallOptions = {}): Promise<ToolCallResult> {
    return this.limiter.run(async () => {
      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs();
      const attempt = async (): Promise<ToolCallResult> => {
        const handle = await this.ensureConnected();
        return this.request(handle, 'request', timeoutMs, async () => {
          const { ResultSchema } = await loadSdk();
          const raw = await handle.client.request(
            { method: 'tools/call', params: { name: rawName, arguments: args ?? {} } },
            ResultSchema,
            {
              timeout: timeoutMs,
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
        return attempt();
      }
    });
  }

  /** Close the session and kill the stdio child, if any. Safe to call repeatedly. */
  async close(): Promise<void> {
    const pending = this.connecting;
    if (pending) await pending.catch(() => undefined);
    await this.drop();
  }

  // Internals ---------------------------------------------------------------------------------

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

  private ensureConnected(): Promise<Handle> {
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
    return this.connecting;
  }

  private async connect(): Promise<Handle> {
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
      const { Client: ClientCtor } = await loadSdk();
      client = new ClientCtor({ name: 'via', version: pkg.version }, { capabilities: {} });
      let transport: Transport;
      let terminate: (() => Promise<void>) | undefined;

      if (resolved.type === 'stdio') {
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
        const stdio = new StdioClientTransport({
          command: resolved.command,
          args: resolved.args,
          env: resolved.env,
          ...(resolved.cwd !== undefined ? { cwd: resolved.cwd } : {}),
          stderr: 'pipe',
        });
        // Child stderr is never forwarded: it could echo credentials. Keep a tail for error messages.
        stdio.stderr?.on('data', (chunk: Buffer | string) => {
          stderrBuf = (stderrBuf + chunk.toString()).slice(-STDERR_KEEP);
        });
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

      const created: Handle = { client, closed: false, stderr: () => stderrBuf, ...(terminate ? { terminate } : {}) };
      handle = created;
      client.onclose = () => {
        created.closed = true;
      };
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
      });
    }
    await this.oauth.requireLogin();
    return this.oauth.createFetch();
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
