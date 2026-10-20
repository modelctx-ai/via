// via's OAuth client (auth.md, "OAuth"), built on the MCP SDK's OAuthClientProvider and helpers.
//
// One class serves two situations:
//  - login (`login` option set): the SDK's `auth()` drives discovery, registration and the token
//    exchange through the OAuthClientProvider methods; state is kept in memory and the record is
//    written once, when the tokens arrive.
//  - calls: `createFetch()` gives the HTTP transport a fetch that attaches the access token,
//    refreshing it before it expires or after a 401. It never starts an authorization: without a
//    usable login it throws LoginRequiredError. This is what keeps agents from ever blocking on
//    a browser, and it works the same in-process and inside a daemon session.
//
// The SDK is loaded on demand; importing this module costs nothing at CLI start.
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { MIN_REDACTED_LITERAL_LENGTH } from '../../config/credentials';
import { LoginRequiredError, TokenRefreshError } from './errors';
import { oauthKey, secretsOf, type OAuthRecord, type OAuthStore, type SetResult } from './store';

/** Refresh when the access token has less than this left. */
export const EXPIRY_SKEW_MS = 60_000;
/** How long a loaded record is trusted before the store is read again. */
const RECORD_CACHE_MS = 2_000;
/** OAuth error codes that say "try again later", as opposed to "this login is no good". */
const TRANSIENT_CODES = new Set(['server_error', 'temporarily_unavailable', 'too_many_requests']);

export interface LoginMode {
  /** `http://127.0.0.1:<port>/callback`. */
  redirectUrl: string;
  /** Random `state` for this attempt. */
  state: string;
  /** Receives the authorization URL the user has to visit. */
  onAuthorizationUrl: (url: URL) => void | Promise<void>;
}

export interface OAuthProviderOptions {
  /** The MCP endpoint. */
  serverUrl: string;
  scopes?: readonly string[];
  /** Pre-registered client id (no dynamic registration). */
  clientId?: string;
  store: OAuthStore;
  /** Told about every secret this provider handles, so output redaction knows it. */
  track?: (value: string) => void;
  now?: () => number;
  fetch?: FetchLike;
  login?: LoginMode;
}

export type TokenState = 'valid' | 'expiring' | 'expired';

/** Where the access token of a record stands. Unknown expiry counts as valid until the server says otherwise. */
export function tokenState(record: Pick<OAuthRecord, 'expiresAt'>, now: number): TokenState {
  if (record.expiresAt === undefined) return 'valid';
  const left = record.expiresAt - now;
  if (left <= 0) return 'expired';
  return left <= EXPIRY_SKEW_MS ? 'expiring' : 'valid';
}

function withBearer(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

function firstLine(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

interface Draft {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
  requestedScope?: string;
}

export class ViaOAuthProvider implements OAuthClientProvider {
  readonly key: string;
  /** Where the last `saveTokens` put the record (login mode). */
  lastSet?: SetResult;

  private readonly store: OAuthStore;
  private readonly now: () => number;
  private readonly fetchFn: FetchLike | undefined;
  private readonly draft: Draft = {};
  private cached?: { record: OAuthRecord | undefined; at: number };
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: OAuthProviderOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.fetchFn = options.fetch;
    this.key = oauthKey({ url: options.serverUrl, ...(options.clientId ? { clientId: options.clientId } : {}), ...(options.scopes ? { scopes: options.scopes } : {}) });
  }

  // Calls ---------------------------------------------------------------------------------------

  /** The stored record, or undefined when there is none. Cached for a moment unless `force`. */
  async load(force = false): Promise<OAuthRecord | undefined> {
    if (!force && this.cached && this.now() - this.cached.at < RECORD_CACHE_MS) return this.cached.record;
    const stored = await this.store.get(this.key);
    this.remember(stored?.record);
    return stored?.record;
  }

  /** Throws LoginRequiredError('missing') without touching the network when there is no login. */
  async requireLogin(): Promise<OAuthRecord> {
    const record = await this.load(true);
    if (!record?.tokens) throw new LoginRequiredError('missing');
    return record;
  }

  /**
   * A fetch for the HTTP transport: bearer token attached, refreshed when due, and refreshed once
   * more (then the request retried once) when the server answers 401.
   */
  createFetch(base: FetchLike = (url, init) => fetch(url, init)): FetchLike {
    return async (url, init) => {
      const token = await this.accessToken();
      const response = await base(url, withBearer(init, token));
      if (response.status !== 401) return response;
      await response.body?.cancel().catch(() => undefined);
      const fresh = await this.accessToken({ rejected: token });
      return base(url, withBearer(init, fresh));
    };
  }

  /**
   * A usable access token. Refreshes when it is expired or about to be, or when `rejected` names
   * the token the server just refused. Concurrent callers share one refresh.
   */
  accessToken(options: { rejected?: string } = {}): Promise<string> {
    const run = (): Promise<string> => this.resolveAccessToken(options.rejected);
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async resolveAccessToken(rejected: string | undefined): Promise<string> {
    const record = await this.load(rejected !== undefined);
    const tokens = record?.tokens;
    if (!record || !tokens) throw new LoginRequiredError('missing');
    // Someone else (another process) may already have replaced the token the server refused.
    const refused = rejected !== undefined && tokens.access_token === rejected;
    const state = tokenState(record, this.now());
    if (!refused && state === 'valid') return tokens.access_token;
    if (!tokens.refresh_token) {
      if (refused || state === 'expired') throw new LoginRequiredError('expired');
      return tokens.access_token; // about to expire, nothing to refresh with: use it while it lasts
    }
    if (!refused && state === 'expiring') {
      // A failed early refresh is not fatal while the token still works.
      try {
        return await this.refresh(record);
      } catch (error) {
        if (error instanceof LoginRequiredError || error instanceof TokenRefreshError) return tokens.access_token;
        throw error;
      }
    }
    return this.refresh(record);
  }

  private configuredClient(): OAuthClientInformationMixed | undefined {
    return this.options.clientId ? { client_id: this.options.clientId } : undefined;
  }

  private async refresh(record: OAuthRecord, retried = false): Promise<string> {
    const refreshToken = record.tokens?.refresh_token;
    const client = this.configuredClient() ?? record.clientInformation;
    if (!refreshToken || !client) {
      await this.dropTokens(record);
      throw new LoginRequiredError('expired');
    }
    const sdk = await import('@modelcontextprotocol/sdk/client/auth.js');
    try {
      let discovery = record.discovery;
      if (!discovery?.authorizationServerUrl) {
        const info = await sdk.discoverOAuthServerInfo(this.options.serverUrl, this.fetchFn ? { fetchFn: this.fetchFn } : {});
        discovery = { ...info };
      }
      const fresh = await sdk.refreshAuthorization(discovery.authorizationServerUrl, {
        clientInformation: client,
        refreshToken,
        ...(discovery.authorizationServerMetadata ? { metadata: discovery.authorizationServerMetadata } : {}),
        // Sent verbatim, as auth() does at login.
        ...(discovery.resourceMetadata?.resource ? { resource: discovery.resourceMetadata.resource } : {}),
        ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
      });
      return await this.commit(record, { ...fresh, issuer: record.tokens?.issuer ?? discovery.authorizationServerUrl }, discovery);
    } catch (error) {
      const code = (error as { errorCode?: unknown } | null)?.errorCode;
      if (typeof code === 'string' && !TRANSIENT_CODES.has(code)) {
        // The server no longer accepts this refresh token. Another process may have rotated it
        // while we were reading: use what it stored, once.
        const again = await this.load(true);
        const rotated = again?.tokens?.refresh_token;
        if (again && rotated && rotated !== refreshToken && !retried) {
          if (tokenState(again, this.now()) === 'valid') return again.tokens!.access_token;
          return this.refresh(again, true);
        }
        await this.dropTokens(record);
        throw new LoginRequiredError('expired');
      }
      throw new TokenRefreshError(firstLine(error));
    }
  }

  /** Persist refreshed tokens; the access token is used even if the store cannot be written. */
  private async commit(record: OAuthRecord, tokens: OAuthTokens, discovery: OAuthDiscoveryState): Promise<string> {
    const now = this.now();
    const next: OAuthRecord = {
      ...record,
      tokens,
      obtainedAt: now,
      discovery,
      scope: tokens.scope ?? record.scope,
    };
    if (tokens.expires_in !== undefined) next.expiresAt = now + tokens.expires_in * 1000;
    else delete next.expiresAt;
    if (next.scope === undefined) delete next.scope;
    this.remember(next);
    try {
      await this.store.set(this.key, next);
    } catch {
      // Read-only store: this process keeps working with the fresh token; the next one refreshes again.
    }
    return tokens.access_token;
  }

  /** Forget the tokens of a login the server refuses; the client registration stays. */
  private async dropTokens(record: OAuthRecord): Promise<void> {
    const next: OAuthRecord = { ...record };
    delete next.tokens;
    delete next.obtainedAt;
    delete next.expiresAt;
    this.remember(next);
    try {
      await this.store.set(this.key, next);
    } catch {
      // nothing more to do
    }
  }

  private remember(record: OAuthRecord | undefined): void {
    this.cached = { record, at: this.now() };
    if (record && this.options.track) {
      for (const secret of secretsOf(record)) if (secret.length >= MIN_REDACTED_LITERAL_LENGTH) this.options.track(secret);
    }
  }

  // OAuthClientProvider (login) ---------------------------------------------------------------

  get redirectUrl(): string | undefined {
    return this.options.login?.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const scope = this.options.scopes?.join(' ');
    return {
      client_name: 'via',
      redirect_uris: this.options.login ? [this.options.login.redirectUrl] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(scope ? { scope } : {}),
    };
  }

  state(): string {
    return this.options.login?.state ?? '';
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    // Only this attempt's registration is used. One from an earlier login was made for another
    // redirect URI (every login listens on a new port), so the record's client is not consulted.
    return this.configuredClient() ?? this.draft.client;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.draft.client = info;
  }

  tokens(): OAuthTokens | undefined {
    return this.draft.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const now = this.now();
    const record: OAuthRecord = {
      version: 1,
      serverUrl: this.options.serverUrl,
      tokens,
      obtainedAt: now,
    };
    if (this.draft.client && !this.options.clientId) record.clientInformation = this.draft.client;
    if (tokens.expires_in !== undefined) record.expiresAt = now + tokens.expires_in * 1000;
    const scope = tokens.scope ?? this.draft.requestedScope;
    if (scope) record.scope = scope;
    if (this.draft.discovery) record.discovery = this.draft.discovery;
    this.draft.tokens = tokens;
    this.remember(record);
    this.lastSet = await this.store.set(this.key, record);
  }

  redirectToAuthorization(url: URL): void | Promise<void> {
    const login = this.options.login;
    if (!login) throw new LoginRequiredError('missing'); // calls never start an authorization
    const scope = url.searchParams.get('scope');
    if (scope) this.draft.requestedScope = scope;
    return login.onAuthorizationUrl(url);
  }

  saveCodeVerifier(verifier: string): void {
    this.draft.verifier = verifier;
  }

  codeVerifier(): string {
    if (!this.draft.verifier) throw new Error('no PKCE verifier saved for this login attempt');
    return this.draft.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.draft.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.draft.discovery;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'client') delete this.draft.client;
    if (scope === 'all' || scope === 'tokens') delete this.draft.tokens;
    if (scope === 'all' || scope === 'verifier') delete this.draft.verifier;
    if (scope === 'all' || scope === 'discovery') delete this.draft.discovery;
  }
}
