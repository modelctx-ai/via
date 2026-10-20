// The state one command run shares: configuration, credential resolver, MCP client, caches, and
// the helpers every command needs (writing, redaction, failure reports). The heavy modules
// (config, catalog, MCP client) are imported on first use, so `via more` stays cheap.
import { join } from 'node:path';
import type { Catalog, McpTool, ProviderCatalog, ProviderStatus } from '../catalog';
import type { McpClient } from '../client';
import type { ToolArgsError } from './args';
import { pathContext, userCacheDir } from '../config/paths';
import type { CredentialResolver, LoadedConfig, ServerConfig } from '../config';
import { createRedactor } from '../render/redact';
import { formatError, type ErrorInfo } from '../render/errors';
import { ExitCode } from '../render/exit-codes';
import type { CatalogCache } from './catalog-cache';
import type { ProviderEntry, ProviderTable } from './directory';
import type { CliEnv } from './env';
import { CliFailure, fail } from './failure';
import type { GlobalOptions } from './options';

/** Per-server ceiling when listing many servers at once, so one slow server cannot stall `via`. */
export const BROWSE_TIMEOUT_MS = 10_000;

/** A fetched `tools/list` and where it came from. */
export interface Listing {
  tools: McpTool[];
  fetchedAt: number;
  fromCache: boolean;
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
  private clientInstance?: McpClient;
  private tableInstance?: ProviderTable;
  private cacheInstance?: CatalogCache;

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
    if (!this.resolverInstance) {
      const { createCredentialResolver } = await import('../config');
      this.resolverInstance = createCredentialResolver({ home: this.io.home, env: this.io.env, platform: this.io.platform, cwd: this.io.cwd });
    }
    return this.resolverInstance;
  }

  /** Every credential value resolved in this run. */
  secrets(): readonly string[] {
    return this.resolverInstance?.resolvedValues() ?? [];
  }

  async client(): Promise<McpClient> {
    if (!this.clientInstance) {
      const config = await this.config({ allowErrors: true });
      const { InProcessClient } = await import('../client');
      this.clientInstance = new InProcessClient(config.servers, await this.resolver());
    }
    return this.clientInstance;
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
    await this.clientInstance?.close().catch(() => undefined);
  }

  // Tool lists --------------------------------------------------------------------------

  /** Timeout for fetching one server's tools: `--timeout`, else the server's own (capped when listing many). */
  listTimeoutMs(server: ServerConfig, many: boolean): number {
    if (this.options.timeoutMs !== undefined) return this.options.timeoutMs;
    return many ? Math.min(server.timeout * 1000, BROWSE_TIMEOUT_MS) : server.timeout * 1000;
  }

  /**
   * Resolve the credentials of a server (in memory) so a missing one fails before any network
   * call, and so redaction knows the values even when the tool list comes from the cache.
   */
  async prime(server: ServerConfig, timeoutMs: number): Promise<void> {
    const { resolveConnection, mapError } = await import('../client');
    try {
      await resolveConnection(server, await this.resolver(), this.io.env as NodeJS.ProcessEnv);
    } catch (error) {
      throw mapError(error, { server, phase: 'connect', timeoutMs, redact: this.redact });
    }
  }

  /**
   * The tools of one server: from the disk cache when fresh, else from the server (and then
   * cached). `refresh` skips the cache read. Throws ClientError.
   */
  async listing(entry: ProviderEntry, options: { refresh?: boolean; many?: boolean } = {}): Promise<Listing> {
    const { server } = entry;
    if (!server.trusted) throw (await import('../client')).untrustedServer(server);
    const timeoutMs = this.listTimeoutMs(server, options.many ?? false);
    await this.prime(server, timeoutMs);
    if (!options.refresh) {
      const cache = await this.cache();
      const hit = cache.read(server);
      if (hit) return { tools: hit.tools, fetchedAt: hit.fetchedAt, fromCache: true };
    }
    const tools = await (await this.client()).listTools(server.name, { timeoutMs });
    (await this.cache()).write(server, tools);
    return { tools, fetchedAt: this.io.now(), fromCache: false };
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
    this.err(formatError(info, this.options.format, this.redact));
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
