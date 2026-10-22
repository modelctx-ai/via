// Errors raised by the OAuth layer. They are matched by `name` in `mapError` (errors.ts), so the
// client's error mapping does not have to import this directory (or the MCP SDK behind it).

export type LoginRequiredReason = 'missing' | 'expired';

/** No usable login: never logged in, or the saved login can no longer be refreshed (exit 4). */
export class LoginRequiredError extends Error {
  readonly reason: LoginRequiredReason;

  constructor(reason: LoginRequiredReason) {
    super(reason === 'missing' ? 'no saved login' : 'the saved login expired and could not be refreshed');
    this.name = 'LoginRequiredError';
    this.reason = reason;
  }
}

/** Refreshing failed for a reason that does not invalidate the login: network, server error (exit 6). */
export class TokenRefreshError extends Error {
  constructor(detail: string, what = 'refresh the saved login') {
    super(`could not ${what}: ${detail}`);
    this.name = 'TokenRefreshError';
  }
}

/**
 * The server now points at another authorization server than the one the saved login (client registration,
 * refresh token, validated client credentials) belongs to. Nothing was sent to the new one (exit 4, auth.md,
 * "绑定授权服务器").
 */
export class AuthorizationServerChangedError extends Error {
  constructor(
    readonly recorded: string,
    readonly current: string,
  ) {
    super('the authorization server changed');
    this.name = 'AuthorizationServerChangedError';
  }
}

/** The authorization server refused the client credentials (client secret or key assertion) of the machine grant (exit 4). */
export class ClientCredentialsRejectedError extends Error {
  constructor(
    /** The OAuth error code (`invalid_client`, `unauthorized_client`, `invalid_scope`, …). */
    readonly code: string,
  ) {
    super(`the authorization server refused the client credentials (${code})`);
    this.name = 'ClientCredentialsRejectedError';
  }
}

/** A login attempt that did not complete. */
export class LoginFailedError extends Error {
  constructor(
    message: string,
    /** 4 for denied, mismatch, timeout; 6 when the server could not be reached; 2 for unsupported setups. */
    readonly exitCode: 2 | 4 | 6 = 4,
    readonly next?: string,
  ) {
    super(message);
    this.name = 'LoginFailedError';
  }
}

/**
 * The OAuth error code (`invalid_grant`, `server_error`, …) of an error the SDK raised for an
 * authorization server's error response; undefined for any other failure. Matched by name so this
 * file does not import the SDK.
 */
export function oauthErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== 'OAuthError') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
