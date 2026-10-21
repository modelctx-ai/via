// The one place the commands reach MCP servers through (daemon.md). A backend either talks to the
// daemon over its socket or connects from this process; commands cannot tell which, so everything
// built on `App` (`call`, `batch`, `auth`, `doctor`…) gets session reuse without knowing about it.
// This file stays light: the MCP SDK, ajv and the socket client load only when a backend is made.
import { join } from 'node:path';
import type { McpTool } from '../catalog/types';
import type { CallOptions, McpClient } from '../client';
import type { CredentialResolver, ServerConfig } from '../config/types';
import type { ProtocolInfo, ServerFeatures, ToolCallResult } from '../protocol';
import { FileCursorStore } from '../render/cursor-file';
import { ExitCode } from '../render/exit-codes';
import { createRedactor, redactValue } from '../render/redact';
import type { CursorRecord, CursorStore } from '../render/cursor';
import type { SchemaCompiler } from './args/validate';
import type { OAuthStore } from '../client/oauth/store';
import type { CatalogCache } from './catalog-cache';

/** A fetched `tools/list` and where it came from. */
export interface Listing {
  /** For a list read from the disk cache this parses on first access, not before. */
  readonly tools: McpTool[];
  fetchedAt: number;
  fromCache: boolean;
  /**
   * Length of the text of the cache file the list is (or was just written to), when there is one.
   * Together with `fetchedAt` it identifies the content without parsing it (view-cache.ts).
   */
  rawBytes?: number;
  /** Resources and prompts the server declared; absent when not known (an older cache entry). */
  features?: ServerFeatures;
  /** The protocol the list was fetched over; absent when not known (an older cache entry). */
  protocol?: ProtocolInfo;
}

export interface ListingOptions {
  /** Per-request ceiling in milliseconds. */
  timeoutMs: number;
  /** Skip the cache and ask the server (`via sync`, `via doctor`). */
  refresh?: boolean;
  /**
   * The `fetchedAt` of a list the caller holds a build of (view-cache.ts). A backend that has to
   * move the tools between processes may then leave them out when its list is that one; the
   * returned listing is the same either way.
   */
  have?: number;
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
  /** Text the CLI composed, scanned for the credential values this backend has resolved (long ones only; see `Redactor.scan`). */
  redact(text: string): Promise<string>;
  /** Content the CLI echoes (dry-run arguments): every string value redacted, the shape kept. */
  redactValue<T>(value: T): Promise<T>;
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
  /** `warning: …` lines for the person running the command (e.g. a refreshed login that could not be saved). */
  onWarning?: (message: string) => void;
  /** Working directory and home of this run, for the `roots` of servers (config.md). */
  roots?: { cwd: string; home: string };
}

/**
 * Direct connections from the current process (`VIA_NO_DAEMON=1`, CI, daemon fallback): the tool
 * list comes from the disk cache or the server, sessions last until `close()`, cursors are files.
 */
export class InProcessBackend implements Backend {
  readonly mode = 'in-process';

  private clientLoading?: Promise<McpClient>;
  private loaded?: McpClient;

  private constructor(private readonly options: InProcessBackendOptions) {}

  static async create(options: InProcessBackendOptions): Promise<InProcessBackend> {
    return new InProcessBackend(options);
  }

  /** The client that talks to servers, made on first use: browsing a cached catalog never needs it. */
  private client(): Promise<McpClient> {
    this.clientLoading ??= import('../client').then(({ InProcessClient }) => {
      const { servers, resolver, now, oauthStore, onWarning, roots, cache, env } = this.options;
      return (this.loaded = new InProcessClient(servers, resolver, {
        now,
        knownProtocol: (server) => cache.read(server)?.protocol,
        env,
        ...(oauthStore ? { oauthStore } : {}),
        ...(onWarning ? { onWarning } : {}),
        ...(roots ? { roots } : {}),
      }));
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
      if (hit) {
        return {
          fetchedAt: hit.fetchedAt,
          fromCache: true,
          rawBytes: hit.rawBytes,
          ...(hit.features ? { features: hit.features } : {}),
          ...(hit.protocol ? { protocol: hit.protocol } : {}),
          get tools(): McpTool[] {
            return hit.tools;
          },
        };
      }
    }
    const client = await this.client();
    let ttlMs: number | undefined;
    const tools = await client.listTools(server.name, { timeoutMs, onTtl: (ms) => void (ttlMs = ms) });
    const features = client.features(server.name);
    const protocol = client.protocol(server.name);
    const fetchedAt = now();
    const rawBytes = cache.write(server, tools, { fetchedAt, ...(features ? { features } : {}), ...(protocol ? { protocol } : {}), ...(ttlMs !== undefined ? { ttlMs } : {}) });
    return { tools, fetchedAt, fromCache: false, ...(rawBytes !== undefined ? { rawBytes } : {}), ...(features ? { features } : {}), ...(protocol ? { protocol } : {}) };
  }

  listTools: McpClient['listTools'] = async (server, options) => (await this.client()).listTools(server, options);

  async callTool(server: string, rawName: string, args?: Record<string, unknown>, options?: CallOptions): Promise<ToolCallResult> {
    return (await this.client()).callTool(server, rawName, args, options);
  }

  listResources: McpClient['listResources'] = async (server, options) => (await this.client()).listResources(server, options);
  readResource: McpClient['readResource'] = async (server, uri, options) => (await this.client()).readResource(server, uri, options);
  listPrompts: McpClient['listPrompts'] = async (server, options) => (await this.client()).listPrompts(server, options);
  getPrompt: McpClient['getPrompt'] = async (server, name, args, options) => (await this.client()).getPrompt(server, name, args, options);

  features(server: string): ServerFeatures | undefined {
    // No client yet means no session, so nothing has been declared.
    return this.loaded?.features(server);
  }

  protocol(server: string): ProtocolInfo | undefined {
    return this.loaded?.protocol(server);
  }

  compiler(): undefined {
    return undefined;
  }

  cursors(): CursorStore {
    return new FileCursorStore(join(this.options.cacheDir, 'cursors'), { now: this.options.now });
  }

  async redact(text: string): Promise<string> {
    return createRedactor(this.options.resolver.resolvedValues()).scan(text);
  }

  async redactValue<T>(value: T): Promise<T> {
    return redactValue(value, createRedactor(this.options.resolver.resolvedValues())) as T;
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
 *
 * A request the daemon refuses as `stale` (this shell's values for the server's `env:` variables
 * differ from what the daemon resolves) was not run, so it is always safe to run it in-process. Only
 * that request goes in-process: the daemon stays in use for everything else, and neither it nor the
 * socket ever sees the values (daemon.md, "环境与工作目录").
 *
 * A request that runs past its deadline while the daemon still answers (`requestOnly`) is treated
 * the same way when it has no side effects: only it is redone in-process, with the notice, and the
 * daemon stays in use for the rest of the run.
 */
export class FallbackBackend implements Backend {
  private current: Backend;
  private fallback?: Promise<Backend>;
  private noted = false;
  private localBackend?: Backend;

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
      if (error instanceof Error && error.name === 'DaemonStale') return op(await this.local());
      if (!(error instanceof Error && error.name === 'DaemonUnavailable')) throw error;
      const { sent, requestOnly } = error as Error & { sent?: boolean; requestOnly?: boolean };
      if (sent === true && !options.idempotent) {
        const { ClientError } = await import('../client/errors');
        throw new ClientError({
          exitCode: ExitCode.Upstream,
          message: requestOnly
            ? `the via daemon did not answer in time while ${options.what}; it may or may not have run`
            : `lost the connection to the via daemon while ${options.what}; it may or may not have run`,
          next: 'via daemon status',
        });
      }
      // The daemon still answers, only this request ran out of time: redo just this one here.
      if (requestOnly === true) {
        this.notice(`warning: ${error.message} while ${options.what}; running it in this process (VIA_NO_DAEMON=1 silences this)\n`);
        return op(await this.local());
      }
      return op(await this.switchToFallback(error.message));
    }
  }

  /** The in-process backend, without switching the run to it. */
  private async local(): Promise<Backend> {
    this.fallback ??= this.makeFallback().then((b) => (this.localBackend = b));
    return this.fallback;
  }

  private localSecrets(): readonly string[] {
    return this.localBackend?.secrets() ?? [];
  }

  /** The one fallback notice of a run (daemon.md, "生命周期" 5). */
  private notice(text: string): void {
    if (this.noted) return;
    this.noted = true;
    this.note(text);
  }

  private async switchToFallback(reason: string): Promise<Backend> {
    this.notice(`warning: ${reason}; continuing without the daemon (VIA_NO_DAEMON=1 silences this)\n`);
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

  // Lists, reads and prompt fetches change nothing on the server, so a request that may have reached the daemon is repeated.
  listResources: McpClient['listResources'] = (server, options) =>
    this.run((b) => b.listResources(server, options), { idempotent: true, what: `listing the resources of ${server}` });

  readResource: McpClient['readResource'] = (server, uri, options) =>
    this.run((b) => b.readResource(server, uri, options), { idempotent: true, what: `reading a resource of ${server}` });

  listPrompts: McpClient['listPrompts'] = (server, options) =>
    this.run((b) => b.listPrompts(server, options), { idempotent: true, what: `listing the prompts of ${server}` });

  getPrompt: McpClient['getPrompt'] = (server, name, args, options) =>
    this.run((b) => b.getPrompt(server, name, args, options), { idempotent: true, what: `getting a prompt of ${server}` });

  protocol(server: string): ProtocolInfo | undefined {
    return this.current.protocol(server);
  }

  features(server: string): ServerFeatures | undefined {
    return this.current.features(server);
  }

  compiler(): SchemaCompiler | undefined {
    return this.current.compiler();
  }

  cursors(): CursorStore {
    return this.current !== this.primary ? this.current.cursors() : new CompositeCursorStore(this.primary.cursors(), this.files);
  }

  /** Both sides: a value resolved in-process for a `stale` request is unknown to the daemon, and the other way round. */
  async redact(text: string): Promise<string> {
    const redacted = await this.current.redact(text);
    if (this.current !== this.primary || !this.fallback) return redacted;
    return (await this.fallback).redact(redacted);
  }

  async redactValue<T>(value: T): Promise<T> {
    const redacted = await this.current.redactValue(value);
    if (this.current !== this.primary || !this.fallback) return redacted;
    return (await this.fallback).redactValue(redacted);
  }

  secrets(): readonly string[] {
    return [...this.current.secrets(), ...(this.current === this.primary ? this.localSecrets() : [])];
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

