// OAuth for HTTP servers (docs/spec/auth.md): login, token storage, silent refresh, status, logout.
// Everything here loads the MCP SDK on demand, so importing it is cheap.
import type { FetchLike } from '@modelcontextprotocol/client';
import type { ServerConfig } from '../../config/types';
import { CLIENT_METADATA_URL } from './client-metadata';
import type { LoginTarget } from './login';
import { ViaOAuthProvider } from './provider';
import type { OAuthStore } from './store';

export { LoginFailedError, LoginRequiredError, TokenRefreshError, type LoginRequiredReason } from './errors';
export { performLogin, type LoginIO, type LoginOptions, type LoginResult, type LoginTarget } from './login';
export { performLogout, type LogoutResult, type RevokeOutcome } from './logout';
export { browserUnavailable, openBrowser, openerCommand, type OpenResult } from './opener';
export { EXPIRY_SKEW_MS, ViaOAuthProvider, tokenState, type OAuthProviderOptions, type TokenState } from './provider';
export { CLIENT_METADATA_URL, documentedRedirectUris } from './client-metadata';
export { CALLBACK_PATH, CALLBACK_PORTS, CallbackPortsBusyError, callbackUrl, parseRedirect, startLoopback, type AuthorizationResponse, type Loopback } from './redirect';
export { accountOf, describeLogin, formatDuration, summarizeLogin, type LoginState, type LoginStatus } from './status';
export {
  KEYCHAIN_SERVICE,
  checkStoreWritable,
  createMemoryOAuthStore,
  createOAuthStore,
  oauthKey,
  parseRecord,
  secretsOf,
  storeModeFromEnv,
  type OAuthIdentity,
  type OAuthKeyring,
  type OAuthLocation,
  type OAuthRecord,
  type OAuthStore,
  type OAuthStoreOptions,
  type SetResult,
  type StoreMode,
  type StoredLogin,
} from './store';

/** The OAuth parameters of a server, or undefined when it does not use OAuth over HTTP. */
export function oauthTarget(server: ServerConfig): LoginTarget | undefined {
  const { auth, transport } = server;
  if (auth.type !== 'oauth' || transport.type !== 'http') return undefined;
  return {
    provider: server.provider,
    url: transport.url,
    ...(auth.scopes && auth.scopes.length > 0 ? { scopes: auth.scopes } : {}),
    ...(auth.clientId ? { clientId: auth.clientId } : {}),
    // CIMD is on by default; `clientMetadataUrl: false` is the opt-out, a URL replaces the hosted document.
    ...(auth.clientMetadataUrl === false ? {} : { clientMetadataUrl: auth.clientMetadataUrl ?? CLIENT_METADATA_URL }),
  };
}

/** A provider for making calls to `server` (never starts an authorization). */
export function createCallProvider(
  server: ServerConfig,
  store: OAuthStore,
  options: { track?: (value: string) => void; now?: () => number; onSaveFailed?: (reason: string) => void; fetch?: FetchLike } = {},
): ViaOAuthProvider {
  const target = oauthTarget(server);
  if (!target) throw new Error(`${server.provider} does not use OAuth over HTTP`);
  return new ViaOAuthProvider({
    serverUrl: target.url,
    ...(target.scopes ? { scopes: target.scopes } : {}),
    ...(target.clientId ? { clientId: target.clientId } : {}),
    ...(target.clientMetadataUrl ? { clientMetadataUrl: target.clientMetadataUrl } : {}),
    store,
    ...(options.track ? { track: options.track } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.onSaveFailed ? { onSaveFailed: options.onSaveFailed } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
