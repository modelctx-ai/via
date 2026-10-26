// The state one command run shares: configuration, credential resolver, MCP client, caches, and
// the helpers every command needs (writing, redaction, failure reports). The heavy modules
// (config, catalog, MCP client) are imported on first use, so `via more` stays cheap.
import { join } from 'node:path';
import type { Catalog, CatalogTool, DocTerms, McpTool, ProviderCatalog, ProviderStatus } from '../catalog';
import type { McpClient } from '../client';
import type { OAuthStore } from '../client/oauth/store';
import type { SchemaCompiler } from './args';
import { pathContext, userCacheDir } from '../config/paths';
import type { CredentialResolver, LoadedConfig, ServerConfig } from '../config';
import { emptyPolicy, isVisible, refusedBy, restrictsCommands, type Policy } from '../config/policy';
import { lazyRedactor, redactValue, type Redactor } from '../render/redact';
import { formatError, type ErrorInfo } from '../render/errors';
import { ExitCode } from '../render/exit-codes';
import type { Backend, Listing } from './backend';
import type { CatalogCache } from './catalog-cache';
import type { ProviderEntry, ProviderTable } from './directory';
import type { ViewCache } from './view-cache';
import type { TaskRecords } from './task-record';
import type { CliEnv } from './env';
import { fail } from './failure';
import { filterHelp, HELP, VERSION } from './help';
import { matchBuiltin } from './builtins';
import type { GlobalOptions } from './options';

/**
 * Per-server ceiling when listing many servers at once in this process, so one slow server cannot
 * stall `via`. Through the daemon the wait is `discovery.wait` instead (3 seconds), because the daemon
 * goes on connecting after the command has printed (discovery.md, "缓存").
 */
export const BROWSE_TIMEOUT_MS = 10_000;

export type { Listing };

/**
 * Whether servers are reached from this process instead of through the daemon: `VIA_NO_DAEMON` set
 * to anything but empty/`0`/`false` (daemon.md, "无 daemon 模式"). The injected environment wins;
 * the real one is consulted too so a test run can switch the daemon off for every sandbox at once.
 */
function daemonDisabled(io: Pick<CliEnv, 'env' | 'platform'>): boolean {
  const value = io.env.VIA_NO_DAEMON ?? process.env.VIA_NO_DAEMON;
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

export interface LoadedProviders {
  /** Visible catalog (deny applied). Failed providers are present with no tools. */
  catalog: Catalog;
  /** Search terms of the tools whose build came from (or went to) the cache, for `SearchIndex`. */
  terms: { get(tool: CatalogTool): DocTerms | undefined };
  statuses: Record<string, ProviderStatus>;
  /** The line after the status in the root view: why a provider `failed`, what to do about one that is `starting`. Redacted. */
  details: Record<string, string>;
  /** Every provider whose list did not come back, with `statuses` saying which way (`needs-auth`, `starting`, `failed`, `untrusted`). */
  failures: Array<{ entry: ProviderEntry; error: unknown }>;
  /** Whether a daemon served the run: a provider that is `starting` then goes on connecting after this command ends. */
  background: boolean;
}

export class App {
  private loaded?: LoadedConfig;
  private resolverInstance?: CredentialResolver;
  private resolverLoading?: Promise<CredentialResolver>;
  private depsLoading?: Promise<typeof import('./browse-deps')>;
  private backendInstance?: Promise<Backend>;
  private backendReady?: Backend;
  private socketClient?: import('../daemon/client').DaemonClient;
  private tableInstance?: ProviderTable;
  private cacheInstance?: CatalogCache;
  private viewCacheInstance?: ViewCache;
  private oauthStoreInstance?: OAuthStore;
  private taskRecordsInstance?: TaskRecords;

  constructor(
    readonly io: CliEnv,
    readonly options: GlobalOptions,
    /** `commands` and `sandbox`, read before dispatch (run.ts). */
    readonly policy: Policy = emptyPolicy(),
  ) {}

  // Commands the configuration restricts (ADR 0028) -------------------------------------

  /** Whether a built-in is shown in help, `via prompt`, `via serve` and the hints of the views. */
  commandVisible(command: string): boolean {
    return isVisible(this.policy.commands, command);
  }

  /** `via -h` and `via help`, without the commands that are refused or hidden. */
  helpText(): string {
    return restrictsCommands(this.policy.commands) ? filterHelp(HELP, (name) => this.commandVisible(name)) : HELP;
  }

  /** A `next:` naming a refused command is no next step: it is left out rather than sending the reader into a refusal. */
  private dropRefusedNext(info: ErrorInfo): ErrorInfo {
    const word = /^via\s+(\S+)/.exec(info.next ?? '')?.[1];
    const command = word === undefined ? undefined : matchBuiltin(word);
    if (command === undefined || refusedBy(this.policy.commands, command) === undefined) return info;
    const { next: _dropped, ...rest } = info;
    return rest;
  }

  // Output ------------------------------------------------------------------------------

  out(text: string): void {
    if (text !== '') this.io.stdout.write(text);
  }

  err(text: string): void {
    if (text !== '') this.io.stderr.write(text);
  }

  /**
   * Replaces the credential values resolved so far with `***`. Call it on content (a value the user
   * typed, text from a server); use `.scan` on text composed here (`Redactor`, output.md "脱敏").
   */
  readonly redact: Redactor = lazyRedactor(() => this.resolverInstance?.resolvedValues() ?? []);

  // Paths -------------------------------------------------------------------------------

  get cacheDir(): string {
    return userCacheDir(pathContext({ home: this.io.home, env: this.io.env, platform: this.io.platform }));
  }

  // Lazily created pieces ---------------------------------------------------------------

  /** Config, catalog, directory, caches and backends in one import (see browse-deps.ts). */
  private deps(): Promise<typeof import('./browse-deps')> {
    this.depsLoading ??= import('./browse-deps');
    return this.depsLoading;
  }

  /**
   * The merged configuration. An error-level diagnostic stops the command (fail closed): a deny
   * rule that did not compile would otherwise leave a tool visible (config.md, "校验与诊断").
   * `via doctor` and `via servers` pass `allowErrors` to show the diagnostics instead.
   */
  async config(options: { allowErrors?: boolean } = {}): Promise<LoadedConfig> {
    const { loadConfig, hasErrors, formatDiagnostic } = await this.deps();
    if (!this.loaded) {
      this.loaded = await loadConfig({ cwd: this.io.cwd, env: this.io.env, home: this.io.home, platform: this.io.platform, parseCacheDir: join(this.cacheDir, 'config') });
    }
    if (!options.allowErrors && hasErrors(this.loaded.diagnostics)) {
      const errors = this.loaded.diagnostics.filter((d) => d.level === 'error').map(formatDiagnostic);
      throw fail(ExitCode.Usage, `invalid configuration: ${errors[0]}`, 'via doctor', errors.slice(1).map((e) => `  ${e}`));
    }
    return this.loaded;
  }

  async resolver(): Promise<CredentialResolver> {
    // One resolver per run, even when several servers ask at once (doctor, sync): two instances would
    // each cache and run `cmd:` separately, and redaction only knows the values of the one it holds.
    this.resolverLoading ??= this.deps().then(({ createLazyCredentialResolver }) => {
      this.resolverInstance = createLazyCredentialResolver({ home: this.io.home, env: this.io.env, platform: this.io.platform, cwd: this.io.cwd });
      return this.resolverInstance;
    });
    return this.resolverLoading;
  }

  /** Whether servers are reached from this process instead of through the daemon (`VIA_NO_DAEMON`). */
  get daemonOff(): boolean {
    return daemonDisabled(this.io);
  }

  /** Every credential value resolved in this process (none when the daemon holds them). */
  secrets(): readonly string[] {
    return this.resolverInstance?.resolvedValues() ?? [];
  }

  /**
   * The connection to MCP servers: the daemon when it can be used, else this process (`daemonDisabled`,
   * or after the daemon failed; daemon.md). Everything that reaches a server goes through here.
   */
  backend(): Promise<Backend> {
    this.backendInstance ??= this.createBackend().then((backend) => (this.backendReady = backend));
    return this.backendInstance;
  }

  /** The upstream client of the commands: the same object as `backend()`, typed as the raw client. */
  async client(): Promise<McpClient> {
    return this.backend();
  }

  private async createBackend(): Promise<Backend> {
    const config = await this.config({ allowErrors: true });
    const onWarning = (message: string): void => this.err(`warning: ${this.redact.scan(message)}\n`);
    const inProcess = async (): Promise<Backend> => {
      const { InProcessBackend } = await this.deps();
      return InProcessBackend.create({
        servers: config.servers,
        resolver: await this.resolver(),
        cache: await this.cache(),
        env: this.io.env,
        cacheDir: this.cacheDir,
        now: this.io.now,
        onWarning,
        roots: { cwd: this.io.cwd, home: this.io.home },
        ...(config.servers.some((s) => s.auth.type === 'oauth') ? { oauthStore: await this.oauthStore() } : {}),
      });
    };
    if (daemonDisabled(this.io)) return inProcess();
    const [{ DaemonBackend }, { FallbackBackend, fileCursors }] = await Promise.all([import('../daemon/backend'), this.deps()]);
    const client = await this.daemonClient(config.daemon.idleTimeout);
    const primary = new DaemonBackend({
      client,
      servers: config.servers,
      cwd: this.io.cwd,
      env: this.io.env,
      serverIdleTimeoutSec: config.daemon.serverIdleTimeout,
      cache: await this.cache(),
      onWarning,
    });
    return new FallbackBackend(primary, inProcess, (message) => this.err(message), () => fileCursors(join(this.cacheDir, 'cursors'), this.io.now));
  }

  /**
   * Cursor store for `via more`, which needs neither configuration nor catalog: a daemon that is
   * already running (it is never started for this), then the cursor files.
   */
  async moreCursors(): Promise<import('../render/cursor').CursorStore> {
    const { FileCursorStore } = await import('../render/cursor-file');
    const files = (): import('../render/cursor').CursorStore => new FileCursorStore(join(this.cacheDir, 'cursors'), { now: this.io.now });
    if (daemonDisabled(this.io)) return files();
    const [{ DaemonCursorStore }, { CompositeCursorStore }] = await Promise.all([import('../daemon/backend'), import('./backend')]);
    return new CompositeCursorStore(new DaemonCursorStore(await this.daemonClient(), false), files);
  }

  /**
   * A client for the daemon's socket that never needs the configuration (`via more`, `via daemon …`).
   * `idleTimeoutSec` only matters when it is used to start a daemon.
   */
  async daemonClient(idleTimeoutSec = 0): Promise<import('../daemon/client').DaemonClient> {
    if (!this.socketClient) {
      const { DaemonClient, daemonPaths } = await import('../daemon/client');
      this.socketClient = new DaemonClient({
        paths: daemonPaths(pathContext({ home: this.io.home, env: this.io.env, platform: this.io.platform })),
        version: VERSION,
        command: this.io.daemonCommand,
        env: this.io.env,
        home: this.io.home,
        idleTimeoutSec,
      });
    }
    return this.socketClient;
  }

  /** Schema compiler for argument validation: in the daemon when there is one, else ajv here. */
  compile: SchemaCompiler = async (schema, label) => {
    const backend = await this.backend();
    return (backend.compiler() ?? (await import('./args/validate')).compileSchema)(schema, label);
  };

  /**
   * Text the CLI composed, scanned for the credentials the daemon knows and this process does not
   * (long ones only: `Redactor.scan`). Content that was echoed into it is redacted as a value first.
   */
  async redactText(text: string): Promise<string> {
    const backend = this.backendReady;
    return backend ? backend.redact(text) : this.redact.scan(text);
  }

  /** Content the CLI echoes, such as the arguments of a dry run: every string value redacted, the shape kept. */
  async redactValue<T>(value: T): Promise<T> {
    const local = redactValue(value, this.redact) as T;
    const backend = this.backendReady;
    return backend ? backend.redactValue(local) : local;
  }

  /** Where OAuth logins are kept: keychain, else a file in the data directory (auth.md). */
  async oauthStore(): Promise<OAuthStore> {
    if (!this.oauthStoreInstance) {
      const { createOAuthStore } = await import('../client/oauth');
      this.oauthStoreInstance = createOAuthStore({ home: this.io.home, env: this.io.env, platform: this.io.platform });
    }
    return this.oauthStoreInstance;
  }

  /** The tasks via started, per server (task-record.ts). */
  async taskRecords(): Promise<TaskRecords> {
    if (!this.taskRecordsInstance) {
      const { TaskRecords } = await import('./task-record');
      this.taskRecordsInstance = new TaskRecords(join(this.cacheDir, 'tasks'), this.io.now);
    }
    return this.taskRecordsInstance;
  }

  async cache(): Promise<CatalogCache> {
    if (!this.cacheInstance) {
      const { CatalogCache } = await this.deps();
      this.cacheInstance = new CatalogCache(join(this.cacheDir, 'catalog'), this.io.now);
    }
    return this.cacheInstance;
  }

  /** Where built provider catalogs are kept next to the raw tool lists (view-cache.ts). */
  async viewCache(): Promise<ViewCache> {
    if (!this.viewCacheInstance) {
      const { ViewCache, rulesFingerprint } = await this.deps();
      this.viewCacheInstance = new ViewCache(join(this.cacheDir, 'catalog'), rulesFingerprint());
    }
    return this.viewCacheInstance;
  }

  async table(): Promise<ProviderTable> {
    if (!this.tableInstance) {
      const { buildProviderTable } = await this.deps();
      this.tableInstance = buildProviderTable((await this.config()).servers);
    }
    return this.tableInstance;
  }

  async close(): Promise<void> {
    await this.backendReady?.close().catch(() => undefined);
    this.socketClient?.close();
  }

  // Tool lists --------------------------------------------------------------------------

  /** Timeout for fetching one server's tools: `--timeout`, else the server's own (capped when listing many). */
  listTimeoutMs(server: ServerConfig, many: boolean): number {
    if (this.options.timeoutMs !== undefined) return this.options.timeoutMs;
    return many ? Math.min(server.timeout * 1000, BROWSE_TIMEOUT_MS) : server.timeout * 1000;
  }

  /**
   * The tools of one server: from the cache when fresh, else from the server (and then cached).
   * `refresh` skips the cache read. `many`: one of several fetched at once, so the wait is capped.
   * `discovery`: a browse (`via`, `via find`, `via prompt`) that does not wait for a slow server (below). Throws ClientError.
   */
  async listing(entry: ProviderEntry, options: { refresh?: boolean; many?: boolean; discovery?: boolean; have?: number } = {}): Promise<Listing> {
    const { server } = entry;
    if (!server.trusted) throw (await import('../client/errors')).untrustedServer(server);
    const many = options.many ?? false;
    const timeoutMs = this.listTimeoutMs(server, many);
    const discovery = options.discovery ?? false;
    // Discovery commands do not wait for the server's whole `timeout`: a daemon answers after `discovery.wait`
    // (or `--timeout`) and keeps connecting behind it; this process has nothing to keep it going, so it uses `timeoutMs`.
    let background: { waitMs: number; timeoutMs: number } | undefined;
    if (discovery && !this.daemonOff) {
      const own = this.options.timeoutMs;
      background = { waitMs: own ?? Math.min((await this.config()).discovery.wait * 1000, server.timeout * 1000), timeoutMs: own ?? server.timeout * 1000 };
    }
    return (await this.backend()).listing(server, {
      timeoutMs,
      ...(background ? { background } : {}),
      refresh: options.refresh ?? false,
      ...(options.have !== undefined ? { have: options.have } : {}),
    });
  }

  /** Fetch several providers in parallel; failures become statuses instead of aborting. */
  async loadProviders(entries: readonly ProviderEntry[], options: { refresh?: boolean; examples?: boolean } = {}): Promise<LoadedProviders> {
    const config = await this.config();
    const [{ buildCatalog, failureReason, providerInput, statusOf }, views] = await Promise.all([this.deps(), this.viewCache()]);
    const statuses: Record<string, ProviderStatus> = {};
    const details: Record<string, string> = {};
    const failures: LoadedProviders['failures'] = [];
    // The build inputs do not depend on the tool list, so they are known before it is fetched; the
    // build we already have tells which list to ask the backend about (it may then skip sending it).
    const early = entries.map((entry) => providerInput(entry, [], config, true));
    const results = await Promise.all(
      entries.map(async (entry, i) => {
        try {
          const have = options.refresh ? undefined : views.peek(entry.server, early[i]!);
          return { entry, listing: await this.listing(entry, { refresh: options.refresh ?? false, many: true, discovery: true, ...(have !== undefined ? { have } : {}) }) };
        } catch (error) {
          const status = statusOf(error);
          statuses[entry.name] = status;
          if (status === 'failed') details[entry.name] = failureReason(await this.redactText(error instanceof Error ? error.message : String(error)), entry.name);
          failures.push({ entry, error });
          return { entry, listing: undefined };
        }
      }),
    );
    // A listing that is a cache file read parses its tools only if somebody asks.
    const inputs = results.map((r, i) => (r.listing ? { ...early[i]!, get tools() { return r.listing!.tools; } } : early[i]!));
    // Providers whose build is in the cache are restored; the rest are built here and then kept.
    const byName = new Map(results.map((r) => [r.entry.name, r]));
    const written = new Map<CatalogTool, DocTerms>();
    const restored = new Map<string, { get(tool: CatalogTool): DocTerms | undefined }>();
    // Builds in the cache that lack the call examples a caller asked for (`via find`): written again with them.
    const withoutExamples = new Set<string>();
    const catalog = buildCatalog(inputs, undefined, (input) => {
      const r = byName.get(input.provider);
      const hit = r?.listing ? views.read(r.entry.server, input, r.listing) : undefined;
      if (!hit) return undefined;
      restored.set(input.provider, hit.terms);
      if (options.examples && !hit.examples) withoutExamples.add(input.provider);
      return hit.catalog;
    });
    for (const [i, r] of results.entries()) {
      const built = catalog.providers.find((p) => p.provider === r.entry.name);
      if (!r.listing || !built) continue;
      if (restored.has(r.entry.name) && !withoutExamples.has(r.entry.name)) continue;
      const terms = await views.write(r.entry.server, inputs[i]!, r.listing, built, { examples: options.examples ?? false });
      if (!restored.has(r.entry.name)) for (const [tool, known] of terms) written.set(tool, known);
    }
    const terms = { get: (tool: CatalogTool): DocTerms | undefined => written.get(tool) ?? restored.get(tool.provider)?.get(tool) };
    const background = this.backendReady?.mode === 'daemon';
    for (const [name, status] of Object.entries(statuses)) {
      if (status === 'starting') details[name] = background ? 'retry in a moment' : `via sync ${name}`;
    }
    return { catalog, terms, statuses, details, failures, background };
  }

  /**
   * Provider catalogs of one server: with `deny` applied (what the user sees, from the build cache
   * when it has one) and without it (only built if something asks, which is rare: a name that does
   * not resolve is checked against the denied tools).
   */
  async providerViews(entry: ProviderEntry, listing: Listing): Promise<{ visible: ProviderCatalog; full: ProviderCatalog }> {
    const config = await this.config();
    const [{ buildProvider, providerInput }, views] = await Promise.all([this.deps(), this.viewCache()]);
    const input = providerInput(entry, listing.tools, config, true);
    let visible = views.read(entry.server, input, listing)?.catalog;
    if (!visible) {
      visible = buildProvider(entry, listing.tools, config, true);
      await views.write(entry.server, input, listing, visible);
    }
    let full: ProviderCatalog | undefined;
    return {
      visible,
      get full(): ProviderCatalog {
        return (full ??= buildProvider(entry, listing.tools, config, false));
      },
    };
  }

  // Failures ----------------------------------------------------------------------------

  /** Print the failure and return its exit code. */
  async report(error: unknown): Promise<number> {
    // Only a failure needs this module.
    const { toErrorInfo } = await import('./error-info');
    const info = this.dropRefusedNext(await toErrorInfo(error));
    this.err(await this.redactText(formatError(info, this.options.format, this.redact)));
    return info.code;
  }
}
