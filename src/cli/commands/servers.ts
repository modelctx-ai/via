// `via servers [--why <provider>]`: where each server comes from, how it connects, whether its
// credentials resolve, and why a provider landed in its domain (cli.md, discovery.md).
import { renderDomainWhy } from '../../catalog';
import { formatDiagnostic, type ServerConfig } from '../../config';
import { alignRows } from '../../render/width';
import { ExitCode } from '../../render/exit-codes';
import type { App } from '../app';
import { authState } from '../auth-state';
import { buildProviderTable } from '../directory';
import { parseLocal } from '../options';
import { openProvider } from './provider';

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

function shorten(path: string, home: string): string {
  return home !== '' && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

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
  const { flags } = parseLocal('servers', argv, [{ name: 'why', value: true }]);
  if (typeof flags.why === 'string') {
    const { entry, views } = await openProvider(app, flags.why);
    app.out(`${renderDomainWhy(entry.name, views.visible.domain)}\n`);
    return ExitCode.Ok;
  }

  const config = await app.config({ allowErrors: true });
  const table = buildProviderTable(config.servers);
  const skipped = new Map(table.skipped.map((s, i) => [s, table.warnings[i]!.message]));
  const rows: string[][] = [];
  for (const server of config.servers) {
    const notes: string[] = [];
    if (server.disabled) notes.push('disabled');
    if (!server.trusted) {
      const path = server.untrustedPaths?.[0];
      notes.push(path ? `untrusted (via trust ${path})` : 'untrusted');
    }
    if (server.conflicts && server.conflicts.length > 0) {
      notes.push(`conflict: ignored ${server.conflicts.map((c) => c.framework ?? c.path ?? c.scope).join(', ')}`);
    }
    const skip = skipped.get(server);
    if (skip) notes.push(skip);
    const source = server.origin.path ? shorten(server.origin.path, app.io.home) : server.origin.scope;
    rows.push([server.provider, describeTransport(server), await authStatus(app, server), source, notes.join('; ')]);
  }
  if (rows.length === 0) app.out('no MCP servers found\n');
  else app.out(`${alignRows(rows).join('\n')}\n`);
  if (config.diagnostics.length > 0) {
    app.out(`\n${config.diagnostics.map((d) => `${d.level}: ${formatDiagnostic(d)}`).join('\n')}\n`);
  }
  return ExitCode.Ok;
}
