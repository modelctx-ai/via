// The daemon's MCP sessions (daemon.md, "daemon 持有的状态", "并发", "独占资源的 server"): one
// `McpSession` per server definition, shared by every client of the daemon, plus the in-memory copy
// of each server's tool list. The session does the connecting, the per-server concurrency limit and
// the error mapping; this layer adds lifetime (idle stop, exclusive servers), the catalog and its
// refresh on `list_changed`, and redaction of what goes back over the socket.
import type { McpTool } from '../catalog/types';
import { CATALOG_TTL_MS, CatalogCache } from '../cli/catalog-cache';
import { ClientError, McpSession, mapError, resolveConnection, untrustedServer, type CallOptions } from '../client';
import type { CredentialResolver, ServerConfig } from '../config/types';
import type { GetPromptResult, ListResult, McpPrompt, ReadResourceResult, ResourceListing, ServerFeatures, ServerTarget, SessionStatus, ToolCallResult } from '../protocol';
import { ExitCode } from '../render/exit-codes';
import { lazyRedactor, redactProtocol, type Redactor } from '../render/redact';
import type { OAuthStore } from '../client/oauth/store';
import { effectiveServer, sessionKey } from './target';

/** Resolved credentials are forgotten after this long, so a rotated token or key is picked up (config.md, "凭证引用"). */
export const CREDENTIAL_TTL_MS = 10 * 60 * 1000;

/** Wait this long after a `list_changed` before listing again, so a burst of notifications costs one request. */
const REFRESH_DEBOUNCE_MS = 50;

/**
 * A resolver whose cache expires. The values it ever returned stay known to `resolvedValues()`: output
 * produced with an old credential must still be redacted.
 */
export class ExpiringResolver implements CredentialResolver {
  private current: CredentialResolver;
  private readonly past = new Set<string>();
  private born: number;

  constructor(
    private readonly make: () => CredentialResolver,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {
    this.current = make();
    this.born = now();
  }

  resolve(ref: string, origin: Parameters<CredentialResolver['resolve']>[1]): Promise<string> {
    if (this.now() - this.born > this.ttlMs) {
      for (const value of this.current.resolvedValues()) this.past.add(value);
      this.current = this.make();
      this.born = this.now();
    }
    return this.current.resolve(ref, origin);
  }

  track(value: string): void {
    this.current.track?.(value);
  }

  resolvedValues(): readonly string[] {
    return [...new Set([...this.past, ...this.current.resolvedValues()])];
  }
}

interface Entry {
  key: string;
  /** The definition as configured: the disk cache is keyed on it, as in in-process mode. */
  original: ServerConfig;
  server: ServerConfig;
  session: McpSession;
  /**
   * The list, held in memory only when the disk cache cannot hold it. Normally the cache file is the
   * copy (this daemon wrote it, in-process runs share it): a few hundred tools are megabytes of
   * parsed objects that nobody reads until a CLI asks without `have`.
   */
  tools?: McpTool[];
  /** When the list was fetched; set while the daemon has a fresh copy, in memory or on disk. */
  fetchedAt?: number;
  /** Number of tools in that list, when known (for `status`). */
  toolCount?: number;
  /** What the server declared at `initialize`, once known. */
  features?: ServerFeatures;
  calls: number;
  active: number;
  lastUsed: number;
  idleMs: number;
  idleTimer?: NodeJS.Timeout;
  refreshTimer?: NodeJS.Timeout;
  refreshing: boolean;
  refreshAgain: boolean;
  /** A newer definition of the same server replaced this one; drop it once it is idle. */
  retired: boolean;
}

export interface SessionManagerOptions {
  resolver: CredentialResolver;
  catalogDir: string;
  /** Environment for stdio children's base environment (the daemon's own). */
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** Home directory and platform, for the OAuth store (logins are made by the CLI and read here). */
  home: string;
  platform: NodeJS.Platform;
  /** Replaces the default login store (tests). */
  oauthStore?: OAuthStore;
}

export class SessionManager {
  private readonly entries = new Map<string, Entry>();
  private readonly byName = new Map<string, string>();
  private readonly cache: CatalogCache;
  private oauthStore?: OAuthStore;
  private closing = false;

  constructor(private readonly options: SessionManagerOptions) {
    this.cache = new CatalogCache(options.catalogDir, options.now);
    this.oauthStore = options.oauthStore;
  }

  /**
   * Replaces the credential values resolved so far with `***`: the function redacts string content
   * (upstream text), `.scan` text composed here, `.key` object keys (see `Redactor`).
   */
  readonly redact: Redactor = lazyRedactor(() => this.options.resolver.resolvedValues());

  // Operations --------------------------------------------------------------------------

  /** `tools/list`: this daemon's copy while it is fresh, else the disk cache, else the server. */
  async list(
    target: ServerTarget,
    options: { timeoutMs: number; refresh: boolean; have?: number; onWarning?: (message: string) => void },
  ): Promise<ListResult> {
    const server = await this.admit(target);
    await this.prime(server, options.timeoutMs);
    const entry = this.entryFor(target, server);
    this.begin(entry);
    try {
      if (!options.refresh) {
        const now = this.options.now();
        if (entry.fetchedAt !== undefined && now - entry.fetchedAt <= CATALOG_TTL_MS) {
          const features = entry.features ? { features: entry.features } : {};
          if (options.have === entry.fetchedAt) return { unchanged: true, fetchedAt: entry.fetchedAt, fromCache: true, ...features };
          if (entry.tools) return { tools: entry.tools, fetchedAt: entry.fetchedAt, fromCache: true, ...features };
        }
        // The copy on disk: the one this daemon wrote, or an in-process run's.
        const hit = this.cache.read(entry.original);
        if (hit) {
          entry.fetchedAt = hit.fetchedAt;
          if (hit.features) entry.features = hit.features;
          const features = entry.features ? { features: entry.features } : {};
          if (options.have === hit.fetchedAt) return { unchanged: true, fetchedAt: hit.fetchedAt, fromCache: true, ...features };
          const tools = hit.tools;
          entry.toolCount = tools.length;
          return { tools, fetchedAt: hit.fetchedAt, fromCache: true, ...features };
        }
        // Nothing usable: ask the server (below). Forget what pointed at a copy that is gone.
        delete entry.tools;
        delete entry.fetchedAt;
      }
      const tools = await entry.session.listTools({ timeoutMs: options.timeoutMs, ...(options.onWarning ? { onWarning: options.onWarning } : {}) });
      this.store(entry, tools);
      return { tools, fetchedAt: entry.fetchedAt!, fromCache: false, ...(entry.features ? { features: entry.features } : {}) };
    } finally {
      this.end(entry);
    }
  }

  /** `tools/call`. The raw result comes back with resolved credentials replaced by `***`. */
  async call(
    target: ServerTarget,
    rawName: string,
    args: Record<string, unknown>,
    options: { timeoutMs?: number; retry?: boolean; onProgress?: CallOptions['onProgress']; onWarning?: (message: string) => void },
  ): Promise<ToolCallResult> {
    const server = await this.admit(target);
    const entry = this.entryFor(target, server);
    this.begin(entry);
    try {
      const result = await entry.session.callTool(rawName, args, {
        timeoutMs: options.timeoutMs ?? server.timeout * 1000,
        ...(options.retry ? { retry: true } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.onWarning ? { onWarning: options.onWarning } : {}),
      });
      entry.calls += 1;
      return redactProtocol(result, this.redact) as ToolCallResult;
    } finally {
      this.end(entry);
    }
  }

  /** `resources/list` and `resources/templates/list`, redacted. */
  resources(target: ServerTarget, options: { timeoutMs: number }): Promise<ResourceListing> {
    return this.ask(target, (session) => session.listResources(options));
  }

  /** `resources/read`, redacted. */
  readResource(target: ServerTarget, uri: string, options: { timeoutMs: number }): Promise<ReadResourceResult> {
    return this.ask(target, (session) => session.readResource(uri, options));
  }

  /** `prompts/list`, redacted. */
  prompts(target: ServerTarget, options: { timeoutMs: number }): Promise<McpPrompt[]> {
    return this.ask(target, (session) => session.listPrompts(options));
  }

  /** `prompts/get`, redacted. */
  getPrompt(target: ServerTarget, name: string, args: Record<string, string>, options: { timeoutMs: number }): Promise<GetPromptResult> {
    return this.ask(target, (session) => session.getPrompt(name, args, options));
  }

  status(): SessionStatus[] {
    const now = this.options.now();
    return [...this.entries.values()].map((e) => {
      const status: SessionStatus = {
        server: e.server.name,
        provider: e.server.provider,
        transport: e.server.transport.type,
        connected: e.session.connected,
        calls: e.calls,
        active: e.active,
        lastUsedAgoMs: Math.max(0, now - e.lastUsed),
      };
      const pid = e.session.pid;
      if (pid !== undefined) status.pid = pid;
      const count = e.toolCount ?? e.tools?.length ?? (e.fetchedAt !== undefined ? this.cache.read(e.original)?.tools.length : undefined);
      if (count !== undefined) status.tools = count;
      return status;
    });
  }

  /** Close every session (and so every stdio child). */
  async closeAll(): Promise<void> {
    this.closing = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.byName.clear();
    for (const e of entries) {
      clearTimeout(e.idleTimer);
      clearTimeout(e.refreshTimer);
    }
    await Promise.all(entries.map((e) => e.session.close().catch(() => undefined)));
  }

  // Internals ---------------------------------------------------------------------------

  /** One request on the server's session; what comes back has resolved credentials replaced by `***`. */
  private async ask<T>(target: ServerTarget, op: (session: McpSession) => Promise<T>): Promise<T> {
    const server = await this.admit(target);
    const entry = this.entryFor(target, server);
    this.begin(entry);
    try {
      const result = await op(entry.session);
      return redactProtocol(result, this.redact) as T;
    } finally {
      this.end(entry);
    }
  }

  /** Untrusted project servers are refused before anything is resolved, spawned or sent (security.md). */
  private async admit(target: ServerTarget): Promise<ServerConfig> {
    if (this.closing) throw new ClientError({ exitCode: ExitCode.Upstream, message: 'the via daemon is shutting down', next: 'rerun the command' });
    if (!target.server.trusted) throw untrustedServer(target.server);
    // One store for the daemon's life; it reads the CLI's logins on use, so a login or logout made
    // after the daemon started is seen by the next request.
    if (target.server.auth.type === 'oauth' && !this.oauthStore) {
      const { createOAuthStore } = await import('../client/oauth');
      this.oauthStore = createOAuthStore({ home: this.options.home, env: this.options.env, platform: this.options.platform });
    }
    return effectiveServer(target.server, target.cwd, this.options.home);
  }

  /** Resolve the credentials first: a missing one fails before any network call (auth.md). */
  private async prime(server: ServerConfig, timeoutMs: number): Promise<void> {
    try {
      await resolveConnection(server, this.options.resolver, this.options.env);
      if (server.auth.type === 'oauth' && this.oauthStore) {
        // A saved login must exist (no network); its tokens join the redaction list.
        const { createCallProvider } = await import('../client/oauth');
        const { resolver } = this.options;
        await createCallProvider(server, this.oauthStore, { track: (value) => resolver.track?.(value), now: this.options.now }).requireLogin();
      }
    } catch (error) {
      throw mapError(error, { server, phase: 'connect', timeoutMs, redact: this.redact });
    }
  }

  private entryFor(target: ServerTarget, server: ServerConfig): Entry {
    const key = sessionKey(server);
    const idleMs = Math.max(0, target.idleTimeout) * 1000;
    const existing = this.entries.get(key);
    if (existing) {
      existing.idleMs = idleMs;
      existing.original = target.server;
      return existing;
    }
    const previous = this.byName.get(server.name);
    if (previous !== undefined) this.retire(previous);
    const entry: Entry = {
      key,
      original: target.server,
      server,
      session: undefined as unknown as McpSession,
      calls: 0,
      active: 0,
      lastUsed: this.options.now(),
      idleMs,
      refreshing: false,
      refreshAgain: false,
      retired: false,
    };
    // `server.roots` is already absolute here (`effectiveServer`), so no base directory is needed.
    entry.session = new McpSession(server, this.options.resolver, {
      onToolsChanged: () => this.toolsChanged(entry),
      now: this.options.now,
      ...(this.oauthStore ? { oauthStore: this.oauthStore } : {}),
      roots: { cwd: target.cwd, home: this.options.home },
    });
    this.entries.set(key, entry);
    this.byName.set(server.name, key);
    return entry;
  }

  private retire(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.retired = true;
    if (entry.active === 0) void this.drop(entry);
  }

  private async drop(entry: Entry): Promise<void> {
    clearTimeout(entry.idleTimer);
    clearTimeout(entry.refreshTimer);
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (this.byName.get(entry.server.name) === entry.key) this.byName.delete(entry.server.name);
    await entry.session.close().catch(() => undefined);
  }

  private begin(entry: Entry): void {
    entry.active += 1;
    clearTimeout(entry.idleTimer);
  }

  /**
   * A stdio server that nobody uses for `serverIdleTimeout` is stopped; an `exclusive` one is stopped
   * as soon as its last request is done, so the daemon does not sit on a lock (SQLite file, browser
   * profile, port) that the agent framework's own instance needs. The tool list stays.
   */
  private end(entry: Entry): void {
    entry.active -= 1;
    entry.lastUsed = this.options.now();
    if (entry.active > 0) return;
    if (entry.retired) {
      void this.drop(entry);
      return;
    }
    if (entry.server.transport.type !== 'stdio') return;
    if (entry.server.exclusive) {
      void entry.session.close().catch(() => undefined);
      return;
    }
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (entry.active === 0) void entry.session.close().catch(() => undefined);
    }, entry.idleMs);
    entry.idleTimer.unref();
  }

  private store(entry: Entry, tools: McpTool[]): void {
    entry.fetchedAt = this.options.now();
    entry.toolCount = tools.length;
    entry.features = entry.session.features() ?? entry.features;
    // Keep the list in memory only if it could not be written to disk.
    const written = this.cache.write(entry.original, tools, { fetchedAt: entry.fetchedAt, ...(entry.features ? { features: entry.features } : {}) });
    if (written === undefined) entry.tools = tools;
    else delete entry.tools;
  }

  // list_changed ------------------------------------------------------------------------

  /** `notifications/tools/list_changed`: list again and replace the memory copy and the disk cache. */
  private toolsChanged(entry: Entry): void {
    if (this.closing || entry.retired) return;
    if (entry.refreshing) {
      entry.refreshAgain = true;
      return;
    }
    clearTimeout(entry.refreshTimer);
    entry.refreshTimer = setTimeout(() => void this.refresh(entry), REFRESH_DEBOUNCE_MS);
    entry.refreshTimer.unref();
  }

  private async refresh(entry: Entry): Promise<void> {
    if (this.closing) return;
    entry.refreshing = true;
    this.begin(entry);
    try {
      const tools = await entry.session.listTools({ timeoutMs: entry.server.timeout * 1000 });
      this.store(entry, tools);
    } catch {
      // The copy is known to be out of date and cannot be renewed now: forget it so the next list asks the server.
      delete entry.tools;
      delete entry.fetchedAt;
      delete entry.toolCount;
      this.cache.clear(entry.original);
    } finally {
      entry.refreshing = false;
      this.end(entry);
    }
    if (entry.refreshAgain) {
      entry.refreshAgain = false;
      this.toolsChanged(entry);
    }
  }
}
