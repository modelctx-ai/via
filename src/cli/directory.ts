// From configured servers to catalog inputs: which providers exist and which tools `deny` hides.
import {
  buildProviderCatalog,
  findDenyRule,
  normalizeProviderName,
  RESERVED_COMMANDS,
  type CatalogTool,
  type CatalogWarning,
  type McpTool,
  type ProviderCatalog,
  type ProviderInput,
  type ProviderStatus,
} from '../catalog';
import type { LoadedConfig, ServerConfig } from '../config';
import { ExitCode } from '../render/exit-codes';
import { sanitizeText } from '../render/sanitize';
import { visibleText } from '../render/shell';

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

export function providerInput(entry: ProviderEntry, tools: McpTool[], config: LoadedConfig, withDeny: boolean): ProviderInput {
  const { server } = entry;
  const input: ProviderInput = {
    provider: entry.name,
    tools,
    rename: server.rename,
    deny: withDeny ? config.deny : [],
  };
  if (server.name !== entry.name) input.aliases = [server.name];
  // Patterns were compiled and screened when the config loaded (load.ts, `checkedPatterns`).
  if (server.confirmTools || server.confirmExcept) {
    input.confirm = { tools: (server.confirmTools ?? []).map((p) => new RegExp(p)), except: (server.confirmExcept ?? []).map((p) => new RegExp(p)) };
  }
  return input;
}

export function buildProvider(entry: ProviderEntry, tools: McpTool[], config: LoadedConfig, withDeny: boolean): ProviderCatalog {
  return buildProviderCatalog(providerInput(entry, tools, config, withDeny));
}

/** What denies this tool (`the deny rule /…/`), matched on every spelling (config.md, "deny"). */
export function matchingDeny(tool: CatalogTool, deny: readonly RegExp[]): string | undefined {
  return findDenyRule(tool, deny);
}

/**
 * How a listing that did not come back shows up in `via` (discovery.md, "浏览视图"). Running out of
 * time (the wait of a discovery command, or a daemon that is still connecting) is `starting`: nothing
 * is known to be wrong. Everything else that is not a login or trust problem is `failed`.
 */
export function statusOf(error: unknown): Exclude<ProviderStatus, 'ok'> {
  if (error instanceof Error && error.name === 'ClientError') {
    const { exitCode: code, kind } = error as Error & { exitCode?: number; kind?: string };
    if (code === ExitCode.Auth) return 'needs-auth';
    if (code === ExitCode.Denied && /untrusted/.test(error.message)) return 'untrusted';
    if (kind === 'timeout') return 'starting';
  }
  return 'failed';
}

/** Longest reason shown after `failed ·` in the root view. */
const MAX_REASON = 80;

/**
 * The first line of why a provider failed, for the row of `via`: without the `cannot start <provider>:`
 * lead (the row says which provider), control characters dropped, folded to one line, cut. `text` is the
 * error message after redaction: the cut must come last, or it could leave the start of a credential behind.
 */
export function failureReason(text: string, provider: string): string {
  const first = text.split(/\r?\n/)[0] ?? '';
  // Bidi and zero-width characters (text from the server's stderr can hold them) become visible escapes.
  const folded = visibleText(sanitizeText(first).replace(/\s+/g, ' ').trim());
  const bare = folded.startsWith(`cannot start ${provider}: `) ? folded.slice(`cannot start ${provider}: `.length) : folded;
  return bare.length > MAX_REASON ? `${bare.slice(0, MAX_REASON - 1)}…` : bare;
}
