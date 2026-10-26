import type { CliState } from './cli-server.mjs';

export interface OAuthServerOptions {
  /** Seconds an access token lives (default 3600). */
  accessTokenTtl?: number;
  /** Offer dynamic client registration (default true). */
  dcr?: boolean;
  /** Offer a revocation endpoint (default true). */
  revocation?: boolean;
  /** Replace the refresh token on every refresh (default true). */
  rotateRefresh?: boolean;
  scopes?: string[];
  /** Include an unsigned `id_token` with an email claim. */
  idToken?: boolean;
  /** Issue refresh tokens at all (default true). */
  refreshTokens?: boolean;
  /** Client metadata document URL -> the document it serves; the server advertises `client_id_metadata_document_supported`. */
  cimd?: Record<string, object>;
  /** The client-credentials grant for one client: a secret (basic or post) or a public key (`private_key_jwt`, verified with jose). */
  machine?: { clientId: string; clientSecret?: string; publicKey?: unknown };
  /** A confidential client for the authorization code flow: any loopback redirect URI, the secret required at the token endpoint. */
  preRegistered?: { clientId: string; clientSecret: string };
  /**
   * RFC 9207. `true`: metadata says `authorization_response_iss_parameter_supported` and the redirect
   * carries this server's issuer. A string other than `'omit'` is sent as `iss` instead. `'omit'`
   * advertises support but leaves `iss` off the redirect.
   */
  iss?: boolean | 'omit' | string;
}

export interface OAuthServerState {
  registrations: Array<Record<string, unknown> & { client_id: string; redirect_uris: string[] }>;
  authorizeRequests: Array<Record<string, string>>;
  tokenRequests: Array<Record<string, string>>;
  /** One entry per token request: grant, client id as presented, and how the client authenticated. */
  tokenAuth: Array<{ grantType: string | null; clientId: string; method: 'basic' | 'post' | 'jwt' | 'none' }>;
  /** When set, the protected resource metadata names these authorization servers instead of the server's own. */
  authorizationServers: string[] | undefined;
  revocations: Array<Record<string, string>>;
  mcp: Array<{ valid: boolean; authorization: string }>;
  cli: CliState;
  denyNext: boolean;
  tokenFailure: number | undefined;
  mcpFailure: { status: number; echo?: boolean } | undefined;
}

export interface OAuthServer {
  url: string;
  issuer: string;
  state: OAuthServerState;
  issuedAccessTokens(): string[];
  issuedRefreshTokens(): string[];
  expireAccessTokens(): void;
  revokeRefreshTokens(): void;
  browse(authorizationUrl: string): Promise<{ status: number; text: string; location: string }>;
  approve(authorizationUrl: string): Promise<string>;
  close(): Promise<void>;
}

export declare function startOAuthServer(options?: OAuthServerOptions): Promise<OAuthServer>;
