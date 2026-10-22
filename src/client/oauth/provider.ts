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
import type { FetchLike, OAuthClientInformationContext, OAuthClientInformationMixed, OAuthClientMetadata, OAuthClientProvider, OAuthDiscoveryState, OAuthTokens } from '@modelcontextprotocol/client';
import { MIN_REDACTED_LITERAL_LENGTH } from '../../config/credentials';
import { AuthorizationServerChangedError, ClientCredentialsRejectedError, LoginRequiredError, oauthErrorCode, PinnedIssuerMismatchError, TokenRefreshError } from './errors';
import { probeChallenge } from './probe';
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
  /**
   * Client ID Metadata Document URL: used as `client_id` when the authorization server advertises
   * `client_id_metadata_document_supported` and no `clientId` is configured; otherwise the client
   * registers dynamically. Absent: CIMD is not used.
   */
  clientMetadataUrl?: string;
  /**
   * The authorization server this server must use (`auth.oauth.issuer`). Discovery, or a saved login, that names another
   * one is refused before a token request, a client secret or a registration is sent to it.
   */
  pinnedIssuer?: string;
  /**
   * `client_credentials`: the machine grant (no browser, no refresh token). Needs `clientId` and one of `clientSecret`
   * and `privateKey`, plus `resolveCredential`. Default: the authorization code flow.
   */
  grant?: 'client_credentials';
  /** Credential reference to the client secret (a pre-registered confidential client, or the machine grant). */
  clientSecret?: string;
  /** Credential reference to the PEM private key of the client assertion (machine grant). */
  privateKey?: string;
  /** JWS algorithm of the client assertion; default `RS256`. */
  keyAlgorithm?: string;
  /** Resolves a credential reference to its value (the resolver also puts it on the redaction list). */
  resolveCredential?: (ref: string) => Promise<string>;
  store: OAuthStore;
  /** Told about every secret this provider handles, so output redaction knows it. */
  track?: (value: string) => void;
  now?: () => number;
  fetch?: FetchLike;
  login?: LoginMode;
  /**
   * The store refused a refreshed login (read-only keychain or directory). Called with the first
   * line of the store's error each time it happens; the caller decides how often to tell the person.
   */
  onSaveFailed?: (reason: string) => void;
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

/** Two issuer identifiers name the same authorization server (a trailing slash does not matter). */
function sameIssuer(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/** The authorization server a discovery result names: its metadata's issuer, else the URL it was found at. */
function issuerOf(discovery: OAuthDiscoveryState): string {
  return discovery.authorizationServerMetadata?.issuer ?? String(discovery.authorizationServerUrl);
}

/** The authorization server a record is bound to; undefined for a record from before binding (it adopts the first one it meets). */
function boundIssuer(record: OAuthRecord | undefined): string | undefined {
  if (!record) return undefined;
  const stamped = (record.clientInformation as { issuer?: string } | undefined)?.issuer;
  return record.issuer ?? stamped ?? record.tokens?.issuer;
}

/** Refuse to use `record`'s client registration, refresh token or credentials with an authorization server other than the bound one. */
function assertBound(record: OAuthRecord | undefined, current: string): void {
  const bound = boundIssuer(record);
  if (bound !== undefined && !sameIssuer(bound, current)) throw new AuthorizationServerChangedError(bound, current);
}

/** The authorization server a saved login belongs to: its bound issuer, else the one in its cached discovery. */
function recordIssuer(record: OAuthRecord): string | undefined {
  return boundIssuer(record) ?? (record.discovery ? issuerOf(record.discovery) : undefined);
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
  /**
   * The newest refreshed login that could not be saved. A server that rotates refresh tokens has
   * already retired the one still in the store, so this process keeps using this record instead of
   * reading the stale one back (unless another process stored something newer).
   */
  private unsaved?: OAuthRecord;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: OAuthProviderOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.fetchFn = options.fetch;
    this.key = oauthKey({
      url: options.serverUrl,
      ...(options.clientId ? { clientId: options.clientId } : {}),
      ...(options.scopes ? { scopes: options.scopes } : {}),
      ...(options.grant ? { grant: options.grant } : {}),
    });
  }

  /** Whether this is the machine grant: tokens come from the client credentials, never from a person. */
  get machine(): boolean {
    return this.options.grant === 'client_credentials';
  }

  // Pinned authorization server --------------------------------------------------------------

  /**
   * Refuse an authorization server other than the pinned one (`auth.oauth.issuer`, auth.md "钉住授权服务器"). Compared
   * the way the binding is: the issuer identifiers are equal apart from a trailing slash. Runs before anything is
   * sent to that server (a token request, a client secret, a registration).
   */
  private assertPinned(actual: string, savedLogin = false): void {
    const pinned = this.options.pinnedIssuer;
    if (pinned !== undefined && !sameIssuer(pinned, actual)) throw new PinnedIssuerMismatchError(pinned, actual, savedLogin);
  }

  /** A saved login issued by another authorization server than the pinned one is not used either. */
  private assertRecordPinned(record: OAuthRecord | undefined): void {
    const issuer = record ? recordIssuer(record) : undefined;
    if (issuer !== undefined) this.assertPinned(issuer, true);
  }

  // Calls ---------------------------------------------------------------------------------------

  /** The stored record, or undefined when there is none. Cached for a moment unless `force`. */
  async load(force = false): Promise<OAuthRecord | undefined> {
    if (!force && this.cached && this.now() - this.cached.at < RECORD_CACHE_MS) return this.cached.record;
    const stored = await this.store.get(this.key);
    let record = stored?.record;
    if (this.unsaved) {
      // Only while the login still exists in the store (a logout elsewhere ends it) and nothing newer was saved.
      if (record?.tokens && (record.obtainedAt ?? 0) <= (this.unsaved.obtainedAt ?? 0)) record = this.unsaved;
      else this.unsaved = undefined;
    }
    this.remember(record);
    return record;
  }

  /**
   * Throws LoginRequiredError('missing') without touching the network when there is no login. The machine grant
   * needs no login to exist (a token is requested when none is usable), but its credentials must resolve.
   */
  async requireLogin(): Promise<void> {
    if (this.machine) {
      await this.machineCredential();
      await this.load(true);
      return;
    }
    const record = await this.load(true);
    if (!record?.tokens) throw new LoginRequiredError('missing');
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
    if (this.machine) return this.resolveMachineToken(rejected);
    const record = await this.load(rejected !== undefined);
    const tokens = record?.tokens;
    if (!record || !tokens) throw new LoginRequiredError('missing');
    this.assertRecordPinned(record);
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

  /** The configured (pre-registered) client: id, and the secret when one is configured. */
  private async configuredClient(): Promise<OAuthClientInformationMixed | undefined> {
    if (!this.options.clientId) return undefined;
    const client: OAuthClientInformationMixed = { client_id: this.options.clientId };
    if (this.options.clientSecret) client.client_secret = await this.credential(this.options.clientSecret);
    return client;
  }

  private credential(ref: string): Promise<string> {
    if (!this.options.resolveCredential) throw new Error('a credential reference is configured but nothing resolves it');
    return this.options.resolveCredential(ref);
  }

  // The machine grant -------------------------------------------------------------------------

  /** The client secret or private key, resolved (in memory only). */
  private async machineCredential(): Promise<{ secret: string; kind: 'secret' | 'key' }> {
    const { clientSecret, privateKey } = this.options;
    if (privateKey) return { secret: await this.credential(privateKey), kind: 'key' };
    if (clientSecret) return { secret: await this.credential(clientSecret), kind: 'secret' };
    throw new Error('the client-credentials grant needs a clientSecret or a privateKey');
  }

  private async resolveMachineToken(rejected: string | undefined): Promise<string> {
    const record = await this.load(rejected !== undefined);
    const tokens = record?.tokens;
    this.assertRecordPinned(record);
    if (tokens) {
      const refused = rejected !== undefined && tokens.access_token === rejected;
      const state = tokenState(record!, this.now());
      if (!refused && state === 'valid') return tokens.access_token;
      if (!refused && state === 'expiring') {
        try {
          return await this.acquire(record);
        } catch (error) {
          if (error instanceof TokenRefreshError) return tokens.access_token; // still works for a moment
          throw error;
        }
      }
    }
    return this.acquire(record);
  }

  /**
   * Ask the authorization server for an access token with the client credentials, discovering it through the protected
   * resource metadata (RFC 9728) as the login does. The credentials go to the authorization server the record is bound
   * to and nowhere else (auth.md, "绑定授权服务器"). The result is stored; with `strict` a store that cannot be written
   * fails the call (the login), otherwise the token is used from memory. Without `fresh` a discovery result in the
   * record is reused.
   */
  async acquire(record?: OAuthRecord, options: { strict?: boolean; fresh?: boolean } = {}): Promise<string> {
    const sdk = await import('@modelcontextprotocol/client');
    const { clientId } = this.options;
    if (!clientId) throw new Error('the client-credentials grant needs a clientId');
    const { secret, kind } = await this.machineCredential();
    // `fresh` (the login) rediscovers; the binding to the recorded authorization server is checked all the same.
    let discovery = options.fresh ? undefined : record?.discovery;
    let challengeScope: string | undefined;
    try {
      if (!discovery?.authorizationServerUrl) {
        const challenge = await probeChallenge(this.options.serverUrl, this.fetchFn);
        challengeScope = challenge.scope;
        const info = await sdk.discoverOAuthServerInfo(this.options.serverUrl, {
          ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
          ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
        });
        discovery = { ...info };
      }
      const issuer = issuerOf(discovery);
      this.assertPinned(issuer);
      assertBound(record, issuer);
      const metadata = discovery.authorizationServerMetadata;
      const configured = this.options.scopes && this.options.scopes.length > 0 ? this.options.scopes.join(' ') : undefined;
      const scope = configured ?? challengeScope ?? record?.scope ?? discovery.resourceMetadata?.scopes_supported?.join(' ');
      const common = { clientId, ...(scope ? { scope } : {}), clientName: 'via', expectedIssuer: issuer };
      const grantProvider =
        kind === 'key'
          ? new sdk.PrivateKeyJwtProvider({ ...common, privateKey: secret, algorithm: this.options.keyAlgorithm ?? 'RS256' })
          : new sdk.ClientCredentialsProvider({ ...common, clientSecret: secret });
      const tokens = await sdk.fetchToken(grantProvider, discovery.authorizationServerUrl, {
        ...(metadata ? { metadata } : {}),
        ...(discovery.resourceMetadata?.resource ? { resource: discovery.resourceMetadata.resource } : {}),
        ...(scope ? { scope } : {}),
        ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
      });
      return await this.commitMachine(record, { ...tokens, issuer }, discovery, issuer, scope, options.strict === true);
    } catch (error) {
      if (error instanceof AuthorizationServerChangedError || error instanceof PinnedIssuerMismatchError) throw error;
      const code = oauthErrorCode(error);
      if (typeof code === 'string' && !TRANSIENT_CODES.has(code)) throw new ClientCredentialsRejectedError(code);
      throw new TokenRefreshError(firstLine(error), 'get an access token with the client credentials');
    }
  }

  private async commitMachine(
    previous: OAuthRecord | undefined,
    tokens: OAuthTokens,
    discovery: OAuthDiscoveryState,
    issuer: string,
    requestedScope: string | undefined,
    strict: boolean,
  ): Promise<string> {
    const now = this.now();
    // No refresh token is kept: the machine grant asks again with its credentials.
    const { refresh_token: _refresh, ...kept } = tokens;
    const record: OAuthRecord = { version: 1, serverUrl: this.options.serverUrl, grant: 'client_credentials', issuer, tokens: kept, obtainedAt: now, discovery };
    if (tokens.expires_in !== undefined) record.expiresAt = now + tokens.expires_in * 1000;
    const scope = tokens.scope ?? requestedScope ?? previous?.scope;
    if (scope) record.scope = scope;
    this.remember(record);
    try {
      this.lastSet = await this.store.set(this.key, record);
      this.unsaved = undefined;
    } catch (error) {
      if (strict) throw error;
      this.unsaved = record;
    }
    return tokens.access_token;
  }

  private async refresh(record: OAuthRecord, retried = false): Promise<string> {
    const refreshToken = record.tokens?.refresh_token;
    const client = (await this.configuredClient()) ?? record.clientInformation;
    if (!refreshToken || !client) {
      await this.dropTokens(record);
      throw new LoginRequiredError('expired');
    }
    const sdk = await import('@modelcontextprotocol/client');
    try {
      let discovery = record.discovery;
      if (!discovery?.authorizationServerUrl) {
        const info = await sdk.discoverOAuthServerInfo(this.options.serverUrl, this.fetchFn ? { fetchFn: this.fetchFn } : {});
        discovery = { ...info };
      }
      // The refresh token and the client's credentials go to the authorization server they were issued by, only.
      this.assertPinned(issuerOf(discovery));
      assertBound(record, issuerOf(discovery));
      const fresh = await sdk.refreshAuthorization(discovery.authorizationServerUrl, {
        clientInformation: client,
        refreshToken,
        ...(discovery.authorizationServerMetadata ? { metadata: discovery.authorizationServerMetadata } : {}),
        // Sent verbatim, as auth() does at login.
        ...(discovery.resourceMetadata?.resource ? { resource: discovery.resourceMetadata.resource } : {}),
        ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
      });
      return await this.commit(record, { ...fresh, issuer: record.tokens?.issuer ?? issuerOf(discovery) }, discovery);
    } catch (error) {
      if (error instanceof AuthorizationServerChangedError || error instanceof PinnedIssuerMismatchError) throw error;
      const code = oauthErrorCode(error);
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
      issuer: boundIssuer(record) ?? issuerOf(discovery),
      scope: tokens.scope ?? record.scope,
    };
    if (tokens.expires_in !== undefined) next.expiresAt = now + tokens.expires_in * 1000;
    else delete next.expiresAt;
    if (next.scope === undefined) delete next.scope;
    this.remember(next);
    try {
      await this.store.set(this.key, next);
      this.unsaved = undefined;
    } catch (error) {
      // Read-only store: this process keeps working with the fresh token. Another process starts
      // from the stored one, which a rotating server no longer accepts; the person has to know.
      this.unsaved = next;
      this.options.onSaveFailed?.(firstLine(error));
    }
    return tokens.access_token;
  }

  /** Forget the tokens of a login the server refuses; the client registration stays. */
  private async dropTokens(record: OAuthRecord): Promise<void> {
    const next: OAuthRecord = { ...record };
    delete next.tokens;
    delete next.obtainedAt;
    delete next.expiresAt;
    this.unsaved = undefined;
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

  /** Read by the SDK's `auth()`: where the authorization server can fetch this client's metadata (CIMD). */
  get clientMetadataUrl(): string | undefined {
    return this.options.clientMetadataUrl;
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

  async clientInformation(ctx?: OAuthClientInformationContext): Promise<OAuthClientInformationMixed | undefined> {
    // Only this attempt's registration is used. One from an earlier login was made for another
    // redirect URI (the port is whichever was free), so the record's client is not consulted.
    // A configured client id is stamped with the authorization server the SDK resolved: unstamped it
    // would make the SDK print a warning about credentials it cannot bind to an issuer.
    // The SDK calls this right after discovery and before it registers a client or sends anything else to the
    // authorization server it found, so the pin is checked here for every login (and for the callback leg).
    if (ctx?.issuer) this.assertPinned(ctx.issuer);
    const configured = await this.configuredClient();
    if (configured) {
      // A configured secret was validated against the authorization server of the earlier login: not sent to another.
      if (this.options.clientSecret && ctx?.issuer) assertBound(this.priorRecord, ctx.issuer);
      return ctx?.issuer ? { ...configured, issuer: ctx.issuer } : configured;
    }
    return this.draft.client;
  }

  private priorRecord?: OAuthRecord;

  /** Login mode: remember what the store holds now, so the new authorization server can be checked against it. */
  async loadPrior(): Promise<void> {
    this.priorRecord = await this.load(true);
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
    if (this.draft.discovery) record.issuer = issuerOf(this.draft.discovery);
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
