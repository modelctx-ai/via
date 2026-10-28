// `via servers`: where each server comes from, how it connects, whether its credentials resolve
// (cli.md, discovery.md).
import { formatDiagnostic, type ServerConfig } from '../../config';
import { shortenHome } from '../../config/paths';
import type { ProtocolInfo } from '../../protocol';
import { shellWord } from '../../render/shell';
import { alignRows } from '../../render/width';
import { ExitCode } from '../../render/exit-codes';
import type { App } from '../app';
import { authState, type AuthState } from '../auth-state';
import type { CacheEntry } from '../../client/catalog-cache';
import { buildProviderTable, type ProviderEntry } from '../directory';
import { writeJson } from '../listing-output';
import { protocolLabel } from '../protocol-label';
import { parseLocal } from '../options';
import { usageFailure } from '../failure';

/** The auth column: the method, and whether it would work (references only, never values). */
async function authStatus(app: App, state: AuthState): Promise<string> {
  if (state.method === 'oauth') {
    const { summarizeLogin, summarizeMachineLogin } = await import('../../client/oauth');
    if (state.storeError) return `oauth (cannot read saved logins: ${state.storeError})`;
    if (state.machine) return state.missing.length > 0 ? `oauth (client credentials, missing ${state.missing.join(', ')})` : `oauth (${summarizeMachineLogin(state.login!, app.io.now())})`;
    return `oauth (${summarizeLogin(state.login!, app.io.now())})`;
  }
  return state.missing.length > 0 ? `${state.method} (missing ${state.missing.join(', ')})` : state.method;
}

const shorten = (path: string, home: string): string => shortenHome(path, home);

/** Scheme and host of a URL: its path and query may carry a credential. Empty when it does not parse. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function describeTransport(server: ServerConfig): string {
  const { transport } = server;
  if (transport.type === 'stdio') return `stdio ${transport.command}`;
  const origin = originOf(transport.url);
  return origin === '' ? 'http' : `http ${origin}`;
}

/** One server as `via servers` knows it: the text row and the JSON object are made from the same facts. */
interface ServerRow {
  server: ServerConfig;
  status: 'ok' | 'disabled' | 'skipped' | 'untrusted';
  auth: AuthState;
  authText: string;
  protocol: ProtocolInfo | undefined;
  tools: number | undefined;
  source: string;
  notes: string[];
}

/**
 * The visible tool count of a server from what is already on disk: the prebuilt catalog's head, or a
 * build from the cached list when there is none yet. Undefined when nothing is cached or the server
 * is not one via would use.
 */
async function toolCount(app: App, entry: ProviderEntry | undefined, cached: CacheEntry | undefined): Promise<number | undefined> {
  if (!entry || !cached || !entry.server.trusted) return undefined;
  const listing = {
    get tools() {
      return cached.tools;
    },
    fetchedAt: cached.fetchedAt,
    fromCache: true,
    rawBytes: cached.rawBytes,
  };
  const { visible } = await app.providerViews(entry, listing);
  return (visible as { toolCount?: number }).toolCount ?? visible.tools.length;
}

/** The JSON form (cli.md, `via servers`): references and counts, never a URL path or query, an environment value or a credential. */
function serverJson(row: ServerRow): Record<string, unknown> {
  const { server, auth } = row;
  const { transport } = server;
  return {
    name: server.name,
    provider: server.provider,
    transport: transport.type === 'stdio' ? { type: 'stdio', command: transport.command } : { type: 'http', origin: originOf(transport.url) },
    source: { scope: server.origin.scope, ...(server.origin.path ? { path: row.source } : {}) },
    status: row.status,
    auth: {
      method: auth.method,
      usable: auth.usable,
      ...(auth.missing.length > 0 ? { missing: auth.missing } : {}),
      ...(auth.login ? { login: auth.login.state } : {}),
    },
    protocol: row.protocol
      ? { version: row.protocol.version, stateful: row.protocol.stateful, pinned: server.protocolVersion !== undefined }
      : server.protocolVersion !== undefined
        ? { version: server.protocolVersion, pinned: true }
        : null,
    tools: row.tools ?? null,
    ...(row.notes.length > 0 ? { notes: row.notes } : {}),
  };
}

export async function serversCommand(app: App, argv: readonly string[]): Promise<number> {
  const { positionals } = parseLocal('servers', argv, []);
  if (positionals.length > 0) throw usageFailure('via servers takes no arguments', 'via servers -h');
  if (app.options.format === 'raw') throw usageFailure('-o raw applies to a tool call: a listing has no upstream text to show', 'via servers -o json');

  const config = await app.config({ allowErrors: true });
  // What each server negotiated the last time its catalog was fetched; nothing is connected here.
  const cache = await app.cache();
  const table = buildProviderTable(config.servers);
  const skipped = new Map(table.skipped.map((s, i) => [s, table.warnings[i]!.message]));
  const entryOf = new Map(table.entries.map((e) => [e.server, e]));
  const rows: ServerRow[] = [];
  for (const server of config.servers) {
    const notes: string[] = [];
    if (server.disabled) notes.push('disabled');
    if (!server.trusted) {
      const paths = server.untrustedPaths ?? [];
      notes.push(paths.length === 1 ? `untrusted (via trust ${shellWord(paths[0]!)})` : 'untrusted (via trust)');
    }
    if (server.conflicts && server.conflicts.length > 0) {
      notes.push(`conflict: ignored ${server.conflicts.map((c) => c.framework ?? c.path ?? c.scope).join(', ')}`);
    }
    const skip = skipped.get(server);
    if (skip) notes.push(skip);
    const cached = server.disabled ? undefined : cache.read(server);
    const auth = await authState(app, server);
    rows.push({
      server,
      status: server.disabled ? 'disabled' : skip ? 'skipped' : !server.trusted ? 'untrusted' : 'ok',
      auth,
      authText: await authStatus(app, auth),
      protocol: cached?.protocol,
      // Counting needs the catalog of a provider that exists; JSON is the only form that shows it.
      tools: app.options.format === 'json' ? await toolCount(app, entryOf.get(server), cached) : undefined,
      source: server.origin.path ? shorten(server.origin.path, app.io.home) : server.origin.scope,
      notes,
    });
  }
  if (app.options.format === 'json') {
    const payload = {
      servers: rows.map(serverJson),
      diagnostics: config.diagnostics.map((d) => ({ level: d.level, message: formatDiagnostic(d) })),
    };
    await writeJson(app, payload);
    return ExitCode.Ok;
  }
  const lines = rows.map((r) => [r.server.provider, describeTransport(r.server), protocolLabel(r.server.disabled ? undefined : r.protocol, r.server.protocolVersion) ?? '-', r.authText, r.source, r.notes.join('; ')]);
  if (lines.length === 0) app.out('no MCP servers found\n');
  else app.out(`${alignRows(lines).join('\n')}\n`);
  if (config.diagnostics.length > 0) {
    app.out(`\n${config.diagnostics.map((d) => `${d.level}: ${formatDiagnostic(d)}`).join('\n')}\n`);
  }
  return ExitCode.Ok;
}
