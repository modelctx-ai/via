// `via servers`: where each server comes from, how it connects, whether its credentials resolve
// (cli.md, discovery.md).
import { formatDiagnostic, type ServerConfig } from '../../config';
import { shortenHome } from '../../config/paths';
import { shellWord } from '../../render/shell';
import { alignRows } from '../../render/width';
import { ExitCode } from '../../render/exit-codes';
import type { App } from '../app';
import { authState } from '../auth-state';
import { buildProviderTable } from '../directory';
import { protocolLabel } from '../protocol-label';
import { parseLocal } from '../options';
import { usageFailure } from '../failure';

/** The auth column: the method, and whether it would work (references only, never values). */
async function authStatus(app: App, server: ServerConfig): Promise<string> {
  const state = await authState(app, server);
  if (state.method === 'oauth') {
    const { summarizeLogin } = await import('../../client/oauth');
    if (state.storeError) return `oauth (cannot read saved logins: ${state.storeError})`;
    return `oauth (${summarizeLogin(state.login!, app.io.now())})`;
  }
  return state.missing.length > 0 ? `${state.method} (missing ${state.missing.join(', ')})` : state.method;
}

const shorten = (path: string, home: string): string => shortenHome(path, home);

function describeTransport(server: ServerConfig): string {
  const { transport } = server;
  if (transport.type === 'stdio') return `stdio ${transport.command}`;
  try {
    return `http ${new URL(transport.url).origin}`;
  } catch {
    return 'http';
  }
}

export async function serversCommand(app: App, argv: readonly string[]): Promise<number> {
  const { positionals } = parseLocal('servers', argv, []);
  if (positionals.length > 0) throw usageFailure('via servers takes no arguments', 'via servers -h');

  const config = await app.config({ allowErrors: true });
  // What each server negotiated the last time its catalog was fetched; nothing is connected here.
  const cache = await app.cache();
  const table = buildProviderTable(config.servers);
  const skipped = new Map(table.skipped.map((s, i) => [s, table.warnings[i]!.message]));
  const rows: string[][] = [];
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
    const source = server.origin.path ? shorten(server.origin.path, app.io.home) : server.origin.scope;
    rows.push([server.provider, describeTransport(server), protocolLabel(server.disabled ? undefined : cache.read(server)?.protocol, server.protocolVersion) ?? '-', await authStatus(app, server), source, notes.join('; ')]);
  }
  if (rows.length === 0) app.out('no MCP servers found\n');
  else app.out(`${alignRows(rows).join('\n')}\n`);
  if (config.diagnostics.length > 0) {
    app.out(`\n${config.diagnostics.map((d) => `${d.level}: ${formatDiagnostic(d)}`).join('\n')}\n`);
  }
  return ExitCode.Ok;
}
