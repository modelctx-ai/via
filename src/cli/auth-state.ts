// How a server's authentication stands, for `via servers` and `via auth status` (auth.md). Reads
// credential references and the OAuth store; contacts no server and shows no secret.
import type { LoginStatus } from '../client/oauth';
import { isCredentialRef, parseCredentialRef, type ServerConfig } from '../config';
import type { App } from './app';

/** Credential references a server uses; references only, never values. */
export function credentialRefs(server: ServerConfig): string[] {
  const refs: string[] = [];
  const { auth, transport } = server;
  if (auth.type === 'bearer') refs.push(auth.bearer);
  if (auth.type === 'headers') refs.push(...Object.values(auth.headers));
  refs.push(...Object.values(transport.type === 'stdio' ? transport.env : transport.headers));
  return [...new Set(refs.filter(isCredentialRef))];
}

export type AuthMethod = 'none' | 'env' | 'bearer' | 'headers' | 'oauth';

export interface AuthState {
  method: AuthMethod;
  /** References that do not resolve (non-OAuth). */
  missing: string[];
  /** For OAuth. */
  login?: LoginStatus;
  /** Why the OAuth store could not be read. */
  storeError?: string;
  /** Whether a call would get through authentication without logging in or fixing a reference. */
  usable: boolean;
}

export async function authState(app: App, server: ServerConfig): Promise<AuthState> {
  const kind = server.auth.type;
  if (kind === 'oauth') {
    const { describeLogin, oauthKey, oauthTarget } = await import('../client/oauth');
    const target = oauthTarget(server);
    if (!target) return { method: 'oauth', missing: [], login: { state: 'not-logged-in' }, usable: false };
    try {
      const stored = await (await app.oauthStore()).get(oauthKey(target));
      const login = describeLogin(stored, app.io.now());
      return { method: 'oauth', missing: [], login, usable: login.state === 'logged-in' || login.state === 'refreshable' };
    } catch (error) {
      return { method: 'oauth', missing: [], login: { state: 'not-logged-in' }, storeError: error instanceof Error ? error.message.split('\n')[0]! : 'store error', usable: false };
    }
  }
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
  const method: AuthMethod = kind === 'none' ? (credentialRefs(server).length > 0 ? 'env' : 'none') : kind;
  return { method, missing, usable: missing.length === 0 };
}
