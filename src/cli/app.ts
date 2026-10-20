// The state one command run shares: configuration, credential resolver, MCP client, caches, and
// the helpers every command needs (writing, redaction, failure reports). The heavy modules
// (config, catalog, MCP client) are imported on first use, so `via more` stays cheap.
import { join } from 'node:path';
import type { Catalog, McpTool, ProviderCatalog, ProviderStatus } from '../catalog';
import type { McpClient } from '../client';
import type { OAuthStore } from '../client/oauth/store';
import type { SchemaCompiler, ToolArgsError } from './args';
import { pathContext, userCacheDir } from '../config/paths';
import type { CredentialResolver, LoadedConfig, ServerConfig } from '../config';
import { createRedactor } from '../render/redact';
import { formatError, type ErrorInfo } from '../render/errors';
import { ExitCode } from '../render/exit-codes';
import type { Backend, Listing } from './backend';
import type { CatalogCache } from './catalog-cache';
import type { ProviderEntry, ProviderTable } from './directory';
import type { CliEnv } from './env';
import { CliFailure, fail } from './failure';
import type { GlobalOptions } from './options';

/** Per-server ceiling when listing many servers at once, so one slow server cannot stall `via`. */
export const BROWSE_TIMEOUT_MS = 10_000;

export type { Listing };

/**
 * Whether servers are reached from this process instead of through the daemon: `VIA_NO_DAEMON` set
 * to anything but empty/`0`/`false` (daemon.md, "无 daemon 模式"). The injected environment wins;
 * the real one is consulted too so a test run can switch the daemon off for every sandbox at once.
 * Windows has no daemon before 0.3.
 */
export function daemonDisabled(io: Pick<CliEnv, 'env' | 'platform'>): boolean {
  if (io.platform === 'win32') return true;
  const value = io.env.VIA_NO_DAEMON ?? process.env.VIA_NO_DAEMON;
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

export interface LoadedProviders {
  /** Visible catalog (deny applied). Failed providers are present with no tools. */
  catalog: Catalog;
  statuses: Record<string, ProviderStatus>;
  failures: Array<{ entry: ProviderEntry; error: unknown }>;
}

export class App {
  private loaded?: LoadedConfig;
  private resolverInstance?: CredentialResolver;
  private resolverLoading?: Promise<CredentialResolver>;
  private backendInstance?: Promise<Backend>;
  private backendReady?: Backend;
  private socketClient?: import('../daemon/client').DaemonClient;
  private tableInstance?: ProviderTable;
  private cacheInstance?: CatalogCache;
  private oauthStoreInstance?: OAuthStore;

  constructor(
    readonly io: CliEnv,
    readonly options: GlobalOptions,
  ) {}

  // Output ------------------------------------------------------------------------------

  out(text: string): void {
    if (text !== '') this.io.stdout.write(text);
  }

  err(text: string): void {
    if (text !== '') this.io.stderr.write(text);
  }

  /** Replaces every credential value resolved so far with `***`. */
  redact = (text: string): string => {
    const values = this.resolverInstance?.resolvedValues() ?? [];
    return values.length === 0 ? text : createRedactor(values)(text);
  };

  // Paths -------------------------------------------------------------------------------

  get cacheDir(): string {
    return userCacheDir(pathContext({ home: this.io.home, env: this.io.env, platform: this.io.platform }));
  }

  // Lazily created pieces ---------------------------------------------------------------

  /**
   * The merged configuration. An error-level diagnostic stops the command (fail closed): a deny
   * rule that did not compile would otherwise leave a tool visible (config.md, "校验与诊断").
   * `via doctor` and `via servers` pass `allowErrors` to show the diagnostics instead.
   */
  async config(options: { allowErrors?: boolean } = {}): Promise<LoadedConfig> {
    const { loadConfig, hasErrors, formatDiagnostic } = await import('../config');
    if (!this.loaded) {
      this.loaded = await loadConfig({ cwd: this.io.cwd, env: this.io.env, home: this.io.home, platform: this.io.platform });
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
    this.resolverLoading ??= import('../config').then(({ createCredentialResolver }) => {
      this.resolverInstance = createCredentialResolver({ home: this.io.home, env: this.io.env, platform: this.io.platform, cwd: this.io.cwd });
      return this.resolverInstance;
    });
    return this.resolverLoading;
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
    const onWarning = (message: string): void => this.err(`warning: ${this.redact(message)}\n`);
    const inProcess = async (): Promise<Backend> => {
      const { InProcessBackend } = await import('./backend');
      return InProcessBackend.create({
        servers: config.servers,
        resolver: await this.resolver(),
        cache: await this.cache(),
        env: this.io.env,
        cacheDir: this.cacheDir,
        now: this.io.now,
        onWarning,
        ...(config.servers.some((s) => s.auth.type === 'oauth') ? { oauthStore: await this.oauthStore() } : {}),
      });
    };
    if (daemonDisabled(this.io)) return inProcess();
    const [{ DaemonBackend }, { FallbackBackend }, { FileCursorStore }] = await Promise.all([
      import('../daemon/backend'),
      import('./backend'),
      import('../render/cursor-file'),
    ]);
    const client = await this.daemonClient(config.daemon.idleTimeout);
    const primary = new DaemonBackend({
      client,
      servers: config.servers,
      cwd: this.io.cwd,
      env: this.io.env,
      serverIdleTimeoutSec: config.daemon.serverIdleTimeout,
      onWarning,
    });
    return new FallbackBackend(primary, inProcess, (message) => this.err(message), () => new FileCursorStore(join(this.cacheDir, 'cursors'), { now: this.io.now }));
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
      const [{ DaemonClient }, { daemonPaths }, { VERSION }] = await Promise.all([import('../daemon/client'), import('../daemon/paths'), import('./help')]);
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

  /** `redact` for text that is about to be printed after the sync paths could not know the daemon's secrets. */
  async redactText(text: string): Promise<string> {
    const backend = this.backendReady;
    return backend ? backend.redact(text) : this.redact(text);
  }

  /** Where OAuth logins are kept: keychain, else a file in the data directory (auth.md). */
  async oauthStore(): Promise<OAuthStore> {
    if (!this.oauthStoreInstance) {
      const { createOAuthStore } = await import('../client/oauth');
      this.oauthStoreInstance = createOAuthStore({ home: this.io.home, env: this.io.env, platform: this.io.platform });
    }
    return this.oauthStoreInstance;
  }

  async cache(): Promise<CatalogCache> {
    if (!this.cacheInstance) {
      const { CatalogCache } = await import('./catalog-cache');
      this.cacheInstance = new CatalogCache(join(this.cacheDir, 'catalog'), this.io.now);
    }
    return this.cacheInstance;
  }

  async table(): Promise<ProviderTable> {
    if (!this.tableInstance) {
      const { buildProviderTable } = await import('./directory');
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
   * `refresh` skips the cache read. Throws ClientError.
   */
  async listing(entry: ProviderEntry, options: { refresh?: boolean; many?: boolean } = {}): Promise<Listing> {
    const { server } = entry;
    if (!server.trusted) throw (await import('../client')).untrustedServer(server);
    const timeoutMs = this.listTimeoutMs(server, options.many ?? false);
    return (await this.backend()).listing(server, { timeoutMs, refresh: options.refresh ?? false });
  }

  /** Fetch several providers in parallel; failures become statuses instead of aborting. */
  async loadProviders(entries: readonly ProviderEntry[], options: { refresh?: boolean } = {}): Promise<LoadedProviders> {
    const config = await this.config();
    const { buildCatalog } = await import('../catalog');
    const { providerInput, statusOf } = await import('./directory');
    const statuses: Record<string, ProviderStatus> = {};
    const failures: LoadedProviders['failures'] = [];
    const results = await Promise.all(
      entries.map(async (entry) => {
        try {
          return { entry, tools: (await this.listing(entry, { refresh: options.refresh ?? false, many: true })).tools };
        } catch (error) {
          statuses[entry.name] = statusOf(error);
          failures.push({ entry, error });
          return { entry, tools: [] as McpTool[] };
        }
      }),
    );
    const catalog = buildCatalog(results.map((r) => providerInput(r.entry, r.tools, config, true)));
    return { catalog, statuses, failures };
  }

  /** Provider catalogs of one server: with `deny` applied (what the user sees) and without it. */
  async providerViews(entry: ProviderEntry, tools: McpTool[]): Promise<{ visible: ProviderCatalog; full: ProviderCatalog }> {
    const config = await this.config();
    const { buildProvider } = await import('./directory');
    return { visible: buildProvider(entry, tools, config, true), full: buildProvider(entry, tools, config, false) };
  }

  // Failures ----------------------------------------------------------------------------

  /** Print the failure and return its exit code. */
  async report(error: unknown): Promise<number> {
    const info = await toErrorInfo(error);
    this.err(await this.redactText(formatError(info, this.options.format, this.redact)));
    return info.code;
  }
}

/** Anything thrown while running a command, as a printable error. */
export async function toErrorInfo(error: unknown): Promise<ErrorInfo> {
  if (error instanceof CliFailure) return error.info;
  if (isToolArgsError(error)) return argsErrorInfo(error);
  if (error instanceof Error && error.name === 'ClientError') {
    const e = error as Error & Pick<ErrorInfo, 'next'> & { exitCode: ErrorInfo['code']; candidates?: string[] };
    const info: ErrorInfo = { code: e.exitCode, message: e.message };
    if (e.candidates && e.candidates.length > 0) info.lines = [`did you mean: ${e.candidates.join(' · ')}`];
    if (e.next) info.next = e.next;
    return info;
  }
  if (error instanceof Error && error.name === 'CredentialError') {
    const info: ErrorInfo = { code: ExitCode.Auth, message: error.message };
    const next = (error as Error & { next?: string }).next;
    if (next) info.next = next;
    return info;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: ExitCode.Internal, message: `internal error: ${message.split('\n')[0]}`, next: 'via doctor' };
}

function isToolArgsError(error: unknown): error is ToolArgsError {
  return error instanceof Error && error.name === 'ToolArgsError';
}

/**
 * Usage and validation failures (arguments.md, "报错"): the headline, the aligned argument lines
 * and the usage block come from the argument parser; `next:` only when it gives one.
 */
async function argsErrorInfo(error: ToolArgsError): Promise<ErrorInfo> {
  const { argsErrorLines } = await import('./args');
  const info: ErrorInfo = { code: ExitCode.Usage, message: error.message, lines: argsErrorLines(error) };
  if (error.next) info.next = error.next;
  if (error.details.length > 0) info.details = [...error.details];
  return info;
}
