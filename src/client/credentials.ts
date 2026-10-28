// Resolve a server's credential references into concrete connection parameters (auth.md,
// "鉴权方式"). Results live in memory only; nothing here logs or persists them.
import { refOrigin, type CredentialResolver, type ServerConfig } from '../config/types';
import { baseEnvironment } from './env';

export interface ResolvedStdio {
  type: 'stdio';
  command: string;
  args: string[];
  cwd?: string;
  /** Base environment plus the server's resolved `env`. */
  env: Record<string, string>;
}

export interface ResolvedHttp {
  type: 'http';
  url: string;
  /** Resolved request headers, in a stable order; `Authorization` set by `auth.bearer` wins. */
  headers: Record<string, string>;
}

export type ResolvedConnection = ResolvedStdio | ResolvedHttp;

/**
 * Resolve every credential reference of `server`. Throws CredentialError (exit 4) when one cannot be
 * resolved, before anything is spawned or sent. `auth: oauth` adds nothing here: its tokens come from
 * the OAuth store when the connection is made (oauth/provider.ts); only a stdio server with it is
 * rejected.
 */
export async function resolveConnection(
  server: ServerConfig,
  resolver: CredentialResolver,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedConnection> {
  const { auth, transport } = server;
  // The error constructors are a big module that only a failure needs, and this runs on every browse.
  if (auth.type === 'oauth' && transport.type === 'stdio') throw (await import('./errors')).oauthNeedsHttp(server);

  // Each reference is checked against the layer that wrote it (`cmd:` only from the user config), not the transport's.
  const resolveAll = async (refs: Record<string, string>, field: (key: string) => string): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const [key, ref] of Object.entries(refs)) out[key] = await resolver.resolve(ref, refOrigin(server, field(key)));
    return out;
  };

  if (transport.type === 'stdio') {
    // `auth.bearer` / `auth.headers` do not apply to stdio: its credentials go through `env` (auth.md).
    const env = { ...baseEnvironment(baseEnv), ...(await resolveAll(transport.env, (key) => `env.${key}`)) };
    return {
      type: 'stdio',
      command: transport.command,
      args: transport.args,
      ...(transport.cwd !== undefined ? { cwd: transport.cwd } : {}),
      env,
    };
  }

  const headers = new Map<string, [name: string, value: string]>();
  const put = (name: string, value: string): void => {
    headers.set(name.toLowerCase(), [name, value]);
  };
  for (const [name, value] of Object.entries(await resolveAll(transport.headers, (key) => `headers.${key}`))) put(name, value);
  if (auth.type === 'headers') {
    for (const [name, value] of Object.entries(await resolveAll(auth.headers, () => 'auth'))) put(name, value);
  }
  if (auth.type === 'bearer') put('Authorization', `Bearer ${await resolver.resolve(auth.bearer, refOrigin(server, 'auth'))}`);
  return { type: 'http', url: transport.url, headers: Object.fromEntries(headers.values()) };
}
