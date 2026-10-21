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
  constructor(detail: string) {
    super(`could not refresh the saved login: ${detail}`);
    this.name = 'TokenRefreshError';
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
