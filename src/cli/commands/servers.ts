// `via servers [--why <provider>]`: where each server comes from, how it connects, whether its
// credentials resolve, and why a provider landed in its domain (cli.md, discovery.md).
import { renderDomainWhy } from '../../catalog';
import { formatDiagnostic, isCredentialRef, parseCredentialRef, type ServerConfig } from '../../config';
import { shellWord } from '../../render/shell';
import { alignRows } from '../../render/width';
import { ExitCode } from '../../render/exit-codes';
import type { App } from '../app';
import { buildProviderTable } from '../directory';
import { parseLocal } from '../options';
import { openProvider } from './provider';

/** Credential references a server uses; references only, never values. */
function credentialRefs(server: ServerConfig): string[] {
  const refs: string[] = [];
  const { auth, transport } = server;
  if (auth.type === 'bearer') refs.push(auth.bearer);
  if (auth.type === 'headers') refs.push(...Object.values(auth.headers));
  refs.push(...Object.values(transport.type === 'stdio' ? transport.env : transport.headers));
  return [...new Set(refs.filter(isCredentialRef))];
}

async function authStatus(app: App, server: ServerConfig): Promise<string> {
  const kind = server.auth.type;
  if (kind === 'oauth') return 'oauth (not supported in 0.1)';
  const missing: string[] = [];
  for (const ref of credentialRefs(server)) {
    // `cmd:` is not run here: `via servers` connects to nothing, and a credential helper may be slow
    // or ask for a fingerprint. It runs when the server is used and in `via doctor`.
    if (parseCredentialRef(ref).kind === 'cmd') continue;
    try {
      await (await app.resolver()).resolve(ref, server.origin);
    } catch {
      missing.push(ref);
    }
  }
  const label = kind === 'none' ? (credentialRefs(server).length > 0 ? 'env' : 'none') : kind;
  return missing.length > 0 ? `${label} (missing ${missing.join(', ')})` : label;
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
      const paths = server.untrustedPaths ?? [];
      notes.push(paths.length === 1 ? `untrusted (via trust ${shellWord(paths[0]!)})` : 'untrusted (via trust)');
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
