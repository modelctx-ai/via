// What the CLI and the daemon agree on when a server definition crosses the socket: which session a
// definition maps to, how the caller's working directory is applied, and how the two sides tell that
// their environments differ for a credential variable without ever exchanging the value.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { rootUri } from '../client/roots';
import { parseCredentialRef } from '../config/credentials';
import type { ServerConfig } from '../config/types';

/** Every credential reference of a server, in a stable order. */
function credentialRefs(server: ServerConfig): string[] {
  const { transport, auth } = server;
  const refs: string[] = Object.values(transport.type === 'stdio' ? transport.env : transport.headers);
  if (auth.type === 'bearer') refs.push(auth.bearer);
  if (auth.type === 'headers') refs.push(...Object.values(auth.headers));
  return refs;
}

/**
 * Digest of the values of the variables behind the server's `env:` references, taken from `env`.
 * The CLI computes it from its environment and the daemon from its own; a difference means the
 * daemon would resolve a credential the CLI would not (it was started in another shell, or the
 * variable changed since). The daemon keeps one session per digest (`SessionManager`), so callers
 * with different values never share a session. Normally only the digest travels, and it is
 * one-way; the values themselves are sent once, when the daemon does not know the digest yet.
 */
export function envStamp(server: ServerConfig, env: Readonly<Record<string, string | undefined>>): string {
  const names = envNames(server);
  if (names.length === 0) return '';
  const hash = createHash('sha256');
  for (const name of names) hash.update(`${name}\0${env[name] ?? ''}\0`);
  return hash.digest('hex').slice(0, 32);
}

/** Names of the variables behind the server's `env:` references, sorted. */
export function envNames(server: ServerConfig): string[] {
  const names = new Set<string>();
  for (const ref of credentialRefs(server)) {
    const parsed = parseCredentialRef(ref);
    if (parsed.kind === 'env') names.add(parsed.arg);
  }
  return [...names].sort();
}

/** The caller's values for those variables (set ones only); sent when the daemon does not know their digest. */
export function envValuesOf(server: ServerConfig, env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of envNames(server)) {
    const value = env[name];
    if (typeof value === 'string' && value !== '') out[name] = value;
  }
  return out;
}

/**
 * `file:` references, a stdio `cwd` and `roots` are relative to the caller; the daemon has its own
 * working directory. Roots become absolute `file://` URIs here, which is what puts them into the
 * session key: callers in other directories get sessions of their own (ADR 0010).
 */
export function effectiveServer(server: ServerConfig, cwd: string, home: string = homedir()): ServerConfig {
  const absolute = (ref: string): string => {
    const parsed = parseCredentialRef(ref);
    if (parsed.kind !== 'file' || parsed.arg === '' || parsed.arg.startsWith('~') || parsed.arg.includes('%') || isAbsolute(parsed.arg)) return ref;
    return `file:${join(cwd, parsed.arg)}`;
  };
  const map = (record: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(record).map(([k, v]) => [k, absolute(v)]));
  const { transport, auth } = server;
  const next: ServerConfig = {
    ...server,
    transport:
      transport.type === 'stdio'
        ? { ...transport, env: map(transport.env), cwd: transport.cwd === undefined ? cwd : resolve(cwd, transport.cwd) }
        : { ...transport, headers: map(transport.headers) },
    auth: auth.type === 'bearer' ? { ...auth, bearer: absolute(auth.bearer) } : auth.type === 'headers' ? { ...auth, headers: map(auth.headers) } : auth,
  };
  if (server.roots !== undefined && server.roots.length > 0) next.roots = server.roots.map((entry) => rootUri(entry, { cwd, home }));
  return next;
}

/**
 * Identity of a session: everything that changes how the server is started or reached or how its
 * failures read. Hashed, so a literal credential in the definition never shows up in a status line.
 */
export function sessionKey(server: ServerConfig): string {
  const identity = {
    name: server.name,
    provider: server.provider,
    transport: server.transport,
    auth: server.auth,
    exclusive: server.exclusive,
    concurrency: server.concurrency,
    roots: server.roots ?? [],
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24);
}
