// Receiving the authorization response (auth.md, "回调"): a loopback listener for the normal flow,
// and parsing of a pasted redirect URL for `--manual`. The response is `code` and `state`, or an
// OAuth error; the caller checks `state` against the one it sent.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomInt } from 'node:crypto';

export interface AuthorizationResponse {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

export const CALLBACK_PATH = '/callback';

function fromParams(params: URLSearchParams): AuthorizationResponse {
  const out: AuthorizationResponse = {};
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');
  const description = params.get('error_description');
  if (code) out.code = code;
  if (state) out.state = state;
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

/** A port in the dynamic range for `--manual`, where nothing listens: the landing page is not meant to load. */
export function randomPort(): number {
  return randomInt(49152, 65536);
}

export interface Loopback {
  /** `http://127.0.0.1:<port>/callback` */
  redirectUrl: string;
  /** Resolves with the first response that hits the callback path. */
  response: Promise<AuthorizationResponse>;
  close(): Promise<void>;
}

const PAGE = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:3em auto;max-width:32em"><h1>${title}</h1><p>${text}</p></body>`;

/** Listen on 127.0.0.1, random port, until one response arrives. Only requests addressed to that host and port are served. */
export async function startLoopback(): Promise<Loopback> {
  let resolve!: (value: AuthorizationResponse) => void;
  const response = new Promise<AuthorizationResponse>((r) => {
    resolve = r;
  });
  let done = false;
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
    const ok = got.code !== undefined;
    res
      .writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      .end(ok ? PAGE('Signed in', 'You can close this tab and return to the terminal.') : PAGE('Authorization failed', 'Return to the terminal for details.'));
    if (!done) {
      done = true;
      resolve(got);
    }
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ok);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    redirectUrl: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    response,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
