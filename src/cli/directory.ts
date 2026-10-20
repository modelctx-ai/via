// From configured servers to catalog inputs: which providers exist, how a server is identified
// for domain inference, which tools `deny` hides.
import {
  buildProviderCatalog,
  normalizeProviderName,
  RESERVED_COMMANDS,
  type CatalogTool,
  type CatalogWarning,
  type McpTool,
  type ProviderCatalog,
  type ProviderIdentity,
  type ProviderInput,
  type ProviderStatus,
} from '../catalog';
import type { LoadedConfig, ServerConfig } from '../config';
import { ExitCode } from '../render/exit-codes';

export interface ProviderEntry {
  /** Provider name on the command line: normalized alias or server name. */
  name: string;
  server: ServerConfig;
}

export interface ProviderTable {
  entries: ProviderEntry[];
  /** Servers left out because their provider name is reserved or taken. */
  warnings: CatalogWarning[];
  /** The servers behind `warnings`, for `via doctor` and `via servers`. */
  skipped: ServerConfig[];
}

/**
 * The providers of this run, before any tools are fetched. Disabled servers are hidden; a name
 * that equals a built-in subcommand or an earlier provider is skipped with a warning, as
 * `buildCatalog` does (discovery.md, step 2).
 */
export function buildProviderTable(servers: readonly ServerConfig[]): ProviderTable {
  const entries: ProviderEntry[] = [];
  const warnings: CatalogWarning[] = [];
  const skipped: ServerConfig[] = [];
  const seen = new Set<string>();
  for (const server of servers) {
    if (server.disabled) continue;
    const name = normalizeProviderName(server.provider);
    if (name === '') continue;
    if (RESERVED_COMMANDS.includes(name)) {
      warnings.push({
        provider: name,
        code: 'reserved-name',
        message: `provider name "${name}" collides with a built-in subcommand; set "alias" in the server config`,
      });
      skipped.push(server);
      continue;
    }
    if (seen.has(name)) {
      warnings.push({ provider: name, code: 'duplicate-provider', message: `provider "${name}" is defined more than once; the first definition is used` });
      skipped.push(server);
      continue;
    }
    seen.add(name);
    entries.push({ name, server });
  }
  return { entries, warnings, skipped };
}

/** npm / PyPI / image names that appear on a stdio command line, and the host of an HTTP URL. */
export function identityOf(server: ServerConfig): ProviderIdentity {
  const { transport } = server;
  if (transport.type === 'http') {
    try {
      return { host: new URL(transport.url).hostname };
    } catch {
      return {};
    }
  }
  const candidates = [transport.command.split(/[\\/]/).pop() ?? '', ...transport.args];
  const packages = candidates.filter((a) => a !== '' && !a.startsWith('-') && !a.startsWith('.') && !a.startsWith('~') && !a.includes('=') && !/^(\/|[A-Za-z]:\\)/.test(a) && (a.match(/\//g) ?? []).length <= 1);
  return { packages };
}

export function providerInput(entry: ProviderEntry, tools: McpTool[], config: LoadedConfig, withDeny: boolean): ProviderInput {
  const { server } = entry;
  const input: ProviderInput = {
    provider: entry.name,
    tools,
    rename: server.rename,
    deny: withDeny ? config.deny : [],
    identity: identityOf(server),
    customDomains: config.domains,
  };
  if (server.name !== entry.name) input.aliases = [server.name];
  if (server.domain !== undefined) input.configDomain = server.domain;
  return input;
}

export function buildProvider(entry: ProviderEntry, tools: McpTool[], config: LoadedConfig, withDeny: boolean): ProviderCatalog {
  return buildProviderCatalog(providerInput(entry, tools, config, withDeny));
}

/** The first `deny` rule that hides this tool, matched on both spellings (config.md, "deny"). */
export function matchingDeny(tool: CatalogTool, deny: readonly RegExp[]): RegExp | undefined {
  return deny.find((re) => {
    const plain = re.global || re.sticky ? new RegExp(re.source, re.flags.replace(/[gy]/g, '')) : re;
    return plain.test(tool.singleRef) || plain.test(`${tool.provider}/${tool.rawName}`);
  });
}

/** How a failed listing shows up in `via` (discovery.md, "浏览视图"). */
export function statusOf(error: unknown): Exclude<ProviderStatus, 'ok'> {
  if (error instanceof Error && error.name === 'ClientError') {
    const code = (error as Error & { exitCode?: number }).exitCode;
    if (code === ExitCode.Auth) return 'needs-auth';
    if (code === ExitCode.Denied && /untrusted/.test(error.message)) return 'untrusted';
  }
  return 'error';
}
