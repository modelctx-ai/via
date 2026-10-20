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
}

export interface OAuthServerState {
  registrations: Array<Record<string, unknown> & { client_id: string; redirect_uris: string[] }>;
  authorizeRequests: Array<Record<string, string>>;
  tokenRequests: Array<Record<string, string>>;
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
