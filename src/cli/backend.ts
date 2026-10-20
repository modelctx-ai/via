// The one place the commands reach MCP servers through (daemon.md). A backend either talks to the
// daemon over its socket or connects from this process; commands cannot tell which, so everything
// built on `App` (`call`, `batch`, `auth`, `doctor`…) gets session reuse without knowing about it.
// This file stays light: the MCP SDK, ajv and the socket client load only when a backend is made.
import { join } from 'node:path';
import type { McpTool } from '../catalog/types';
import type { CallOptions, McpClient } from '../client';
import type { CredentialResolver, ServerConfig } from '../config/types';
import type { ToolCallResult } from '../protocol';
import { FileCursorStore } from '../render/cursor-file';
import { ExitCode } from '../render/exit-codes';
import { createRedactor } from '../render/redact';
import type { CursorRecord, CursorStore } from '../render/cursor';
import type { SchemaCompiler } from './args/validate';
import type { OAuthStore } from '../client/oauth/store';
import type { CatalogCache } from './catalog-cache';

/** A fetched `tools/list` and where it came from. */
export interface Listing {
  tools: McpTool[];
  fetchedAt: number;
  fromCache: boolean;
}

export interface ListingOptions {
  /** Per-request ceiling in milliseconds. */
  timeoutMs: number;
  /** Skip the cache and ask the server (`via sync`, `via doctor`). */
  refresh?: boolean;
}

/**
 * What the commands need from "the thing that talks to MCP servers". `McpClient` (raw `listTools`,
 * `callTool`, `close`) stays the base so code written against the in-process client keeps working;
 * the rest is what a command needs around it. Failures are thrown as `ClientError`.
 */
export interface Backend extends McpClient {
  readonly mode: 'daemon' | 'in-process';
  /**
   * The tools of one server: the cache when it is fresh, else the server (and then cached). A missing
   * credential fails before any network call. `server` is the definition from the configuration.
   */
  listing(server: ServerConfig, options: ListingOptions): Promise<Listing>;
  /** Schema compiler for local argument validation, or undefined for ajv in this process. */
  compiler(): SchemaCompiler | undefined;
  /** Where the full text of truncated results is kept. */
  cursors(): CursorStore;
  /** Replace the credential values this backend has resolved with `***`. */
  redact(text: string): Promise<string>;
  /** Credential values known to this process, for rendering. Empty when the daemon holds them. */
  secrets(): readonly string[];
}

// In-process ----------------------------------------------------------------------------

export interface InProcessBackendOptions {
  servers: readonly ServerConfig[];
  resolver: CredentialResolver;
  cache: CatalogCache;
  env: Readonly<Record<string, string | undefined>>;
  cacheDir: string;
  now: () => number;
  /** Where OAuth logins live; only given when some server uses OAuth. */
  oauthStore?: OAuthStore;
}

/**
 * Direct connections from the current process (`VIA_NO_DAEMON=1`, CI, daemon fallback): the tool
 * list comes from the disk cache or the server, sessions last until `close()`, cursors are files.
 */
export class InProcessBackend implements Backend {
  readonly mode = 'in-process';

  private clientLoading?: Promise<McpClient>;

  private constructor(private readonly options: InProcessBackendOptions) {}

  static async create(options: InProcessBackendOptions): Promise<InProcessBackend> {
    return new InProcessBackend(options);
  }

  /** The client that talks to servers, made on first use: browsing a cached catalog never needs it. */
  private client(): Promise<McpClient> {
    this.clientLoading ??= import('../client').then(({ InProcessClient }) => {
      const { servers, resolver, now, oauthStore } = this.options;
      return new InProcessClient(servers, resolver, { now, ...(oauthStore ? { oauthStore } : {}) });
    });
    return this.clientLoading;
  }

  async listing(server: ServerConfig, { timeoutMs, refresh }: ListingOptions): Promise<Listing> {
    const [{ resolveConnection }, { mapError }] = await Promise.all([import('../client/credentials'), import('../client/errors')]);
    const { resolver, cache, env, now } = this.options;
    // Resolve the credentials first: a missing one fails before any network call, and redaction
    // knows the values even when the tool list comes from the cache (discovery.md, "缓存").
    try {
      await resolveConnection(server, resolver, env as NodeJS.ProcessEnv);
      if (server.auth.type === 'oauth' && this.options.oauthStore) {
        // A saved login must exist (no network); its tokens join the redaction list.
        const { createCallProvider } = await import('../client/oauth');
        await createCallProvider(server, this.options.oauthStore, { track: (value) => resolver.track?.(value), now }).requireLogin();
      }
    } catch (error) {
      throw mapError(error, { server, phase: 'connect', timeoutMs, redact: (text) => createRedactor(resolver.resolvedValues())(text) });
    }
    if (!refresh) {
      const hit = cache.read(server);
      if (hit) return { tools: hit.tools, fetchedAt: hit.fetchedAt, fromCache: true };
    }
    const tools = await (await this.client()).listTools(server.name, { timeoutMs });
    const fetchedAt = now();
    cache.write(server, tools, fetchedAt);
    return { tools, fetchedAt, fromCache: false };
  }

  listTools: McpClient['listTools'] = async (server, options) => (await this.client()).listTools(server, options);

  async callTool(server: string, rawName: string, args?: Record<string, unknown>, options?: CallOptions): Promise<ToolCallResult> {
    return (await this.client()).callTool(server, rawName, args, options);
  }

  compiler(): undefined {
    return undefined;
  }

  cursors(): CursorStore {
    return new FileCursorStore(join(this.options.cacheDir, 'cursors'), { now: this.options.now });
  }

  async redact(text: string): Promise<string> {
    return createRedactor(this.options.resolver.resolvedValues())(text);
  }

  secrets(): readonly string[] {
    return this.options.resolver.resolvedValues();
  }

  async close(): Promise<void> {
    // Nothing to close when no server was ever contacted.
    if (this.clientLoading) await (await this.clientLoading).close();
  }
}

// Fallback ------------------------------------------------------------------------------

/**
 * Daemon first; when the daemon cannot be used (it will not start, refuses the handshake, the
 * connection breaks) the rest of this run goes in-process, with one notice on stderr (daemon.md,
 * "生命周期" 5). A request that may already have reached the daemon is not repeated unless it has no
 * side effects: a list, or a call of a read-only tool.
 */
export class FallbackBackend implements Backend {
  private current: Backend;
  private fallback?: Promise<Backend>;
  private noted = false;

  constructor(
    private readonly primary: Backend,
    private readonly makeFallback: () => Promise<Backend>,
    private readonly note: (message: string) => void,
    /** The file cursor store, for cursors the daemon cannot take or no longer has. */
    private readonly files: () => CursorStore,
  ) {
    this.current = primary;
  }

  get mode(): Backend['mode'] {
    return this.current.mode;
  }

  /** Run `op` on the daemon; on `DaemonUnavailable` redo it in-process when that is safe. */
  private async run<T>(op: (backend: Backend) => Promise<T>, options: { idempotent: boolean; what: string }): Promise<T> {
    if (this.current !== this.primary) return op(this.current);
    try {
      return await op(this.primary);
    } catch (error) {
      if (!(error instanceof Error && error.name === 'DaemonUnavailable')) throw error;
      const sent = (error as Error & { sent?: boolean }).sent === true;
      if (sent && !options.idempotent) {
        const { ClientError } = await import('../client/errors');
        throw new ClientError({
          exitCode: ExitCode.Upstream,
          message: `lost the connection to the via daemon while ${options.what}; it may or may not have run`,
          next: 'via daemon status',
        });
      }
      return op(await this.switchToFallback(error.message));
    }
  }

  private async switchToFallback(reason: string): Promise<Backend> {
    if (!this.noted) {
      this.noted = true;
      this.note(`warning: ${reason}; continuing without the daemon (VIA_NO_DAEMON=1 silences this)\n`);
    }
    this.fallback ??= this.makeFallback();
    this.current = await this.fallback;
    return this.current;
  }

  listing(server: ServerConfig, options: ListingOptions): Promise<Listing> {
    return this.run((b) => b.listing(server, options), { idempotent: true, what: `listing ${server.provider}` });
  }

  listTools: McpClient['listTools'] = (server, options) =>
    this.run((b) => b.listTools(server, options), { idempotent: true, what: `listing ${server}` });

  callTool(server: string, rawName: string, args?: Record<string, unknown>, options?: CallOptions): Promise<ToolCallResult> {
    return this.run((b) => b.callTool(server, rawName, args, options), { idempotent: options?.retry === true, what: `calling ${rawName}` });
  }

  compiler(): SchemaCompiler | undefined {
    return this.current.compiler();
  }

  cursors(): CursorStore {
    return this.current !== this.primary ? this.current.cursors() : new CompositeCursorStore(this.primary.cursors(), this.files);
  }

  redact(text: string): Promise<string> {
    return this.current.redact(text);
  }

  secrets(): readonly string[] {
    return this.current.secrets();
  }

  async close(): Promise<void> {
    await this.primary.close().catch(() => undefined);
    if (this.fallback) await (await this.fallback).close().catch(() => undefined);
  }
}

/**
 * Cursors go to `primary` (the daemon); when it cannot be reached they go to `secondary` (files), and
 * a lookup that `primary` does not know is tried there too, so a cursor made while the run was
 * in-process can still be continued.
 */
export class CompositeCursorStore implements CursorStore {
  constructor(
    private readonly primary: CursorStore,
    private readonly secondary: () => CursorStore,
  ) {}

  async put(record: CursorRecord): Promise<string> {
    try {
      return await this.primary.put(record);
    } catch {
      return this.secondary().put(record);
    }
  }

  async get(id: string): Promise<CursorRecord | undefined> {
    try {
      const found = await this.primary.get(id);
      if (found) return found;
    } catch {
      // the daemon is not there: the files may still have it
    }
    return this.secondary().get(id);
  }
}

