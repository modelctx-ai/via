// What the CLI and the daemon agree on when a server definition crosses the socket: which session a
// definition maps to, how the caller's working directory is applied, and how the two sides tell that
// their environments differ for a credential variable without ever exchanging the value.
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
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
 * variable changed since), so the daemon asks to be restarted instead of using a stale value. Only
 * the digest travels; it is one-way, so the socket still never carries a credential.
 */
export function envStamp(server: ServerConfig, env: Readonly<Record<string, string | undefined>>): string {
  const names = new Set<string>();
  for (const ref of credentialRefs(server)) {
    const parsed = parseCredentialRef(ref);
    if (parsed.kind === 'env') names.add(parsed.arg);
  }
  if (names.size === 0) return '';
  const hash = createHash('sha256');
  for (const name of [...names].sort()) hash.update(`${name}\0${env[name] ?? ''}\0`);
  return hash.digest('hex').slice(0, 32);
}

/** `file:` references and a stdio `cwd` are relative to the caller; the daemon has its own working directory. */
export function effectiveServer(server: ServerConfig, cwd: string): ServerConfig {
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
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24);
}
