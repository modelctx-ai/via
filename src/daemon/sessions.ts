// The daemon's MCP sessions (daemon.md, "daemon 持有的状态", "并发", "独占资源的 server"): one
// `McpSession` per server definition, shared by every client of the daemon, plus the in-memory copy
// of each server's tool list. The session does the connecting, the per-server concurrency limit and
// the error mapping; this layer adds lifetime (idle stop, exclusive servers), the catalog and its
// refresh on `list_changed`, and redaction of what goes back over the socket.
import type { McpTool } from '../catalog/types';
import { CATALOG_TTL_MS, CatalogCache, effectiveTtl } from '../client/catalog-cache';
import { ClientError, McpSession, mapError, resolveConnection, untrustedServer, type CallOptions } from '../client';
import { refOrigin, type CredentialResolver, type ServerConfig } from '../config/types';
import type { DetachedCall, SkillEntry, SkillRead, TaskInfo, TaskList, TaskOutcome, CompletionRef, CompletionResult, GetPromptResult, ListedTools, ListResult, McpPrompt, ProtocolInfo, ReadResourceResult, ResourceListing, ServerFeatures, ServerTarget, SessionStatus, ToolCallResult } from '../protocol';
import { ExitCode } from '../render/exit-codes';
import { lazyRedactor, redactProtocol, type Redactor } from '../render/redact';
import type { OAuthStore } from '../client/oauth/store';
import { openLog, ServerLog, serverLogPath } from '../log';
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
  /** What the last connection negotiated, once known. */
  protocol?: ProtocolInfo;
  /** The server's own freshness hint for the list (stateless protocol); the shorter of it and 24 hours applies. */
  ttlMs?: number;
  /** This server's log file (shared by its sessions); absent when the daemon has no log directory. */
  log?: ServerLog;
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
  /** The `tools/list` being fetched from the server, so a second request joins it instead of starting another. */
  listing?: Promise<ListedTools>;
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
  /** Where the servers' logs are written (`logs/` in the user cache directory); none: no logs. */
  logDir?: string;
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

  /**
   * `tools/list`: this daemon's copy while it is fresh, else the disk cache, else the server. With
   * `waitMs` (discovery commands) the answer comes after at most that long: a server that has not
   * finished by then, or whose attempt ran out of time, is `pending` and the fetch goes on in the
   * background (up to `timeoutMs`), writing the cache when it succeeds, so the next command finds it.
   */
  async list(
    target: ServerTarget,
    options: { timeoutMs: number; waitMs?: number; refresh: boolean; have?: number; onWarning?: (message: string) => void },
  ): Promise<ListResult> {
    const server = await this.admit(target);
    await this.prime(server, options.timeoutMs);
    const entry = this.entryFor(target, server);
    this.begin(entry);
    try {
      if (!options.refresh) {
        const now = this.options.now();
        if (entry.fetchedAt !== undefined && now - entry.fetchedAt <= effectiveTtl(CATALOG_TTL_MS, entry.ttlMs)) {
          const features = { ...(entry.features ? { features: entry.features } : {}), ...(entry.protocol ? { protocol: entry.protocol } : {}) };
          if (options.have === entry.fetchedAt) return { unchanged: true, fetchedAt: entry.fetchedAt, fromCache: true, ...features };
          if (entry.tools) return { tools: entry.tools, fetchedAt: entry.fetchedAt, fromCache: true, ...features };
        }
        // The copy on disk: the one this daemon wrote, or an in-process run's.
        const hit = this.cache.read(entry.original);
        if (hit) {
          entry.fetchedAt = hit.fetchedAt;
          if (hit.features) entry.features = hit.features;
          if (hit.protocol) entry.protocol = hit.protocol;
          if (hit.ttlMs !== undefined) entry.ttlMs = hit.ttlMs;
          else delete entry.ttlMs;
          const features = { ...(entry.features ? { features: entry.features } : {}), ...(entry.protocol ? { protocol: entry.protocol } : {}) };
          if (options.have === hit.fetchedAt) return { unchanged: true, fetchedAt: hit.fetchedAt, fromCache: true, ...features };
          const tools = hit.tools;
          entry.toolCount = tools.length;
          return { tools, fetchedAt: hit.fetchedAt, fromCache: true, ...features };
        }
        // Nothing usable: ask the server (below). Forget what pointed at a copy that is gone.
        delete entry.tools;
        delete entry.fetchedAt;
      }
      // Warnings belong to the request that is waiting: once it has been answered there is nobody to tell.
      let waiting = true;
      const onWarning = options.onWarning;
      const warn = onWarning ? (message: string): void => void (waiting && onWarning(message)) : undefined;
      const fetching = entry.listing ?? this.fetchTools(entry, options.timeoutMs, warn);
      if (options.waitMs === undefined) return await fetching.finally(() => void (waiting = false));
      let timer: NodeJS.Timeout | undefined;
      const waited = new Promise<'waited'>((resolve) => {
        timer = setTimeout(() => resolve('waited'), options.waitMs);
      });
      try {
        const done = await Promise.race([fetching, waited]);
        if (done !== 'waited') return done;
      } catch (error) {
        // Ran out of time connecting: not a failure that is certain, the same as the wait running out.
        if (!(error instanceof ClientError && error.kind === 'timeout')) throw error;
      } finally {
        clearTimeout(timer);
        waiting = false;
      }
      entry.log?.event(`the tool list is not ready after ${Math.round(options.waitMs / 100) / 10}s: answering "still starting" and going on in the background`);
      fetching.then(
        (tools) => entry.log?.event(`the tool list arrived after the wait: ${tools.tools.length} tools, cached`),
        (error: unknown) => entry.log?.error(`listing the tools failed after the wait: ${error instanceof Error ? (error.message.split('\n')[0] ?? '').slice(0, 300) : 'unknown error'}`),
      );
      return { pending: true };
    } finally {
      this.end(entry);
    }
  }

  /** Ask the server for its tools and keep the answer (memory and disk). Shared by every request that arrives meanwhile. */
  private fetchTools(entry: Entry, timeoutMs: number, onWarning: ((message: string) => void) | undefined): Promise<ListedTools> {
    this.begin(entry);
    let ttlMs: number | undefined;
    const run = entry.session
      .listTools({ timeoutMs, onTtl: (ms) => void (ttlMs = ms), ...(onWarning ? { onWarning } : {}) })
      .then((tools): ListedTools => {
        this.store(entry, tools, ttlMs);
        return { tools, fetchedAt: entry.fetchedAt!, fromCache: false, ...(entry.features ? { features: entry.features } : {}), ...(entry.protocol ? { protocol: entry.protocol } : {}) };
      })
      .finally(() => {
        entry.listing = undefined;
        this.end(entry);
      });
    entry.listing = run;
    return run;
  }

  /** `tools/call`. The raw result comes back with resolved credentials replaced by `***`. */
  async call(
    target: ServerTarget,
    rawName: string,
    args: Record<string, unknown>,
    options: { timeoutMs?: number; retry?: boolean; taskSupport?: string; onProgress?: CallOptions['onProgress']; onTask?: CallOptions['onTask']; onWarning?: (message: string) => void; elicit?: CallOptions['elicit'] },
  ): Promise<ToolCallResult> {
    const server = await this.admit(target);
    const entry = this.entryFor(target, server);
    this.begin(entry);
    try {
      const result = await entry.session.callTool(rawName, args, {
        timeoutMs: options.timeoutMs ?? server.timeout * 1000,
        ...(options.retry ? { retry: true } : {}),
        ...(options.taskSupport !== undefined ? { taskSupport: options.taskSupport } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.onTask ? { onTask: options.onTask } : {}),
        ...(options.onWarning ? { onWarning: options.onWarning } : {}),
        ...(options.elicit ? { elicit: options.elicit } : {}),
      });
      entry.calls += 1;
      return redactProtocol(result, this.redact) as ToolCallResult;
    } finally {
      this.end(entry);
    }
  }

  /** `tools/call` that returns once a task exists (`--detach`). */
  async detach(
    target: ServerTarget,
    rawName: string,
    args: Record<string, unknown>,
    options: { timeoutMs?: number; taskSupport?: string; onProgress?: CallOptions['onProgress']; onTask?: CallOptions['onTask']; onWarning?: (message: string) => void; elicit?: CallOptions['elicit'] },
  ): Promise<DetachedCall> {
    const server = await this.admit(target);
    const entry = this.entryFor(target, server);
    this.begin(entry);
    try {
      const done = await entry.session.detachTool(rawName, args, {
        timeoutMs: options.timeoutMs ?? server.timeout * 1000,
        ...(options.taskSupport !== undefined ? { taskSupport: options.taskSupport } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.onTask ? { onTask: options.onTask } : {}),
        ...(options.onWarning ? { onWarning: options.onWarning } : {}),
        ...(options.elicit ? { elicit: options.elicit } : {}),
      });
      entry.calls += 1;
      return redactProtocol(done, this.redact) as DetachedCall;
    } finally {
      this.end(entry);
    }
  }

  /** Task requests: the state of one, waiting for its end, cancelling it, or the server's listing. */
  task(target: ServerTarget, action: 'get' | 'wait' | 'cancel' | 'list', taskId: string | undefined, options: { timeoutMs: number; elicit?: CallOptions['elicit'] }): Promise<TaskInfo | TaskOutcome | TaskList> {
    return this.ask<TaskInfo | TaskOutcome | TaskList>(target, (session) => {
      const id = String(taskId ?? '');
      switch (action) {
        case 'get':
          return session.getTask(id, options);
        case 'wait':
          return session.waitForTask(id, options);
        case 'cancel':
          return session.cancelTask(id, options);
        default:
          return session.listTasks(options);
      }
    });
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

  /** `skills/list`, redacted. */
  skills(target: ServerTarget, options: { timeoutMs: number; onWarning?: (message: string) => void }): Promise<SkillEntry[]> {
    return this.ask(target, (session) => session.listSkills(options));
  }

  /** One verified file of a skill. The check ran against the bytes the server sent; only then is the content redacted. */
  readSkill(target: ServerTarget, skill: string, file: string | undefined, options: { timeoutMs: number }): Promise<SkillRead> {
    return this.ask(target, (session) => session.readSkill(skill, file, options));
  }

  /** `completion/complete`, redacted. */
  complete(target: ServerTarget, ref: CompletionRef, argument: { name: string; value: string }, context: Record<string, string> | undefined, options: { timeoutMs: number }): Promise<CompletionResult> {
    return this.ask(target, (session) => session.complete(ref, argument, context, options));
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
      const protocol = e.session.protocol();
      if (protocol) status.protocol = protocol;
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
        await createCallProvider(server, this.oauthStore, { track: (value) => resolver.track?.(value), resolveCredential: (ref) => resolver.resolve(ref, refOrigin(server, 'auth')), now: this.options.now }).requireLogin();
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
    const log = this.options.logDir ? new ServerLog(openLog(serverLogPath(this.options.logDir, server.name)), this.redact) : undefined;
    log?.event(`session opened (${server.transport.type}${previous !== undefined ? '; replaces the session of an older definition' : ''})`);
    const entry: Entry = {
      ...(log ? { log } : {}),
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
      log: () => log,
      onToolsChanged: () => this.toolsChanged(entry),
      knownProtocol: () => this.cache.read(entry.original)?.protocol,
      // Proxy variables come from the daemon's own environment, like `env:` credentials (config.md, "代理").
      env: this.options.env,
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
    entry.log?.event('session closed (replaced by a newer definition)');
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
      entry.log?.event('exclusive server: stopping it after the last request');
      void entry.session.close().catch(() => undefined);
      return;
    }
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (entry.active === 0) {
        entry.log?.event(`idle for ${Math.round(entry.idleMs / 1000)}s: stopping the server process`);
        void entry.session.close().catch(() => undefined);
      }
    }, entry.idleMs);
    entry.idleTimer.unref();
  }

  private store(entry: Entry, tools: McpTool[], ttlMs?: number): void {
    entry.fetchedAt = this.options.now();
    entry.toolCount = tools.length;
    entry.features = entry.session.features() ?? entry.features;
    entry.protocol = entry.session.protocol() ?? entry.protocol;
    if (ttlMs !== undefined) entry.ttlMs = ttlMs;
    else delete entry.ttlMs;
    // Keep the list in memory only if it could not be written to disk.
    const info = entry.session.info();
    const written = this.cache.write(entry.original, tools, {
      fetchedAt: entry.fetchedAt,
      ...(info ? { info } : {}),
      ...(entry.features ? { features: entry.features } : {}),
      ...(entry.protocol ? { protocol: entry.protocol } : {}),
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    });
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
      let ttlMs: number | undefined;
      const tools = await entry.session.listTools({ timeoutMs: entry.server.timeout * 1000, onTtl: (ms) => void (ttlMs = ms) });
      this.store(entry, tools, ttlMs);
    } catch (error) {
      entry.log?.error(`refreshing the tool list failed: ${error instanceof Error ? (error.message.split('\n')[0] ?? '').slice(0, 300) : 'unknown error'}`);
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
