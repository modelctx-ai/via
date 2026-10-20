// What `via auth status` and `via servers` say about a login: state, expiry, scopes, who. Pure;
// nothing here returns or formats a token.
import { tokenState } from './provider';
import type { OAuthLocation, StoredLogin } from './store';

export type LoginState =
  /** Nothing saved, or the saved login was dropped after a refresh was refused. */
  | 'not-logged-in'
  | 'logged-in'
  /** The access token ran out; the next call refreshes it. */
  | 'refreshable'
  /** The access token ran out and there is no refresh token. */
  | 'expired';

export interface LoginStatus {
  state: LoginState;
  /** Epoch milliseconds. */
  expiresAt?: number;
  scope?: string;
  /** `email`, `preferred_username` or `sub` of the ID token, when the server issued one. */
  account?: string;
  location?: OAuthLocation;
}

/** Claims of a JWT payload, unverified: display only, never used for a decision. */
function claims(jwt: string): Record<string, unknown> {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return {};
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function accountOf(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  const c = claims(idToken);
  for (const key of ['email', 'preferred_username', 'sub']) {
    const value = c[key];
    if (typeof value === 'string' && value !== '' && value.length <= 200) return value;
  }
  return undefined;
}

export function describeLogin(stored: StoredLogin | undefined, now: number): LoginStatus {
  const record = stored?.record;
  if (!stored || !record?.tokens) return { state: 'not-logged-in' };
  const status: LoginStatus = { state: 'logged-in', location: stored.location };
  if (record.expiresAt !== undefined) status.expiresAt = record.expiresAt;
  if (record.scope) status.scope = record.scope;
  const account = accountOf(record.tokens.id_token);
  if (account) status.account = account;
  if (tokenState(record, now) === 'expired') status.state = record.tokens.refresh_token ? 'refreshable' : 'expired';
  return status;
}

/** `45s`, `54m`, `3h`, `2d`: one unit, rounded down. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** The state as one phrase for `via servers`: `logged in, expires in 54m`, `not logged in`, … */
export function summarizeLogin(status: LoginStatus, now: number): string {
  switch (status.state) {
    case 'not-logged-in':
      return 'not logged in';
    case 'expired':
      return 'expired';
    case 'refreshable':
      return 'access token expired, refreshable';
    default:
      return status.expiresAt === undefined ? 'logged in' : `logged in, expires in ${formatDuration(status.expiresAt - now)}`;
  }
}
