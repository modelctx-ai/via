// `via auth logout` (auth.md, "状态与登出"): revoke the tokens at the authorization server when it
// offers a revocation endpoint (RFC 7009, best effort), then delete the local record whatever
// happened. A logout never fails because the server could not be reached.
import { oauthKey, type OAuthRecord, type OAuthStore } from './store';
import type { LoginTarget } from './login';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

export type RevokeOutcome =
  /** The server accepted the revocation. */
  | 'revoked'
  /** The server has no revocation endpoint; only the local record was removed. */
  | 'unsupported'
  /** The request failed; only the local record was removed. */
  | 'failed'
  /** There was nothing to revoke. */
  | 'none';

export interface LogoutResult {
  /** Whether a local record existed and was deleted. */
  removed: boolean;
  revoke: RevokeOutcome;
}

const REVOKE_TIMEOUT_MS = 5000;

async function revokeToken(endpoint: string, token: string, hint: 'refresh_token' | 'access_token', record: OAuthRecord, fetchFn: FetchLike): Promise<boolean> {
  const client = record.clientInformation as { client_id?: string; client_secret?: string } | undefined;
  const body = new URLSearchParams({ token, token_type_hint: hint });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (client?.client_id) {
    if (client.client_secret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64')}`;
    else body.set('client_id', client.client_id);
  }
  const response = await fetchFn(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS) });
  await response.body?.cancel().catch(() => undefined);
  return response.ok;
}

export async function performLogout(options: { target: LoginTarget; store: OAuthStore; fetch?: FetchLike }): Promise<LogoutResult> {
  const { target, store } = options;
  const key = oauthKey({ url: target.url, ...(target.clientId ? { clientId: target.clientId } : {}), ...(target.scopes ? { scopes: target.scopes } : {}) });
  const stored = await store.get(key).catch(() => undefined);
  let revoke: RevokeOutcome = 'none';
  const tokens = stored?.record.tokens;
  if (stored && tokens) {
    const endpoint = (stored.record.discovery?.authorizationServerMetadata as { revocation_endpoint?: string } | undefined)?.revocation_endpoint;
    if (!endpoint) revoke = 'unsupported';
    else {
      const fetchFn = options.fetch ?? ((u, init) => fetch(u, init));
      try {
        const results = [await revokeToken(endpoint, tokens.refresh_token ?? tokens.access_token, tokens.refresh_token ? 'refresh_token' : 'access_token', stored.record, fetchFn)];
        if (tokens.refresh_token) results.push(await revokeToken(endpoint, tokens.access_token, 'access_token', stored.record, fetchFn));
        revoke = results.every(Boolean) ? 'revoked' : 'failed';
      } catch {
        revoke = 'failed';
      }
    }
  }
  const removed = await store.delete(key);
  return { removed, revoke };
}
