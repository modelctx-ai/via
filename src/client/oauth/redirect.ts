// Receiving the authorization response (auth.md, "回调"): a loopback listener for the normal flow,
// and parsing of a pasted redirect URL for `--manual`. The response is `code`, `state` and, when
// the authorization server sends it, `iss` (RFC 9207); or an OAuth error. The caller checks
// `state` against the one it sent and passes `iss` through to the token exchange.
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface AuthorizationResponse {
  code?: string;
  state?: string;
  /** RFC 9207 `iss` from the authorization response, form-urlencoded then decoded. */
  iss?: string;
  error?: string;
  errorDescription?: string;
}

export const CALLBACK_PATH = '/callback';

/**
 * The loopback ports the callback listener may use, tried in this order (auth.md, "回调"). Fixed so that the
 * client metadata document (`pages/client-metadata.json`, CIMD) can list every redirect URI up front; a test
 * keeps the two in step. Below every operating system's ephemeral range (Linux 32768-60999, macOS, Windows and
 * the BSDs 49152-65535), so a busy port means another program listens there, never an outgoing connection of
 * this machine; away from the ports development servers and databases like (3000, 5000, 8000-9999, 5432, …);
 * ten of them, so a few concurrent logins or a stale listener do not block one.
 */
export const CALLBACK_PORTS: readonly number[] = Object.freeze(Array.from({ length: 10 }, (_, i) => 29842 + i));

/** `http://127.0.0.1:<port>/callback`: the IP literal (RFC 8252 section 8.3), never `localhost`. */
export function callbackUrl(port: number): string {
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

function fromParams(params: URLSearchParams): AuthorizationResponse {
  const out: AuthorizationResponse = {};
  const code = params.get('code');
  const state = params.get('state');
  const iss = params.get('iss');
  const error = params.get('error');
  const description = params.get('error_description');
  if (code) out.code = code;
  if (state) out.state = state;
  if (iss) out.iss = iss;
  if (error) out.error = error;
  if (description) out.errorDescription = description;
  return out;
}

/**
 * What the user pasted in `--manual` mode: the full landing URL, or just its query string
 * (`code=…&state=…`). Returns undefined when it holds neither a code nor an error.
 */
export function parseRedirect(input: string): AuthorizationResponse | undefined {
  const text = input.trim().replace(/^['"]|['"]$/g, '');
  if (text === '') return undefined;
  let params: URLSearchParams;
  try {
    params = new URL(text).searchParams;
  } catch {
    params = new URLSearchParams(text.startsWith('?') ? text.slice(1) : text);
  }
  const response = fromParams(params);
  return response.code || response.error ? response : undefined;
}

export interface Loopback {
  /** `http://127.0.0.1:<port>/callback` */
  redirectUrl: string;
  /** Resolves with the first response that hits the callback path. */
  response: Promise<AuthorizationResponse>;
  /**
   * Write the browser page. Call with `true` only after the authorization code has been accepted.
   * A granted callback is held until this, so the page does not say "Signed in" while the token
   * exchange is still going to fail. An error callback is answered immediately.
   */
  finish(ok: boolean): Promise<void>;
  close(): Promise<void>;
}

const PAGE = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:3em auto;max-width:32em"><h1>${title}</h1><p>${text}</p></body>`;

/** Every port of the callback range is taken (or may not be bound): the listener cannot start. */
export class CallbackPortsBusyError extends Error {
  constructor(readonly ports: readonly number[]) {
    super(`ports ${ports[0]}-${ports[ports.length - 1]} on 127.0.0.1 are all in use`);
    this.name = 'CallbackPortsBusyError';
  }
}

/**
 * Listen on 127.0.0.1, on the first free port of `ports`, until one response arrives. A port that is taken
 * (`EADDRINUSE`) or that the system keeps from this user (`EACCES`, e.g. Windows' excluded ranges) is skipped;
 * any other error ends the attempt. Only requests addressed to that host and port are served.
 */
export async function startLoopback(ports: readonly number[] = CALLBACK_PORTS): Promise<Loopback> {
  let resolve!: (value: AuthorizationResponse) => void;
  const response = new Promise<AuthorizationResponse>((r) => {
    resolve = r;
  });
  let done = false;
  let pending: ServerResponse | undefined;
  let settled = false;
  let pageOk = false;
  const send = (res: ServerResponse, ok: boolean, andThen?: () => void): void => {
    res
      .writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      .end(ok ? PAGE('Signed in', 'You can close this tab and return to the terminal.') : PAGE('Authorization failed', 'Return to the terminal for details.'), () => andThen?.());
  };
  const finish = (ok: boolean): Promise<void> =>
    new Promise((doneFinish) => {
      settled = true;
      pageOk = ok;
      const res = pending;
      pending = undefined;
      if (!res) {
        doneFinish();
        return;
      }
      send(res, ok, doneFinish);
    });
  const server: Server = createServer((req, res) => {
    const address = server.address() as AddressInfo;
    const host = req.headers.host;
    const url = (() => {
      try {
        return new URL(req.url ?? '/', 'http://127.0.0.1');
      } catch {
        return undefined;
      }
    })();
    // A browser page on another origin cannot read this (no CORS headers), and DNS-rebinding hosts are refused.
    if (!url || url.pathname !== CALLBACK_PATH || (host !== `127.0.0.1:${address.port}` && host !== `localhost:${address.port}`)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const got = fromParams(url.searchParams);
    if (!got.code && !got.error) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('missing authorization response');
      return;
    }
    // A granted code is not success yet: the token exchange may still reject it. Hold the page.
    if (got.code && !settled) {
      if (!pending) pending = res;
      else send(res, false);
    } else if (!got.code) {
      send(res, false);
    } else {
      send(res, pageOk);
    }
    if (!done) {
      done = true;
      resolve(got);
    }
  });
  let port: number | undefined;
  for (const candidate of ports) {
    try {
      await new Promise<void>((ok, fail) => {
        server.once('error', fail);
        server.listen(candidate, '127.0.0.1', () => {
          server.off('error', fail);
          ok();
        });
      });
      port = (server.address() as AddressInfo).port;
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error;
    }
  }
  if (port === undefined) throw new CallbackPortsBusyError(ports);
  return {
    redirectUrl: callbackUrl(port),
    response,
    finish,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
